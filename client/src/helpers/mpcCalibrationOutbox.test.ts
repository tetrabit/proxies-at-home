import "fake-indexeddb/auto";
import { Blob as NodeBlob } from "node:buffer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProxxiedDexie } from "@/db";
import { createMpcCalibrationSyncStateStore } from "./mpcCalibrationSyncState";
import { flushMpcCalibrationOutbox } from "./mpcCalibrationOutbox";
import { MpcCalibrationTransportError, type MpcCalibrationTransport } from "./mpcCalibrationTransport";

const identity = { ownerId: "owner", harnessId: "harness", connectionId: "connection" };
const bytes = new Uint8Array([1, 2, 3, 4]);
const sha256 = "9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a";
const handles: ProxxiedDexie[] = [];

function snapshot() {
  return {
    version: 1 as const,
    retainedRoot: { exact: ["queue", 1] },
    datasets: [{ id: "dataset", name: "Dataset", targetCaseCount: 1, createdAt: 1, updatedAt: 2, version: 1, retained: { dataset: true } }],
    cases: [{
      id: "case", datasetId: "dataset", createdAt: 3, updatedAt: 4,
      source: { name: "Card", retained: { source: true } }, candidates: [], retained: { calibrationCase: true },
    }],
    assets: [{ id: "asset", datasetId: "dataset", caseId: "case", role: "source" as const, mimeType: "image/png", createdAt: 5, hash: "legacy", sha256, byteLength: bytes.byteLength, retained: { asset: true } }],
    runs: [],
  };
}

function freshDatabase(): ProxxiedDexie {
  const database = new ProxxiedDexie(`mpc-calibration-outbox-${crypto.randomUUID()}`);
  handles.push(database);
  return database;
}

function transport(): MpcCalibrationTransport {
  return {
    pair: async () => ({ ownerId: identity.ownerId, harnessId: identity.harnessId }),
    unpair: async () => undefined,
    getSession: async () => ({ ownerId: identity.ownerId, harnessId: identity.harnessId }),
    getSnapshot: async () => null,
    getBlob: async () => { throw new Error("outbox never downloads"); },
    missingBlobs: async hashes => ({ missing: [...hashes] }),
    putBlob: async (hash, body) => ({ sha256: hash, byteLength: body.byteLength, inserted: true }),
    publishSnapshot: async (sent, expectedRevision) => ({ revision: expectedRevision! + 1, snapshot: sent }),
  };
}

async function queueBoundSnapshot(database: ProxxiedDexie) {
  const state = createMpcCalibrationSyncStateStore(database, { now: () => 10 });
  const base = { revision: 1, snapshot: { version: 1 as const, datasets: [], cases: [], assets: [], runs: [], retainedRoot: { base: true } } };
  const queued = snapshot();
  await state.storeBaseWhenClean(identity, base);
  await state.queueSnapshot(identity, queued);
  await database.mpcCalibrationCacheBindings.put({ id: "mpc-calibration-cache-binding", ...identity, revision: 1, updatedAt: 10 });
  await database.mpcCalibrationAssets.put({ ...queued.assets[0]!, blob: new NodeBlob([bytes], { type: "image/png" }) } as never);
  return { state, queued };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const database of handles.splice(0)) database.close();
});

