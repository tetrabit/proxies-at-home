import "fake-indexeddb/auto";
import { Blob as NativeBlob } from "node:buffer";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MpcCalibrationAssetRecord, MpcCalibrationCaseRecord, MpcCalibrationDatasetRecord } from "@/db";
import { ProxxiedDexie } from "@/db";
import { createMpcCalibrationSyncStateStore } from "./mpcCalibrationSyncState";
import {
  MPC_CALIBRATION_CACHE_BINDING_ID,
  MpcCalibrationMutationError,
  createMpcCalibrationMutationCoordinator,
} from "./mpcCalibrationMutations";

globalThis.Blob = NativeBlob as unknown as typeof Blob;

const identity = { ownerId: "owner", harnessId: "harness", connectionId: "connection" };
const handles: ProxxiedDexie[] = [];

function fresh(): ProxxiedDexie {
  const database = new ProxxiedDexie(`c6-mutations-${crypto.randomUUID()}`);
  handles.push(database);
  return database;
}

async function bound(database: ProxxiedDexie) {
  const state = createMpcCalibrationSyncStateStore(database, { now: () => 10 });
  await state.storeBaseWhenClean(identity, {
    revision: 1,
    snapshot: {
      version: 1,
      retainedRoot: { extension: ["root", "order"] },
      datasets: [],
      cases: [],
      assets: [],
      runs: [],
    },
  });
  await database.mpcCalibrationCacheBindings.put({
    id: MPC_CALIBRATION_CACHE_BINDING_ID,
    ...identity,
    revision: 1,
    updatedAt: 10,
  });
  return state;
}

afterEach(() => {
  for (const database of handles.splice(0)) database.close();
});

