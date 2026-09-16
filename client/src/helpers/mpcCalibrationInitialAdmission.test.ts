import "fake-indexeddb/auto";
import { Blob as NativeBlob } from "node:buffer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProxxiedDexie } from "@/db";
import { buildBootstrapPreferenceFixture } from "./mpcPreferenceBootstrap";
import { MpcCalibrationTransportError, type MpcCalibrationTransport } from "./mpcCalibrationTransport";
import {
  runMpcCalibrationInitialAdmission,
  runMpcCalibrationInitialAdmissionWithIdentity,
} from "./mpcCalibrationInitialAdmission";
import { createMpcCalibrationOperationScope } from "./mpcCalibrationOperationScope";
import { validateCalibrationHarnessSnapshot } from "../../../shared/calibrationHarness";

globalThis.Blob = NativeBlob as unknown as typeof Blob;

const handles: ProxxiedDexie[] = [];
const owners: ReturnType<typeof createMpcCalibrationOperationScope>[] = [];

function freshDatabase(): ProxxiedDexie {
  const database = new ProxxiedDexie(`initial-admission-${crypto.randomUUID()}`);
  handles.push(database);
  return database;
}

function bootstrapSnapshot() {
  const bootstrap = buildBootstrapPreferenceFixture();
  return {
    version: 1 as const,
    datasets: [bootstrap.dataset],
    cases: bootstrap.cases,
    assets: [],
    runs: [],
    retainedRoot: { exactBootstrap: true },
  };
}

const deferredAssetBytes = new Uint8Array([1, 2, 3, 4]);
const deferredAssetHash = "9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a";

function deferredSnapshot() {
  return {
    version: 1 as const,
    retainedRoot: { deferred: true },
    datasets: [{ id: "deferred-dataset", name: "Deferred", targetCaseCount: 1, createdAt: 1, updatedAt: 2, version: 1, retained: { fixture: true } }],
    cases: [{
      id: "deferred-case", datasetId: "deferred-dataset", createdAt: 3, updatedAt: 4,
      source: { name: "Deferred", retained: { fixture: true } },
      candidates: [{ identifier: "deferred-candidate", name: "Deferred", rawName: "Deferred", smallThumbnailUrl: "small", mediumThumbnailUrl: "medium", imageUrl: "image", dpi: 72, tags: ["deferred"], sourceName: "source", source: "source", extension: "png", size: 4, retained: { fixture: true } }],
      expectedIdentifier: "deferred-candidate", notes: "deferred fence", comparisonHints: { fullCard: { deferred: 1 } }, retained: { fixture: true },
    }],
    assets: [{ id: "deferred-asset", datasetId: "deferred-dataset", caseId: "deferred-case", role: "source" as const, mimeType: "image/png", createdAt: 5, hash: "deferred", sha256: deferredAssetHash, byteLength: deferredAssetBytes.byteLength, retained: { fixture: true } }],
    runs: [{
      id: "deferred-run", datasetId: "deferred-dataset", algorithmId: "deferred-algorithm", algorithmLabel: "Deferred", createdAt: 6,
      summary: { totalCases: 1, matchedCases: 1, mismatchedCases: 0, accuracy: 1 },
      results: [{ caseId: "deferred-case", matched: true, retained: { fixture: true } }], retained: { fixture: true },
    }],
  };
}

function controlledTransport(
  getSession: MpcCalibrationTransport["getSession"],
  getSnapshot: MpcCalibrationTransport["getSnapshot"],
): MpcCalibrationTransport {
  const unsupported = vi.fn(async (): Promise<never> => { throw new Error("unexpected transport operation"); });
  return {
    pair: unsupported,
    unpair: unsupported,
    getSession,
    getSnapshot,
    publishSnapshot: unsupported,
    getBlob: unsupported,
    putBlob: unsupported,
    missingBlobs: unsupported,
  };
}

afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const database of handles.splice(0)) database.close();
});

