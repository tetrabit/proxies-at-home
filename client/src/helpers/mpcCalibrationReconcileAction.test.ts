import "fake-indexeddb/auto";
import { Blob as NativeBlob } from "node:buffer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProxxiedDexie } from "@/db";
import type { CalibrationHarnessSnapshot } from "../../../shared/calibrationHarness";
import { recoverAndFlushMpcCalibration } from "./mpcCalibrationRecovery";
import { createMpcCalibrationSyncStateStore } from "./mpcCalibrationSyncState";
import {
  reconcileMpcCalibrationMerge,
  resetMpcCalibrationToRemote,
} from "./mpcCalibrationReconcileAction";
import type { MpcCalibrationTransport } from "./mpcCalibrationTransport";

globalThis.Blob = NativeBlob as unknown as typeof Blob;

const identity = { ownerId: "owner", harnessId: "harness", connectionId: "connection" };
const assetBytes = new Uint8Array([1, 2, 3, 4]);
const assetHash = "9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a";
const handles: ProxxiedDexie[] = [];

function fresh(): ProxxiedDexie {
  const database = new ProxxiedDexie(`reconcile-${crypto.randomUUID()}`);
  handles.push(database);
  return database;
}

function snapshot(tag: string, extraCase: boolean): CalibrationHarnessSnapshot {
  const base = {
    version: 1,
    retained: { tag },
    datasets: [{ id: "dataset", name: "Dataset", targetCaseCount: extraCase ? 2 : 1, createdAt: 1, updatedAt: 1, version: 1 }],
    cases: [
      { id: "a", datasetId: "dataset", createdAt: 1, updatedAt: 1, source: { name: "a" }, candidates: [], notes: "remote A" },
    ],
    assets: [],
    runs: [],
  } as unknown as CalibrationHarnessSnapshot;
  if (extraCase) {
    base.cases.push({ id: "b", datasetId: "dataset", createdAt: 1, updatedAt: 1, source: { name: "b" }, candidates: [], notes: "remote B" });
    base.assets.push({
      id: "remote-asset", datasetId: "dataset", caseId: "b", role: "source",
      mimeType: "image/png", createdAt: 1, hash: "legacy", sha256: assetHash, byteLength: assetBytes.byteLength,
    });
  }
  return base;
}

function remote(initial: CalibrationHarnessSnapshot, revision: number): MpcCalibrationTransport {
  let currentRevision = revision;
  let current = structuredClone(initial);
  return {
    pair: async () => ({ ownerId: identity.ownerId, harnessId: identity.harnessId }),
    unpair: async () => undefined,
    getSession: async () => ({ ownerId: identity.ownerId, harnessId: identity.harnessId }),
    getSnapshot: async () => ({ revision: currentRevision, snapshot: structuredClone(current) }),
    getBlob: async (hash) => {
      if (hash !== assetHash) throw new Error("unknown blob");
      return assetBytes.slice();
    },
    missingBlobs: async () => ({ missing: [] }),
    putBlob: async () => { throw new Error("not needed"); },
    publishSnapshot: async (next, expected) => {
      if (expected !== currentRevision) throw Object.assign(new Error("precondition"), { status: 412 });
      current = structuredClone(next);
      currentRevision += 1;
      return { revision: currentRevision, snapshot: structuredClone(current) };
    },
  };
}

async function seeded() {
  const database = fresh();
  const base = snapshot("base", true);
  await database.mpcCalibrationDatasets.bulkPut(base.datasets as never);
  await database.mpcCalibrationCases.bulkPut([{ ...base.cases[0]!, notes: "local A" }] as never);
  await database.mpcCalibrationCacheBindings.put({
    id: "mpc-calibration-cache-binding",
    ...identity,
    revision: 1,
    updatedAt: 1,
  });
  return { database, base };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const db of handles.splice(0)) db.close();
});

