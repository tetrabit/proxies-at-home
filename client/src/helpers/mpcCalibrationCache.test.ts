import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProxxiedDexie } from "@/db";
import { applyMpcCalibrationRecoveryCache, hydrateMpcCalibrationCache } from "./mpcCalibrationCache";
import type { MpcCalibrationTransport } from "./mpcCalibrationTransport";
import { buildBootstrapPreferenceFixture } from "./mpcPreferenceBootstrap";
import { CALIBRATION_HARNESS_LIMITS, validateCalibrationHarnessSnapshot } from "../../../shared/calibrationHarness";
import { validateCalibrationHarnessRecoveryState } from "../../../shared/calibrationHarnessRecoveryState";

const identity = { ownerId: "owner", harnessId: "harness", connectionId: "connection" };
const assetBytes = new Uint8Array([1, 2, 3, 4]);
const assetHash = "9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a";
const handles: ProxxiedDexie[] = [];

function snapshot() {
  return {
    version: 1 as const,
    retainedRoot: { exact: ["root", 1] },
    datasets: [{ id: "dataset", name: "Dataset", targetCaseCount: 1, createdAt: 1, updatedAt: 2, version: 1, retained: { dataset: true } }],
    cases: [{
      id: "case", datasetId: "dataset", createdAt: 3, updatedAt: 4,
      source: { name: "Card", retained: { source: true } },
      candidates: [{ identifier: "candidate", name: "Candidate", rawName: "Candidate", smallThumbnailUrl: "small", mediumThumbnailUrl: "medium", imageUrl: "image", dpi: 72, tags: ["tag"], sourceName: "source", source: "source", extension: "png", size: 4, retained: { candidate: true } }],
      expectedIdentifier: "candidate", notes: "note", comparisonHints: { fullCard: { candidate: 1 } }, retained: { calibrationCase: true },
    }],
    assets: [{ id: "asset", datasetId: "dataset", caseId: "case", role: "source" as const, mimeType: "image/png", createdAt: 5, hash: "legacy", sha256: assetHash, byteLength: assetBytes.byteLength, retained: { asset: true } }],
    runs: [{
      id: "run", datasetId: "dataset", algorithmId: "algorithm", algorithmLabel: "Algorithm", createdAt: 6,
      summary: { totalCases: 1, matchedCases: 1, mismatchedCases: 0, accuracy: 1 },
      results: [{ caseId: "case", matched: true, retained: { result: true } }],
      retained: { run: true },
    }],
  };
}

function freshDatabase(): ProxxiedDexie {
  const database = new ProxxiedDexie(`mpc-calibration-cache-${crypto.randomUUID()}`);
  handles.push(database);
  return database;
}

function transport(revision = 1): MpcCalibrationTransport {
  return {
    pair: async () => ({ ownerId: identity.ownerId, harnessId: identity.harnessId }),
    unpair: async () => undefined,
    getSession: async () => ({ ownerId: identity.ownerId, harnessId: identity.harnessId }),
    getSnapshot: async () => ({ revision, snapshot: snapshot() }),
    publishSnapshot: async () => { throw new Error("C3 never publishes"); },
    getBlob: async (hash) => {
      if (hash !== assetHash) throw new Error("unexpected blob");
      return assetBytes.slice();
    },
    putBlob: async () => { throw new Error("C3 never uploads"); },
    missingBlobs: async () => ({ missing: [] }),
  };
}

async function bytes(blob: Blob): Promise<number[]> {
  return Array.from(new Uint8Array(await blob.arrayBuffer()));
}

async function bootstrapState(database: ProxxiedDexie) {
  return {
    datasets: await database.mpcCalibrationDatasets.toArray(),
    cases: await database.mpcCalibrationCases.toArray(),
    assets: await database.mpcCalibrationAssets.toArray(),
    runs: await database.mpcCalibrationRuns.toArray(),
    base: await database.mpcCalibrationSyncStates.get([identity.ownerId, identity.harnessId, identity.connectionId]),
    binding: await database.mpcCalibrationCacheBindings.get("mpc-calibration-cache-binding"),
  };
}

afterEach(() => {
  for (const database of handles.splice(0)) database.close();
});

