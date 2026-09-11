import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProxxiedDexie } from "@/db";
import { createMpcCalibrationSyncStateStore } from "./mpcCalibrationSyncState";
import { recoverAndFlushMpcCalibration } from "./mpcCalibrationRecovery";
import { MpcCalibrationTransportError, type MpcCalibrationTransport } from "./mpcCalibrationTransport";
import type { CalibrationHarnessSnapshot } from "../../../shared/calibrationHarness";

const identity = { ownerId: "owner", harnessId: "harness", connectionId: "connection" };
const assetBytes = new Uint8Array([1, 2, 3, 4]);
const assetHash = "9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a";
const handles: ProxxiedDexie[] = [];

function fresh(): ProxxiedDexie {
  const database = new ProxxiedDexie(`recovery-${crypto.randomUUID()}`);
  handles.push(database);
  return database;
}

function snapshot(tag: string): CalibrationHarnessSnapshot {
  return {
    version: 1,
    retained: { tag, order: ["first", "second"] },
    datasets: [{ id: "dataset", name: "Dataset", targetCaseCount: 2, createdAt: 1, updatedAt: 1, version: 1 }],
    cases: ["a", "b"].map(id => ({ id, datasetId: "dataset", createdAt: 1, updatedAt: 1, source: { name: id }, candidates: [] })),
    assets: [],
    runs: [],
  };
}

async function seeded() {
  const database = fresh();
  const base = snapshot("base");
  const local = structuredClone(base);
  local.cases[0]!.notes = "local A";
  local.datasets[0]!.updatedAt = 2;
  const state = createMpcCalibrationSyncStateStore(database, { now: () => 10 });
  await state.storeBaseWhenClean(identity, { revision: 1, snapshot: base });
  await state.queueSnapshot(identity, local);
  await database.mpcCalibrationDatasets.bulkPut(local.datasets as never);
  await database.mpcCalibrationCases.bulkPut(local.cases as never);
  await database.mpcCalibrationCacheBindings.put({ id: "mpc-calibration-cache-binding", ...identity, revision: 1, updatedAt: 1 });
  return { database, state, base, local };
}

async function seededSnapshots(base: CalibrationHarnessSnapshot, local: CalibrationHarnessSnapshot) {
  const database = fresh();
  const state = createMpcCalibrationSyncStateStore(database, { now: () => 10 });
  await state.storeBaseWhenClean(identity, { revision: 1, snapshot: base });
  await state.queueSnapshot(identity, local);
  await database.mpcCalibrationDatasets.bulkPut(local.datasets as never);
  await database.mpcCalibrationCases.bulkPut(local.cases as never);
  await database.mpcCalibrationCacheBindings.put({ id: "mpc-calibration-cache-binding", ...identity, revision: 1, updatedAt: 1 });
  return { database, state };
}

function remote(initial: CalibrationHarnessSnapshot, initialRevision: number): MpcCalibrationTransport {
  let revision = initialRevision;
  let current = structuredClone(initial);
  return {
    pair: async () => ({ ownerId: identity.ownerId, harnessId: identity.harnessId }),
    unpair: async () => undefined,
    getSession: async () => ({ ownerId: identity.ownerId, harnessId: identity.harnessId }),
    getSnapshot: async () => ({ revision, snapshot: structuredClone(current) }),
    getBlob: async () => { throw new Error("no assets"); },
    missingBlobs: async () => ({ missing: [] }),
    putBlob: async () => { throw new Error("no assets"); },
    publishSnapshot: async (next, expected) => {
      if (expected !== revision) throw Object.assign(new Error("precondition"), { status: 412 });
      current = structuredClone(next);
      revision += 1;
      return { revision, snapshot: structuredClone(current) };
    },
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(next => { resolve = next; });
  return { promise, resolve };
}

async function queueNewerG2(database: ProxxiedDexie, state: ReturnType<typeof createMpcCalibrationSyncStateStore>, g1: CalibrationHarnessSnapshot) {
  const g2 = structuredClone(g1);
  g2.cases[1]!.notes = "local G2";
  await state.queueSnapshot(identity, g2);
  await database.mpcCalibrationCases.bulkPut(g2.cases as never);
  return g2;
}

async function seedLegacyInFlight(database: ProxxiedDexie, base: CalibrationHarnessSnapshot, local: CalibrationHarnessSnapshot) {
  await database.mpcCalibrationSyncStates.put({
    formatVersion: 1,
    ...identity,
    base: { revision: 1, snapshot: base },
    queued: { generation: 1, snapshot: local },
    inFlight: { generation: 1, snapshot: local, expectedBaseRevision: 1 },
    dirtyGeneration: 1,
    sentGeneration: 1,
    acknowledgedGeneration: 0,
    updatedAt: 1,
  } as never);
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const db of handles.splice(0)) db.close();
});