describe("mpcCalibrationMutations", () => {
  it("commits final rows with one queue generation and actual Blob metadata", async () => {
    const database = fresh();
    const state = await bound(database);
    const coordinator = createMpcCalibrationMutationCoordinator(database, { now: () => 11 });
    const bytes = new Uint8Array([4, 3, 2, 1]);

    await coordinator.mutate(async () => {
      const dataset: MpcCalibrationDatasetRecord & Record<string, unknown> = {
        id: "dataset", name: "Dataset", targetCaseCount: 1, createdAt: 1, updatedAt: 1, version: 1, retainedDataset: { nested: [2, 1] },
      };
      const calibrationCase: MpcCalibrationCaseRecord & Record<string, unknown> = {
        id: "case", datasetId: "dataset", createdAt: 1, updatedAt: 1,
        source: { name: "Card", retainedSource: { nested: ["first", "second"] } } as MpcCalibrationCaseRecord["source"] & Record<string, unknown>, candidates: [], retainedCase: true,
      };
      const asset: MpcCalibrationAssetRecord & Record<string, unknown> = {
        id: "asset", datasetId: "dataset", caseId: "case", role: "source", mimeType: "text/plain",
        blob: new Blob([bytes], { type: "image/png" }), createdAt: 1, hash: "stale", sha256: "0".repeat(64), byteLength: 999, retainedAsset: { array: [3, 1, 2] },
      };
      await database.mpcCalibrationDatasets.add(dataset);
      await database.mpcCalibrationCases.add(calibrationCase);
      await database.mpcCalibrationAssets.add(asset);
      return { value: undefined, changed: true };
    });

    const queued = await state.load(identity);
    expect(queued).toMatchObject({ dirtyGeneration: 1, queued: { generation: 1 } });
    expect(queued!.queued!.snapshot.retainedRoot).toEqual({ extension: ["root", "order"] });
    expect(queued!.queued!.snapshot.assets).toEqual([expect.objectContaining({
      id: "asset", mimeType: "image/png", byteLength: 4,
      sha256: "ee10da4aefe61a37df1dee937ca3221afa3b2351f9ea34edbbb769573c6785f7",
      retainedAsset: { array: [3, 1, 2] },
    })]);
    expect(await database.mpcCalibrationAssets.get("asset")).toMatchObject({
      id: "asset",
      mimeType: "image/png",
      byteLength: 4,
      sha256: "ee10da4aefe61a37df1dee937ca3221afa3b2351f9ea34edbbb769573c6785f7",
      retainedAsset: { array: [3, 1, 2] },
    });
  });

  it("rolls back prior rows and queue state when a real same-key state write rejects", async () => {
    const database = fresh();
    const state = await bound(database);
    const coordinator = createMpcCalibrationMutationCoordinator(database, { now: () => 11 });
    const before = await state.load(identity);
    const original = database.mpcCalibrationSyncStates.put.bind(database.mpcCalibrationSyncStates);
    const put = vi.spyOn(database.mpcCalibrationSyncStates, "put").mockImplementation((async (...args: unknown[]) => {
      await Reflect.apply(original, database.mpcCalibrationSyncStates, args);
      throw new Error("quota after state write");
    }) as unknown as typeof original);
    try {
      await expect(coordinator.mutate(async () => {
        await database.mpcCalibrationDatasets.put({ id: "dataset", name: "rolled back", targetCaseCount: 1, createdAt: 1, updatedAt: 1, version: 1 });
        return { value: undefined, changed: true };
      })).rejects.toThrow("quota after state write");
      expect(put).toHaveBeenCalledOnce();
      expect(await database.mpcCalibrationDatasets.get("dataset")).toBeUndefined();
      expect(await state.load(identity)).toEqual(before);
    } finally {
      put.mockRestore();
    }
  });

  it("rejects a captured local-only scope when a binding appears before commit", async () => {
    const database = fresh();
    const coordinator = createMpcCalibrationMutationCoordinator(database, { now: () => 11 });
    const scope = await coordinator.captureScope();
    const other = { ...identity, ownerId: "later-owner" };
    const state = createMpcCalibrationSyncStateStore(database, { now: () => 10 });
    await state.storeBaseWhenClean(other, {
      revision: 1,
      snapshot: { version: 1, datasets: [], cases: [], assets: [], runs: [] },
    });
    await database.mpcCalibrationCacheBindings.put({
      id: MPC_CALIBRATION_CACHE_BINDING_ID,
      ...other,
      revision: 1,
      updatedAt: 10,
    });

    await expect(coordinator.mutate(async () => {
      await database.mpcCalibrationDatasets.add({ id: "retargeted", name: "no", targetCaseCount: 1, createdAt: 1, updatedAt: 1, version: 1 });
      return { value: undefined, changed: true };
    }, scope)).rejects.toBeInstanceOf(MpcCalibrationMutationError);
    expect(await database.mpcCalibrationDatasets.get("retargeted")).toBeUndefined();
  });

  it("rejects a captured scope when another identity replaces the binding", async () => {
    const database = fresh();
    await bound(database);
    const coordinator = createMpcCalibrationMutationCoordinator(database, { now: () => 11 });
    const scope = await coordinator.captureScope();
    await database.mpcCalibrationCacheBindings.put({
      id: MPC_CALIBRATION_CACHE_BINDING_ID,
      ownerId: "other-owner",
      harnessId: identity.harnessId,
      connectionId: identity.connectionId,
      revision: 2,
      updatedAt: 12,
    });

    await expect(coordinator.mutate(async () => {
      await database.mpcCalibrationDatasets.add({ id: "wrong-target", name: "wrong", targetCaseCount: 1, createdAt: 1, updatedAt: 1, version: 1 });
      return { value: undefined, changed: true };
    }, scope)).rejects.toBeInstanceOf(MpcCalibrationMutationError);
    expect(await database.mpcCalibrationDatasets.get("wrong-target")).toBeUndefined();
  });

  it("rejects a captured scope after same-identity physical replacement without changing prior rows or queue", async () => {
    const database = fresh();
    const state = await bound(database);
    const coordinator = createMpcCalibrationMutationCoordinator(database, { now: () => 11 });
    await database.mpcCalibrationCases.put({
      id: "case", datasetId: "dataset", createdAt: 1, updatedAt: 1, source: { name: "remote" }, candidates: [],
    });
    const scope = await coordinator.captureScope();
    const before = await state.load(identity);
    await database.mpcCalibrationCacheBindings.put({
      id: MPC_CALIBRATION_CACHE_BINDING_ID,
      ...identity,
      revision: 2,
      updatedAt: 12,
    });

    await expect(coordinator.mutate(async () => ({ value: undefined, changed: false }), scope))
      .rejects.toBeInstanceOf(MpcCalibrationMutationError);

    expect(await database.mpcCalibrationCases.get("case")).toMatchObject({ source: { name: "remote" }, updatedAt: 1 });
    expect(await state.load(identity)).toEqual(before);
  });

  it("does not enqueue a generation when a writer reports changed but the final canonical content is unchanged", async () => {
    const database = fresh();
    const state = await bound(database);
    const coordinator = createMpcCalibrationMutationCoordinator(database, { now: () => 11 });

    await coordinator.mutate(async () => ({ value: undefined, changed: true }));

    expect(await state.load(identity)).toMatchObject({
      dirtyGeneration: 0,
      queued: null,
      base: { revision: 1 },
    });
  });
});