describe("hydrateMpcCalibrationCache", () => {
  it("adopts an authoritative remote revision into all four physical tables and exact common base", async () => {
    const database = freshDatabase();
    const remote = snapshot();

    await expect(hydrateMpcCalibrationCache({ database, transport: transport(), identity })).resolves.toMatchObject({ status: "hydrated", revision: 1 });

    expect(await database.mpcCalibrationDatasets.toArray()).toEqual(remote.datasets);
    expect(await database.mpcCalibrationCases.toArray()).toEqual(remote.cases);
    expect(await database.mpcCalibrationRuns.toArray()).toEqual(remote.runs);
    const storedAsset = await database.mpcCalibrationAssets.get("asset");
    expect(storedAsset).toMatchObject({ ...remote.assets[0], blob: expect.any(Blob) });
    expect(await bytes(storedAsset!.blob)).toEqual(Array.from(assetBytes));
    expect(storedAsset!.blob.type).toBe("image/png");
    expect(await database.mpcCalibrationSyncStates.get([identity.ownerId, identity.harnessId, identity.connectionId])).toMatchObject({ base: { revision: 1, snapshot: remote }, queued: null, inFlight: null });
  });

  it("recognizes actual bootstrap content by its complete semantics and replaces it", async () => {
    const database = freshDatabase();
    const bootstrap = buildBootstrapPreferenceFixture();
    await database.mpcCalibrationDatasets.add(bootstrap.dataset);
    await database.mpcCalibrationCases.bulkAdd(bootstrap.cases);

    await expect(hydrateMpcCalibrationCache({ database, transport: transport(), identity })).resolves.toMatchObject({ status: "hydrated", revision: 1 });
    expect(await database.mpcCalibrationDatasets.get("dataset")).toMatchObject({ retained: { dataset: true } });
  });

  it.each(["dataset-rekey", "case-rekey", "foreign-case-link", "swapped-case-ids"] as const)("preserves deterministic bootstrap identity for %s before snapshot admission", async change => {
    const database = freshDatabase();
    const bootstrap = buildBootstrapPreferenceFixture();
    if (change === "dataset-rekey") {
      bootstrap.dataset.id = "manual-dataset";
      for (const entry of bootstrap.cases) entry.datasetId = bootstrap.dataset.id;
    }
    if (change === "case-rekey") bootstrap.cases[0]!.id = "manual-case";
    if (change === "foreign-case-link") bootstrap.cases[0]!.datasetId = "foreign-dataset";
    if (change === "swapped-case-ids") {
      const firstId = bootstrap.cases[0]!.id;
      bootstrap.cases[0]!.id = bootstrap.cases[1]!.id;
      bootstrap.cases[1]!.id = firstId;
    }
    await database.mpcCalibrationDatasets.add(bootstrap.dataset);
    await database.mpcCalibrationCases.bulkAdd(bootstrap.cases);
    const before = await bootstrapState(database);
    const remote = transport();
    let snapshots = 0;
    remote.getSnapshot = async () => {
      snapshots += 1;
      return { revision: 1, snapshot: snapshot() };
    };

    await expect(hydrateMpcCalibrationCache({ database, transport: remote, identity })).resolves.toMatchObject({ status: "needs-reconciliation" });
    expect(snapshots).toBe(0);
    await expect(bootstrapState(database)).resolves.toEqual(before);
  });

  it("accepts timestamp-only bootstrap changes with reversed table insertion order", async () => {
    const database = freshDatabase();
    const bootstrap = buildBootstrapPreferenceFixture();
    bootstrap.dataset.createdAt = 1;
    bootstrap.dataset.updatedAt = 2;
    for (const entry of bootstrap.cases) {
      entry.createdAt = 3;
      entry.updatedAt = 4;
    }
    await database.mpcCalibrationDatasets.add(bootstrap.dataset);
    await database.mpcCalibrationCases.bulkAdd([...bootstrap.cases].reverse());
    const remote = transport();
    let snapshots = 0;
    remote.getSnapshot = async () => {
      snapshots += 1;
      return { revision: 1, snapshot: snapshot() };
    };

    await expect(hydrateMpcCalibrationCache({ database, transport: remote, identity })).resolves.toMatchObject({ status: "hydrated", revision: 1 });
    expect(snapshots).toBe(1);
  });

  it("blocks manual unbased data before any remote snapshot request and leaves all four tables intact", async () => {
    const database = freshDatabase();
    await database.mpcCalibrationDatasets.add({ id: "manual", name: "Manual", targetCaseCount: 0, createdAt: 1, updatedAt: 1, version: 1, retained: { manual: true } } as never);
    const remote = transport();
    let snapshots = 0;
    remote.getSnapshot = async () => { snapshots += 1; return { revision: 1, snapshot: snapshot() }; };

    await expect(hydrateMpcCalibrationCache({ database, transport: remote, identity })).resolves.toMatchObject({ status: "needs-reconciliation" });
    expect(snapshots).toBe(0);
    expect(await database.mpcCalibrationDatasets.get("manual")).toMatchObject({ retained: { manual: true } });
    expect(await Promise.all([database.mpcCalibrationCases.count(), database.mpcCalibrationAssets.count(), database.mpcCalibrationRuns.count()])).toEqual([0, 0, 0]);
  });

  it("keeps local cache and base unchanged for absent snapshots and corrupt blobs", async () => {
    const database = freshDatabase();
    const absent = transport();
    absent.getSnapshot = async () => null;
    await expect(hydrateMpcCalibrationCache({ database, transport: absent, identity })).resolves.toEqual({ status: "no-remote-snapshot" });
    expect(await database.mpcCalibrationDatasets.count()).toBe(0);

    const corrupt = transport();
    corrupt.getBlob = async () => new Uint8Array([9]);
    await expect(hydrateMpcCalibrationCache({ database, transport: corrupt, identity })).resolves.toMatchObject({ status: "blocked" });
    expect(await Promise.all([database.mpcCalibrationDatasets.count(), database.mpcCalibrationCases.count(), database.mpcCalibrationAssets.count(), database.mpcCalibrationRuns.count(), database.mpcCalibrationSyncStates.count()])).toEqual([0, 0, 0, 0, 0]);
    expect(await database.mpcCalibrationHydrationStaging.count()).toBe(0);
  });

  it("fails closed when a physical cache is bound to a different authenticated owner", async () => {
    const database = freshDatabase();
    await hydrateMpcCalibrationCache({ database, transport: transport(), identity });
    const otherIdentity = { ownerId: "other-owner", harnessId: identity.harnessId, connectionId: identity.connectionId };
    const other = transport();
    other.getSession = async () => ({ ownerId: otherIdentity.ownerId, harnessId: otherIdentity.harnessId });
    let snapshots = 0;
    other.getSnapshot = async () => { snapshots += 1; return { revision: 2, snapshot: snapshot() }; };

    await expect(hydrateMpcCalibrationCache({ database, transport: other, identity: otherIdentity })).resolves.toMatchObject({ status: "blocked", reason: "physical-cache-bound-to-different-identity" });
    expect(snapshots).toBe(0);
  });

  it("does not treat same-size and same-MIME changed local Blob bytes as clean", async () => {
    const database = freshDatabase();
    await expect(hydrateMpcCalibrationCache({ database, transport: transport(), identity })).resolves.toMatchObject({ status: "hydrated" });
    const changed = new Uint8Array([4, 3, 2, 1]);
    await database.mpcCalibrationAssets.update("asset", { blob: new Blob([changed], { type: "image/png" }) });

    await expect(hydrateMpcCalibrationCache({ database, transport: transport(2), identity })).resolves.not.toMatchObject({ status: "hydrated" });
    expect(await bytes((await database.mpcCalibrationAssets.get("asset"))!.blob)).toEqual([...changed]);
    expect((await database.mpcCalibrationSyncStates.get([identity.ownerId, identity.harnessId, identity.connectionId]))!.base!.revision).toBe(1);
  });

  it("does not overwrite a same-size Blob edit made while remote bytes are pending", async () => {
    const database = freshDatabase();
    await hydrateMpcCalibrationCache({ database, transport: transport(), identity });
    let releaseBlob: ((value: Uint8Array) => void) | undefined;
    let entered: (() => void) | undefined;
    const pendingBlob = new Promise<Uint8Array>(resolve => { releaseBlob = resolve; });
    const blobEntered = new Promise<void>(resolve => { entered = resolve; });
    const remote = transport(2);
    remote.getBlob = async () => { entered!(); return pendingBlob; };

    const pending = hydrateMpcCalibrationCache({ database, transport: remote, identity });
    await blobEntered;
    const changed = new Uint8Array([4, 3, 2, 1]);
    await database.mpcCalibrationAssets.update("asset", { blob: new Blob([changed], { type: "image/png" }) });
    releaseBlob!(assetBytes.slice());

    await expect(pending).resolves.not.toMatchObject({ status: "hydrated" });
    expect(await bytes((await database.mpcCalibrationAssets.get("asset"))!.blob)).toEqual([...changed]);
  });

  it("rolls back an abort observed after a real canonical table write", async () => {
    const database = freshDatabase();
    const controller = new AbortController();
    const original = database.mpcCalibrationCases.bulkPut.bind(database.mpcCalibrationCases);
    let writes = 0;
    vi.spyOn(database.mpcCalibrationCases, "bulkPut").mockImplementation((async (...args: unknown[]) => {
      const result = await Reflect.apply(original, database.mpcCalibrationCases, args);
      writes += 1;
      controller.abort();
      return result;
    }) as unknown as typeof original);

    await expect(hydrateMpcCalibrationCache({ database, transport: transport(), identity, signal: controller.signal })).resolves.toMatchObject({ status: "cancelled" });
    expect(writes).toBe(1);
    await expect(Promise.all([
      database.mpcCalibrationDatasets.count(), database.mpcCalibrationCases.count(), database.mpcCalibrationAssets.count(),
      database.mpcCalibrationRuns.count(), database.mpcCalibrationSyncStates.count(), database.mpcCalibrationCacheBindings.count(),
    ])).resolves.toEqual([0, 0, 0, 0, 0, 0]);
  });

  it("uses the originally captured database after asynchronous session admission", async () => {
    const original = freshDatabase();
    const replacement = freshDatabase();
    let releaseSession: ((value: { ownerId: string; harnessId: string }) => void) | undefined;
    let entered: (() => void) | undefined;
    const sessionPending = new Promise<{ ownerId: string; harnessId: string }>(resolve => { releaseSession = resolve; });
    const sessionEntered = new Promise<void>(resolve => { entered = resolve; });
    const remote = transport();
    let calls = 0;
    remote.getSession = async () => {
      calls += 1;
      if (calls === 1) { entered!(); return sessionPending; }
      return { ownerId: identity.ownerId, harnessId: identity.harnessId };
    };
    const input = { database: original, transport: remote, identity };
    const pending = hydrateMpcCalibrationCache(input);
    await sessionEntered;
    (input as { database: ProxxiedDexie }).database = replacement;
    releaseSession!({ ownerId: identity.ownerId, harnessId: identity.harnessId });

    await expect(pending).resolves.toMatchObject({ status: "hydrated" });
    expect(await replacement.mpcCalibrationDatasets.count()).toBe(0);
    expect(await replacement.mpcCalibrationSyncStates.count()).toBe(0);
  });

  it("cleans owned staging after a final session mismatch without touching foreign staging", async () => {
    const database = freshDatabase();
    await database.mpcCalibrationHydrationStaging.add({ id: "foreign", operationId: "foreign", ...identity, assetId: "foreign", sha256: "foreign", byteLength: 1, mimeType: "text/plain", blob: new Blob(["f"]) });
    const remote = transport();
    let sessions = 0;
    remote.getSession = async () => {
      sessions += 1;
      return sessions === 1 ? { ownerId: identity.ownerId, harnessId: identity.harnessId } : { ownerId: "other", harnessId: identity.harnessId };
    };

    await expect(hydrateMpcCalibrationCache({ database, transport: remote, identity })).resolves.toMatchObject({ status: "blocked", reason: "session-identity-replaced" });
    expect(await database.mpcCalibrationHydrationStaging.toArray()).toHaveLength(1);
    expect((await database.mpcCalibrationHydrationStaging.get("foreign"))!.operationId).toBe("foreign");
  });

  it("reports committed hydration honestly when owned staging cleanup fails", async () => {
    const database = freshDatabase();
    vi.spyOn(database.mpcCalibrationHydrationStaging, "bulkDelete").mockRejectedValue(new Error("cleanup failure"));

    await expect(hydrateMpcCalibrationCache({ database, transport: transport(), identity })).resolves.toMatchObject({
      status: "hydrated", revision: 1, reason: "committed-staging-cleanup-failed",
    });
    expect(await database.mpcCalibrationDatasets.count()).toBe(1);
    expect(await database.mpcCalibrationCacheBindings.count()).toBe(1);
  });

  it("blocks a semantic bootstrap modification before snapshot network admission", async () => {
    const database = freshDatabase();
    const bootstrap = buildBootstrapPreferenceFixture();
    await database.mpcCalibrationDatasets.add(bootstrap.dataset);
    await database.mpcCalibrationCases.bulkAdd(bootstrap.cases);
    const modified = await database.mpcCalibrationCases.get(bootstrap.cases[0]!.id);
    await database.mpcCalibrationCases.put({ ...modified!, notes: "manual preservation sentinel" });
    const remote = transport();
    let snapshots = 0;
    remote.getSnapshot = async () => { snapshots += 1; return { revision: 1, snapshot: snapshot() }; };

    await expect(hydrateMpcCalibrationCache({ database, transport: remote, identity })).resolves.toMatchObject({ status: "needs-reconciliation" });
    expect(snapshots).toBe(0);
  });

  it("does zero network work for a pre-aborted operation", async () => {
    const database = freshDatabase();
    const controller = new AbortController();
    controller.abort();
    const remote = transport();
    let calls = 0;
    remote.getSession = async () => { calls += 1; return { ownerId: identity.ownerId, harnessId: identity.harnessId }; };

    await expect(hydrateMpcCalibrationCache({ database, transport: remote, identity, signal: controller.signal })).resolves.toMatchObject({ status: "cancelled", reason: "operation-not-current" });
    expect(calls).toBe(0);
  });

  it("preserves the prior four-table base when a multi-asset stage fails", async () => {
    const database = freshDatabase();
    await hydrateMpcCalibrationCache({ database, transport: transport(), identity });
    const remoteSnapshot = snapshot();
    remoteSnapshot.cases.push({ ...structuredClone(remoteSnapshot.cases[0]!), id: "case-two" });
    remoteSnapshot.assets.push({ id: "asset-two", datasetId: "dataset", caseId: "case-two", role: "source", mimeType: "image/png", createdAt: 6, hash: "legacy-two", sha256: "55e5509f8052998294266ee5b50cb592938191fb5d67f73cac2e60b0276b1bdd", byteLength: 4, retained: { asset: true } });
    validateCalibrationHarnessSnapshot(remoteSnapshot);
    const remote = transport(2);
    remote.getSnapshot = async () => ({ revision: 2, snapshot: remoteSnapshot });
    let blobCalls = 0;
    remote.getBlob = async (hash) => {
      blobCalls += 1;
      return hash === assetHash ? assetBytes.slice() : Promise.reject(new Error("second asset offline"));
    };

    await expect(hydrateMpcCalibrationCache({ database, transport: remote, identity })).resolves.toMatchObject({ status: "failed" });
    expect(blobCalls).toBe(2);
    await expect(Promise.all([database.mpcCalibrationDatasets.count(), database.mpcCalibrationCases.count(), database.mpcCalibrationAssets.count(), database.mpcCalibrationRuns.count(), database.mpcCalibrationHydrationStaging.count()])).resolves.toEqual([1, 1, 1, 1, 0]);
    expect((await database.mpcCalibrationSyncStates.get([identity.ownerId, identity.harnessId, identity.connectionId]))!.base!.revision).toBe(1);
  });

  it("rolls back a real post-write persistence error to the prior base", async () => {
    const database = freshDatabase();
    await hydrateMpcCalibrationCache({ database, transport: transport(), identity });
    const original = database.mpcCalibrationRuns.bulkPut.bind(database.mpcCalibrationRuns);
    vi.spyOn(database.mpcCalibrationRuns, "bulkPut").mockImplementation((async (...args: unknown[]) => {
      await Reflect.apply(original, database.mpcCalibrationRuns, args);
      throw new Error("quota after write");
    }) as unknown as typeof original);

    await expect(hydrateMpcCalibrationCache({ database, transport: transport(2), identity })).resolves.toMatchObject({ status: "failed" });
    await expect(Promise.all([database.mpcCalibrationDatasets.count(), database.mpcCalibrationCases.count(), database.mpcCalibrationAssets.count(), database.mpcCalibrationRuns.count()])).resolves.toEqual([1, 1, 1, 1]);
    expect((await database.mpcCalibrationSyncStates.get([identity.ownerId, identity.harnessId, identity.connectionId]))!.base!.revision).toBe(1);
  });

  it("lets a newer completion win over a stale deferred operation", async () => {
    const database = freshDatabase();
    let releaseBlob: ((value: Uint8Array) => void) | undefined;
    let entered: (() => void) | undefined;
    const pendingBlob = new Promise<Uint8Array>(resolve => { releaseBlob = resolve; });
    const blobEntered = new Promise<void>(resolve => { entered = resolve; });
    const older = transport(1);
    older.getBlob = async () => { entered!(); return pendingBlob; };
    const oldPending = hydrateMpcCalibrationCache({ database, transport: older, identity });
    await blobEntered;

    await expect(hydrateMpcCalibrationCache({ database, transport: transport(2), identity })).resolves.toMatchObject({ status: "hydrated", revision: 2 });
    releaseBlob!(assetBytes.slice());
    await expect(oldPending).resolves.not.toMatchObject({ status: "hydrated" });
    expect((await database.mpcCalibrationSyncStates.get([identity.ownerId, identity.harnessId, identity.connectionId]))!.base!.revision).toBe(2);
  });

  it("cleans staged records after a post-stage abort and preserves canonical data", async () => {
    const database = freshDatabase();
    const controller = new AbortController();
    const remote = transport();
    let sessions = 0;
    remote.getSession = async () => {
      sessions += 1;
      if (sessions === 2) controller.abort();
      return { ownerId: identity.ownerId, harnessId: identity.harnessId };
    };

    await expect(hydrateMpcCalibrationCache({ database, transport: remote, identity, signal: controller.signal })).resolves.toMatchObject({ status: "cancelled" });
    await expect(Promise.all([database.mpcCalibrationDatasets.count(), database.mpcCalibrationHydrationStaging.count()])).resolves.toEqual([0, 0]);
  });

  it("does not download or replace an equal remote revision", async () => {
    const database = freshDatabase();
    await hydrateMpcCalibrationCache({ database, transport: transport(), identity });
    const remote = transport(1);
    let blobs = 0;
    remote.getBlob = async () => { blobs += 1; return assetBytes.slice(); };

    await expect(hydrateMpcCalibrationCache({ database, transport: remote, identity })).resolves.toMatchObject({ status: "blocked", reason: "remote-revision-not-newer" });
    expect(blobs).toBe(0);
    expect((await database.mpcCalibrationSyncStates.get([identity.ownerId, identity.harnessId, identity.connectionId]))!.base!.revision).toBe(1);
  });

  it("blocks dirty C1 state before remote replacement", async () => {
    const database = freshDatabase();
    await hydrateMpcCalibrationCache({ database, transport: transport(), identity });
    const key: [string, string, string] = [identity.ownerId, identity.harnessId, identity.connectionId];
    const state = await database.mpcCalibrationSyncStates.get(key);
    await database.mpcCalibrationSyncStates.put({
      ...state!,
      dirtyGeneration: 2,
      sentGeneration: 0,
      queued: { generation: 2, snapshot: state!.base!.snapshot },
    });
    const remote = transport(2);
    let snapshots = 0;
    remote.getSnapshot = async () => { snapshots += 1; return { revision: 2, snapshot: snapshot() }; };

    await expect(hydrateMpcCalibrationCache({ database, transport: remote, identity })).resolves.toMatchObject({ status: "needs-reconciliation" });
    expect(snapshots).toBe(0);
  });

  it("fails closed when the shared physical cache has a different connection binding", async () => {
    const database = freshDatabase();
    await hydrateMpcCalibrationCache({ database, transport: transport(), identity });
    const changedConnection = { ...identity, connectionId: "replacement-connection" };
    const remote = transport(2);

    await expect(hydrateMpcCalibrationCache({ database, transport: remote, identity: changedConnection })).resolves.toMatchObject({ status: "blocked", reason: "physical-cache-bound-to-different-identity" });
    expect((await database.mpcCalibrationCacheBindings.get("mpc-calibration-cache-binding"))!.connectionId).toBe(identity.connectionId);
  });

  it("retains current hydrated bytes, MIME, and root metadata after close and reopen", async () => {
    const database = freshDatabase();
    const databaseName = database.name;
    const remote = snapshot();
    await hydrateMpcCalibrationCache({ database, transport: transport(), identity });
    database.close();
    const reopened = new ProxxiedDexie(databaseName);
    handles.push(reopened);
    await reopened.open();

    expect(await bytes((await reopened.mpcCalibrationAssets.get("asset"))!.blob)).toEqual([...assetBytes]);
    expect((await reopened.mpcCalibrationAssets.get("asset"))!.blob.type).toBe("image/png");
    expect((await reopened.mpcCalibrationSyncStates.get([identity.ownerId, identity.harnessId, identity.connectionId]))!.base!.snapshot).toEqual(remote);
  });

  it("admits local Blob reads serially during a multi-asset refresh", async () => {
    const database = freshDatabase();
    const remoteSnapshot = snapshot();
    remoteSnapshot.cases.push({ ...structuredClone(remoteSnapshot.cases[0]!), id: "case-two" });
    remoteSnapshot.assets.push({ ...structuredClone(remoteSnapshot.assets[0]!), id: "asset-two", caseId: "case-two" });
    validateCalibrationHarnessSnapshot(remoteSnapshot);
    const remote = transport();
    remote.getSnapshot = async () => ({ revision: 1, snapshot: remoteSnapshot });
    expect((await hydrateMpcCalibrationCache({ database, transport: remote, identity })).status).toBe("hydrated");
    remote.getSnapshot = async () => ({ revision: 2, snapshot: remoteSnapshot });
    const originalRead = Blob.prototype.arrayBuffer;
    let active = 0;
    let maximumActive = 0;
    const read = vi.spyOn(Blob.prototype, "arrayBuffer").mockImplementation(function (this: Blob) {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      return originalRead.call(this).finally(() => {
        active -= 1;
      });
    });
    try {
      const result = await hydrateMpcCalibrationCache({ database, transport: remote, identity });
      expect(read).toHaveBeenCalled();
      expect(active).toBe(0);
      expect(maximumActive).toBe(1);
      expect(result).toMatchObject({ status: "hydrated", revision: 2 });
      expect(await database.mpcCalibrationAssets.count()).toBe(2);
    } finally {
      read.mockRestore();
    }
  });

  it("rejects an oversized local Blob before admitting a byte read", async () => {
    const database = freshDatabase();
    const oversized = new Blob([new ArrayBuffer(CALIBRATION_HARNESS_LIMITS.maxAssetBytes + 1)], { type: "image/png" });
    await database.mpcCalibrationAssets.add({ ...snapshot().assets[0]!, blob: oversized });
    // Intercept before materializing the oversized bytes; the fixture itself is bounded.
    const read = vi.spyOn(Blob.prototype, "arrayBuffer").mockRejectedValue(new Error("oversized read admitted"));
    try {
      expect((await hydrateMpcCalibrationCache({ database, transport: transport(), identity })).status).not.toBe("hydrated");
      expect(read).not.toHaveBeenCalled();
      expect((await database.mpcCalibrationAssets.get("asset"))!.blob.size).toBe(oversized.size);
      expect(await database.mpcCalibrationSyncStates.count()).toBe(0);
    } finally {
      read.mockRestore();
    }
  });

  it("preserves the original operation receiver when capturing its fence", async () => {
    const database = freshDatabase();
    const operation = { id: "current", isCurrent() { return this.id === "current"; } };
    await expect(hydrateMpcCalibrationCache({ database, transport: transport(), identity, operation })).resolves.toMatchObject({ status: "hydrated", revision: 1 });
    expect(await database.mpcCalibrationCases.count()).toBe(1);
  });

  it("adopts an authoritative empty revision without changing foreign sync state or opening the global database", async () => {
    const database = freshDatabase();
    const originalOpen = indexedDB.open.bind(indexedDB);
    const open = vi.spyOn(indexedDB, "open").mockImplementation((name, version) => {
      expect(name).toBe(database.name);
      return originalOpen(name, version);
    });
    try {
      expect((await hydrateMpcCalibrationCache({ database, transport: transport(), identity })).status).toBe("hydrated");
      const own = await database.mpcCalibrationSyncStates.get([identity.ownerId, identity.harnessId, identity.connectionId]);
      const foreign = { ...structuredClone(own!), ownerId: "foreign-owner" };
      await database.mpcCalibrationSyncStates.add(foreign);
      const remote = transport(2);
      const empty = { version: 1 as const, datasets: [], cases: [], assets: [], runs: [], retainedRoot: { authoritativeEmpty: true } };
      remote.getSnapshot = async () => ({ revision: 2, snapshot: empty });
      const getBlob = vi.spyOn(remote, "getBlob");

      await expect(hydrateMpcCalibrationCache({ database, transport: remote, identity })).resolves.toMatchObject({ status: "hydrated", revision: 2 });
      expect(getBlob).not.toHaveBeenCalled();
      expect(await Promise.all([database.mpcCalibrationDatasets.count(), database.mpcCalibrationCases.count(), database.mpcCalibrationAssets.count(), database.mpcCalibrationRuns.count()])).toEqual([0, 0, 0, 0]);
      expect((await database.mpcCalibrationSyncStates.get([identity.ownerId, identity.harnessId, identity.connectionId]))!.base).toEqual({ revision: 2, snapshot: empty });
      expect(await database.mpcCalibrationSyncStates.get([foreign.ownerId, foreign.harnessId, foreign.connectionId])).toEqual(foreign);
    } finally {
      open.mockRestore();
    }
  });

  it("cleans a just-persisted staging row when cancellation precedes add settlement", async () => {
    const database = freshDatabase();
    await hydrateMpcCalibrationCache({ database, transport: transport(), identity });
    const beforeBase = await database.mpcCalibrationSyncStates.toArray();
    const beforeBinding = await database.mpcCalibrationCacheBindings.toArray();
    await database.mpcCalibrationHydrationStaging.add({ id: "foreign", operationId: "foreign", ...identity, assetId: "foreign", sha256: assetHash, byteLength: 4, mimeType: "image/png", blob: new Blob([assetBytes], { type: "image/png" }) });
    const controller = new AbortController();
    const originalAdd = database.mpcCalibrationHydrationStaging.add.bind(database.mpcCalibrationHydrationStaging);
    const add = vi.spyOn(database.mpcCalibrationHydrationStaging, "add").mockImplementation((...args: Parameters<typeof originalAdd>) => originalAdd(...args).then(key => {
      controller.abort();
      return key;
    }));
    try {
      await expect(hydrateMpcCalibrationCache({ database, transport: transport(2), identity, signal: controller.signal })).resolves.toMatchObject({ status: "cancelled" });
      expect(add).toHaveBeenCalledTimes(1);
      expect(await database.mpcCalibrationSyncStates.toArray()).toEqual(beforeBase);
      expect(await database.mpcCalibrationCacheBindings.toArray()).toEqual(beforeBinding);
      expect(await bytes((await database.mpcCalibrationAssets.get("asset"))!.blob)).toEqual([...assetBytes]);
      expect((await database.mpcCalibrationHydrationStaging.toArray()).map(row => row.id)).toEqual(["foreign"]);
    } finally {
      add.mockRestore();
    }
  });

  it("atomically applies a queued recovery snapshot with a verified remote Blob and exact next state", async () => {
    const database = freshDatabase();
    await expect(hydrateMpcCalibrationCache({ database, transport: transport(), identity })).resolves.toMatchObject({ status: "hydrated" });
    const stateStore = (await import("./mpcCalibrationSyncState")).createMpcCalibrationSyncStateStore(database, { now: () => 10 });
    const expectedState = await stateStore.queueSnapshot(identity, snapshot());
    const target = snapshot();
    const replacementBytes = new Uint8Array([8, 7, 6, 5]);
    target.assets[0] = {
      ...target.assets[0]!,
      sha256: "952b50fd4fe30aee9420f479ff3f4c6268f2865ee65a82e1f8e157abc1455272",
      byteLength: replacementBytes.byteLength,
    };
    const nextState = {
      ...expectedState,
      base: { revision: 2, snapshot: target },
      queued: { generation: 2, snapshot: target },
      dirtyGeneration: 2,
      updatedAt: 11,
    };
    const remote = transport();
    remote.getBlob = async hash => {
      expect(hash).toBe(target.assets[0]!.sha256);
      return replacementBytes.slice();
    };

    await expect(applyMpcCalibrationRecoveryCache({
      database, transport: remote, identity, expectedState, nextState: nextState as never, snapshot: target,
    })).resolves.toMatchObject({ status: "applied", revision: 2 });

    expect(await bytes((await database.mpcCalibrationAssets.get("asset"))!.blob)).toEqual([...replacementBytes]);
    expect(await database.mpcCalibrationSyncStates.get([identity.ownerId, identity.harnessId, identity.connectionId])).toEqual(nextState);
    expect(await database.mpcCalibrationCacheBindings.get("mpc-calibration-cache-binding")).toMatchObject({ ...identity, revision: 2 });
    expect(await database.mpcCalibrationHydrationStaging.count()).toBe(0);
  });

  it("retains a foreign replacement at a recovery staging ID after cancellation", async () => {
    const database = freshDatabase();
    await hydrateMpcCalibrationCache({ database, transport: transport(), identity });
    const stateStore = (await import("./mpcCalibrationSyncState")).createMpcCalibrationSyncStateStore(database, { now: () => 10 });
    const expectedState = await stateStore.queueSnapshot(identity, snapshot());
    const target = snapshot();
    target.assets[0] = { ...target.assets[0]!, sha256: "952b50fd4fe30aee9420f479ff3f4c6268f2865ee65a82e1f8e157abc1455272" };
    const nextState = { ...expectedState, base: { revision: 2, snapshot: target }, queued: { generation: 2, snapshot: target }, dirtyGeneration: 2, updatedAt: 11 };
    const controller = new AbortController();
    const originalAdd = database.mpcCalibrationHydrationStaging.add.bind(database.mpcCalibrationHydrationStaging);
    let stageId: string | undefined;
    vi.spyOn(database.mpcCalibrationHydrationStaging, "add").mockImplementation((async (...args: unknown[]) => {
      const id = await Reflect.apply(originalAdd, database.mpcCalibrationHydrationStaging, args);
      stageId = id;
      const staged = await database.mpcCalibrationHydrationStaging.get(id);
      await database.mpcCalibrationHydrationStaging.put({ ...staged!, ownerId: "foreign-owner", operationId: "foreign-operation" });
      controller.abort();
      return id;
    }) as unknown as typeof originalAdd);
    const remote = transport();
    remote.getBlob = async () => new Uint8Array([8, 7, 6, 5]);

    await expect(applyMpcCalibrationRecoveryCache({ database, transport: remote, identity, expectedState, nextState: nextState as never, snapshot: target, signal: controller.signal })).resolves.not.toMatchObject({ status: "applied" });
    expect(stageId).toBeDefined();
    expect(await database.mpcCalibrationHydrationStaging.get(stageId!)).toMatchObject({ ownerId: "foreign-owner", operationId: "foreign-operation" });
  });

  it("rejects a recovery proof whose prior queued and sent body differs from expected state", async () => {
    const database = freshDatabase();
    await hydrateMpcCalibrationCache({ database, transport: transport(), identity });
    const stateStore = (await import("./mpcCalibrationSyncState")).createMpcCalibrationSyncStateStore(database, { now: () => 10 });
    const local = snapshot();
    local.cases[0]!.notes = "local choice";
    const expectedState = await stateStore.queueSnapshot(identity, local);
    await database.mpcCalibrationCases.put(local.cases[0]! as never);
    const sent = await stateStore.markSnapshotSent(identity, expectedState.dirtyGeneration);
    const foreign = structuredClone(local);
    foreign.cases[0]!.notes = "foreign choice";
    const observed = { revision: 2, snapshot: foreign };
    const nextState = {
      ...sent, base: observed, queued: null, inFlight: null, settledGeneration: sent.dirtyGeneration, updatedAt: 11,
      lastRecovery: { kind: "observed-current-inflight" as const, priorBase: sent.base!, priorQueued: { generation: sent.dirtyGeneration, snapshot: foreign }, retiredInFlight: { generation: sent.dirtyGeneration, snapshot: foreign, expectedBaseRevision: sent.base!.revision }, observed, resultingQueued: null, settledGeneration: sent.dirtyGeneration },
    };

    await expect(applyMpcCalibrationRecoveryCache({ database, transport: transport(), identity, expectedState: sent, nextState: nextState as never, snapshot: foreign })).resolves.toMatchObject({ status: "blocked" });
    expect((await database.mpcCalibrationCases.get("case"))!.notes).toBe("local choice");
  });

  it("rejects an unsent recovery rebase that drops the queued local edit", async () => {
    const database = freshDatabase();
    await hydrateMpcCalibrationCache({ database, transport: transport(), identity });
    const stateStore = (await import("./mpcCalibrationSyncState")).createMpcCalibrationSyncStateStore(database, { now: () => 10 });
    const local = snapshot();
    local.cases[0]!.notes = "local choice";
    const expectedState = await stateStore.queueSnapshot(identity, local);
    await database.mpcCalibrationCases.put(local.cases[0]! as never);
    const remote = snapshot();
    remote.datasets[0]!.name = "Remote rename";
    const nextState = { ...expectedState, base: { revision: 2, snapshot: remote }, queued: { generation: 2, snapshot: remote }, dirtyGeneration: 2, updatedAt: 11 };

    await expect(applyMpcCalibrationRecoveryCache({ database, transport: transport(), identity, expectedState, nextState: nextState as never, snapshot: remote })).resolves.toMatchObject({ status: "blocked" });
    expect((await database.mpcCalibrationCases.get("case"))!.notes).toBe("local choice");
  });

  it("reuses verified local recovery bytes without downloading them", async () => {
    const database = freshDatabase();
    await hydrateMpcCalibrationCache({ database, transport: transport(), identity });
    const stateStore = (await import("./mpcCalibrationSyncState")).createMpcCalibrationSyncStateStore(database, { now: () => 10 });
    const expectedState = await stateStore.queueSnapshot(identity, snapshot());
    const target = snapshot();
    const nextState = { ...expectedState, base: { revision: 2, snapshot: target }, queued: { generation: 2, snapshot: target }, dirtyGeneration: 2, updatedAt: 11 };
    const remote = transport();
    const getBlob = vi.spyOn(remote, "getBlob");

    await expect(applyMpcCalibrationRecoveryCache({ database, transport: remote, identity, expectedState, nextState: nextState as never, snapshot: target })).resolves.toMatchObject({ status: "applied" });
    expect(getBlob).not.toHaveBeenCalled();
    expect(await bytes((await database.mpcCalibrationAssets.get("asset"))!.blob)).toEqual([...assetBytes]);
  });

  it("deduplicates a remote digest while validating and installing every logical asset", async () => {
    const database = freshDatabase();
    await hydrateMpcCalibrationCache({ database, transport: transport(), identity });
    const stateStore = (await import("./mpcCalibrationSyncState")).createMpcCalibrationSyncStateStore(database, { now: () => 10 });
    const expectedState = await stateStore.queueSnapshot(identity, snapshot());
    const target = snapshot();
    target.cases.push({ ...structuredClone(target.cases[0]!), id: "case-two" });
    target.assets[0] = { ...target.assets[0]!, id: "remote-one", sha256: "952b50fd4fe30aee9420f479ff3f4c6268f2865ee65a82e1f8e157abc1455272" };
    target.assets.push({ ...structuredClone(target.assets[0]!), id: "remote-two", caseId: "case-two" });
    validateCalibrationHarnessSnapshot(target);
    const nextState = { ...expectedState, base: { revision: 2, snapshot: target }, queued: { generation: 2, snapshot: target }, dirtyGeneration: 2, updatedAt: 11 };
    const remote = transport();
    const getBlob = vi.spyOn(remote, "getBlob").mockResolvedValue(new Uint8Array([8, 7, 6, 5]));

    await expect(applyMpcCalibrationRecoveryCache({ database, transport: remote, identity, expectedState, nextState: nextState as never, snapshot: target })).resolves.toMatchObject({ status: "applied" });
    expect(getBlob).toHaveBeenCalledTimes(1);
    expect(await database.mpcCalibrationAssets.toArray()).toHaveLength(2);
    await expect(Promise.all((await database.mpcCalibrationAssets.toArray()).map(record => bytes(record.blob)))).resolves.toEqual([[8, 7, 6, 5], [8, 7, 6, 5]]);
  });

  it("blocks corrupt remote recovery bytes and pre-aborted recovery without canonical writes", async () => {
    const database = freshDatabase();
    await hydrateMpcCalibrationCache({ database, transport: transport(), identity });
    const stateStore = (await import("./mpcCalibrationSyncState")).createMpcCalibrationSyncStateStore(database, { now: () => 10 });
    const expectedState = await stateStore.queueSnapshot(identity, snapshot());
    const target = snapshot();
    target.assets[0] = { ...target.assets[0]!, sha256: "952b50fd4fe30aee9420f479ff3f4c6268f2865ee65a82e1f8e157abc1455272" };
    const nextState = { ...expectedState, base: { revision: 2, snapshot: target }, queued: { generation: 2, snapshot: target }, dirtyGeneration: 2, updatedAt: 11 };
    const corrupt = transport();
    corrupt.getBlob = async () => new Uint8Array([1, 2, 3, 4]);
    await expect(applyMpcCalibrationRecoveryCache({ database, transport: corrupt, identity, expectedState, nextState: nextState as never, snapshot: target })).resolves.toMatchObject({ status: "blocked" });
    expect((await database.mpcCalibrationSyncStates.get([identity.ownerId, identity.harnessId, identity.connectionId]))).toEqual(expectedState);
    const controller = new AbortController();
    controller.abort();
    const neverCalled = transport();
    const getSession = vi.spyOn(neverCalled, "getSession");
    await expect(applyMpcCalibrationRecoveryCache({ database, transport: neverCalled, identity, expectedState, nextState: nextState as never, snapshot: target, signal: controller.signal })).resolves.toMatchObject({ status: "cancelled" });
    expect(getSession).not.toHaveBeenCalled();
  });

  it("blocks corrupt local bytes and oversized declared remote recovery content before download", async () => {
    const database = freshDatabase();
    await hydrateMpcCalibrationCache({ database, transport: transport(), identity });
    const stateStore = (await import("./mpcCalibrationSyncState")).createMpcCalibrationSyncStateStore(database, { now: () => 10 });
    const expectedState = await stateStore.queueSnapshot(identity, snapshot());
    await database.mpcCalibrationAssets.update("asset", { blob: new Blob([new Uint8Array([4, 3, 2, 1])], { type: "image/png" }) });
    const target = snapshot();
    const nextState = { ...expectedState, base: { revision: 2, snapshot: target }, queued: { generation: 2, snapshot: target }, dirtyGeneration: 2, updatedAt: 11 };
    await expect(applyMpcCalibrationRecoveryCache({ database, transport: transport(), identity, expectedState, nextState: nextState as never, snapshot: target })).resolves.toMatchObject({ status: "blocked" });
    const oversized = structuredClone(target);
    oversized.assets[0] = { ...oversized.assets[0]!, byteLength: CALIBRATION_HARNESS_LIMITS.maxAssetBytes + 1 };
    const getBlob = vi.spyOn(transport(), "getBlob");
    await expect(applyMpcCalibrationRecoveryCache({ database, transport: { ...transport(), getBlob }, identity, expectedState, nextState: { ...nextState, base: { revision: 2, snapshot: oversized }, queued: { generation: 2, snapshot: oversized } } as never, snapshot: oversized })).resolves.toMatchObject({ status: "blocked" });
    expect(getBlob).not.toHaveBeenCalled();
  });

  it("rolls back recovery when binding persistence fails after its real write", async () => {
    const database = freshDatabase();
    await hydrateMpcCalibrationCache({ database, transport: transport(), identity });
    const stateStore = (await import("./mpcCalibrationSyncState")).createMpcCalibrationSyncStateStore(database, { now: () => 10 });
    const expectedState = await stateStore.queueSnapshot(identity, snapshot());
    const before = await bootstrapState(database);
    const target = snapshot();
    target.assets[0] = { ...target.assets[0]!, sha256: "952b50fd4fe30aee9420f479ff3f4c6268f2865ee65a82e1f8e157abc1455272" };
    const nextState = { ...expectedState, base: { revision: 2, snapshot: target }, queued: { generation: 2, snapshot: target }, dirtyGeneration: 2, updatedAt: 11 };
    const originalPut = database.mpcCalibrationCacheBindings.put.bind(database.mpcCalibrationCacheBindings);
    vi.spyOn(database.mpcCalibrationCacheBindings, "put").mockImplementation((async (...args: unknown[]) => {
      await Reflect.apply(originalPut, database.mpcCalibrationCacheBindings, args);
      throw new Error("quota after binding write");
    }) as unknown as typeof originalPut);
    const remote = transport();
    remote.getBlob = async () => new Uint8Array([8, 7, 6, 5]);

    await expect(applyMpcCalibrationRecoveryCache({ database, transport: remote, identity, expectedState, nextState: nextState as never, snapshot: target })).resolves.toMatchObject({ status: "failed" });
    await expect(bootstrapState(database)).resolves.toEqual(before);
    expect(await database.mpcCalibrationHydrationStaging.count()).toBe(0);
  });

  it("cancels a recovery after staging and preserves a newer queued state", async () => {
    const database = freshDatabase();
    await hydrateMpcCalibrationCache({ database, transport: transport(), identity });
    const stateStore = (await import("./mpcCalibrationSyncState")).createMpcCalibrationSyncStateStore(database, { now: () => 10 });
    const expectedState = await stateStore.queueSnapshot(identity, snapshot());
    const target = snapshot();
    target.assets[0] = { ...target.assets[0]!, sha256: "952b50fd4fe30aee9420f479ff3f4c6268f2865ee65a82e1f8e157abc1455272" };
    const nextState = { ...expectedState, base: { revision: 2, snapshot: target }, queued: { generation: 2, snapshot: target }, dirtyGeneration: 2, updatedAt: 11 };
    const remote = transport();
    let sessions = 0;
    remote.getSession = async () => {
      sessions += 1;
      if (sessions === 2) await stateStore.queueSnapshot(identity, snapshot());
      return { ownerId: identity.ownerId, harnessId: identity.harnessId };
    };
    remote.getBlob = async () => new Uint8Array([8, 7, 6, 5]);

    await expect(applyMpcCalibrationRecoveryCache({ database, transport: remote, identity, expectedState, nextState: nextState as never, snapshot: target })).resolves.toMatchObject({ status: "cancelled" });
    expect((await database.mpcCalibrationSyncStates.get([identity.ownerId, identity.harnessId, identity.connectionId]))!.dirtyGeneration).toBeGreaterThan(expectedState.dirtyGeneration);
    expect(await database.mpcCalibrationHydrationStaging.count()).toBe(0);
  });

  it("blocks an unqueued manual row before replacing the recovery cache", async () => {
    const database = freshDatabase();
    await hydrateMpcCalibrationCache({ database, transport: transport(), identity });
    const stateStore = (await import("./mpcCalibrationSyncState")).createMpcCalibrationSyncStateStore(database, { now: () => 10 });
    const expectedState = await stateStore.queueSnapshot(identity, snapshot());
    await database.mpcCalibrationDatasets.add({ id: "manual", name: "manual", targetCaseCount: 0, createdAt: 1, updatedAt: 1, version: 1 } as never);
    const target = snapshot();
    const nextState = { ...expectedState, base: { revision: 2, snapshot: target }, queued: { generation: 2, snapshot: target }, dirtyGeneration: 2, updatedAt: 11 };

    await expect(applyMpcCalibrationRecoveryCache({ database, transport: transport(), identity, expectedState, nextState: nextState as never, snapshot: target })).resolves.toMatchObject({ status: "blocked" });
    expect(await database.mpcCalibrationDatasets.get("manual")).toMatchObject({ name: "manual" });
  });

  it("distinguishes committed recovery cleanup failure from precommit cleanup failure", async () => {
    const committed = freshDatabase();
    await hydrateMpcCalibrationCache({ database: committed, transport: transport(), identity });
    const committedStore = (await import("./mpcCalibrationSyncState")).createMpcCalibrationSyncStateStore(committed, { now: () => 10 });
    const committedExpected = await committedStore.queueSnapshot(identity, snapshot());
    const target = snapshot();
    target.assets[0] = { ...target.assets[0]!, sha256: "952b50fd4fe30aee9420f479ff3f4c6268f2865ee65a82e1f8e157abc1455272" };
    const committedNext = { ...committedExpected, base: { revision: 2, snapshot: target }, queued: { generation: 2, snapshot: target }, dirtyGeneration: 2, updatedAt: 11 };
    vi.spyOn(committed.mpcCalibrationHydrationStaging, "bulkDelete").mockRejectedValue(new Error("committed cleanup failure"));
    const remote = transport();
    remote.getBlob = async () => new Uint8Array([8, 7, 6, 5]);
    await expect(applyMpcCalibrationRecoveryCache({ database: committed, transport: remote, identity, expectedState: committedExpected, nextState: committedNext as never, snapshot: target })).resolves.toMatchObject({ status: "applied", reason: "committed-staging-cleanup-failed" });
    expect((await committed.mpcCalibrationSyncStates.get([identity.ownerId, identity.harnessId, identity.connectionId]))!.base!.revision).toBe(2);

    const precommit = freshDatabase();
    await hydrateMpcCalibrationCache({ database: precommit, transport: transport(), identity });
    const precommitStore = (await import("./mpcCalibrationSyncState")).createMpcCalibrationSyncStateStore(precommit, { now: () => 10 });
    const precommitExpected = await precommitStore.queueSnapshot(identity, snapshot());
    const precommitNext = { ...precommitExpected, base: { revision: 2, snapshot: target }, queued: { generation: 2, snapshot: target }, dirtyGeneration: 2, updatedAt: 11 };
    const replacingSession = transport();
    let calls = 0;
    replacingSession.getSession = async () => ({ ownerId: calls++ === 0 ? identity.ownerId : "other", harnessId: identity.harnessId });
    replacingSession.getBlob = async () => new Uint8Array([8, 7, 6, 5]);
    vi.spyOn(precommit.mpcCalibrationHydrationStaging, "bulkDelete").mockRejectedValue(new Error("precommit cleanup failure"));
    await expect(applyMpcCalibrationRecoveryCache({ database: precommit, transport: replacingSession, identity, expectedState: precommitExpected, nextState: precommitNext as never, snapshot: target })).resolves.toMatchObject({ status: "failed", reason: "staging-cleanup-failed" });
    expect((await precommit.mpcCalibrationSyncStates.get([identity.ownerId, identity.harnessId, identity.connectionId]))).toEqual(precommitExpected);
  });

  it("treats a valid non-ACK-settled V2 state as clean during ordinary C3 hydration", async () => {
    const database = freshDatabase();
    await expect(hydrateMpcCalibrationCache({ database, transport: transport(), identity })).resolves.toMatchObject({ status: "hydrated" });
    const key: [string, string, string] = [identity.ownerId, identity.harnessId, identity.connectionId];
    const clean = await database.mpcCalibrationSyncStates.get(key);
    const base = clean!.base!;
    const observed = { revision: 2, snapshot: base.snapshot };
    await database.mpcCalibrationSyncStates.put({
      ...clean!, base: observed, dirtyGeneration: 1, sentGeneration: 1, settledGeneration: 1,
      lastRecovery: {
        kind: "observed-current-inflight", priorBase: base,
        priorQueued: { generation: 1, snapshot: base.snapshot },
        retiredInFlight: { generation: 1, snapshot: base.snapshot, expectedBaseRevision: base.revision },
        observed, resultingQueued: null, settledGeneration: 1,
      }, updatedAt: 12,
    } as never);

    const persisted = await database.mpcCalibrationSyncStates.get(key);
    expect(() => validateCalibrationHarnessRecoveryState(persisted)).not.toThrow();
    await expect(hydrateMpcCalibrationCache({ database, transport: transport(3), identity })).resolves.toEqual({ status: "hydrated", revision: 3 });
    expect((await database.mpcCalibrationSyncStates.get(key))!.base!.revision).toBe(3);
  });
});
