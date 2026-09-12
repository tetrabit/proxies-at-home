import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProxxiedDexie } from "@/db";
import { createMpcCalibrationSyncStateStore } from "./mpcCalibrationSyncState";
import { createMpcCalibrationOperationScope } from "./mpcCalibrationOperationScope";
import { dispatchMpcCalibrationQueuedRecovery } from "./mpcCalibrationQueuedRecovery";
import type { MpcCalibrationRecoveryInput, MpcCalibrationRecoveryResult } from "./mpcCalibrationRecovery";
import type { MpcCalibrationTransport } from "./mpcCalibrationTransport";
import type { CalibrationHarnessSnapshot } from "../../../shared/calibrationHarness";

const identity = { ownerId: "owner", harnessId: "harness", connectionId: "connection" };
const handles: ProxxiedDexie[] = [];
const owners: ReturnType<typeof createMpcCalibrationOperationScope>[] = [];

function fresh(): ProxxiedDexie {
  const database = new ProxxiedDexie(`queued-recovery-${crypto.randomUUID()}`);
  handles.push(database);
  return database;
}

function snapshot(tag: string): CalibrationHarnessSnapshot {
  return {
    version: 1,
    retained: { tag },
    datasets: [{ id: "dataset", name: "Dataset", targetCaseCount: 1, createdAt: 1, updatedAt: 1, version: 1 }],
    cases: [{ id: "case", datasetId: "dataset", createdAt: 1, updatedAt: 1, source: { name: tag }, candidates: [] }],
    assets: [],
    runs: [],
  };
}

function transport(): MpcCalibrationTransport {
  return {
    pair: async () => ({ ownerId: identity.ownerId, harnessId: identity.harnessId }),
    unpair: async () => undefined,
    getSession: async () => ({ ownerId: identity.ownerId, harnessId: identity.harnessId }),
    getSnapshot: async () => ({ revision: 1, snapshot: snapshot("base") }),
    getBlob: async () => new Uint8Array(),
    missingBlobs: async () => ({ missing: [] }),
    putBlob: async () => ({ sha256: "hash", byteLength: 0, inserted: false }),
    publishSnapshot: async () => ({ revision: 2, snapshot: snapshot("queued") }),
  };
}

async function queued(database: ProxxiedDexie) {
  const store = createMpcCalibrationSyncStateStore(database, { now: () => 10 });
  await store.storeBaseWhenClean(identity, { revision: 1, snapshot: snapshot("base") });
  await store.queueSnapshot(identity, snapshot("queued"));
  return store;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const owner of owners.splice(0)) owner.dispose();
  for (const database of handles.splice(0)) database.close();
});