describe("reconcileMpcCalibrationMerge", () => {
  it("fails with missing-binding when no cache binding exists", async () => {
    const database = fresh();
    await expect(
      reconcileMpcCalibrationMerge({ database, transport: remote(snapshot("base", true), 1) }),
    ).rejects.toMatchObject({ code: "missing-binding" });
  });

  it("fails with identity-mismatch when the session identity diverges from the binding", async () => {
    const { database } = await seeded();
    const transport = remote(snapshot("base", true), 1);
    transport.getSession = async () => ({ ownerId: "someone-else", harnessId: identity.harnessId });
    await expect(
      reconcileMpcCalibrationMerge({ database, transport }),
    ).rejects.toMatchObject({ code: "identity-mismatch" });
  });

  it("fails with no-remote-snapshot when the remote is empty", async () => {
    const { database } = await seeded();
    const transport = remote(snapshot("base", false), 1);
    transport.getSnapshot = async () => null;
    await expect(
      reconcileMpcCalibrationMerge({ database, transport }),
    ).rejects.toMatchObject({ code: "no-remote-snapshot" });
  });

  it("unites local and remote rows, verifies blobs, anchors the base, and queues the union", async () => {
    const { database, base } = await seeded();
    const transport = remote(base, 1);
    const state = createMpcCalibrationSyncStateStore(database, { now: () => 10 });

    const result = await reconcileMpcCalibrationMerge({ database, transport });

    expect(result).toMatchObject({ baseRevision: 1, delta: { cases: 1, assets: 1 } });
    // Remote-only case and its verified blob are present locally.
    const remoteCase = await database.mpcCalibrationCases.get("b");
    expect(remoteCase).toMatchObject({ id: "b", notes: "remote B" });
    const staged = await database.mpcCalibrationAssets.get("remote-asset");
    expect(staged).toMatchObject({ sha256: assetHash, byteLength: 4 });
    expect(Array.from(new Uint8Array(await staged!.blob.arrayBuffer()))).toEqual([...assetBytes]);
    // Local rows are untouched.
    expect(await database.mpcCalibrationCases.get("a")).toMatchObject({ notes: "local A" });
    // State is anchored to the observed remote revision and the union is queued.
    expect(await state.load(identity)).toMatchObject({
      base: { revision: 1 },
      queued: { generation: 1 },
    });
    const queuedState = await state.load(identity);
    expect(queuedState?.queued?.snapshot.cases.map((record) => record.id).sort()).toEqual(["a", "b"]);
    expect(queuedState?.queued?.snapshot.cases.find((record) => record.id === "a")?.notes).toBe("local A");
    const binding = await database.mpcCalibrationCacheBindings.get("mpc-calibration-cache-binding");
    expect(binding?.revision).toBe(1);
  });

  it("fails with blob-verification-failed when the remote blob content diverges", async () => {
    const { database, base } = await seeded();
    const transport = remote(base, 1);
    transport.getBlob = async () => new Uint8Array([9, 9, 9, 9]);
    await expect(
      reconcileMpcCalibrationMerge({ database, transport }),
    ).rejects.toMatchObject({ code: "blob-verification-failed" });
    expect(await database.mpcCalibrationCases.count()).toBe(1);
    expect(await database.mpcCalibrationSyncStates.count()).toBe(0);
  });

  it("settles to a clean published state through the real queue-recovery machinery", async () => {
    const { database, base } = await seeded();
    const transport = remote(base, 1);

    await reconcileMpcCalibrationMerge({ database, transport });
    const flush = await recoverAndFlushMpcCalibration({ database, transport, identity, maxCycles: 4 });

    expect(flush).toMatchObject({ status: "published", generation: 1 });
    const published = (await transport.getSnapshot())!;
    expect(published.revision).toBe(2);
    expect(published.snapshot.cases.find((record) => record.id === "a")?.notes).toBe("local A");
    expect(published.snapshot.cases.find((record) => record.id === "b")?.notes).toBe("remote B");
    const state = createMpcCalibrationSyncStateStore(database, { now: () => 20 });
    expect(await state.load(identity)).toMatchObject({
      base: { revision: 2 },
      queued: null,
      inFlight: null,
      acknowledgedGeneration: 1,
    });
  });
});

describe("resetMpcCalibrationToRemote", () => {
  it("clears every calibration table and leaves the other tables untouched", async () => {
    const database = fresh();
    await database.mpcCalibrationDatasets.put({ id: "dataset", name: "Dataset", targetCaseCount: 1, createdAt: 1, updatedAt: 1, version: 1 } as never);
    await database.mpcCalibrationCases.put({ id: "a", datasetId: "dataset", createdAt: 1, updatedAt: 1, source: { name: "a" }, candidates: [] } as never);
    await database.mpcCalibrationAssets.put({
      id: "asset", datasetId: "dataset", caseId: "a", role: "source", mimeType: "image/png",
      createdAt: 1, hash: "legacy", sha256: assetHash, byteLength: 4, blob: new NativeBlob([assetBytes]),
    } as never);
    await database.mpcCalibrationRuns.put({
      id: "run", datasetId: "dataset", algorithmId: "algorithm", algorithmLabel: "Algorithm", createdAt: 1,
      summary: { totalCases: 1, matchedCases: 1, mismatchedCases: 0, accuracy: 1 },
      results: [{ caseId: "a", matched: true }],
    } as never);
    await database.mpcCalibrationSyncStates.put({
      formatVersion: 2,
      ...identity,
      base: null,
      queued: null,
      inFlight: null,
      lastAcknowledgement: null,
      settledGeneration: 0,
      lastRecovery: null,
      dirtyGeneration: 0,
      sentGeneration: 0,
      acknowledgedGeneration: 0,
      updatedAt: 1,
    } as never);
    await database.mpcCalibrationCacheBindings.put({ id: "mpc-calibration-cache-binding", ...identity, revision: 1, updatedAt: 1 });
    await database.mpcCalibrationLinkStates.put({ formatVersion: 1, ...identity, updatedAt: 1 });
    await database.mpcCalibrationHydrationStaging.put({
      id: "staged", operationId: "op", ...identity, assetId: "asset", sha256: assetHash, byteLength: 4,
      blob: new NativeBlob([assetBytes]), createdAt: 1,
    } as never);
    await database.cards.put({ uuid: "card-1", name: "Sol Ring" } as never);
    await database.projects.put({ id: "project-1", name: "Project" } as never);

    const result = await resetMpcCalibrationToRemote(database);

    expect(result).toEqual({ clearedTables: 8 });
    expect(await database.mpcCalibrationDatasets.count()).toBe(0);
    expect(await database.mpcCalibrationCases.count()).toBe(0);
    expect(await database.mpcCalibrationAssets.count()).toBe(0);
    expect(await database.mpcCalibrationRuns.count()).toBe(0);
    expect(await database.mpcCalibrationSyncStates.count()).toBe(0);
    expect(await database.mpcCalibrationCacheBindings.count()).toBe(0);
    expect(await database.mpcCalibrationLinkStates.count()).toBe(0);
    expect(await database.mpcCalibrationHydrationStaging.count()).toBe(0);
    expect(await database.cards.get("card-1")).toMatchObject({ name: "Sol Ring" });
    expect(await database.projects.get("project-1")).toMatchObject({ name: "Project" });
  });

  it("clears idempotently on an already-empty database", async () => {
    const database = fresh();
    await expect(resetMpcCalibrationToRemote(database)).resolves.toEqual({ clearedTables: 8 });
  });
});