describe("recoverAndFlushMpcCalibration", () => {
  it("rebases and publishes an unsent queue against a disjoint advancing remote snapshot", async () => {
    const { database, state, base } = await seeded();
    const advanced = structuredClone(base);
    advanced.cases[1]!.notes = "remote B";
    advanced.datasets[0]!.updatedAt = 3;
    advanced.assets.push({ id: "remote-asset", datasetId: "dataset", caseId: "b", role: "source", mimeType: "image/png", createdAt: 3, hash: "legacy", sha256: assetHash, byteLength: assetBytes.byteLength });
    const transport = remote(advanced, 2);
    transport.getBlob = async hash => {
      expect(hash).toBe(assetHash);
      return assetBytes.slice();
    };

    await expect(recoverAndFlushMpcCalibration({ database, transport, identity, maxCycles: 4 })).resolves.toMatchObject({ status: "published", generation: 2, revision: 3 });
    expect((await transport.getSnapshot())!.snapshot.cases).toMatchObject([{ id: "a", notes: "local A" }, { id: "b", notes: "remote B" }]);
    expect(await database.mpcCalibrationCases.get("b")).toMatchObject({ notes: "remote B" });
    const stagedRemoteAsset = await database.mpcCalibrationAssets.get("remote-asset");
    expect(stagedRemoteAsset).toMatchObject({ sha256: assetHash, mimeType: "image/png", byteLength: 4 });
    expect(Array.from(new Uint8Array(await stagedRemoteAsset!.blob.arrayBuffer()))).toEqual([...assetBytes]);
    expect(await database.mpcCalibrationHydrationStaging.count()).toBe(0);
    expect(await state.load(identity)).toMatchObject({ formatVersion: 2, queued: null, inFlight: null, acknowledgedGeneration: 2, settledGeneration: 2 });
  });

  it("converts an actual persisted V1 inFlight row, settles only by observation, and leaves lastAcknowledgement empty", async () => {
    const { database, state, base, local } = await seeded();
    await seedLegacyInFlight(database, base, local);

    await expect(recoverAndFlushMpcCalibration({ database, transport: remote(local, 2), identity, maxCycles: 2 })).resolves.toEqual({ status: "no-queued" });
    expect(await state.load(identity)).toMatchObject({
      formatVersion: 2, base: { revision: 2, snapshot: local }, queued: null, inFlight: null,
      acknowledgedGeneration: 0, sentGeneration: 1, settledGeneration: 1, lastAcknowledgement: null,
      lastRecovery: { kind: "observed-current-inflight", settledGeneration: 1 },
    });
  });

  it("reopens an actual persisted V1 inFlight row before observed settlement without rewriting it on load", async () => {
    const { database, base, local } = await seeded();
    await seedLegacyInFlight(database, base, local);
    const name = database.name;
    database.close();
    const reopened = new ProxxiedDexie(name);
    handles.push(reopened);
    const reopenedState = createMpcCalibrationSyncStateStore(reopened, { now: () => 10 });
    const readonlyLegacy = await reopenedState.load(identity);
    expect(readonlyLegacy).toMatchObject({ formatVersion: 1, inFlight: { generation: 1 } });
    expect(Object.hasOwn(readonlyLegacy!, "lastAcknowledgement")).toBe(false);

    await expect(recoverAndFlushMpcCalibration({ database: reopened, transport: remote(local, 2), identity, maxCycles: 2 })).resolves.toEqual({ status: "no-queued" });
    expect(await reopenedState.load(identity)).toMatchObject({
      formatVersion: 2, base: { revision: 2, snapshot: local }, queued: null, inFlight: null,
      lastAcknowledgement: null, lastRecovery: { kind: "observed-current-inflight", settledGeneration: 1 },
    });
  });

  it("retires an ambiguous old attempt by observing the prior base, then publishes only a fresh CAS generation", async () => {
    const { database, state, base, local } = await seeded();
    await state.markSnapshotSent(identity, 1);

    await expect(recoverAndFlushMpcCalibration({ database, transport: remote(base, 1), identity, maxCycles: 2 })).resolves.toMatchObject({ status: "published", generation: 2, revision: 2 });
    const recovered = await state.load(identity);
    expect(recovered).toMatchObject({ acknowledgedGeneration: 2, settledGeneration: 2, queued: null, inFlight: null });
    expect(recovered!.lastAcknowledgement).toMatchObject({ generation: 2, snapshot: local });
    if (recovered?.formatVersion !== 2) throw new Error("expected a V2 recovery state");
    expect(recovered.lastRecovery).toMatchObject({ kind: "observed-current-base", settledGeneration: 1 });
  });

  it("does not let a late physical G1 reply acknowledge or clear a newer G2", async () => {
    const { database, state, base } = await seeded();
    let remoteRevision = 1;
    let remoteSnapshot = structuredClone(base);
    let enterG1!: () => void;
    let enterG2!: () => void;
    let releaseG1!: () => void;
    let releaseG2!: () => void;
    const g1Entered = new Promise<void>(resolve => { enterG1 = resolve; });
    const g2Entered = new Promise<void>(resolve => { enterG2 = resolve; });
    const g1Released = new Promise<void>(resolve => { releaseG1 = resolve; });
    const g2Released = new Promise<void>(resolve => { releaseG2 = resolve; });
    let putCount = 0;
    const transport = remote(base, 1);
    transport.getSnapshot = async () => ({ revision: remoteRevision, snapshot: structuredClone(remoteSnapshot) });
    transport.publishSnapshot = async (next, expected) => {
      putCount += 1;
      if (putCount === 1) { enterG1(); await g1Released; }
      else { enterG2(); await g2Released; }
      if (expected !== remoteRevision) throw new MpcCalibrationTransportError("http", 412);
      remoteRevision += 1;
      remoteSnapshot = structuredClone(next);
      return { revision: remoteRevision, snapshot: structuredClone(remoteSnapshot) };
    };

    const first = recoverAndFlushMpcCalibration({ database, transport, identity, maxCycles: 1 });
    await g1Entered;
    const second = recoverAndFlushMpcCalibration({ database, transport, identity, maxCycles: 2 });
    await g2Entered;
    expect((await state.load(identity))!.inFlight).toMatchObject({ generation: 2, expectedBaseRevision: 1 });
    releaseG1();
    await expect(first).resolves.not.toMatchObject({ status: "published", generation: 1 });
    releaseG2();
    await expect(second).resolves.toMatchObject({ status: "pending" });
    expect(await state.load(identity)).toMatchObject({ acknowledgedGeneration: 0, settledGeneration: 1, queued: { generation: 2 }, inFlight: { generation: 2 } });
    await expect(recoverAndFlushMpcCalibration({ database, transport, identity, maxCycles: 2 })).resolves.toEqual({ status: "no-queued" });
    expect(await state.load(identity)).toMatchObject({ acknowledgedGeneration: 0, settledGeneration: 2, queued: null, inFlight: null, lastAcknowledgement: null });
  });

  it("retains the originally supplied database and bound operation receiver across awaits", async () => {
    const { database, base } = await seeded();
    const replacement = fresh();
    const transport = remote(base, 1);
    let release!: () => void;
    let entered!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    const admitted = new Promise<void>(resolve => { entered = resolve; });
    let first = true;
    transport.getSession = async () => {
      if (first) { first = false; entered(); await wait; }
      return { ownerId: identity.ownerId, harnessId: identity.harnessId };
    };
    const operation = { marker: "current", isCurrent() { return this.marker === "current"; } };
    const input = { database, transport, identity, operation };
    const pending = recoverAndFlushMpcCalibration(input);
    await admitted;
    input.database = replacement;
    release();

    await expect(pending).resolves.toMatchObject({ status: "published" });
    expect(await replacement.mpcCalibrationSyncStates.count()).toBe(0);
  });

  it("reports a committed staging-cleanup failure with its revision and does not publish again", async () => {
    const { database, state, base } = await seeded();
    const advanced = structuredClone(base);
    advanced.cases[1]!.notes = "remote B";
    advanced.datasets[0]!.updatedAt = 3;
    advanced.assets.push({ id: "remote-asset", datasetId: "dataset", caseId: "b", role: "source", mimeType: "image/png", createdAt: 3, hash: "legacy", sha256: assetHash, byteLength: assetBytes.byteLength });
    const transport = remote(advanced, 2);
    transport.getBlob = async () => assetBytes.slice();
    const publish = vi.spyOn(transport, "publishSnapshot");
    vi.spyOn(database.mpcCalibrationHydrationStaging, "bulkDelete").mockRejectedValueOnce(new Error("owned cleanup failed"));

    await expect(recoverAndFlushMpcCalibration({ database, transport, identity, maxCycles: 4 })).resolves.toEqual({
      status: "pending", revision: 2, reason: "committed-staging-cleanup-failed",
    });
    expect(publish).not.toHaveBeenCalled();
    expect(await database.mpcCalibrationAssets.get("remote-asset")).toMatchObject({ sha256: assetHash, byteLength: assetBytes.byteLength });
    expect(await state.load(identity)).toMatchObject({ formatVersion: 2, base: { revision: 2 }, queued: { generation: 2 } });
  });

  it("reports cancellation after a committed producer result without publishing or claiming rollback", async () => {
    const { database, state, base } = await seeded();
    const advanced = structuredClone(base);
    advanced.cases[1]!.notes = "remote B";
    advanced.datasets[0]!.updatedAt = 3;
    advanced.assets.push({ id: "remote-asset", datasetId: "dataset", caseId: "b", role: "source", mimeType: "image/png", createdAt: 3, hash: "legacy", sha256: assetHash, byteLength: assetBytes.byteLength });
    const transport = remote(advanced, 2);
    transport.getBlob = async () => assetBytes.slice();
    const publish = vi.spyOn(transport, "publishSnapshot");
    let current = true;
    const originalBulkDelete = database.mpcCalibrationHydrationStaging.bulkDelete.bind(database.mpcCalibrationHydrationStaging);
    vi.spyOn(database.mpcCalibrationHydrationStaging, "bulkDelete").mockImplementation(ids => {
      const deleted = originalBulkDelete(ids);
      void deleted.then(() => { current = false; });
      return deleted;
    });

    await expect(recoverAndFlushMpcCalibration({
      database, transport, identity, maxCycles: 4, operation: { isCurrent: () => current },
    })).resolves.toEqual({ status: "cancelled", revision: 2, reason: "committed-operation-cancelled" });
    expect(publish).not.toHaveBeenCalled();
    expect(await database.mpcCalibrationAssets.get("remote-asset")).toMatchObject({ sha256: assetHash });
    expect(await state.load(identity)).toMatchObject({ formatVersion: 2, base: { revision: 2 }, queued: { generation: 2 } });
  });

  it.each(["release-old-first", "release-new-first"] as const)(
    "preserves a genuinely newer G2 through %s physical CAS ordering",
    async order => {
      const { database, state, base, local: g1 } = await seeded();
      let remoteRevision = 1;
      let remoteSnapshot = structuredClone(base);
      const entered = [deferred(), deferred()];
      const release = [deferred(), deferred()];
      const calls: Array<{ snapshot: CalibrationHarnessSnapshot; expected: number | null }> = [];
      const transport = remote(base, 1);
      transport.getSnapshot = async () => ({ revision: remoteRevision, snapshot: structuredClone(remoteSnapshot) });
      transport.publishSnapshot = async (next, expected) => {
        const index = calls.length;
        calls.push({ snapshot: structuredClone(next), expected });
        if (index < 2) {
          entered[index]!.resolve();
          await release[index]!.promise;
        }
        if (expected !== remoteRevision) throw new MpcCalibrationTransportError("http", 412);
        remoteRevision += 1;
        remoteSnapshot = structuredClone(next);
        return { revision: remoteRevision, snapshot: structuredClone(remoteSnapshot) };
      };

      const first = recoverAndFlushMpcCalibration({ database, transport, identity, maxCycles: 1 });
      await entered[0]!.promise;
      const g2 = await queueNewerG2(database, state, g1);
      const second = recoverAndFlushMpcCalibration({ database, transport, identity, maxCycles: 4 });
      await entered[1]!.promise;
      try {
        if (order === "release-old-first") {
          release[0]!.resolve();
          release[1]!.resolve();
        } else {
          release[1]!.resolve();
          release[0]!.resolve();
        }
        const [firstResult, secondResult] = await Promise.all([first, second]);
        expect(firstResult).not.toMatchObject({ status: "published", generation: 1 });
        expect(secondResult.status).toMatch(/published|pending|no-queued/);
        expect(calls).toHaveLength(order === "release-old-first" ? 3 : 2);
        expect(calls.slice(0, 2).map(call => call.expected)).toEqual([1, 1]);
        expect(calls[0]!.snapshot).toEqual(g1);
        expect(calls[1]!.snapshot).toEqual(g2);
        expect(remoteSnapshot).toEqual(g2);
        expect(await state.load(identity)).toMatchObject({ queued: null, inFlight: null });
      } finally {
        release[0]!.resolve();
        release[1]!.resolve();
        await Promise.allSettled([first, second]);
      }
    }
  );

  it.each(["same-record", "delete-edit", "immutable-run", "asset-slot"] as const)(
    "refuses the %s M3 conflict without publishing or replacing durable state",
    async kind => {
      const base = snapshot("base");
      let local = structuredClone(base);
      let observed = structuredClone(base);
      if (kind === "same-record") {
        local.cases[0]!.notes = "local conflict";
        observed.cases[0]!.notes = "remote conflict";
      } else if (kind === "delete-edit") {
        local.cases[0]!.notes = "local edit";
        observed.cases = [];
      } else if (kind === "immutable-run") {
        base.runs = [{ id: "run-1", datasetId: "dataset", algorithmId: "algo", createdAt: 1, summary: { totalCases: 0, matchedCases: 0, mismatchedCases: 0, accuracy: 0 }, results: [] }];
        local = structuredClone(base);
        observed = structuredClone(base);
        local.runs[0]!.algorithmLabel = "local";
        observed.runs[0]!.algorithmLabel = "remote";
      } else {
        base.assets = [{ id: "asset-1", datasetId: "dataset", caseId: "a", role: "source", mimeType: "image/png", createdAt: 1, hash: "legacy", sha256: assetHash, byteLength: assetBytes.byteLength }];
        local = structuredClone(base);
        observed = structuredClone(base);
        local.assets[0]!.sha256 = "a".repeat(64);
        observed.assets[0]!.sha256 = "b".repeat(64);
      }
      const { database, state } = await seededSnapshots(base, local);
      const before = await state.load(identity);
      const transport = remote(observed, 2);
      const publish = vi.spyOn(transport, "publishSnapshot");

      await expect(recoverAndFlushMpcCalibration({ database, transport, identity })).resolves.toMatchObject({ status: "conflict" });
      expect(publish).not.toHaveBeenCalled();
      expect(await state.load(identity)).toEqual(before);
      expect(await database.mpcCalibrationCacheBindings.get("mpc-calibration-cache-binding")).toMatchObject({ revision: 1, ...identity });
    }
  );

  it("converges two independent clients after overlapping disjoint publications without a hydration echo", async () => {
    const base = snapshot("shared base");
    const localA = structuredClone(base);
    const localB = structuredClone(base);
    localA.cases[0]!.notes = "client A";
    localA.datasets[0]!.updatedAt = 2;
    localB.cases[1]!.notes = "client B";
    localB.datasets[0]!.updatedAt = 3;
    const seedClient = async (connectionId: string, desired: CalibrationHarnessSnapshot) => {
      const database = fresh();
      const clientIdentity = { ...identity, connectionId };
      const store = createMpcCalibrationSyncStateStore(database, { now: () => 10 });
      await store.storeBaseWhenClean(clientIdentity, { revision: 1, snapshot: base });
      await store.queueSnapshot(clientIdentity, desired);
      await database.mpcCalibrationDatasets.bulkPut(desired.datasets as never);
      await database.mpcCalibrationCases.bulkPut(desired.cases as never);
      await database.mpcCalibrationCacheBindings.put({ id: "mpc-calibration-cache-binding", ...clientIdentity, revision: 1, updatedAt: 10 });
      return { database, identity: clientIdentity, store };
    };
    const clientA = await seedClient("client-a", localA);
    const clientB = await seedClient("client-b", localB);
    const firstReads = deferred();
    const initialRevisions: number[] = [];
    let serverRevision = 1;
    let serverSnapshot = structuredClone(base);
    let publications = 0;
    let rejectedPublications = 0;
    const transport = remote(base, 1);
    transport.getSnapshot = async () => {
      const observed = { revision: serverRevision, snapshot: structuredClone(serverSnapshot) };
      if (initialRevisions.length < 2) {
        initialRevisions.push(observed.revision);
        if (initialRevisions.length === 2) firstReads.resolve();
        await firstReads.promise;
      }
      return observed;
    };
    transport.publishSnapshot = async (next, expected) => {
      publications += 1;
      if (expected !== serverRevision) {
        rejectedPublications += 1;
        throw new MpcCalibrationTransportError("http", 412);
      }
      serverRevision += 1;
      serverSnapshot = structuredClone(next);
      return { revision: serverRevision, snapshot: structuredClone(serverSnapshot) };
    };
    const pending = [clientA, clientB].map(client => recoverAndFlushMpcCalibration({
      database: client.database, identity: client.identity, transport, maxCycles: 4,
    }));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("independent-client recovery did not settle")), 5000);
    });
    try {
      const results = await Promise.race([Promise.all(pending), deadline]);
      expect(results.map(result => result.status)).toEqual(["published", "published"]);
      expect(initialRevisions).toEqual([1, 1]);
      expect(rejectedPublications).toBe(1);
      expect(publications).toBe(3);
      expect(serverSnapshot.cases).toMatchObject([{ id: "a", notes: "client A" }, { id: "b", notes: "client B" }]);
      const { hydrateMpcCalibrationCache } = await import("./mpcCalibrationCache");
      for (const client of [clientA, clientB]) {
        const before = await client.store.load(client.identity);
        if (before!.base!.revision < serverRevision) {
          await expect(hydrateMpcCalibrationCache({ database: client.database, transport, identity: client.identity })).resolves.toMatchObject({ status: "hydrated" });
        }
        expect(await client.store.load(client.identity)).toMatchObject({ base: { revision: serverRevision, snapshot: serverSnapshot }, queued: null, inFlight: null });
        expect(await client.database.mpcCalibrationCases.toArray()).toEqual(serverSnapshot.cases);
        expect(await client.database.mpcCalibrationDatasets.toArray()).toEqual(serverSnapshot.datasets);
      }
      expect(publications).toBe(3);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      firstReads.resolve();
      await Promise.allSettled(pending);
    }
  });

  it("reopens a rejected V2 publication and recovers against a newly advanced remote base", async () => {
    const { database, state, base } = await seeded();
    const transport = remote(base, 1);
    transport.publishSnapshot = async () => { throw new MpcCalibrationTransportError("http", 412); };
    await expect(recoverAndFlushMpcCalibration({ database, transport, identity, maxCycles: 1 })).resolves.toEqual({
      status: "pending", reason: "recovery-cycle-budget-exhausted",
    });
    const before = await state.load(identity);
    expect(before).toMatchObject({ queued: { generation: 1 }, inFlight: { generation: 1, expectedBaseRevision: 1 }, acknowledgedGeneration: 0 });
    const name = database.name;
    database.close();
    const reopened = new ProxxiedDexie(name);
    handles.push(reopened);
    const reopenedStore = createMpcCalibrationSyncStateStore(reopened, { now: () => 11 });
    expect(await reopenedStore.load(identity)).toEqual(before);
    const advanced = structuredClone(base);
    advanced.cases[1]!.notes = "remote after restart";
    advanced.datasets[0]!.updatedAt = 3;
    const reconnected = remote(advanced, 2);
    await expect(recoverAndFlushMpcCalibration({ database: reopened, transport: reconnected, identity, maxCycles: 3 })).resolves.toMatchObject({
      status: "published", generation: 2, revision: 3,
    });
    const observed = await reconnected.getSnapshot();
    expect(observed!.snapshot.cases).toMatchObject([{ id: "a", notes: "local A" }, { id: "b", notes: "remote after restart" }]);
    expect(await reopenedStore.load(identity)).toMatchObject({ queued: null, inFlight: null, acknowledgedGeneration: 2, settledGeneration: 2, base: observed });
  });

  it("rejects a valid older remote revision while preserving the installed base and queued edit", async () => {
    const database = fresh();
    const state = createMpcCalibrationSyncStateStore(database, { now: () => 10 });
    const base = snapshot("base");
    const local = structuredClone(base);
    local.cases[0]!.notes = "queued local edit";
    await state.storeBaseWhenClean(identity, { revision: 2, snapshot: base });
    const before = await state.queueSnapshot(identity, local);
    await database.mpcCalibrationDatasets.bulkPut(local.datasets as never);
    await database.mpcCalibrationCases.bulkPut(local.cases as never);
    await database.mpcCalibrationCacheBindings.put({ id: "mpc-calibration-cache-binding", ...identity, revision: 2, updatedAt: 10 });
    const transport = remote(base, 1);
    const publish = vi.spyOn(transport, "publishSnapshot");

    await expect(recoverAndFlushMpcCalibration({ database, transport, identity })).resolves.toEqual({
      status: "conflict", reason: "remote-base-regressed-or-diverged",
    });
    expect(publish).not.toHaveBeenCalled();
    expect(await state.load(identity)).toEqual(before);
    expect(await database.mpcCalibrationCases.toArray()).toEqual(local.cases);
    expect(await database.mpcCalibrationCacheBindings.get("mpc-calibration-cache-binding")).toMatchObject({ ...identity, revision: 2 });
  });

  it.each([
    ["missing", async () => null, "blocked"],
    ["invalid-zero-revision", async (base: CalibrationHarnessSnapshot) => ({ revision: 0, snapshot: base }), "failed"],
    ["same-revision-changed", async (base: CalibrationHarnessSnapshot) => {
      const changed = structuredClone(base);
      changed.cases[1]!.notes = "diverged";
      return { revision: 1, snapshot: changed };
    }, "conflict"],
    ["malformed", async () => ({ revision: "invalid", snapshot: null } as never), "failed"],
    ["offline", async () => { throw new MpcCalibrationTransportError("offline"); }, "failed"],
    ["authentication", async () => { throw new MpcCalibrationTransportError("authentication", 401); }, "failed"],
    ["timeout", async () => { throw new MpcCalibrationTransportError("timeout"); }, "failed"],
  ] as const)("preserves durable intent for %s remote observation", async (_name, getSnapshot, status) => {
    const { database, state, base } = await seeded();
    const before = await state.load(identity);
    const transport = remote(base, 1);
    transport.getSnapshot = () => getSnapshot(base);
    const publish = vi.spyOn(transport, "publishSnapshot");

    await expect(recoverAndFlushMpcCalibration({ database, transport, identity })).resolves.toMatchObject({ status });
    expect(publish).not.toHaveBeenCalled();
    expect(await state.load(identity)).toEqual(before);
  });

  it("preserves a manual physical row when a merged recovery cannot pass the real producer fence", async () => {
    const { database, state, base, local } = await seeded();
    await database.mpcCalibrationCases.put({ ...local.cases[0]!, notes: "manual unqueued edit" } as never);
    const advanced = structuredClone(base);
    advanced.cases[1]!.notes = "remote disjoint edit";
    const transport = remote(advanced, 2);
    const publish = vi.spyOn(transport, "publishSnapshot");

    await expect(recoverAndFlushMpcCalibration({ database, transport, identity })).resolves.toEqual({
      status: "blocked", reason: "current-cache-is-not-the-expected-queued-state",
    });
    expect(publish).not.toHaveBeenCalled();
    expect(await database.mpcCalibrationCases.get("a")).toMatchObject({ notes: "manual unqueued edit" });
    expect(await state.load(identity)).toMatchObject({ base: { revision: 1 }, queued: { generation: 1, snapshot: local } });
  });

  it("rejects pre-abort, wrong server identity, empty publication, and invalid budget without a publish", async () => {
    const { database, state, base } = await seeded();
    const aborted = new AbortController();
    aborted.abort();
    const transport = remote(base, 1);
    const session = vi.spyOn(transport, "getSession");
    const publish = vi.spyOn(transport, "publishSnapshot");
    await expect(recoverAndFlushMpcCalibration({ database, transport, identity, signal: aborted.signal })).resolves.toMatchObject({ status: "cancelled" });
    expect(session).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    await expect(recoverAndFlushMpcCalibration({ database, transport, identity, maxCycles: 0 })).resolves.toEqual({ status: "blocked", reason: "invalid-cycle-budget" });
    expect(publish).not.toHaveBeenCalled();

    transport.getSession = async () => ({ ownerId: "other-owner", harnessId: identity.harnessId });
    await expect(recoverAndFlushMpcCalibration({ database, transport, identity })).resolves.toMatchObject({ status: "cancelled", reason: "session-identity-mismatch" });
    expect(publish).not.toHaveBeenCalled();

    const emptyDatabase = fresh();
    const emptyStore = createMpcCalibrationSyncStateStore(emptyDatabase, { now: () => 10 });
    await emptyStore.storeBaseWhenClean(identity, { revision: 1, snapshot: base });
    await emptyStore.queueSnapshot(identity, { version: 1, retained: { empty: true }, datasets: [], cases: [], assets: [], runs: [] });
    const emptyTransport = remote(base, 1);
    const emptyPublish = vi.spyOn(emptyTransport, "publishSnapshot");
    await expect(recoverAndFlushMpcCalibration({ database: emptyDatabase, transport: emptyTransport, identity })).resolves.toEqual({
      status: "blocked", reason: "empty-snapshot-requires-reconciliation",
    });
    expect(emptyPublish).not.toHaveBeenCalled();
    expect(await state.load(identity)).toMatchObject({ queued: { generation: 1 } });
  });

  it("retains the originally captured signal when caller options are replaced during an await", async () => {
    const { database, base } = await seeded();
    const original = new AbortController();
    const replacement = new AbortController();
    replacement.abort();
    const transport = remote(base, 1);
    const entered = deferred();
    const release = deferred();
    let first = true;
    transport.getSession = async () => {
      if (first) { first = false; entered.resolve(); await release.promise; }
      return { ownerId: identity.ownerId, harnessId: identity.harnessId };
    };
    const input: { database: ProxxiedDexie; transport: MpcCalibrationTransport; identity: typeof identity; signal: AbortSignal } = {
      database, transport, identity, signal: original.signal,
    };
    const pending = recoverAndFlushMpcCalibration(input);
    await entered.promise;
    input.signal = replacement.signal;
    release.resolve();

    await expect(pending).resolves.toMatchObject({ status: "published" });
  });

  it("keeps a typed 412 recovery bounded and rejects generation overflow or malformed durable state without writes", async () => {
    const { database, state, base, local } = await seeded();
    const transport = remote(base, 1);
    transport.publishSnapshot = async () => { throw new MpcCalibrationTransportError("http", 412); };
    await expect(recoverAndFlushMpcCalibration({ database, transport, identity, maxCycles: 2 })).resolves.toEqual({
      status: "pending", reason: "recovery-cycle-budget-exhausted",
    });
    expect(await state.load(identity)).toMatchObject({ queued: { generation: 2 }, inFlight: null });

    const overflow = fresh();
    const overflowState = createMpcCalibrationSyncStateStore(overflow, { now: () => 10 });
    await overflowState.storeBaseWhenClean(identity, { revision: 1, snapshot: base });
    await overflowState.queueSnapshot(identity, local);
    const overflowRow = await overflowState.load(identity);
    await overflow.mpcCalibrationSyncStates.put({
      ...overflowRow, queued: { generation: Number.MAX_SAFE_INTEGER, snapshot: local }, dirtyGeneration: Number.MAX_SAFE_INTEGER,
    } as never);
    await overflow.mpcCalibrationDatasets.bulkPut(local.datasets as never);
    await overflow.mpcCalibrationCases.bulkPut(local.cases as never);
    await overflow.mpcCalibrationCacheBindings.put({ id: "mpc-calibration-cache-binding", ...identity, revision: 1, updatedAt: 1 });
    const advanced = structuredClone(base);
    advanced.cases[1]!.notes = "remote advance";
    const overflowTransport = remote(advanced, 2);
    const overflowPublish = vi.spyOn(overflowTransport, "publishSnapshot");
    await expect(recoverAndFlushMpcCalibration({ database: overflow, transport: overflowTransport, identity })).resolves.toEqual({
      status: "blocked", reason: "generation-overflow",
    });
    expect(overflowPublish).not.toHaveBeenCalled();
    expect(await overflowState.load(identity)).toMatchObject({ dirtyGeneration: Number.MAX_SAFE_INTEGER, queued: { generation: Number.MAX_SAFE_INTEGER } });

    const malformed = fresh();
    await malformed.mpcCalibrationSyncStates.put({ ...identity, formatVersion: 2, queued: "invalid" } as never);
    const malformedTransport = remote(base, 1);
    const malformedPublish = vi.spyOn(malformedTransport, "publishSnapshot");
    await expect(recoverAndFlushMpcCalibration({ database: malformed, transport: malformedTransport, identity })).resolves.toMatchObject({ status: "failed" });
    expect(malformedPublish).not.toHaveBeenCalled();
  });
});
