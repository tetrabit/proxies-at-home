import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProxxiedDexie } from "@/db";
import { validateCalibrationHarnessRecoveryState } from "../../../shared/calibrationHarnessRecoveryState";
import { createMpcCalibrationSyncStateStore } from "./mpcCalibrationSyncState";
import {
  createMpcCalibrationLinkStateStore,
  MpcCalibrationLinkStateError,
} from "./mpcCalibrationLinkState";

const handles: ProxxiedDexie[] = [];
const session = { ownerId: "owner", harnessId: "harness" };

function freshDatabase(): ProxxiedDexie {
  const database = new ProxxiedDexie(`link-state-${crypto.randomUUID()}`);
  handles.push(database);
  return database;
}

async function readProtocolRows(database: ProxxiedDexie) {
  return {
    binding: await database.mpcCalibrationCacheBindings.toArray(),
    sync: await database.mpcCalibrationSyncStates.toArray(),
    datasets: await database.mpcCalibrationDatasets.toArray(),
    settings: await database.settings.toArray(),
    preferences: await database.userPreferences.toArray(),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const database of handles.splice(0)) database.close();
});

describe("mpcCalibrationLinkState", () => {
  it("creates one non-secret owner/harness-bound connection ID and preserves it through concurrent restart", async () => {
    const database = freshDatabase();
    const store = createMpcCalibrationLinkStateStore(database, {
      now: () => 10,
      createConnectionId: () => "generated-connection",
    });

    const [first, concurrent] = await Promise.all([
      store.resolve(session),
      store.resolve({ ...session }),
    ]);
    expect(first).toEqual({ ownerId: "owner", harnessId: "harness", connectionId: "generated-connection" });
    expect(concurrent).toEqual(first);
    expect(await database.mpcCalibrationLinkStates.toArray()).toEqual([
      { formatVersion: 1, ...first, updatedAt: 10 },
    ]);

    database.close();
    const reopened = new ProxxiedDexie(database.name);
    handles.push(reopened);
    await expect(createMpcCalibrationLinkStateStore(reopened).resolve(session)).resolves.toEqual(first);
  });

  it("keeps distinct owner/harness identities isolated without delimiter-key collisions", async () => {
    const database = freshDatabase();
    let sequence = 0;
    const store = createMpcCalibrationLinkStateStore(database, {
      createConnectionId: () => `connection-${++sequence}`,
    });

    const ownerSplit = await store.resolve({ ownerId: "a:b", harnessId: "c" });
    const harnessSplit = await store.resolve({ ownerId: "a", harnessId: "b:c" });
    const otherOwner = await store.resolve({ ownerId: "other", harnessId: "c" });

    expect([ownerSplit.connectionId, harnessSplit.connectionId, otherOwner.connectionId]).toEqual([
      "connection-1", "connection-2", "connection-3",
    ]);
    expect(await database.mpcCalibrationLinkStates.count()).toBe(3);
  });

  it("rejects invalid, accessor, symbol, extra, and null session input before any write", async () => {
    const database = freshDatabase();
    const store = createMpcCalibrationLinkStateStore(database);
    const accessor = { ownerId: "owner", harnessId: "harness" } as Record<string, unknown>;
    let reads = 0;
    Object.defineProperty(accessor, "ownerId", {
      enumerable: true,
      get() { reads += 1; return "owner"; },
    });

    for (const invalid of [
      null,
      { ownerId: "owner" },
      { ownerId: "owner", harnessId: "harness", credential: "never-store" },
      { ownerId: "owner", harnessId: "harness", [Symbol("authority")]: "never-store" },
      accessor,
    ]) {
      await expect(store.resolve(invalid as never)).rejects.toBeInstanceOf(MpcCalibrationLinkStateError);
    }
    expect(reads).toBe(0);
    expect(await database.mpcCalibrationLinkStates.count()).toBe(0);
  });

  it("captures the session before an await so mutation cannot retarget the durable row", async () => {
    const database = freshDatabase();
    const store = createMpcCalibrationLinkStateStore(database, { createConnectionId: () => "captured" });
    const mutable = { ownerId: "owner", harnessId: "harness" };
    const transaction = database.transaction.bind(database);
    let entered!: () => void;
    let release!: () => void;
    const enteredTransaction = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(database, "transaction").mockImplementation((async (...args: unknown[]) => {
      entered();
      await gate;
      return Reflect.apply(transaction, database, args);
    }) as never);

    const pending = store.resolve(mutable);
    await enteredTransaction;
    mutable.ownerId = "retargeted";
    mutable.harnessId = "retargeted";
    release();

    await expect(pending).resolves.toEqual({ ownerId: "owner", harnessId: "harness", connectionId: "captured" });
    expect(await database.mpcCalibrationLinkStates.get(["owner", "harness"])).toMatchObject({ connectionId: "captured" });
    expect(await database.mpcCalibrationLinkStates.get(["retargeted", "retargeted"])).toBeUndefined();
  });

  it("preserves the default Crypto generator receiver", async () => {
    const database = freshDatabase();
    const receiver = globalThis.crypto;
    vi.spyOn(receiver, "randomUUID").mockImplementation(function (this: Crypto) {
      if (this !== receiver) throw new TypeError("Illegal invocation");
      return "00000000-0000-4000-8000-000000000001";
    });

    await expect(createMpcCalibrationLinkStateStore(database).resolve(session)).resolves.toEqual({
      ownerId: "owner",
      harnessId: "harness",
      connectionId: "00000000-0000-4000-8000-000000000001",
    });
  });

  it("rejects malformed protocol rows without deriving link metadata from identity fields", async () => {
    const database = freshDatabase();
    const malformed = {
      formatVersion: 99,
      ownerId: "owner",
      harnessId: "harness",
      connectionId: "retained",
      unexpected: "unchanged",
    };
    await database.mpcCalibrationSyncStates.put(malformed as never);
    const before = await readProtocolRows(database);

    await expect(createMpcCalibrationLinkStateStore(database).resolve(session)).rejects.toBeInstanceOf(MpcCalibrationLinkStateError);

    expect(await database.mpcCalibrationLinkStates.count()).toBe(0);
    expect(await readProtocolRows(database)).toEqual(before);
  });

  it("preserves valid V1 and V2 queued, in-flight, and acknowledgement protocol state while selecting its ID", async () => {
    const baseSnapshot = { version: 1 as const, datasets: [], cases: [], assets: [], runs: [] };
    for (const formatVersion of [1, 2] as const) {
      const database = freshDatabase();
      const identity = { ...session, connectionId: `protocol-${formatVersion}` };
      const protocol = createMpcCalibrationSyncStateStore(database, { now: () => 10 });
      const firstSnapshot = { ...baseSnapshot, retained: { generation: 1 } };
      const secondSnapshot = { ...baseSnapshot, retained: { generation: 2 } };
      await protocol.queueSnapshot(identity, firstSnapshot);
      await protocol.markSnapshotSent(identity, 1);
      await protocol.acknowledge({
        ...identity,
        generation: 1,
        snapshot: firstSnapshot,
        expectedBaseRevision: null,
        base: { revision: 1, snapshot: firstSnapshot },
      });
      await protocol.queueSnapshot(identity, secondSnapshot);
      const v2 = await protocol.markSnapshotSent(identity, 2);
      if (v2.formatVersion !== 2) throw new Error("expected writable V2 protocol state");
      if (formatVersion === 1) {
        const { settledGeneration: _settledGeneration, lastRecovery: _lastRecovery, ...legacy } = v2;
        await database.mpcCalibrationSyncStates.put({ ...legacy, formatVersion: 1 } as never);
      }
      const before = await readProtocolRows(database);

      await expect(createMpcCalibrationLinkStateStore(database).resolve(session)).resolves.toEqual(identity);

      expect(await readProtocolRows(database)).toEqual(before);
      expect(await database.mpcCalibrationLinkStates.get([session.ownerId, session.harnessId])).toEqual({
        formatVersion: 1,
        ...identity,
        updatedAt: expect.any(Number),
      });
    }
  });

  it("preserves valid V2 recovery proof state while selecting its ID", async () => {
    const database = freshDatabase();
    const identity = { ...session, connectionId: "recovered-protocol" };
    const baseSnapshot = { version: 1 as const, datasets: [], cases: [], assets: [], runs: [], retained: { exact: "base" } };
    const priorQueued = { generation: 1, snapshot: { ...baseSnapshot, retained: { exact: "sent" } } };
    const observed = { revision: 2, snapshot: structuredClone(priorQueued.snapshot) };
    const recovered = validateCalibrationHarnessRecoveryState({
      formatVersion: 2,
      ...identity,
      base: observed,
      queued: null,
      inFlight: null,
      lastAcknowledgement: null,
      settledGeneration: 1,
      lastRecovery: {
        kind: "observed-current-inflight",
        priorBase: { revision: 1, snapshot: baseSnapshot },
        priorQueued,
        retiredInFlight: { ...priorQueued, expectedBaseRevision: 1 },
        observed,
        resultingQueued: null,
        settledGeneration: 1,
      },
      dirtyGeneration: 1,
      sentGeneration: 1,
      acknowledgedGeneration: 0,
      updatedAt: 10,
    });
    await database.mpcCalibrationSyncStates.put(recovered);
    const before = await readProtocolRows(database);

    await expect(createMpcCalibrationLinkStateStore(database).resolve(session)).resolves.toEqual(identity);

    expect(await readProtocolRows(database)).toEqual(before);
  });

  it("reuses a matching physical binding without rewriting complete C1/C6 state", async () => {
    const database = freshDatabase();
    const identity = { ownerId: "owner", harnessId: "harness", connectionId: "bound-connection" };
    await database.mpcCalibrationCacheBindings.put({ id: "mpc-calibration-cache-binding", ...identity, revision: 4, updatedAt: 7 });
    await database.mpcCalibrationSyncStates.put({
      formatVersion: 1, ...identity, base: null, queued: null, inFlight: null,
      dirtyGeneration: 0, sentGeneration: 0, acknowledgedGeneration: 0, updatedAt: 8,
    } as never);
    await database.mpcCalibrationDatasets.put({ id: "dataset", name: "retained", targetCaseCount: 1, createdAt: 1, updatedAt: 2, version: 1 } as never);
    const before = await readProtocolRows(database);

    await expect(createMpcCalibrationLinkStateStore(database, {
      createConnectionId: () => "must-not-mint",
    }).resolve(session)).resolves.toEqual(identity);

    expect(await readProtocolRows(database)).toEqual(before);
    expect(await database.mpcCalibrationLinkStates.get(["owner", "harness"])).toEqual({ formatVersion: 1, ...identity, updatedAt: expect.any(Number) });
  });

  it("fails closed and preserves all rows for contradictory or ambiguous protocol state", async () => {
    const database = freshDatabase();
    const store = createMpcCalibrationLinkStateStore(database, { createConnectionId: () => "new" });
    await database.mpcCalibrationLinkStates.put({ formatVersion: 1, ...session, connectionId: "stored", updatedAt: 1 });
    await database.mpcCalibrationCacheBindings.put({
      id: "mpc-calibration-cache-binding", ...session, connectionId: "bound", revision: 1, updatedAt: 1,
    });
    const contradictory = await readProtocolRows(database);
    await expect(store.resolve(session)).rejects.toThrow(/conflict/i);
    expect(await readProtocolRows(database)).toEqual(contradictory);

    await database.mpcCalibrationLinkStates.clear();
    await database.mpcCalibrationCacheBindings.clear();
    await database.mpcCalibrationSyncStates.bulkPut([
      { formatVersion: 1, ...session, connectionId: "one", base: null, queued: null, inFlight: null, dirtyGeneration: 0, sentGeneration: 0, acknowledgedGeneration: 0, updatedAt: 1 },
      { formatVersion: 1, ...session, connectionId: "two", base: null, queued: null, inFlight: null, dirtyGeneration: 0, sentGeneration: 0, acknowledgedGeneration: 0, updatedAt: 1 },
    ] as never);
    const ambiguous = await readProtocolRows(database);
    await expect(store.resolve(session)).rejects.toThrow(/ambiguous/i);
    expect(await readProtocolRows(database)).toEqual(ambiguous);
  });

  it("rejects malformed stored state and rolls back a post-put failure without touching unrelated rows", async () => {
    const database = freshDatabase();
    const store = createMpcCalibrationLinkStateStore(database, { createConnectionId: () => "new" });
    const malformed = { formatVersion: 1, ...session, connectionId: "stored", updatedAt: 1, extra: true };
    await database.mpcCalibrationLinkStates.put(malformed as never);
    await expect(store.resolve(session)).rejects.toBeInstanceOf(MpcCalibrationLinkStateError);
    expect(await database.mpcCalibrationLinkStates.get(["owner", "harness"])).toEqual(malformed);

    await database.mpcCalibrationLinkStates.clear();
    await database.settings.put({ id: "setting", value: { retained: true } });
    await database.userPreferences.put({ id: "default", retained: "preference" } as never);
    await database.mpcCalibrationSyncStates.put({
      formatVersion: 1, ownerId: "other", harnessId: "other", connectionId: "other", base: null, queued: null, inFlight: null,
      dirtyGeneration: 0, sentGeneration: 0, acknowledgedGeneration: 0, updatedAt: 1,
    } as never);
    const before = await readProtocolRows(database);
    const put = database.mpcCalibrationLinkStates.put.bind(database.mpcCalibrationLinkStates);
    vi.spyOn(database.mpcCalibrationLinkStates, "put").mockImplementation((row, key) =>
      put(row, key).then(() => { throw new Error("after-real-put"); })
    );

    await expect(store.resolve(session)).rejects.toBeInstanceOf(MpcCalibrationLinkStateError);
    expect(await database.mpcCalibrationLinkStates.get(["owner", "harness"])).toBeUndefined();
    expect(await readProtocolRows(database)).toEqual(before);
  });

  it("survives actual settings clear and singleton preference replacement", async () => {
    const database = freshDatabase();
    const store = createMpcCalibrationLinkStateStore(database, { createConnectionId: () => "durable" });
    const resolved = await store.resolve(session);
    await database.settings.put({ id: "application", value: { old: true } });
    await database.userPreferences.put({ id: "default", retained: "old" } as never);
    await database.settings.clear();
    await database.userPreferences.put({ id: "default", retained: "replacement" } as never);

    expect(await store.resolve(session)).toEqual(resolved);
    expect(await database.mpcCalibrationLinkStates.get(["owner", "harness"])).toEqual({ formatVersion: 1, ...resolved, updatedAt: expect.any(Number) });
  });

  it("serializes two independent handles without minting a replacement identity", async () => {
    const first = freshDatabase();
    const second = new ProxxiedDexie(first.name);
    handles.push(second);
    await Promise.all([first.open(), second.open()]);
    const mint = vi.fn(() => "one-connection");
    const results = await Promise.all([
      createMpcCalibrationLinkStateStore(first, { createConnectionId: mint }).resolve(session),
      createMpcCalibrationLinkStateStore(second, { createConnectionId: mint }).resolve(session),
    ]);
    expect(results).toEqual([
      { ...session, connectionId: "one-connection" },
      { ...session, connectionId: "one-connection" },
    ]);
    expect(mint).toHaveBeenCalledTimes(1);
    expect(await first.mpcCalibrationLinkStates.count()).toBe(1);
    expect(await second.mpcCalibrationLinkStates.toArray()).toEqual(await first.mpcCalibrationLinkStates.toArray());
  });

  it("uses the default generator and returns detached metadata", async () => {
    const database = freshDatabase();
    const store = createMpcCalibrationLinkStateStore(database);
    const result = await store.resolve(session);
    expect(result.connectionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const expected = { ...result };
    Object.assign(result, { ownerId: "changed", harnessId: "changed", connectionId: "changed" });
    expect(await store.resolve(session)).toEqual(expected);
    expect(await database.mpcCalibrationLinkStates.toArray()).toEqual([
      { formatVersion: 1, ...expected, updatedAt: expect.any(Number) },
    ]);
  });

  it("rejects hidden authority and bounded-invalid identities without reflecting input or writing", async () => {
    const database = freshDatabase();
    const store = createMpcCalibrationLinkStateStore(database);
    const sentinel = "synthetic-authority-not-for-error-output";
    const hidden = Object.defineProperty({ ...session }, "credential", { value: sentinel });
    const hiddenOwner = Object.defineProperty({ ...session }, "ownerId", { value: "owner", enumerable: false });
    const invalid: unknown[] = [hidden, hiddenOwner];
    for (const field of ["credential", "cookie", "headers", "backendOrigin", "url", "connectionId"]) {
      invalid.push({ ...session, [field]: sentinel });
    }
    for (const field of ["ownerId", "harnessId"]) {
      for (const value of ["", "x".repeat(129), "bad\nidentity", "bad\u007fidentity", "bad\u0085identity", 1, null]) {
        invalid.push({ ...session, [field]: value });
      }
    }
    const before = await readProtocolRows(database);
    for (const value of invalid) {
      const error: unknown = await store.resolve(value as never).catch((reason: unknown) => reason);
      expect(error).toBeInstanceOf(MpcCalibrationLinkStateError);
      expect(String(error)).not.toContain(sentinel);
    }
    expect(await database.mpcCalibrationLinkStates.count()).toBe(0);
    expect(await readProtocolRows(database)).toEqual(before);
    await expect(store.resolve({ ownerId: "o".repeat(128), harnessId: "h".repeat(128) })).resolves.toMatchObject({
      ownerId: "o".repeat(128), harnessId: "h".repeat(128),
    });
  });

  it("preserves a foreign physical binding and never creates a conflicting link", async () => {
    const database = freshDatabase();
    await database.mpcCalibrationCacheBindings.put({
      id: "mpc-calibration-cache-binding", ownerId: "foreign-owner", harnessId: "foreign-harness",
      connectionId: "foreign-connection", revision: 3, updatedAt: 1,
    });
    const before = await readProtocolRows(database);
    const mint = vi.fn(() => "must-not-mint");
    await expect(createMpcCalibrationLinkStateStore(database, { createConnectionId: mint }).resolve(session)).rejects.toThrow(
      "physical cache binding belongs to another identity"
    );
    expect(mint).not.toHaveBeenCalled();
    expect(await database.mpcCalibrationLinkStates.count()).toBe(0);
    expect(await readProtocolRows(database)).toEqual(before);
  });
});
