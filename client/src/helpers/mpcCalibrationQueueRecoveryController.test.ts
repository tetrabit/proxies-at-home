import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Blob as NativeBlob } from "node:buffer";
import { ProxxiedDexie } from "@/db";
import type { CalibrationHarnessRevision, CalibrationHarnessSnapshot } from "../../../shared/calibrationHarness";
import { createMpcCalibrationOperationScope } from "./mpcCalibrationOperationScope";
import { createMpcCalibrationQueueRecoveryController } from "./mpcCalibrationQueueRecoveryController";
import { createMpcCalibrationSyncStateStore } from "./mpcCalibrationSyncState";
import type { MpcCalibrationTransport } from "./mpcCalibrationTransport";

const identity = { ownerId: "owner", harnessId: "harness", connectionId: "connection" };

const databases: ProxxiedDexie[] = [];
const owners: ReturnType<typeof createMpcCalibrationOperationScope>[] = [];

globalThis.Blob = NativeBlob as unknown as typeof Blob;

type Deferred<T> = Readonly<{
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}>;

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function snapshot(tag: string): CalibrationHarnessSnapshot {
  return {
    version: 1,
    retained: { tag },
    datasets: [{ id: "dataset", name: tag, targetCaseCount: 1, createdAt: 1, updatedAt: 1, version: 1 }],
    cases: [{ id: "case", datasetId: "dataset", createdAt: 1, updatedAt: 1, source: { name: tag }, candidates: [] }],
    assets: [],
    runs: [],
  };
}

function fresh(): ProxxiedDexie {
  const database = new ProxxiedDexie(`queue-recovery-controller-${crypto.randomUUID()}`);
  databases.push(database);
  return database;
}

async function expectPhysicalSettlement(
  controller: ReturnType<typeof createMpcCalibrationQueueRecoveryController>
): Promise<void> {
  await vi.waitFor(() => expect(controller.isRunning()).toBe(false), { interval: 1, timeout: 1_000 });
}

async function seedBoundBase(database: ProxxiedDexie, base = snapshot("base")) {
  const state = createMpcCalibrationSyncStateStore(database, { now: () => 10 });
  await state.storeBaseWhenClean(identity, { revision: 1, snapshot: base });
  await database.mpcCalibrationCacheBindings.put({
    id: "mpc-calibration-cache-binding",
    ...identity,
    revision: 1,
    updatedAt: 1,
  });
  return state;
}

function queuedTransport(
  initial: CalibrationHarnessRevision,
  publications: Deferred<CalibrationHarnessRevision>[],
  started: Deferred<CalibrationHarnessSnapshot>[]
): MpcCalibrationTransport {
  let remote = structuredClone(initial);
  let index = 0;
  return {
    pair: async () => ({ ownerId: identity.ownerId, harnessId: identity.harnessId }),
    unpair: async () => undefined,
    getSession: async () => ({ ownerId: identity.ownerId, harnessId: identity.harnessId }),
    getSnapshot: async () => structuredClone(remote),
    getBlob: async () => new Uint8Array(),
    missingBlobs: async () => ({ missing: [] }),
    putBlob: async () => ({ sha256: "unused", byteLength: 0, inserted: false }),
    publishSnapshot: vi.fn((next: CalibrationHarnessSnapshot, expectedRevision: number | null) => {
      expect(expectedRevision).toBe(remote.revision);
      const slot = index++;
      started[slot]?.resolve(structuredClone(next));
      return publications[slot]!.promise.then(result => {
        remote = structuredClone(result);
        return result;
      });
    }),
  };
}

afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
  for (const database of databases.splice(0)) database.close();
  vi.restoreAllMocks();
});

