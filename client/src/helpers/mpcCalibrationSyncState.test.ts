import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProxxiedDexie } from "@/db";
import {
  createMpcCalibrationSyncStateStore,
  MpcCalibrationSyncStateError,
} from "./mpcCalibrationSyncState";

const snapshot = {
  version: 1 as const,
  datasets: [],
  cases: [],
  assets: [],
  runs: [],
};
const identity = { ownerId: "owner", harnessId: "harness", connectionId: "connection" };
const handles: ProxxiedDexie[] = [];

function freshDatabase(): ProxxiedDexie {
  const database = new ProxxiedDexie(`mpc-calibration-sync-${crypto.randomUUID()}`);
  handles.push(database);
  return database;
}

afterEach(() => {
  for (const database of handles.splice(0)) database.close();
});

describe("mpcCalibrationSyncState", () => {
  it("persists a common base and the newest queued generation through reopen", async () => {
    const database = freshDatabase();
    const state = createMpcCalibrationSyncStateStore(database, { now: () => 10 });
    await state.storeBaseWhenClean(identity, { revision: 1, snapshot });
    await state.queueSnapshot(identity, { ...snapshot, retained: { generation: 1 } });
    const queued = await state.markSnapshotSent(identity, 1);
    expect(queued).toMatchObject({ dirtyGeneration: 1, sentGeneration: 1, acknowledgedGeneration: 0, queued: { generation: 1 }, inFlight: { generation: 1, expectedBaseRevision: 1 }, base: { revision: 1 } });
    database.close();

    const reopened = new ProxxiedDexie(database.name);
    handles.push(reopened);
    const reloaded = await createMpcCalibrationSyncStateStore(reopened, { now: () => 11 }).load(identity);
    expect(reloaded).toEqual(queued);
  });

  it("rejects null, regressive, and same-revision changed bases without changing the installed row", async () => {
    const database = freshDatabase();
    const state = createMpcCalibrationSyncStateStore(database, { now: () => 15 });
    const installed = { revision: 5, snapshot: { ...snapshot, retained: "revision-five" } };
    await state.storeBaseWhenClean(identity, installed);
    const before = await state.load(identity);

    await expect(state.storeBaseWhenClean(identity, null)).rejects.toThrow(MpcCalibrationSyncStateError);
    await expect(state.storeBaseWhenClean(identity, { revision: 4, snapshot })).rejects.toThrow(MpcCalibrationSyncStateError);
    await expect(state.storeBaseWhenClean(identity, { revision: 5, snapshot })).rejects.toThrow(MpcCalibrationSyncStateError);
    expect(await state.load(identity)).toEqual(before);

    await expect(state.storeBaseWhenClean(identity, { revision: 5, snapshot: installed.snapshot })).resolves.toEqual(before);
  });

  it("binds acknowledgements to both exact sent snapshots and retains newer queued edits", async () => {
    const database = freshDatabase();
    const state = createMpcCalibrationSyncStateStore(database, { now: () => 20 });
    const base1 = { revision: 1, snapshot };
    const snapshot1 = { ...snapshot, retained: { generation: 1 } };
    const snapshot2 = { ...snapshot, retained: { generation: 2 } };
    await state.storeBaseWhenClean(identity, base1);
    await state.queueSnapshot(identity, snapshot1);
    await state.markSnapshotSent(identity, 1);
    await state.queueSnapshot(identity, snapshot2);
    const beforeWrongAck = await state.load(identity);

    await expect(state.acknowledge({ ...identity, generation: 2, snapshot: snapshot2, expectedBaseRevision: 1, base: { revision: 2, snapshot: snapshot2 } })).rejects.toThrow(/inFlight/i);
    await expect(state.acknowledge({ ...identity, generation: 1, snapshot: snapshot2, expectedBaseRevision: 1, base: { revision: 2, snapshot: snapshot1 } })).rejects.toThrow(/snapshot/i);
    await expect(state.acknowledge({ ...identity, generation: 1, snapshot: snapshot1, expectedBaseRevision: 1, base: { revision: 2, snapshot } })).rejects.toThrow(/snapshot/i);
    expect(await state.load(identity)).toEqual(beforeWrongAck);

    const acknowledged1 = await state.acknowledge({ ...identity, generation: 1, snapshot: snapshot1, expectedBaseRevision: 1, base: { revision: 2, snapshot: snapshot1 } });
    expect(acknowledged1).toMatchObject({ acknowledgedGeneration: 1, sentGeneration: 1, dirtyGeneration: 2, base: { revision: 2 }, queued: { generation: 2, snapshot: snapshot2 }, inFlight: null });

    await state.markSnapshotSent(identity, 2);
    const clean = await state.acknowledge({ ...identity, generation: 2, snapshot: snapshot2, expectedBaseRevision: 2, base: { revision: 3, snapshot: snapshot2 } });
    expect(clean).toMatchObject({ dirtyGeneration: 2, sentGeneration: 2, acknowledgedGeneration: 2, queued: null, inFlight: null, base: { revision: 3 } });
  });

  it("allows only the exact latest acknowledgement receipt to replay idempotently", async () => {
    const database = freshDatabase();
    const state = createMpcCalibrationSyncStateStore(database, { now: () => 25 });
    const sent = { ...snapshot, retained: "sent" };
    const receipt = { ...identity, generation: 1, snapshot: sent, expectedBaseRevision: null, base: { revision: 1, snapshot: sent } };
    await state.queueSnapshot(identity, sent);
    await state.markSnapshotSent(identity, 1);
    const acknowledged = await state.acknowledge(receipt);
    expect(acknowledged).toMatchObject({
      dirtyGeneration: 1,
      sentGeneration: 1,
      acknowledgedGeneration: 1,
      queued: null,
      inFlight: null,
      base: { revision: 1, snapshot: sent },
    });

    await expect(state.acknowledge(receipt)).resolves.toEqual(acknowledged);
    await expect(state.acknowledge({ ...receipt, expectedBaseRevision: 999 })).rejects.toThrow();
    await expect(state.acknowledge({ ...receipt, base: { revision: 1, snapshot } })).rejects.toThrow();
    await expect(state.acknowledge({ ...receipt, base: { revision: 0, snapshot: sent } })).rejects.toThrow();
    await expect(state.acknowledge({ ...receipt, unexpected: true } as never)).rejects.toThrow();

    const accessorReceipt = { ...receipt } as Record<string, unknown>;
    let getterCalls = 0;
    Object.defineProperty(accessorReceipt, "generation", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return 1;
      },
    });
    await expect(state.acknowledge(accessorReceipt as never)).rejects.toThrow();
    expect(getterCalls).toBe(0);

    await state.storeBaseWhenClean(identity, { revision: 2, snapshot: { ...sent, retained: "later base" } });
    await expect(state.acknowledge(receipt)).resolves.toEqual(await state.load(identity));

    await state.queueSnapshot(identity, { ...snapshot, retained: "second" });
    await state.markSnapshotSent(identity, 2);
    await state.acknowledge({ ...identity, generation: 2, snapshot: { ...snapshot, retained: "second" }, expectedBaseRevision: 2, base: { revision: 3, snapshot: { ...snapshot, retained: "second" } } });
    await expect(state.acknowledge(receipt)).rejects.toThrow();
  });

  it("rejects unsent and overflowed generations without altering durable state", async () => {
    const database = freshDatabase();
    const state = createMpcCalibrationSyncStateStore(database, { now: () => 28 });
    const unsent = { ...snapshot, retained: "unsent" };
    await state.queueSnapshot(identity, unsent);
    await expect(state.acknowledge({
      ...identity,
      generation: 1,
      snapshot: unsent,
      expectedBaseRevision: null,
      base: { revision: 1, snapshot: unsent },
    })).rejects.toThrow(/inFlight/i);
    expect((await state.load(identity))?.queued).toEqual({ generation: 1, snapshot: unsent });

    await database.mpcCalibrationSyncStates.put({
      formatVersion: 1,
      ...identity,
      base: null,
      queued: null,
      inFlight: null,
      dirtyGeneration: Number.MAX_SAFE_INTEGER,
      sentGeneration: Number.MAX_SAFE_INTEGER,
      acknowledgedGeneration: Number.MAX_SAFE_INTEGER,
      updatedAt: 28,
    } as never);
    await expect(state.queueSnapshot(identity, snapshot)).rejects.toThrow(/overflow/i);
    expect((await state.load(identity))?.dirtyGeneration).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("converts a valid persisted V1 row only when transitioning and retains it through reopen", async () => {
    const database = freshDatabase();
    const legacy = {
      formatVersion: 1 as const, ...identity, base: { revision: 1, snapshot },
      queued: { generation: 1, snapshot: { ...snapshot, retained: { legacy: true } } }, inFlight: null,
      dirtyGeneration: 1, sentGeneration: 0, acknowledgedGeneration: 0, updatedAt: 1,
    };
    await database.mpcCalibrationSyncStates.put(legacy as never);
    const retainedBlob = new Blob(["legacy-asset"], { type: "application/octet-stream" });
    await database.settings.put({ id: "legacy-setting", value: { preserved: true } });
    await database.mpcCalibrationAssets.put({
      id: "legacy-asset",
      datasetId: "dataset",
      caseId: "case",
      role: "source",
      mimeType: retainedBlob.type,
      blob: retainedBlob,
      createdAt: 1,
      retained: { unrelated: true },
    } as never);
    const state = createMpcCalibrationSyncStateStore(database, { now: () => 31 });
    expect(await state.load(identity)).toEqual(legacy);
    expect(await database.mpcCalibrationSyncStates.get([identity.ownerId, identity.harnessId, identity.connectionId])).toEqual(legacy);
    expect(await database.settings.get("legacy-setting")).toEqual({ id: "legacy-setting", value: { preserved: true } });
    const preservedAsset = await database.mpcCalibrationAssets.get("legacy-asset");
    expect(preservedAsset).toMatchObject({ id: "legacy-asset", retained: { unrelated: true }, mimeType: "application/octet-stream" });
    expect(await preservedAsset!.blob.arrayBuffer()).toEqual(await retainedBlob.arrayBuffer());

    const transitioned = await state.markSnapshotSent(identity, 1);
    expect(transitioned).toMatchObject({ formatVersion: 2, settledGeneration: 0, lastRecovery: null, inFlight: { generation: 1 } });
    expect(await database.mpcCalibrationSyncStates.get([identity.ownerId, identity.harnessId, identity.connectionId])).toEqual(transitioned);
    expect(await database.settings.get("legacy-setting")).toEqual({ id: "legacy-setting", value: { preserved: true } });
    database.close();
    const reopened = new ProxxiedDexie(database.name);
    handles.push(reopened);
    expect(await createMpcCalibrationSyncStateStore(reopened).load(identity)).toEqual(transitioned);
    expect(await reopened.settings.get("legacy-setting")).toEqual({ id: "legacy-setting", value: { preserved: true } });
    const reopenedAsset = await reopened.mpcCalibrationAssets.get("legacy-asset");
    expect(reopenedAsset).toMatchObject({ id: "legacy-asset", retained: { unrelated: true }, mimeType: "application/octet-stream" });
    expect(await reopenedAsset!.blob.arrayBuffer()).toEqual(await retainedBlob.arrayBuffer());
  });

  it("fails closed on corrupt rows and is isolated from generic settings and preferences", async () => {
    const database = freshDatabase();
    const state = createMpcCalibrationSyncStateStore(database, { now: () => 30 });
    const queued = await state.queueSnapshot(identity, snapshot);
    await database.settings.put({ id: "default", value: { unrelated: true } });
    await database.userPreferences.put({ id: "default", retained: "unrelated" } as never);
    await database.settings.clear();
    await database.userPreferences.put({ id: "default", retained: "rewritten" } as never);
    expect(await state.load(identity)).toEqual(queued);

    const corrupt = { ...queued, queued: { generation: 1, snapshot: { version: 1, datasets: [], cases: [], assets: [], runs: "bad" } } };
    await database.mpcCalibrationSyncStates.put(corrupt as never);
    await expect(state.load(identity)).rejects.toBeInstanceOf(MpcCalibrationSyncStateError);
    expect(await database.mpcCalibrationSyncStates.get([identity.ownerId, identity.harnessId, identity.connectionId])).toEqual(corrupt);
  });

  it("rolls back a real same-key state put when persistence fails after the put resolves", async () => {
    const database = freshDatabase();
    const state = createMpcCalibrationSyncStateStore(database, { now: () => 35 });
    const before = await state.queueSnapshot(identity, { ...snapshot, retained: "before" });
    const put = database.mpcCalibrationSyncStates.put.bind(database.mpcCalibrationSyncStates);
    const failure = new Error("post-put failure");
    const spy = vi.spyOn(database.mpcCalibrationSyncStates, "put").mockImplementation((row, key) =>
      put(row, key).then(() => { throw failure; })
    );

    await expect(state.queueSnapshot(identity, { ...snapshot, retained: "after" })).rejects.toThrow("post-put failure");
    spy.mockRestore();

    expect(await database.mpcCalibrationSyncStates.get([identity.ownerId, identity.harnessId, identity.connectionId])).toEqual(before);
    expect(await state.load(identity)).toEqual(before);
  });
});