function admissionSetup(target: "local" | "linked-web" | "linked-electron" = "linked-web") {
  const database = freshDatabase();
  const owner = createMpcCalibrationOperationScope({ target, identity: null });
  owners.push(owner);
  const getSession = vi.fn(async () => ({ ownerId: "parent-owner", harnessId: "parent-harness" }));
  const getSnapshot = vi.fn(async () => null);
  const selected = controlledTransport(getSession, getSnapshot);
  const factory = vi.fn(() => selected);
  return { database, owner, getSession, getSnapshot, selected, factory,
    input: { database, target, operation: owner.captureAppOperation(), createWebTransport: factory } };
}

describe("runMpcCalibrationInitialAdmission", () => {
  it.each(["createWebTransport", "electronBridge"])("local default does not read unused %s capability", async field => {
    const { input, database } = admissionSetup("local");
    const getter = vi.fn(() => { throw new Error("synthetic-private-unused-provider"); });
    const args = { ...input, target: undefined };
    Object.defineProperty(args, field, { get: getter });
    expect(await runMpcCalibrationInitialAdmission(args)).toEqual({ kind: "local", target: "local" });
    expect(getter).not.toHaveBeenCalled();
    expect(await database.mpcCalibrationLinkStates.count()).toBe(0);
  });

  it.each(["local", "electronBridge"])("linked-web ignores unused %s capability", async field => {
    const { input, getSnapshot } = admissionSetup();
    const getter = vi.fn(() => { throw new Error("synthetic-private-unused-provider"); });
    Object.defineProperty(input, field, { get: getter });
    expect(await runMpcCalibrationInitialAdmission(input)).toEqual({ kind: "no-remote", target: "linked-web" });
    expect(getter).not.toHaveBeenCalled();
    expect(getSnapshot).toHaveBeenCalledOnce();
  });

  it("bounds link-store initialization failure before requests", async () => {
    const { input, getSession } = admissionSetup();
    vi.stubGlobal("crypto", { get randomUUID() { throw new Error("synthetic-private-uuid-provider"); } });
    await expect(runMpcCalibrationInitialAdmission(input)).resolves.toEqual({ kind: "failed", target: "linked-web", code: "unavailable" });
    expect(getSession).not.toHaveBeenCalled();
  });

  it("uses the signal it validated instead of rereading a changing accessor", async () => {
    const { input, getSession } = admissionSetup();
    const aborted = new AbortController(); aborted.abort();
    const live = new AbortController();
    let reads = 0;
    const operation = { ...input.operation };
    Object.defineProperty(operation, "signal", { get() { return reads++ === 0 ? aborted.signal : live.signal; } });
    expect(await runMpcCalibrationInitialAdmission({ ...input, operation })).toEqual({ kind: "cancelled", target: "linked-web" });
    expect(reads).toBe(1);
    expect(getSession).not.toHaveBeenCalled();
  });

  it("captures one default Electron bridge for restoration and C3", async () => {
    const { input } = admissionSetup("linked-electron");
    let reads = 0;
    const execute = vi.fn(async (request: { kind: string }) => request.kind === "getSession"
      ? { ok: true, value: { ownerId: "parent-owner", harnessId: "parent-harness" } }
      : { ok: false, error: { code: "http", status: 404 } });
    const bridge = { calibrationHarnessExecute: execute };
    vi.stubGlobal("window", { get electronAPI() { return reads++ === 0 ? bridge : undefined; } });
    expect(await runMpcCalibrationInitialAdmission(input)).toEqual({ kind: "no-remote", target: "linked-electron" });
    expect(reads).toBe(1);
    expect(execute.mock.calls.map(([request]) => request.kind)).toEqual(["getSession", "getSession", "getSnapshot"]);
  });

  it("admits a preseeded unbound exact bootstrap through real C3", async () => {
    const { database, input, selected } = admissionSetup();
    const fixture = buildBootstrapPreferenceFixture();
    await database.mpcCalibrationDatasets.put(fixture.dataset);
    await database.mpcCalibrationCases.bulkPut(fixture.cases);
    expect(await database.mpcCalibrationCases.count()).toBeGreaterThan(0);
    expect(await database.mpcCalibrationCacheBindings.count()).toBe(0);
    expect(await database.mpcCalibrationSyncStates.count()).toBe(0);
    selected.getSnapshot = async () => ({ revision: 1, snapshot: { version: 1, datasets: [], cases: [], assets: [], runs: [], preservedRoot: "authoritative" } });
    expect(await runMpcCalibrationInitialAdmission(input)).toEqual({ kind: "hydrated", target: "linked-web", revision: 1 });
    expect(await database.mpcCalibrationCases.count()).toBe(0);
    expect(await database.mpcCalibrationDatasets.count()).toBe(0);
    expect(await database.mpcCalibrationCacheBindings.get("mpc-calibration-cache-binding")).toMatchObject({ ownerId: "parent-owner", harnessId: "parent-harness", revision: 1 });
    expect(selected.publishSnapshot).not.toHaveBeenCalled();
  });

  it("does not discover an Electron bridge for an already cancelled operation", async () => {
    const { input } = admissionSetup("linked-electron");
    input.operation.dispose();
    const getter = vi.fn(() => { throw new Error("cancelled operation must not discover bridge"); });
    vi.stubGlobal("window", { get electronAPI() { return getter(); } });
    expect(await runMpcCalibrationInitialAdmission(input)).toEqual({ kind: "cancelled", target: "linked-electron" });
    expect(getter).not.toHaveBeenCalled();
  });

  it("captures the default bridge execute method once with its receiver", async () => {
    const { input } = admissionSetup("linked-electron");
    const value = { ownerId: "parent-owner", harnessId: "parent-harness" };
    const execute = vi.fn(async function(this: { marker: string }, request: { kind: string }) {
      expect(this.marker).toBe("original-bridge");
      return request.kind === "getSession" ? { ok: true, value } : { ok: false, error: { code: "http", status: 404 } };
    });
    const replacement = vi.fn(async (request: { kind: string }) => request.kind === "getSession" ? { ok: true, value } : { ok: false, error: { code: "http", status: 404 } });
    let reads = 0;
    const bridge = { marker: "original-bridge", get calibrationHarnessExecute() { return reads++ === 0 ? execute : replacement; } };
    vi.stubGlobal("window", { electronAPI: bridge });
    expect(await runMpcCalibrationInitialAdmission(input)).toEqual({ kind: "no-remote", target: "linked-electron" });
    expect(reads).toBe(1);
    expect(execute).toHaveBeenCalledTimes(3);
    expect(replacement).not.toHaveBeenCalled();
  });

  it("does not admit truthy non-boolean currentness", async () => {
    const { input, factory } = admissionSetup();
    const operation = { ...input.operation, isCurrent: () => "not-a-currentness-proof" as never };
    expect(await runMpcCalibrationInitialAdmission({ ...input, operation })).toEqual({ kind: "cancelled", target: "linked-web" });
    expect(factory).not.toHaveBeenCalled();
  });

  it("waits for real authenticated restoration before invoking C3 and reports no remote without publishing", async () => {
    const database = freshDatabase();
    let releaseSession!: (value: { ownerId: string; harnessId: string }) => void;
    const session = new Promise<{ ownerId: string; harnessId: string }>(resolve => { releaseSession = resolve; });
    const getSession = vi.fn(async () => session);
    const getSnapshot = vi.fn(async () => null);
    const transport = controlledTransport(getSession, getSnapshot);
    const operation = {
      target: "linked-web" as const,
      identity: null,
      signal: new AbortController().signal,
      isCurrent: () => true,
    };
    const input = {
      database,
      target: "linked-web" as const,
      operation,
      createWebTransport: vi.fn(() => transport),
    };

    const pending = runMpcCalibrationInitialAdmission(input);
    await Promise.resolve();
    expect(getSession).toHaveBeenCalledOnce();
    expect(getSnapshot).not.toHaveBeenCalled();

    releaseSession({ ownerId: "owner-a", harnessId: "harness-a" });

    await expect(pending).resolves.toEqual({ kind: "no-remote", target: "linked-web" });
    expect(getSession).toHaveBeenCalledTimes(2);
    expect(getSnapshot).toHaveBeenCalledOnce();
    expect(await database.mpcCalibrationLinkStates.get(["owner-a", "harness-a"])).toMatchObject({
      ownerId: "owner-a",
      harnessId: "harness-a",
      connectionId: expect.any(String),
    });
    expect(transport.publishSnapshot).not.toHaveBeenCalled();
    expect(transport.pair).not.toHaveBeenCalled();
    expect(transport.unpair).not.toHaveBeenCalled();
  });

  it("surfaces a foreign physical binding as blocked before C3 and retains its canonical bytes", async () => {
    const database = freshDatabase();
    const foreignBinding = {
      id: "mpc-calibration-cache-binding" as const,
      ownerId: "foreign-owner",
      harnessId: "foreign-harness",
      connectionId: "foreign-connection",
      revision: 7,
      updatedAt: 11,
    };
    await database.mpcCalibrationCacheBindings.put(foreignBinding);
    const getSnapshot = vi.fn(async () => null);
    const transport = controlledTransport(async () => ({ ownerId: "owner-a", harnessId: "harness-a" }), getSnapshot);
    const operation = {
      target: "linked-web" as const,
      identity: null,
      signal: new AbortController().signal,
      isCurrent: () => true,
    };

    await expect(runMpcCalibrationInitialAdmission({
      database,
      target: "linked-web",
      operation,
      createWebTransport: () => transport,
    })).resolves.toEqual({ kind: "blocked", target: "linked-web", reason: "foreign-physical-binding" });

    expect(getSnapshot).not.toHaveBeenCalled();
    expect(await database.mpcCalibrationCacheBindings.get("mpc-calibration-cache-binding")).toEqual(foreignBinding);
    expect(await database.mpcCalibrationSyncStates.count()).toBe(0);
  });

  it("hydrates an authoritative empty remote revision through C3 after restoration", async () => {
    const database = freshDatabase();
    const getSession = vi.fn(async () => ({ ownerId: "owner-a", harnessId: "harness-a" }));
    const transport = controlledTransport(getSession, async () => ({
      revision: 1,
      snapshot: { version: 1, datasets: [], cases: [], assets: [], runs: [], retainedRoot: { empty: true } },
    }));
    const operation = {
      target: "linked-web" as const,
      identity: null,
      signal: new AbortController().signal,
      isCurrent: () => true,
    };

    await expect(runMpcCalibrationInitialAdmission({
      database,
      target: "linked-web",
      operation,
      createWebTransport: () => transport,
      now: () => 7,
    })).resolves.toEqual({ kind: "hydrated", target: "linked-web", revision: 1 });

    expect(getSession).toHaveBeenCalledTimes(3);
    expect(await database.mpcCalibrationCacheBindings.get("mpc-calibration-cache-binding")).toMatchObject({
      ownerId: "owner-a", harnessId: "harness-a", revision: 1, updatedAt: 7,
    });
    expect(await database.mpcCalibrationSyncStates.count()).toBe(1);
    expect(transport.publishSnapshot).not.toHaveBeenCalled();
    expect(transport.pair).not.toHaveBeenCalled();
    expect(transport.unpair).not.toHaveBeenCalled();
  });

  it("retains a manual unbased cache and surfaces reconciliation without a remote snapshot request", async () => {
    const database = freshDatabase();
    const manual = { id: "manual", name: "Manual", targetCaseCount: 0, createdAt: 1, updatedAt: 1, version: 1, retained: { manual: true } };
    await database.mpcCalibrationDatasets.add(manual);
    const getSnapshot = vi.fn(async () => null);
    const transport = controlledTransport(async () => ({ ownerId: "owner-a", harnessId: "harness-a" }), getSnapshot);
    const operation = {
      target: "linked-web" as const,
      identity: null,
      signal: new AbortController().signal,
      isCurrent: () => true,
    };

    await expect(runMpcCalibrationInitialAdmission({
      database,
      target: "linked-web",
      operation,
      createWebTransport: () => transport,
    })).resolves.toEqual({ kind: "needs-reconciliation", target: "linked-web", reason: "unbased-or-dirty-local-harness" });

    expect(getSnapshot).not.toHaveBeenCalled();
    expect(await database.mpcCalibrationDatasets.get("manual")).toEqual(manual);
    expect(await database.mpcCalibrationSyncStates.count()).toBe(0);
    expect(await database.mpcCalibrationCacheBindings.count()).toBe(0);
    expect(await database.mpcCalibrationLinkStates.count()).toBe(1);
  });

  it("retains dirty base queue and binding bytes without requesting a remote snapshot", async () => {
    const database = freshDatabase();
    const remote = bootstrapSnapshot();
    const first = controlledTransport(async () => ({ ownerId: "owner-a", harnessId: "harness-a" }), async () => ({
      revision: 1,
      snapshot: validateCalibrationHarnessSnapshot(remote),
    }));
    const firstOperation = {
      target: "linked-web" as const,
      identity: null,
      signal: new AbortController().signal,
      isCurrent: () => true,
    };
    await expect(runMpcCalibrationInitialAdmission({
      database, target: "linked-web", operation: firstOperation, createWebTransport: () => first, now: () => 7,
    })).resolves.toMatchObject({ kind: "hydrated" });
    const key: [string, string, string] = ["owner-a", "harness-a", (await database.mpcCalibrationLinkStates.get(["owner-a", "harness-a"]))!.connectionId];
    const clean = (await database.mpcCalibrationSyncStates.get(key))!;
    await database.mpcCalibrationSyncStates.put({
      ...clean,
      dirtyGeneration: clean.dirtyGeneration + 1,
      queued: { generation: clean.dirtyGeneration + 1, snapshot: clean.base!.snapshot },
    });
    const beforeState = await database.mpcCalibrationSyncStates.get(key);
    const beforeBinding = await database.mpcCalibrationCacheBindings.get("mpc-calibration-cache-binding");
    const beforeCanonical = await Promise.all([
      database.mpcCalibrationDatasets.toArray(), database.mpcCalibrationCases.toArray(),
      database.mpcCalibrationAssets.toArray(), database.mpcCalibrationRuns.toArray(),
    ]);
    const getSnapshot = vi.fn(async () => null);
    const second = controlledTransport(async () => ({ ownerId: "owner-a", harnessId: "harness-a" }), getSnapshot);
    const secondOperation = { ...firstOperation, signal: new AbortController().signal };

    await expect(runMpcCalibrationInitialAdmission({
      database, target: "linked-web", operation: secondOperation, createWebTransport: () => second,
    })).resolves.toEqual({ kind: "needs-reconciliation", target: "linked-web", reason: "unbased-local-sync-state-is-not-clean" });

    expect(getSnapshot).not.toHaveBeenCalled();
    expect(await database.mpcCalibrationSyncStates.get(key)).toEqual(beforeState);
    expect(await database.mpcCalibrationCacheBindings.get("mpc-calibration-cache-binding")).toEqual(beforeBinding);
    await expect(Promise.all([
      database.mpcCalibrationDatasets.toArray(), database.mpcCalibrationCases.toArray(),
      database.mpcCalibrationAssets.toArray(), database.mpcCalibrationRuns.toArray(),
    ])).resolves.toEqual(beforeCanonical);
  });

  it("uses the originally captured transport, database, target, and operation fence after deferred restoration", async () => {
    const database = freshDatabase();
    const replacementDatabase = freshDatabase();
    let releaseSession!: (value: { ownerId: string; harnessId: string }) => void;
    const session = new Promise<{ ownerId: string; harnessId: string }>(resolve => { releaseSession = resolve; });
    const firstSnapshot = vi.fn(async () => null);
    const first = controlledTransport(async () => session, firstSnapshot);
    const secondSnapshot = vi.fn(async () => null);
    const second = controlledTransport(async () => ({ ownerId: "owner-b", harnessId: "harness-b" }), secondSnapshot);
    const operation = {
      target: "linked-web" as const,
      identity: null,
      signal: new AbortController().signal,
      current: true,
      isCurrent(this: { current: boolean }) { return this.current; },
    };
    const input = {
      database,
      target: "linked-web" as const,
      operation,
      createWebTransport: () => first,
    };
    const pending = runMpcCalibrationInitialAdmission(input);
    await Promise.resolve();
    (input as { database: ProxxiedDexie }).database = replacementDatabase;
    (input as { target: "linked-web" | "local" }).target = "local";
    (input as { createWebTransport: () => MpcCalibrationTransport }).createWebTransport = () => second;
    first.getSnapshot = async () => { throw new Error("mutated transport must not be selected"); };
    releaseSession({ ownerId: "owner-a", harnessId: "harness-a" });

    await expect(pending).resolves.toEqual({ kind: "no-remote", target: "linked-web" });
    expect(firstSnapshot).toHaveBeenCalledOnce();
    expect(secondSnapshot).not.toHaveBeenCalled();
    expect(await database.mpcCalibrationLinkStates.count()).toBe(1);
    expect(await replacementDatabase.mpcCalibrationLinkStates.count()).toBe(0);
  });

  it("blocks an authenticated identity replacement while the captured operation remains current", async () => {
    const database = freshDatabase();
    const getSnapshot = vi.fn(async () => null);
    const transport = controlledTransport(async () => ({ ownerId: "owner-a", harnessId: "harness-a" }), getSnapshot);
    const operation = {
      target: "linked-web" as const,
      identity: { ownerId: "expected-owner", harnessId: "expected-harness", connectionId: "expected-connection" },
      signal: new AbortController().signal,
      isCurrent: () => true,
    };

    await expect(runMpcCalibrationInitialAdmission({
      database,
      target: "linked-web",
      operation,
      createWebTransport: () => transport,
    })).resolves.toEqual({ kind: "blocked", target: "linked-web", reason: "identity-changed" });

    expect(getSnapshot).not.toHaveBeenCalled();
    expect(await database.mpcCalibrationLinkStates.get(["owner-a", "harness-a"])).toMatchObject({
      ownerId: "owner-a", harnessId: "harness-a",
    });
    expect(await database.mpcCalibrationSyncStates.count()).toBe(0);
    expect(await database.mpcCalibrationCacheBindings.count()).toBe(0);
  });

  it("cancels a pre-aborted linked operation before transport selection or C3", async () => {
    const database = freshDatabase();
    const controller = new AbortController();
    controller.abort();
    const factory = vi.fn();
    const operation = {
      target: "linked-web" as const,
      identity: null,
      signal: controller.signal,
      isCurrent: () => true,
    };

    await expect(runMpcCalibrationInitialAdmission({
      database,
      target: "linked-web",
      operation,
      createWebTransport: factory,
    })).resolves.toEqual({ kind: "cancelled", target: "linked-web" });

    expect(factory).not.toHaveBeenCalled();
    expect(await database.mpcCalibrationLinkStates.count()).toBe(0);
    expect(await database.mpcCalibrationSyncStates.count()).toBe(0);
  });

  it.each(["signal", "current"] as const)("passes its original deferred %s fence into C3 transaction protection", async fence => {
    const database = freshDatabase();
    const controller = new AbortController();
    const owner = createMpcCalibrationOperationScope({ target: "linked-web", identity: null });
    owners.push(owner);
    const operation = {
      ...owner.captureAppOperation(),
      // Separate the signal from the owner's epoch to prove each C3 fence independently.
      signal: controller.signal,
    };
    const transport = controlledTransport(
      async () => ({ ownerId: "owner-a", harnessId: "harness-a" }),
      async () => ({ revision: 1, snapshot: deferredSnapshot() }),
    );
    transport.getBlob = async hash => {
      if (hash !== deferredAssetHash) throw new Error("unexpected deferred asset");
      return deferredAssetBytes.slice();
    };
    await expect(runMpcCalibrationInitialAdmission({ database, target: "linked-web", operation, createWebTransport: () => transport, now: () => 1 })).resolves.toEqual({ kind: "hydrated", target: "linked-web", revision: 1 });
    const readPreserved = async () => {
      const assets = [];
      for (const row of await database.mpcCalibrationAssets.toArray()) {
        const { blob, ...metadata } = row;
        assets.push({ metadata, size: blob.size, mime: blob.type, bytes: Array.from(new Uint8Array(await blob.arrayBuffer())) });
      }
      return { assets, rows: await Promise.all([
        database.mpcCalibrationDatasets.toArray(), database.mpcCalibrationCases.toArray(), database.mpcCalibrationRuns.toArray(),
        database.mpcCalibrationSyncStates.toArray(), database.mpcCalibrationCacheBindings.toArray(), database.mpcCalibrationLinkStates.toArray(),
      ]) };
    };
    const before = await readPreserved();
    expect(before.assets).toHaveLength(1);
    expect(before.rows.every(rows => rows.length > 0)).toBe(true);
    const nextSnapshot = deferredSnapshot();
    nextSnapshot.cases[0]!.notes = "must roll back";
    transport.getSnapshot = async () => ({ revision: 2, snapshot: nextSnapshot });
    const originalPut = database.mpcCalibrationCacheBindings.put.bind(database.mpcCalibrationCacheBindings);
    let completedWrites = 0;
    const bindingPut = vi.spyOn(database.mpcCalibrationCacheBindings, "put").mockImplementation((async (...args: unknown[]) => {
      const key = await Reflect.apply(originalPut, database.mpcCalibrationCacheBindings, args);
      completedWrites += 1;
      if (fence === "signal") controller.abort();
      else owner.replaceAuthentication({ replaced: true });
      return key;
    }) as typeof originalPut);

    await expect(runMpcCalibrationInitialAdmission({
      database,
      target: "linked-web",
      operation,
      createWebTransport: () => transport,
      now: () => 7,
    })).resolves.toEqual({ kind: "cancelled", target: "linked-web" });

    expect(completedWrites).toBe(1);
    expect(bindingPut).toHaveBeenCalledOnce();
    expect(bindingPut).toHaveBeenCalledWith(expect.objectContaining({ revision: 2 }));
    await expect(readPreserved()).resolves.toEqual(before);
  });

  it("hands the restored non-secret identity to an app owner once before hydration settles", async () => {
    const { input, getSession } = admissionSetup();
    const identities: unknown[] = [];

    await expect(runMpcCalibrationInitialAdmissionWithIdentity({
      ...input,
      onAuthenticated: (identity) => identities.push(identity),
    })).resolves.toEqual({
      kind: "no-remote",
      target: "linked-web",
      identity: expect.objectContaining({ ownerId: "parent-owner", harnessId: "parent-harness" }),
    });

    expect(identities).toEqual([
      expect.objectContaining({ ownerId: "parent-owner", harnessId: "parent-harness" }),
    ]);
    // One restoration session plus C3's independent server-identity recheck.
    expect(getSession).toHaveBeenCalledTimes(2);
  });

  it("hands the one restored identity to queue-aware blocked admission without running C3", async () => {
    const database = freshDatabase();
    const getSession = vi.fn(async () => ({ ownerId: "owner-a", harnessId: "harness-a" }));
    const getSnapshot = vi.fn(async () => null);
    const transport = controlledTransport(getSession, getSnapshot);
    const operation = {
      target: "linked-web" as const,
      identity: { ownerId: "prior-owner", harnessId: "prior-harness", connectionId: "prior-connection" },
      signal: new AbortController().signal,
      isCurrent: () => true,
    };

    await expect(runMpcCalibrationInitialAdmissionWithIdentity({
      database,
      target: "linked-web",
      operation,
      createWebTransport: () => transport,
    })).resolves.toEqual({
      kind: "blocked",
      target: "linked-web",
      reason: "identity-changed",
      identity: expect.objectContaining({ ownerId: "owner-a", harnessId: "harness-a" }),
    });

    expect(getSession).toHaveBeenCalledOnce();
    expect(getSnapshot).not.toHaveBeenCalled();
  });

  it("hands the restored identity to queue-aware reconciliation without requesting C3", async () => {
    const database = freshDatabase();
    await database.mpcCalibrationDatasets.add({
      id: "manual",
      name: "Manual",
      targetCaseCount: 0,
      createdAt: 1,
      updatedAt: 1,
      version: 1,
    });
    const getSnapshot = vi.fn(async () => null);
    const transport = controlledTransport(async () => ({ ownerId: "owner-a", harnessId: "harness-a" }), getSnapshot);
    const operation = {
      target: "linked-web" as const,
      identity: null,
      signal: new AbortController().signal,
      isCurrent: () => true,
    };

    await expect(runMpcCalibrationInitialAdmissionWithIdentity({
      database,
      target: "linked-web",
      operation,
      createWebTransport: () => transport,
    })).resolves.toEqual({
      kind: "needs-reconciliation",
      target: "linked-web",
      reason: "unbased-or-dirty-local-harness",
      identity: expect.objectContaining({ ownerId: "owner-a", harnessId: "harness-a" }),
    });

    expect(getSnapshot).not.toHaveBeenCalled();
  });

  it("reports an allowlisted restoration status only on the with-identity failed result", async () => {
    const { input, factory } = admissionSetup();
    const transport = controlledTransport(
      async () => { throw new MpcCalibrationTransportError("offline"); },
      async () => null,
    );
    factory.mockReturnValue(transport);

    await expect(runMpcCalibrationInitialAdmission(input)).resolves.toEqual({
      kind: "failed",
      target: "linked-web",
      code: "unavailable",
    });
    await expect(runMpcCalibrationInitialAdmissionWithIdentity(input)).resolves.toEqual({
      kind: "failed",
      target: "linked-web",
      code: "unavailable",
      restorationStatus: "offline",
    });
  });

  it("with-identity local admission leaves its dormant callback unread", async () => {
    const { input, database } = admissionSetup("local");
    const getter = vi.fn(() => { throw new Error("local admission must not read dormant callback"); });
    Object.defineProperty(input, "onAuthenticated", { get: getter });

    await expect(runMpcCalibrationInitialAdmissionWithIdentity(input)).resolves.toEqual({ kind: "local", target: "local" });

    expect(getter).not.toHaveBeenCalled();
    expect(await database.mpcCalibrationLinkStates.count()).toBe(0);
  });

  it("with-identity pre-abort leaves its dormant callback unread", async () => {
    const { input, database, factory } = admissionSetup();
    input.operation.dispose();
    const getter = vi.fn(() => { throw new Error("pre-abort must not read dormant callback"); });
    Object.defineProperty(input, "onAuthenticated", { get: getter });

    await expect(runMpcCalibrationInitialAdmissionWithIdentity(input)).resolves.toEqual({ kind: "cancelled", target: "linked-web" });

    expect(getter).not.toHaveBeenCalled();
    expect(factory).not.toHaveBeenCalled();
    expect(await database.mpcCalibrationLinkStates.count()).toBe(0);
  });

  it("captures the app callback once with its receiver and fences callback cancellation before C3", async () => {
    const { input, getSnapshot } = admissionSetup();
    const controller = new AbortController();
    const operation = { ...input.operation, signal: controller.signal };
    const replacement = vi.fn();
    const callback = vi.fn(function(this: typeof input) {
      expect(this).toBe(input);
      controller.abort();
    });
    let reads = 0;
    Object.defineProperty(input, "onAuthenticated", {
      get() { return reads++ === 0 ? callback : replacement; },
    });

    input.operation = operation;
    await expect(runMpcCalibrationInitialAdmissionWithIdentity(input)).resolves.toEqual({
      kind: "cancelled",
      target: "linked-web",
    });

    expect(reads).toBe(1);
    expect(callback).toHaveBeenCalledOnce();
    expect(replacement).not.toHaveBeenCalled();
    expect(getSnapshot).not.toHaveBeenCalled();
  });
});