describe("createMpcCalibrationQueueRecoveryController", () => {
  it("observes repeated actual C1 queue writes and coalesces them into one C5 publication of the newest generation", async () => {
    const database = fresh();
    const state = await seedBoundBase(database);
    const owner = createMpcCalibrationOperationScope({ target: "linked-web", identity });
    owners.push(owner);
    const published = deferred<CalibrationHarnessRevision>();
    const publishStarted = deferred<CalibrationHarnessSnapshot>();
    const transport = queuedTransport({ revision: 1, snapshot: snapshot("base") }, [published], [publishStarted]);
    const controller = createMpcCalibrationQueueRecoveryController({
      database,
      operation: owner.captureAppOperation(),
      transport,
    });

    await state.queueSnapshot(identity, snapshot("G1"));
    await state.queueSnapshot(identity, snapshot("G2"));
    const newest = await state.queueSnapshot(identity, snapshot("G3"));

    await expect(publishStarted.promise).resolves.toEqual(snapshot("G3"));
    expect(transport.publishSnapshot).toHaveBeenCalledOnce();
    expect(controller.isRunning()).toBe(true);
    expect(newest.queued).toMatchObject({ generation: 3, snapshot: snapshot("G3") });

    published.resolve({ revision: 2, snapshot: snapshot("G3") });
    await expectPhysicalSettlement(controller);

    expect(await state.load(identity)).toMatchObject({
      base: { revision: 2, snapshot: snapshot("G3") },
      queued: null,
      inFlight: null,
      acknowledgedGeneration: 3,
    });
    controller.dispose();
    const afterDispose = await state.queueSnapshot(identity, snapshot("G4"));
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    expect(afterDispose.queued).toMatchObject({ generation: 4, snapshot: snapshot("G4") });
    expect(transport.publishSnapshot).toHaveBeenCalledOnce();
  });

  it("retains queued G2 while physically pending G1 settles, then dispatches exactly one G2 C5 publication", async () => {
    const database = fresh();
    const state = await seedBoundBase(database);
    const owner = createMpcCalibrationOperationScope({ target: "linked-web", identity });
    owners.push(owner);
    const firstPublication = deferred<CalibrationHarnessRevision>();
    const secondPublication = deferred<CalibrationHarnessRevision>();
    const firstStarted = deferred<CalibrationHarnessSnapshot>();
    const secondStarted = deferred<CalibrationHarnessSnapshot>();
    const transport = queuedTransport(
      { revision: 1, snapshot: snapshot("base") },
      [firstPublication, secondPublication],
      [firstStarted, secondStarted]
    );
    const controller = createMpcCalibrationQueueRecoveryController({
      database,
      operation: owner.captureAppOperation(),
      transport,
    });

    await state.queueSnapshot(identity, snapshot("G1"));
    await expect(firstStarted.promise).resolves.toEqual(snapshot("G1"));
    await state.queueSnapshot(identity, snapshot("G2"));
    expect(await state.load(identity)).toMatchObject({
      inFlight: { generation: 1, snapshot: snapshot("G1") },
      queued: { generation: 2, snapshot: snapshot("G2") },
      acknowledgedGeneration: 0,
    });

    firstPublication.resolve({ revision: 2, snapshot: snapshot("G1") });
    await expect(secondStarted.promise).resolves.toEqual(snapshot("G2"));
    expect(await state.load(identity)).toMatchObject({
      base: { revision: 2, snapshot: snapshot("G1") },
      inFlight: { generation: 2, snapshot: snapshot("G2") },
      queued: { generation: 2, snapshot: snapshot("G2") },
      acknowledgedGeneration: 1,
    });
    expect(transport.publishSnapshot).toHaveBeenCalledTimes(2);

    secondPublication.resolve({ revision: 3, snapshot: snapshot("G2") });
    await expectPhysicalSettlement(controller);

    expect(await state.load(identity)).toMatchObject({
      base: { revision: 3, snapshot: snapshot("G2") },
      queued: null,
      inFlight: null,
      acknowledgedGeneration: 2,
    });
    controller.dispose();
  });

  it("fences future callbacks after operation cancellation while preserving the physically pending C5 publication and C1 evidence", async () => {
    const database = fresh();
    const state = await seedBoundBase(database);
    const owner = createMpcCalibrationOperationScope({ target: "linked-web", identity });
    owners.push(owner);
    const publication = deferred<CalibrationHarnessRevision>();
    const started = deferred<CalibrationHarnessSnapshot>();
    const results = vi.fn();
    const transport = queuedTransport({ revision: 1, snapshot: snapshot("base") }, [publication], [started]);
    const controller = createMpcCalibrationQueueRecoveryController({
      database,
      operation: owner.captureAppOperation(),
      transport,
      onResult: results,
    });

    await state.queueSnapshot(identity, snapshot("G1"));
    await expect(started.promise).resolves.toEqual(snapshot("G1"));
    owner.replaceAuthentication({ replacement: true });
    expect(controller.isRunning()).toBe(true);
    expect(await state.load(identity)).toMatchObject({
      queued: { generation: 1, snapshot: snapshot("G1") },
      inFlight: { generation: 1, snapshot: snapshot("G1") },
      acknowledgedGeneration: 0,
    });

    publication.resolve({ revision: 2, snapshot: snapshot("G1") });
    await expectPhysicalSettlement(controller);

    expect(await state.load(identity)).toMatchObject({
      queued: { generation: 1, snapshot: snapshot("G1") },
      inFlight: { generation: 1, snapshot: snapshot("G1") },
      acknowledgedGeneration: 0,
    });
    expect(results).not.toHaveBeenCalled();
    controller.dispose();
  });

  it("publishes a bounded C5 conflict result from the real durable queue and preserves both queued and remote inputs", async () => {
    const database = fresh();
    const state = await seedBoundBase(database);
    const owner = createMpcCalibrationOperationScope({ target: "linked-web", identity });
    owners.push(owner);
    const local = snapshot("local-conflict");
    const remote = snapshot("remote-conflict");
    const results = vi.fn();
    const transport: MpcCalibrationTransport = {
      pair: async () => ({ ownerId: identity.ownerId, harnessId: identity.harnessId }),
      unpair: async () => undefined,
      getSession: async () => ({ ownerId: identity.ownerId, harnessId: identity.harnessId }),
      getSnapshot: async () => ({ revision: 2, snapshot: remote }),
      getBlob: async () => new Uint8Array(),
      missingBlobs: async () => ({ missing: [] }),
      putBlob: async () => ({ sha256: "unused", byteLength: 0, inserted: false }),
      publishSnapshot: vi.fn(async () => ({ revision: 3, snapshot: local })),
    };
    const controller = createMpcCalibrationQueueRecoveryController({
      database,
      operation: owner.captureAppOperation(),
      transport,
      onResult: results,
    });

    await state.queueSnapshot(identity, local);

    await vi.waitFor(() => expect(results).toHaveBeenCalledOnce());
    expect(results).toHaveBeenCalledWith({ kind: "recovery", target: "linked-web", status: "conflict" });
    expect(transport.publishSnapshot).not.toHaveBeenCalled();
    expect(await state.load(identity)).toMatchObject({
      queued: { generation: 1, snapshot: local },
      base: { revision: 1, snapshot: snapshot("base") },
    });
    controller.dispose();
  });

  it("does not publish a C5 result after controller disposal although the physical request settles", async () => {
    const database = fresh();
    const state = await seedBoundBase(database);
    const owner = createMpcCalibrationOperationScope({ target: "linked-web", identity });
    owners.push(owner);
    const publication = deferred<CalibrationHarnessRevision>();
    const started = deferred<CalibrationHarnessSnapshot>();
    const results = vi.fn();
    const transport = queuedTransport({ revision: 1, snapshot: snapshot("base") }, [publication], [started]);
    const controller = createMpcCalibrationQueueRecoveryController({
      database,
      operation: owner.captureAppOperation(),
      transport,
      onResult: results,
    });

    await state.queueSnapshot(identity, snapshot("G1"));
    await started.promise;
    controller.dispose();
    publication.resolve({ revision: 2, snapshot: snapshot("G1") });
    await expectPhysicalSettlement(controller);

    expect(results).not.toHaveBeenCalled();
    // Disposal fences publication, not the already admitted physical C5 request.
    expect(await state.load(identity)).toMatchObject({ acknowledgedGeneration: 1, queued: null });
  });
});