describe("dispatchMpcCalibrationQueuedRecovery", () => {
  it("invokes C5 once for an identity-scoped durable queue and publishes its bounded outcome", async () => {
    const database = fresh();
    await queued(database);
    const recover = vi.fn(async (input: MpcCalibrationRecoveryInput): Promise<MpcCalibrationRecoveryResult> => {
      expect(input.identity).toEqual(identity);
      return { status: "published", generation: 1, revision: 2 };
    });

    await expect(dispatchMpcCalibrationQueuedRecovery({
      database,
      target: "linked-web",
      identity,
      transport: transport(),
      recover,
    })).resolves.toEqual({ kind: "recovery", target: "linked-web", status: "published", generation: 1, revision: 2 });
    expect(recover).toHaveBeenCalledTimes(1);
  });

  it("reports only no queued recovery work without invoking C5 or a transport request", async () => {
    const database = fresh();
    const remote = transport();
    const getSession = vi.fn(remote.getSession);
    remote.getSession = getSession;
    const recover = vi.fn(async (): Promise<MpcCalibrationRecoveryResult> => ({ status: "published", generation: 1, revision: 2 }));

    await expect(dispatchMpcCalibrationQueuedRecovery({
      database,
      target: "linked-web",
      identity,
      transport: remote,
      recover,
    })).resolves.toEqual({ kind: "no-queued-work", target: "linked-web" });
    expect(recover).not.toHaveBeenCalled();
    expect(getSession).not.toHaveBeenCalled();
  });

  it.each([
    [{ status: "conflict", reason: "dataset:private-conflict-id" }, { kind: "recovery", target: "linked-web", status: "conflict" }],
    [{ status: "pending", generation: 2, revision: 3, reason: "private recovery detail" }, { kind: "recovery", target: "linked-web", status: "pending", generation: 2, revision: 3 }],
    [{ status: "no-queued", reason: "race detail" }, { kind: "no-queued-work", target: "linked-web" }],
  ] as const)("maps C5 %s without reflecting free-form reason", async (outcome, expected) => {
    const database = fresh();
    await queued(database);
    const recover = vi.fn(async (): Promise<MpcCalibrationRecoveryResult> => outcome);

    await expect(dispatchMpcCalibrationQueuedRecovery({
      database,
      target: "linked-web",
      identity,
      transport: transport(),
      recover,
    })).resolves.toEqual(expected);
    expect(recover).toHaveBeenCalledTimes(1);
  });

  it("defaults only undefined to local and rejects null without probing C5", async () => {
    const database = fresh();
    const recover = vi.fn(async (): Promise<MpcCalibrationRecoveryResult> => ({ status: "published", generation: 1, revision: 2 }));

    await expect(dispatchMpcCalibrationQueuedRecovery({ database, recover })).resolves.toEqual({ kind: "local", target: "local" });
    await expect(dispatchMpcCalibrationQueuedRecovery({
      database,
      target: null as never,
      identity,
      transport: transport(),
      recover,
    })).resolves.toEqual({ kind: "rejected", status: "invalid-operation" });
    expect(recover).not.toHaveBeenCalled();
  });

  it("cancels after the durable queue observation without invoking C5", async () => {
    const database = fresh();
    await queued(database);
    let checks = 0;
    const recover = vi.fn(async (): Promise<MpcCalibrationRecoveryResult> => ({ status: "published", generation: 1, revision: 2 }));

    await expect(dispatchMpcCalibrationQueuedRecovery({
      database,
      target: "linked-web",
      identity,
      transport: transport(),
      recover,
      operation: { isCurrent: () => ++checks === 1 },
    })).resolves.toEqual({ kind: "cancelled", target: "linked-web" });
    expect(recover).not.toHaveBeenCalled();
  });

  it("captures identity and transport methods before C1 awaits cannot retarget C5", async () => {
    const database = fresh();
    await queued(database);
    const remote = transport() as MpcCalibrationTransport & { marker: string };
    remote.marker = "captured";
    const originalGetSession = vi.fn(function(this: { marker: string }) {
      return Promise.resolve({ ownerId: this.marker, harnessId: identity.harnessId });
    });
    remote.getSession = originalGetSession;
    const replacementGetSession = vi.fn(async () => ({ ownerId: "replacement", harnessId: identity.harnessId }));
    const input = { database, target: "linked-web" as const, identity: { ...identity }, transport: remote };
    const recover = vi.fn(async (recoveryInput: MpcCalibrationRecoveryInput): Promise<MpcCalibrationRecoveryResult> => {
      await recoveryInput.transport.getSession();
      expect(recoveryInput.identity).toEqual(identity);
      return { status: "published", generation: 1, revision: 2 };
    });

    const pending = dispatchMpcCalibrationQueuedRecovery({ ...input, recover });
    input.identity.ownerId = "replacement";
    remote.getSession = replacementGetSession;
    await expect(pending).resolves.toEqual({ kind: "recovery", target: "linked-web", status: "published", generation: 1, revision: 2 });
    expect(originalGetSession).toHaveBeenCalledOnce();
    expect(replacementGetSession).not.toHaveBeenCalled();
  });

  it("blocks a corrupt scoped C1 row without changing it or invoking C5", async () => {
    const database = fresh();
    const corrupt = { ownerId: identity.ownerId, harnessId: identity.harnessId, connectionId: identity.connectionId, queued: { bad: true } };
    await database.mpcCalibrationSyncStates.put(corrupt as never);
    const recover = vi.fn(async (): Promise<MpcCalibrationRecoveryResult> => ({ status: "published", generation: 1, revision: 2 }));

    await expect(dispatchMpcCalibrationQueuedRecovery({ database, target: "linked-web", identity, transport: transport(), recover }))
      .resolves.toEqual({ kind: "recovery", target: "linked-web", status: "blocked" });
    expect(recover).not.toHaveBeenCalled();
    expect(await database.mpcCalibrationSyncStates.get([identity.ownerId, identity.harnessId, identity.connectionId])).toEqual(corrupt);
  });

  it("uses the real C5 producer once for a controlled durable queue", async () => {
    const database = fresh();
    const base = snapshot("base");
    const local = snapshot("queued");
    const state = createMpcCalibrationSyncStateStore(database, { now: () => 10 });
    await state.storeBaseWhenClean(identity, { revision: 1, snapshot: base });
    await state.queueSnapshot(identity, local);
    await database.mpcCalibrationDatasets.bulkPut(local.datasets as never);
    await database.mpcCalibrationCases.bulkPut(local.cases as never);
    await database.mpcCalibrationCacheBindings.put({ id: "mpc-calibration-cache-binding", ...identity, revision: 1, updatedAt: 1 });
    const remote = transport();
    remote.getSnapshot = vi.fn(async () => ({ revision: 1, snapshot: structuredClone(base) }));
    remote.publishSnapshot = vi.fn(async (next) => ({ revision: 2, snapshot: structuredClone(next) }));

    await expect(dispatchMpcCalibrationQueuedRecovery({ database, target: "linked-web", identity, transport: remote }))
      .resolves.toEqual({ kind: "recovery", target: "linked-web", status: "published", generation: 1, revision: 2 });
    expect(remote.publishSnapshot).toHaveBeenCalledOnce();
    expect(await state.load(identity)).toMatchObject({ queued: null, inFlight: null, acknowledgedGeneration: 1 });
  });

  it("stops truthy non-boolean standalone currentness before real C5 starts a transport request", async () => {
    const database = fresh();
    const state = await queued(database);
    const before = await state.load(identity);
    const remote = transport();
    remote.getSession = vi.fn(remote.getSession);
    remote.getSnapshot = vi.fn(remote.getSnapshot);
    remote.publishSnapshot = vi.fn(remote.publishSnapshot);
    let checks = 0;
    const operation = {
      current: true,
      isCurrent(this: { current: boolean }) {
        return ++checks <= 2 ? this.current : "truthy-but-not-current" as never;
      },
    };

    await expect(dispatchMpcCalibrationQueuedRecovery({ database, target: "linked-web", identity, transport: remote, operation }))
      .resolves.toEqual({ kind: "cancelled", target: "linked-web" });
    expect(remote.getSession).not.toHaveBeenCalled();
    expect(remote.getSnapshot).not.toHaveBeenCalled();
    expect(remote.publishSnapshot).not.toHaveBeenCalled();
    expect(await state.load(identity)).toEqual(before);
  });

  it("preserves a valid standalone currentness receiver through real C5", async () => {
    const database = fresh();
    const base = snapshot("base");
    const local = snapshot("queued");
    const state = createMpcCalibrationSyncStateStore(database, { now: () => 10 });
    await state.storeBaseWhenClean(identity, { revision: 1, snapshot: base });
    await state.queueSnapshot(identity, local);
    await database.mpcCalibrationDatasets.bulkPut(local.datasets as never);
    await database.mpcCalibrationCases.bulkPut(local.cases as never);
    await database.mpcCalibrationCacheBindings.put({ id: "mpc-calibration-cache-binding", ...identity, revision: 1, updatedAt: 1 });
    const remote = transport();
    remote.getSnapshot = vi.fn(async () => ({ revision: 1, snapshot: structuredClone(base) }));
    remote.publishSnapshot = vi.fn(async (next) => ({ revision: 2, snapshot: structuredClone(next) }));
    const operation = { current: true, isCurrent(this: { current: boolean }) { return this.current; } };

    await expect(dispatchMpcCalibrationQueuedRecovery({ database, target: "linked-web", identity, transport: remote, operation }))
      .resolves.toEqual({ kind: "recovery", target: "linked-web", status: "published", generation: 1, revision: 2 });
    expect(remote.publishSnapshot).toHaveBeenCalledOnce();
  });

  it("stops real C5 before snapshot and publish when currentness ends while its bound session request resolves", async () => {
    const database = fresh();
    const state = await queued(database);
    const before = await state.load(identity);
    const remote = Object.assign(transport(), { marker: "original" }) as MpcCalibrationTransport & { marker: string };
    let releaseSession!: (value: { ownerId: string; harnessId: string }) => void;
    let startedSession!: () => void;
    const started = new Promise<void>(resolve => { startedSession = resolve; });
    const getSession = vi.fn(function(this: { marker: string }) {
      expect(this.marker).toBe("original");
      startedSession();
      return new Promise<{ ownerId: string; harnessId: string }>(resolve => { releaseSession = resolve; });
    });
    remote.getSession = getSession;
    remote.getSnapshot = vi.fn(remote.getSnapshot);
    remote.publishSnapshot = vi.fn(remote.publishSnapshot);
    let checks = 0;
    const operation = { isCurrent: () => ++checks <= 3 };

    const pending = dispatchMpcCalibrationQueuedRecovery({ database, target: "linked-web", identity, transport: remote, operation });
    await started;
    expect(getSession).toHaveBeenCalledOnce();
    releaseSession({ ownerId: identity.ownerId, harnessId: identity.harnessId });

    await expect(pending).resolves.toEqual({ kind: "cancelled", target: "linked-web" });
    expect(remote.getSnapshot).not.toHaveBeenCalled();
    expect(remote.publishSnapshot).not.toHaveBeenCalled();
    expect(await state.load(identity)).toEqual(before);
  });

  it("uses the branded supplied abort signal through real C5 despite a shadowed aborted property", async () => {
    const database = fresh();
    const state = await queued(database);
    const before = await state.load(identity);
    const controller = new AbortController();
    Object.defineProperty(controller.signal, "aborted", { configurable: true, value: false });
    const remote = transport();
    let releaseSession!: (value: { ownerId: string; harnessId: string }) => void;
    let startedSession!: () => void;
    const started = new Promise<void>(resolve => { startedSession = resolve; });
    let sessionCalls = 0;
    remote.getSession = vi.fn(() => {
      sessionCalls += 1;
      if (sessionCalls !== 1) return Promise.resolve({ ownerId: identity.ownerId, harnessId: identity.harnessId });
      startedSession();
      return new Promise<{ ownerId: string; harnessId: string }>(resolve => { releaseSession = resolve; });
    });
    remote.getSnapshot = vi.fn(remote.getSnapshot);
    remote.publishSnapshot = vi.fn(remote.publishSnapshot);

    const pending = dispatchMpcCalibrationQueuedRecovery({ database, target: "linked-web", identity, transport: remote, signal: controller.signal });
    await started;
    controller.abort();
    releaseSession({ ownerId: identity.ownerId, harnessId: identity.harnessId });

    await expect(pending).resolves.toEqual({ kind: "cancelled", target: "linked-web" });
    expect(remote.getSnapshot).not.toHaveBeenCalled();
    expect(remote.publishSnapshot).not.toHaveBeenCalled();
    expect(await state.load(identity)).toEqual(before);
  });

  it.each(["blocked", "cancelled", "failed"] as const)("preserves the bounded C5 %s distinction", async (status) => {
    const database = fresh();
    await queued(database);
    const recover = vi.fn(async (): Promise<MpcCalibrationRecoveryResult> => ({ status, reason: "raw error detail" }));

    await expect(dispatchMpcCalibrationQueuedRecovery({ database, target: "linked-web", identity, transport: transport(), recover }))
      .resolves.toEqual({ kind: "recovery", target: "linked-web", status });
    expect(recover).toHaveBeenCalledOnce();
  });

  it("rejects a missing linked identity and stops an already-aborted operation before C1/C5", async () => {
    const database = fresh();
    const recover = vi.fn(async (): Promise<MpcCalibrationRecoveryResult> => ({ status: "published", generation: 1, revision: 2 }));
    const aborted = new AbortController();
    aborted.abort();

    await expect(dispatchMpcCalibrationQueuedRecovery({ database, target: "linked-web", transport: transport(), recover }))
      .resolves.toEqual({ kind: "rejected", target: "linked-web", status: "invalid-identity" });
    await expect(dispatchMpcCalibrationQueuedRecovery({ database, target: "linked-web", identity, transport: transport(), recover, signal: aborted.signal }))
      .resolves.toEqual({ kind: "cancelled", target: "linked-web" });
    expect(recover).not.toHaveBeenCalled();
  });

  it("does not fabricate an ACK or clear a distinct queued G2 around a pending C5 result", async () => {
    const database = fresh();
    const state = await queued(database);
    const g1 = (await state.load(identity))!.queued!.snapshot;
    await state.markSnapshotSent(identity, 1);
    const g2 = snapshot("queued-G2");
    await state.queueSnapshot(identity, g2);
    const recover = vi.fn(async (): Promise<MpcCalibrationRecoveryResult> => ({ status: "pending", generation: 1, reason: "untrusted detail" }));

    await expect(dispatchMpcCalibrationQueuedRecovery({ database, target: "linked-web", identity, transport: transport(), recover }))
      .resolves.toEqual({ kind: "recovery", target: "linked-web", status: "pending", generation: 1 });
    expect(recover).toHaveBeenCalledOnce();
    expect(await state.load(identity)).toMatchObject({
      queued: { generation: 2, snapshot: g2 },
      inFlight: { generation: 1, snapshot: g1 },
      acknowledgedGeneration: 0,
    });
  });

  it.each(["target", "owner", "connection"] as const)("rejects a current operation with mismatched captured %s before C5", async boundary => {
    const database = fresh();
    const state = await queued(database);
    const before = await state.load(identity);
    const operationOwner = createMpcCalibrationOperationScope({
      target: boundary === "target" ? "linked-electron" : "linked-web",
      identity: {
        ...identity,
        ...(boundary === "owner" ? { ownerId: "other-owner" } : {}),
        ...(boundary === "connection" ? { connectionId: "other-connection" } : {}),
      },
    });
    owners.push(operationOwner);
    const recover = vi.fn(async (): Promise<MpcCalibrationRecoveryResult> => ({ status: "pending", generation: 1 }));

    await expect(dispatchMpcCalibrationQueuedRecovery({
      database,
      target: "linked-web",
      identity,
      transport: transport(),
      operation: operationOwner.captureAppOperation(),
      recover,
    })).resolves.toEqual({ kind: "rejected", target: "linked-web", status: "invalid-operation" });
    expect(recover).not.toHaveBeenCalled();
    expect(await state.load(identity)).toEqual(before);
  });

  it("forwards the captured operation signal to C5 when there is no override", async () => {
    const database = fresh();
    await queued(database);
    const operationOwner = createMpcCalibrationOperationScope({ target: "linked-web", identity });
    owners.push(operationOwner);
    const operation = operationOwner.captureAppOperation();
    const recover = vi.fn(async (_input: MpcCalibrationRecoveryInput): Promise<MpcCalibrationRecoveryResult> => ({ status: "pending", generation: 1 }));

    await expect(dispatchMpcCalibrationQueuedRecovery({
      database,
      target: "linked-web",
      identity,
      transport: transport(),
      operation,
      recover,
    })).resolves.toMatchObject({ kind: "recovery", status: "pending" });
    expect(recover).toHaveBeenCalledOnce();
    expect(recover.mock.calls[0]![0].signal).toBe(operation.signal);
  });

  it("rejects a conflicting signal override and cancels an already-aborted owner signal before C5", async () => {
    const database = fresh();
    await queued(database);
    const operationOwner = createMpcCalibrationOperationScope({ target: "linked-web", identity });
    owners.push(operationOwner);
    const operation = operationOwner.captureAppOperation();
    const recover = vi.fn(async (): Promise<MpcCalibrationRecoveryResult> => ({ status: "pending", generation: 1 }));

    await expect(dispatchMpcCalibrationQueuedRecovery({
      database,
      target: "linked-web",
      identity,
      transport: transport(),
      operation,
      signal: new AbortController().signal,
      recover,
    })).resolves.toEqual({ kind: "rejected", target: "linked-web", status: "invalid-operation" });
    operationOwner.replaceAuthentication({ replaced: true });
    await expect(dispatchMpcCalibrationQueuedRecovery({
      database,
      target: "linked-web",
      identity,
      transport: transport(),
      operation,
      recover,
    })).resolves.toEqual({ kind: "cancelled", target: "linked-web" });
    expect(recover).not.toHaveBeenCalled();
  });

  it.each(["absent", "corrupt"] as const)("cancels an obsolete %s C1 observation rather than publishing it", async stateKind => {
    const database = fresh();
    const operationOwner = createMpcCalibrationOperationScope({ target: "linked-web", identity });
    owners.push(operationOwner);
    const operation = operationOwner.captureAppOperation();
    const table = database.mpcCalibrationSyncStates;
    const key = [identity.ownerId, identity.harnessId, identity.connectionId];
    if (stateKind === "corrupt") await table.put({ ...identity, formatVersion: 99 } as never);
    const original = table.get.bind(table);
    const before = await original(key);
    const get = vi.spyOn(table, "get").mockImplementation(keyOrCriteria => original(keyOrCriteria as [string, string, string]).then(result => {
      operationOwner.replaceAuthentication({ replaced: true });
      return result;
    }));
    const recover = vi.fn(async (): Promise<MpcCalibrationRecoveryResult> => ({ status: "pending", generation: 1 }));

    try {
      await expect(dispatchMpcCalibrationQueuedRecovery({
        database,
        target: "linked-web",
        identity,
        transport: transport(),
        operation,
        recover,
      })).resolves.toEqual({ kind: "cancelled", target: "linked-web" });
      expect(recover).not.toHaveBeenCalled();
      expect(await original(key)).toEqual(before);
    } finally {
      get.mockRestore();
    }
  });

  it.each(["changing-status", "null", "throwing-generation"] as const)("bounds malformed C5 result %s without a raw rejection", async boundary => {
    const database = fresh();
    await queued(database);
    let reads = 0;
    const recover = vi.fn(async (): Promise<MpcCalibrationRecoveryResult> => {
      if (boundary === "null") return null as never;
      const result: MpcCalibrationRecoveryResult = { status: "pending", generation: 1 };
      if (boundary === "changing-status") {
        Object.defineProperty(result, "status", { get: () => reads++ === 0 ? "pending" : "private-status" });
      } else {
        Object.defineProperty(result, "generation", { get: () => { throw new Error("private-generation"); } });
      }
      return result;
    });

    const mapped = await dispatchMpcCalibrationQueuedRecovery({ database, target: "linked-web", identity, transport: transport(), recover });
    if (boundary === "changing-status") {
      expect(mapped).toEqual({ kind: "recovery", target: "linked-web", status: "pending", generation: 1 });
      expect(reads).toBe(1);
    } else {
      expect(mapped).toEqual({ kind: "recovery", target: "linked-web", status: "failed" });
    }
  });

  it("preserves valid C5 settlement provenance when the owner cancels before publication", async () => {
    const database = fresh();
    const state = await queued(database);
    const before = await state.load(identity);
    const operationOwner = createMpcCalibrationOperationScope({ target: "linked-web", identity });
    owners.push(operationOwner);
    const recover = vi.fn(async (): Promise<MpcCalibrationRecoveryResult> => {
      operationOwner.replaceAuthentication({ replaced: true });
      return { status: "cancelled", generation: 1, revision: 2 };
    });

    await expect(dispatchMpcCalibrationQueuedRecovery({
      database,
      target: "linked-web",
      identity,
      transport: transport(),
      operation: operationOwner.captureAppOperation(),
      recover,
    })).resolves.toEqual({ kind: "cancelled", target: "linked-web", generation: 1, revision: 2 });
    expect(await state.load(identity)).toEqual(before);
  });

  it("rejects a forged captured signal before observing C1 or invoking C5", async () => {
    const database = fresh();
    const state = await queued(database);
    const before = await state.load(identity);
    const owner = createMpcCalibrationOperationScope({ target: "linked-web", identity });
    owners.push(owner);
    const recover = vi.fn(async (): Promise<MpcCalibrationRecoveryResult> => ({ status: "pending", generation: 1 }));
    const operation = { ...owner.captureAppOperation(), signal: { aborted: false } as unknown as AbortSignal };

    await expect(dispatchMpcCalibrationQueuedRecovery({
      database,
      target: "linked-web",
      identity,
      transport: transport(),
      operation,
      recover,
    })).resolves.toEqual({ kind: "rejected", target: "linked-web", status: "invalid-operation" });
    expect(recover).not.toHaveBeenCalled();
    expect(await state.load(identity)).toEqual(before);
  });

  it("rejects an accessor-backed captured owner identity before C5", async () => {
    const database = fresh();
    const state = await queued(database);
    const before = await state.load(identity);
    const owner = createMpcCalibrationOperationScope({ target: "linked-web", identity });
    owners.push(owner);
    const recover = vi.fn(async (): Promise<MpcCalibrationRecoveryResult> => ({ status: "pending", generation: 1 }));
    const capturedIdentity = { ...identity };
    Object.defineProperty(capturedIdentity, "ownerId", { enumerable: true, get: () => identity.ownerId });
    const operation = { ...owner.captureAppOperation(), identity: capturedIdentity };

    await expect(dispatchMpcCalibrationQueuedRecovery({
      database,
      target: "linked-web",
      identity,
      transport: transport(),
      operation,
      recover,
    })).resolves.toEqual({ kind: "rejected", target: "linked-web", status: "invalid-operation" });
    expect(recover).not.toHaveBeenCalled();
    expect(await state.load(identity)).toEqual(before);
  });

  it("captures signal and currentness once and requires currentness to affirm literal true", async () => {
    const database = fresh();
    await queued(database);
    const controller = new AbortController();
    const recover = vi.fn(async (): Promise<MpcCalibrationRecoveryResult> => ({ status: "pending", generation: 1 }));
    let signalReads = 0;
    let currentReads = 0;
    let currentCalls = 0;
    const operation = {
      target: "linked-web" as const,
      identity: { ...identity },
      get signal() {
        signalReads += 1;
        return controller.signal;
      },
      get isCurrent() {
        currentReads += 1;
        return () => ++currentCalls === 1 ? true : "truthy-but-not-current";
      },
    };

    await expect(dispatchMpcCalibrationQueuedRecovery({
      database,
      target: "linked-web",
      identity,
      transport: transport(),
      operation: operation as never,
      recover,
    })).resolves.toEqual({ kind: "cancelled", target: "linked-web" });
    expect(signalReads).toBe(1);
    expect(currentReads).toBe(1);
    expect(currentCalls).toBe(2);
    expect(recover).not.toHaveBeenCalled();
  });

  it("rejects null and unknown linked targets without invoking C5", async () => {
    const database = fresh();
    const recover = vi.fn(async (): Promise<MpcCalibrationRecoveryResult> => ({ status: "pending", generation: 1 }));

    for (const target of [null, "forged-target"] as const) {
      await expect(dispatchMpcCalibrationQueuedRecovery({
        database,
        target: target as never,
        identity,
        transport: transport(),
        recover,
      })).resolves.toEqual({ kind: "rejected", status: "invalid-operation" });
    }
    expect(recover).not.toHaveBeenCalled();
  });
});