describe("flushMpcCalibrationOutbox", () => {
  it("does not publish after its mark-sent transaction settles into a superseded operation", async () => {
    const database = freshDatabase();
    const { state } = await queueBoundSnapshot(database);
    let current = true;
    const actual = database.transaction.bind(database);
    vi.spyOn(database, "transaction").mockImplementation(((...args: unknown[]) => {
      const pending = Reflect.apply(actual, database, args) as Promise<unknown>;
      return pending.then(value => {
        if (value !== null && typeof value === "object" && Object.hasOwn(value, "generation") && Object.hasOwn(value, "snapshot") && Object.hasOwn(value, "expectedBaseRevision")) current = false;
        return value;
      });
    }) as typeof database.transaction);
    const remote = transport();
    const publish = vi.spyOn(remote, "publishSnapshot");

    await expect(flushMpcCalibrationOutbox({ database, transport: remote, identity, operation: { isCurrent: () => current } })).resolves.toMatchObject({ status: "cancelled" });
    expect(publish).not.toHaveBeenCalled();
    await expect(state.load(identity)).resolves.toMatchObject({ base: { revision: 1 }, queued: { generation: 1 }, inFlight: { generation: 1 } });
  });

  it("does not upload after a pending missing-content lookup changes the cache binding", async () => {
    const database = freshDatabase();
    const { state } = await queueBoundSnapshot(database);
    const before = await state.load(identity);
    const remote = transport();
    remote.missingBlobs = async hashes => {
      await database.mpcCalibrationCacheBindings.update("mpc-calibration-cache-binding", { connectionId: "replacement-connection" });
      return { missing: [...hashes] };
    };
    const put = vi.spyOn(remote, "putBlob");
    const publish = vi.spyOn(remote, "publishSnapshot");

    await expect(flushMpcCalibrationOutbox({ database, transport: remote, identity })).resolves.toMatchObject({ status: "blocked" });
    expect(put).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    await expect(state.load(identity)).resolves.toEqual(before);
  });

  it("rejects a symbol-bearing publish snapshot without acknowledging its inFlight generation", async () => {
    const database = freshDatabase();
    const { state, queued } = await queueBoundSnapshot(database);
    const remote = transport();
    remote.publishSnapshot = async (_sent, expectedRevision) => {
      const symbolBearing = structuredClone(queued) as Record<string, unknown>;
      Object.defineProperty(symbolBearing, Symbol("untrusted"), { value: true, enumerable: true });
      return { revision: expectedRevision! + 1, snapshot: symbolBearing as never };
    };

    await expect(flushMpcCalibrationOutbox({ database, transport: remote, identity })).resolves.toMatchObject({ status: "blocked" });
    await expect(state.load(identity)).resolves.toMatchObject({
      base: { revision: 1 }, queued: { generation: 1, snapshot: queued },
      inFlight: { generation: 1, snapshot: queued, expectedBaseRevision: 1 },
    });
  });

  it("does no transport work for a pre-cancelled operation", async () => {
    const database = freshDatabase();
    const controller = new AbortController();
    controller.abort();
    const remote = transport();
    const session = vi.spyOn(remote, "getSession");

    await expect(flushMpcCalibrationOutbox({ database, transport: remote, identity, signal: controller.signal })).resolves.toEqual({
      status: "cancelled", reason: "operation-not-current",
    });
    expect(session).not.toHaveBeenCalled();
    expect(await database.mpcCalibrationSyncStates.count()).toBe(0);
  });

  it("preserves an unbased queued generation without publishing it", async () => {
    const database = freshDatabase();
    const state = createMpcCalibrationSyncStateStore(database, { now: () => 10 });
    const queued = snapshot();
    await state.queueSnapshot(identity, queued);
    const remote = transport();
    const missing = vi.spyOn(remote, "missingBlobs");
    const publish = vi.spyOn(remote, "publishSnapshot");

    await expect(flushMpcCalibrationOutbox({ database, transport: remote, identity })).resolves.toEqual({
      status: "blocked", reason: "missing-recorded-base",
    });
    expect(missing).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    await expect(state.load(identity)).resolves.toMatchObject({ base: null, queued: { generation: 1, snapshot: queued }, inFlight: null });
  });

  it("rolls back mark-sent when cancellation occurs after its real durable put", async () => {
    const database = freshDatabase();
    const { state, queued } = await queueBoundSnapshot(database);
    const controller = new AbortController();
    const originalPut = database.mpcCalibrationSyncStates.put.bind(database.mpcCalibrationSyncStates);
    const put = vi.spyOn(database.mpcCalibrationSyncStates, "put").mockImplementation((async (...args: Parameters<typeof originalPut>) => {
      const result = await originalPut(...args);
      controller.abort();
      return result;
    }) as typeof originalPut);
    try {
      await expect(flushMpcCalibrationOutbox({ database, transport: transport(), identity, signal: controller.signal })).resolves.toMatchObject({ status: "cancelled" });
      expect(put).toHaveBeenCalledTimes(1);
      await expect(state.load(identity)).resolves.toMatchObject({
        base: { revision: 1 }, queued: { generation: 1, snapshot: queued }, inFlight: null,
        dirtyGeneration: 1, sentGeneration: 0, acknowledgedGeneration: 0,
      });
    } finally {
      put.mockRestore();
    }
  });

  it("preserves a queued snapshot when referenced cached Blob bytes are corrupt", async () => {
    const database = freshDatabase();
    const { state, queued } = await queueBoundSnapshot(database);
    await database.mpcCalibrationAssets.update("asset", { blob: new NodeBlob([new Uint8Array([4, 3, 2, 1])], { type: "image/png" }) });
    const remote = transport();
    const missing = vi.spyOn(remote, "missingBlobs");
    const publish = vi.spyOn(remote, "publishSnapshot");

    await expect(flushMpcCalibrationOutbox({ database, transport: remote, identity })).resolves.toMatchObject({ status: "blocked" });
    expect(missing).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    await expect(state.load(identity)).resolves.toMatchObject({ base: { revision: 1 }, queued: { generation: 1, snapshot: queued }, inFlight: null });
  });

  it("retains the exact inFlight publication after a 412 conflict", async () => {
    const database = freshDatabase();
    const { state, queued } = await queueBoundSnapshot(database);
    const remote = transport();
    remote.publishSnapshot = async () => { throw new MpcCalibrationTransportError("http", 412); };

    await expect(flushMpcCalibrationOutbox({ database, transport: remote, identity })).resolves.toEqual({
      status: "conflict", reason: "precondition-failed", errorCode: "http",
    });
    const retained = await state.load(identity);
    expect(retained).toMatchObject({
      base: { revision: 1 }, queued: { generation: 1, snapshot: queued },
      inFlight: { generation: 1, snapshot: queued, expectedBaseRevision: 1 },
    });
    database.close();
    const reopened = new ProxxiedDexie(database.name);
    handles.push(reopened);
    await expect(createMpcCalibrationSyncStateStore(reopened).load(identity)).resolves.toEqual(retained);
  });

  it("preserves a newer queued generation when the exact sent generation is acknowledged", async () => {
    const database = freshDatabase();
    const { state, queued } = await queueBoundSnapshot(database);
    const newer = { ...queued, retainedRoot: { exact: ["queue", 2] } };
    const remote = transport();
    remote.publishSnapshot = async (sent, expectedRevision) => {
      expect(sent).toEqual(queued);
      await state.queueSnapshot(identity, newer);
      return { revision: expectedRevision! + 1, snapshot: sent };
    };

    await expect(flushMpcCalibrationOutbox({ database, transport: remote, identity })).resolves.toEqual({
      status: "published", generation: 1, revision: 2,
    });
    await expect(state.load(identity)).resolves.toMatchObject({
      base: { revision: 2, snapshot: queued }, inFlight: null,
      queued: { generation: 2, snapshot: newer }, dirtyGeneration: 2, sentGeneration: 1, acknowledgedGeneration: 1,
    });
  });

  it("uploads only missing content then publishes and acknowledges the exact queued generation", async () => {
    const database = freshDatabase();
    const { state, queued } = await queueBoundSnapshot(database);
    const remote = transport();
    const puts: string[] = [];
    remote.putBlob = async (hash, body) => {
      puts.push(`${hash}:${body.byteLength}`);
      return { sha256: hash, byteLength: body.byteLength, inserted: true };
    };

    await expect(flushMpcCalibrationOutbox({ database, transport: remote, identity })).resolves.toEqual({
      status: "published", generation: 1, revision: 2,
    });
    expect(puts).toEqual([`${sha256}:4`]);
    await expect(state.load(identity)).resolves.toMatchObject({
      base: { revision: 2, snapshot: queued }, queued: null, inFlight: null,
      dirtyGeneration: 1, sentGeneration: 1, acknowledgedGeneration: 1,
    });
  });

  it("leaves no-queue, destructive empty, malformed, and unauthenticated durable state untouched without write calls", async () => {
    const variants = ["no-queue", "empty", "malformed", "unauthenticated"] as const;
    for (const variant of variants) {
      const database = freshDatabase();
      const remote = transport();
      const state = createMpcCalibrationSyncStateStore(database, { now: () => 10 });
      if (variant === "empty") {
        const base = { revision: 1, snapshot: { version: 1 as const, datasets: [], cases: [], assets: [], runs: [], retainedRoot: { base: true } } };
        await state.storeBaseWhenClean(identity, base);
        await state.queueSnapshot(identity, { version: 1, datasets: [], cases: [], assets: [], runs: [], retainedRoot: { destructive: true } });
        await database.mpcCalibrationCacheBindings.put({ id: "mpc-calibration-cache-binding", ...identity, revision: 1, updatedAt: 10 });
      }
      if (variant === "malformed") {
        await database.mpcCalibrationSyncStates.put({ ownerId: identity.ownerId, harnessId: identity.harnessId, connectionId: identity.connectionId, malformed: true } as never);
      }
      if (variant === "unauthenticated") {
        await queueBoundSnapshot(database);
        remote.getSession = async () => ({ ownerId: "foreign", harnessId: identity.harnessId });
      }
      const before = await database.mpcCalibrationSyncStates.toArray();
      const missing = vi.spyOn(remote, "missingBlobs");
      const put = vi.spyOn(remote, "putBlob");
      const publish = vi.spyOn(remote, "publishSnapshot");
      const result = await flushMpcCalibrationOutbox({ database, transport: remote, identity });
      expect(["no-queued", "blocked", "cancelled"]).toContain(result.status);
      expect(missing).not.toHaveBeenCalled();
      expect(put).not.toHaveBeenCalled();
      expect(publish).not.toHaveBeenCalled();
      expect(await database.mpcCalibrationSyncStates.toArray()).toEqual(before);
    }
  });

  it("preserves a foreign or missing cache binding before any write", async () => {
    for (const binding of [undefined, { id: "mpc-calibration-cache-binding" as const, ...identity, connectionId: "foreign", revision: 1, updatedAt: 10 }]) {
      const database = freshDatabase();
      const { state } = await queueBoundSnapshot(database);
      if (binding === undefined) await database.mpcCalibrationCacheBindings.clear();
      else await database.mpcCalibrationCacheBindings.put(binding);
      const before = await state.load(identity);
      const remote = transport();
      const writes = [vi.spyOn(remote, "missingBlobs"), vi.spyOn(remote, "putBlob"), vi.spyOn(remote, "publishSnapshot")];
      await expect(flushMpcCalibrationOutbox({ database, transport: remote, identity })).resolves.toMatchObject({ status: "blocked" });
      for (const write of writes) expect(write).not.toHaveBeenCalled();
      await expect(state.load(identity)).resolves.toEqual(before);
    }
  });

  it.each(["offline", "timeout", "authentication", "aborted"] as const)("retains the queued generation when %s occurs before mark-sent", async code => {
    const database = freshDatabase();
    const { state } = await queueBoundSnapshot(database);
    const before = await state.load(identity);
    const remote = transport();
    remote.missingBlobs = async () => { throw new MpcCalibrationTransportError(code); };
    await expect(flushMpcCalibrationOutbox({ database, transport: remote, identity })).resolves.toMatchObject({ status: "failed", errorCode: code });
    await expect(state.load(identity)).resolves.toEqual(before);
  });

  it.each(["offline", "timeout", "authentication", "aborted"] as const)("retains exact inFlight through reopen when %s occurs after metadata dispatch", async code => {
    const database = freshDatabase();
    const { state, queued } = await queueBoundSnapshot(database);
    const remote = transport();
    remote.publishSnapshot = async () => { throw new MpcCalibrationTransportError(code); };
    await expect(flushMpcCalibrationOutbox({ database, transport: remote, identity })).resolves.toMatchObject({ status: "failed", errorCode: code });
    const retained = await state.load(identity);
    expect(retained).toMatchObject({ base: { revision: 1 }, queued: { generation: 1, snapshot: queued }, inFlight: { generation: 1, snapshot: queued, expectedBaseRevision: 1 } });
    database.close();
    const reopened = new ProxxiedDexie(database.name);
    handles.push(reopened);
    await expect(createMpcCalibrationSyncStateStore(reopened).load(identity)).resolves.toEqual(retained);
  });

  it("blocks missing, wrong-length, and oversized local assets before missing-content lookup", async () => {
    for (const mutation of ["missing", "wrong-length", "oversized"] as const) {
      const database = freshDatabase();
      const { state } = await queueBoundSnapshot(database);
      if (mutation === "missing") await database.mpcCalibrationAssets.delete("asset");
      if (mutation === "wrong-length") {
        const record = await database.mpcCalibrationAssets.get("asset");
        await database.mpcCalibrationAssets.put({ ...record!, byteLength: 3 } as never);
      }
      const oversizedRead = mutation === "oversized"
        ? vi.spyOn(NodeBlob.prototype, "arrayBuffer").mockRejectedValue(new Error("oversized read admitted"))
        : undefined;
      if (mutation === "oversized") vi.spyOn(NodeBlob.prototype, "size", "get").mockReturnValue(32 * 1024 * 1024 + 1);
      const before = await state.load(identity);
      const remote = transport();
      const missing = vi.spyOn(remote, "missingBlobs");
      await expect(flushMpcCalibrationOutbox({ database, transport: remote, identity })).resolves.toMatchObject({ status: "blocked" });
      expect(missing).not.toHaveBeenCalled();
      if (oversizedRead !== undefined) expect(oversizedRead).not.toHaveBeenCalled();
      await expect(state.load(identity)).resolves.toEqual(before);
    }
  });

  it("chunks 513 unique hashes while performing bounded serial Blob reads", async () => {
    const database = freshDatabase();
    const state = createMpcCalibrationSyncStateStore(database, { now: () => 10 });
    const base = { revision: 1, snapshot: { version: 1 as const, datasets: [], cases: [], assets: [], runs: [], retainedRoot: { base: true } } };
    const assets = await Promise.all(Array.from({ length: 513 }, async (_, index) => {
      const body = new Uint8Array([index >>> 8, index & 255]);
      const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", body))).map(byte => byte.toString(16).padStart(2, "0")).join("");
      return { id: `asset-${index}`, datasetId: "dataset", caseId: `case-${index}`, role: "source" as const, mimeType: "image/png", createdAt: index + 5, hash: `legacy-${index}`, sha256: hash, byteLength: body.byteLength, retained: { asset: true }, blob: new NodeBlob([body], { type: "image/png" }) };
    }));
    const queued = {
      ...snapshot(),
      cases: assets.map((_, index) => ({ ...snapshot().cases[0]!, id: `case-${index}` })),
      assets: assets.map(({ blob: _blob, ...asset }) => asset),
    };
    await state.storeBaseWhenClean(identity, base);
    await state.queueSnapshot(identity, queued);
    await database.mpcCalibrationCacheBindings.put({ id: "mpc-calibration-cache-binding", ...identity, revision: 1, updatedAt: 10 });
    await database.mpcCalibrationAssets.bulkPut(assets as never);
    const remote = transport();
    const chunks: number[] = [];
    remote.missingBlobs = async hashes => { chunks.push(hashes.length); return { missing: [] }; };
    const readOriginal = NodeBlob.prototype.arrayBuffer;
    let active = 0;
    let maximum = 0;
    const read = vi.spyOn(NodeBlob.prototype, "arrayBuffer").mockImplementation(function (this: Blob) {
      active += 1;
      maximum = Math.max(maximum, active);
      return readOriginal.call(this).finally(() => { active -= 1; });
    });
    await expect(flushMpcCalibrationOutbox({ database, transport: remote, identity })).resolves.toMatchObject({ status: "published" });
    expect(chunks).toEqual([512, 1]);
    expect(maximum).toBe(1);
    expect(active).toBe(0);
    expect(read).toHaveBeenCalledTimes(513);
  }, 20_000);

  it("uploads identical content once even when it is referenced by two assets", async () => {
    const database = freshDatabase();
    const { state, queued } = await queueBoundSnapshot(database);
    const duplicate = { ...queued.assets[0]!, id: "asset-duplicate", caseId: "case-duplicate" };
    const snapshotWithDuplicate = { ...queued, cases: [...queued.cases, { ...queued.cases[0]!, id: "case-duplicate" }], assets: [...queued.assets, duplicate] };
    await state.queueSnapshot(identity, snapshotWithDuplicate);
    await database.mpcCalibrationAssets.put({ ...duplicate, blob: new NodeBlob([bytes], { type: "image/png" }) } as never);
    const remote = transport();
    const put = vi.spyOn(remote, "putBlob");
    await expect(flushMpcCalibrationOutbox({ database, transport: remote, identity })).resolves.toMatchObject({ status: "published", generation: 2 });
    expect(put).toHaveBeenCalledTimes(1);
  });

  it("blocks a missing second logical asset even when its content hash is duplicated", async () => {
    const database = freshDatabase();
    const { state, queued } = await queueBoundSnapshot(database);
    const duplicate = { ...queued.assets[0]!, id: "asset-duplicate", caseId: "case-duplicate" };
    await state.queueSnapshot(identity, { ...queued, cases: [...queued.cases, { ...queued.cases[0]!, id: "case-duplicate" }], assets: [...queued.assets, duplicate] });
    const remote = transport();
    const publish = vi.spyOn(remote, "publishSnapshot");
    await expect(flushMpcCalibrationOutbox({ database, transport: remote, identity })).resolves.toMatchObject({ status: "blocked" });
    expect(publish).not.toHaveBeenCalled();
    await expect(state.load(identity)).resolves.toMatchObject({ queued: { generation: 2 }, inFlight: null });
  });

  it("rejects malformed missing responses, blob receipts, and ACKs without invoking accessors or changing the applicable durable row", async () => {
    const database = freshDatabase();
    const { state, queued } = await queueBoundSnapshot(database);
    const remote = transport();
    let getterCalls = 0;
    const accessorMissing = {} as Record<string, unknown>;
    Object.defineProperty(accessorMissing, "missing", { enumerable: true, get() { getterCalls += 1; return []; } });
    remote.missingBlobs = async () => accessorMissing as never;
    const beforeMissing = await state.load(identity);
    await expect(flushMpcCalibrationOutbox({ database, transport: remote, identity })).resolves.toMatchObject({ status: "blocked" });
    expect(getterCalls).toBe(0);
    await expect(state.load(identity)).resolves.toEqual(beforeMissing);

    remote.missingBlobs = async hashes => ({ missing: [...hashes] });
    remote.putBlob = async () => ({ sha256, byteLength: 3, inserted: true });
    await expect(flushMpcCalibrationOutbox({ database, transport: remote, identity })).resolves.toMatchObject({ status: "blocked" });
    await expect(state.load(identity)).resolves.toMatchObject({ base: { revision: 1 }, queued: { generation: 1, snapshot: queued }, inFlight: null });

    const databaseAck = freshDatabase();
    const { state: ackState, queued: ackQueued } = await queueBoundSnapshot(databaseAck);
    const ackRemote = transport();
    ackRemote.publishSnapshot = async sent => ({ revision: 1, snapshot: sent });
    await expect(flushMpcCalibrationOutbox({ database: databaseAck, transport: ackRemote, identity })).resolves.toMatchObject({ status: "blocked" });
    await expect(ackState.load(identity)).resolves.toMatchObject({ base: { revision: 1 }, queued: { generation: 1, snapshot: ackQueued }, inFlight: { generation: 1 } });
  });

  it("captures original database, identity, transport, signal, and operation receiver across awaited session admission", async () => {
    const database = freshDatabase();
    const replacement = freshDatabase();
    await queueBoundSnapshot(database);
    let release: ((value: { ownerId: string; harnessId: string }) => void) | undefined;
    let entered: (() => void) | undefined;
    const session = new Promise<{ ownerId: string; harnessId: string }>(resolve => { release = resolve; });
    const admitted = new Promise<void>(resolve => { entered = resolve; });
    const remote = transport();
    let sessions = 0;
    remote.getSession = async () => { sessions += 1; if (sessions === 1) { entered!(); return session; } return { ownerId: identity.ownerId, harnessId: identity.harnessId }; };
    const input = { database, transport: remote, identity: { ...identity }, signal: new AbortController().signal, operation: { label: "captured", isCurrent() { return this.label === "captured"; } } };
    const pending = flushMpcCalibrationOutbox(input);
    await admitted;
    input.database = replacement;
    input.identity.ownerId = "replacement";
    input.transport = { ...transport(), getSession: async () => { throw new Error("replacement transport used"); } };
    input.signal = new AbortController().signal;
    input.operation = { label: "replacement", isCurrent: () => false };
    release!({ ownerId: identity.ownerId, harnessId: identity.harnessId });
    await expect(pending).resolves.toMatchObject({ status: "published" });
    expect(await replacement.mpcCalibrationSyncStates.count()).toBe(0);
  });

  it("uses the original signal cancellation to stop after awaited admission without redirecting persistence", async () => {
    const database = freshDatabase();
    const { state } = await queueBoundSnapshot(database);
    const controller = new AbortController();
    let release: ((value: { ownerId: string; harnessId: string }) => void) | undefined;
    const remote = transport();
    remote.getSession = async () => new Promise(resolve => { release = resolve; });
    const pending = flushMpcCalibrationOutbox({ database, transport: remote, identity, signal: controller.signal });
    controller.abort();
    release!({ ownerId: identity.ownerId, harnessId: identity.harnessId });
    await expect(pending).resolves.toMatchObject({ status: "cancelled" });
    await expect(state.load(identity)).resolves.toMatchObject({ queued: { generation: 1 }, inFlight: null });
  });

  it("rolls back acknowledgement after its real durable put while retaining exact inFlight", async () => {
    const database = freshDatabase();
    const { state, queued } = await queueBoundSnapshot(database);
    const controller = new AbortController();
    const actual = database.mpcCalibrationSyncStates.put.bind(database.mpcCalibrationSyncStates);
    let writes = 0;
    vi.spyOn(database.mpcCalibrationSyncStates, "put").mockImplementation((async (...args: Parameters<typeof actual>) => {
      const result = await actual(...args);
      writes += 1;
      if (writes === 2) controller.abort();
      return result;
    }) as typeof actual);
    const remote = transport();
    const publish = vi.spyOn(remote, "publishSnapshot");
    await expect(flushMpcCalibrationOutbox({ database, transport: remote, identity, signal: controller.signal })).resolves.toMatchObject({ status: "cancelled" });
    expect(writes).toBe(2);
    expect(publish).toHaveBeenCalledTimes(1);
    await expect(state.load(identity)).resolves.toMatchObject({ base: { revision: 1 }, queued: { generation: 1, snapshot: queued }, inFlight: { generation: 1, snapshot: queued, expectedBaseRevision: 1 } });
  });

  it("allows only one publication when two flushes capture the same queued generation", async () => {
    const database = freshDatabase();
    const { state, queued } = await queueBoundSnapshot(database);
    const remote = transport();
    const deferred = () => {
      let resolve!: () => void;
      const promise = new Promise<void>(finish => { resolve = finish; });
      return { promise, resolve };
    };
    const bothAdmitted = deferred();
    const releaseLookup = deferred();
    const publicationStarted = deferred();
    const releasePublication = deferred();
    let admissions = 0;
    let publications = 0;
    remote.missingBlobs = async () => {
      admissions += 1;
      if (admissions === 2) bothAdmitted.resolve();
      await releaseLookup.promise;
      return { missing: [] };
    };
    remote.publishSnapshot = async (sent, expectedRevision) => {
      publications += 1;
      publicationStarted.resolve();
      await releasePublication.promise;
      return { revision: expectedRevision! + 1, snapshot: sent };
    };
    const attempts = [
      flushMpcCalibrationOutbox({ database, transport: remote, identity }),
      flushMpcCalibrationOutbox({ database, transport: remote, identity }),
    ];
    try {
      await bothAdmitted.promise;
      releaseLookup.resolve();
      await publicationStarted.promise;
      expect(await Promise.race(attempts)).toMatchObject({ status: "recovery-needed" });
      expect(publications).toBe(1);
      expect(await state.load(identity)).toMatchObject({
        base: { revision: 1 }, queued: { generation: 1, snapshot: queued },
        inFlight: { generation: 1, snapshot: queued }, acknowledgedGeneration: 0,
      });
      releasePublication.resolve();
      expect((await Promise.all(attempts)).map(result => result.status).sort()).toEqual(["published", "recovery-needed"]);
      expect(await state.load(identity)).toMatchObject({ base: { revision: 2, snapshot: queued }, queued: null, inFlight: null });
    } finally {
      releaseLookup.resolve();
      releasePublication.resolve();
      await Promise.allSettled(attempts);
    }
  });

  it("does not acknowledge an advancing response containing different snapshot content", async () => {
    const database = freshDatabase();
    const { state, queued } = await queueBoundSnapshot(database);
    const remote = transport();
    remote.publishSnapshot = async (sent, expectedRevision) => ({
      revision: expectedRevision! + 1,
      snapshot: { ...sent, retainedRoot: { different: true } },
    });
    expect(await flushMpcCalibrationOutbox({ database, transport: remote, identity })).toMatchObject({ status: "blocked" });
    expect(await state.load(identity)).toMatchObject({
      base: { revision: 1 }, queued: { generation: 1, snapshot: queued },
      inFlight: { generation: 1, snapshot: queued }, acknowledgedGeneration: 0,
    });
  });

  it("does not replace existing inFlight or mislabel G1 when G2 queues before mark-sent", async () => {
    const database = freshDatabase();
    const { state } = await queueBoundSnapshot(database);
    await state.markSnapshotSent(identity, 1);
    const remote = transport();
    const publish = vi.spyOn(remote, "publishSnapshot");
    await expect(flushMpcCalibrationOutbox({ database, transport: remote, identity })).resolves.toMatchObject({ status: "recovery-needed" });
    expect(publish).not.toHaveBeenCalled();

    const databaseG2 = freshDatabase();
    const { state: stateG2, queued: queuedG1 } = await queueBoundSnapshot(databaseG2);
    const newer = { ...queuedG1, retainedRoot: { exact: ["queue", "G2"] } };
    const g2Remote = transport();
    g2Remote.missingBlobs = async hashes => { await stateG2.queueSnapshot(identity, newer); return { missing: [...hashes] }; };
    const g2Publish = vi.spyOn(g2Remote, "publishSnapshot");
    await expect(flushMpcCalibrationOutbox({ database: databaseG2, transport: g2Remote, identity })).resolves.toMatchObject({ status: "recovery-needed" });
    expect(g2Publish).not.toHaveBeenCalled();
    await expect(stateG2.load(identity)).resolves.toMatchObject({ queued: { generation: 2, snapshot: newer }, inFlight: null });
  });
});
