import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProxxiedDexie } from "@/db";
import { MpcCalibrationTransportError, type MpcCalibrationTransport } from "./mpcCalibrationTransport";
import { restoreMpcCalibrationSession } from "./mpcCalibrationSessionRestoration";

const handles: ProxxiedDexie[] = [];

function freshDatabase(): ProxxiedDexie {
  const database = new ProxxiedDexie(`session-restoration-${crypto.randomUUID()}`);
  handles.push(database);
  return database;
}

function linkedTransport(getSession: MpcCalibrationTransport["getSession"]): MpcCalibrationTransport {
  const unsupported = vi.fn(async (): Promise<never> => { throw new Error("unexpected downstream transport call"); });
  return {
    pair: unsupported,
    unpair: unsupported,
    getSession,
    getSnapshot: unsupported,
    publishSnapshot: unsupported,
    getBlob: unsupported,
    putBlob: unsupported,
    missingBlobs: unsupported,
  };
}

function protocolRows(database: ProxxiedDexie) {
  return Promise.all([
    database.mpcCalibrationCacheBindings.toArray(),
    database.mpcCalibrationSyncStates.toArray(),
  ]);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const database of handles.splice(0)) database.close();
});

describe("restoreMpcCalibrationSession", () => {
  it("restores an authenticated linked-web session through the real selector and durable non-secret link store", async () => {
    const database = freshDatabase();
    const getSession = vi.fn(async function (this: { marker: string }, options?: { signal?: AbortSignal }) {
      expect(this.marker).toBe("web-receiver");
      expect(options).toEqual({ signal: undefined });
      return { ownerId: "owner-a", harnessId: "harness-a" };
    });
    const transport = Object.assign(linkedTransport(getSession), { marker: "web-receiver" });
    const webFactory = vi.fn(() => transport);

    const result = await restoreMpcCalibrationSession({ database, target: "linked-web", createWebTransport: webFactory });

    expect(result).toMatchObject({
      kind: "restored",
      target: "linked-web",
      identity: { ownerId: "owner-a", harnessId: "harness-a", connectionId: expect.any(String) },
    });
    expect(webFactory).toHaveBeenCalledOnce();
    expect(await database.mpcCalibrationLinkStates.get(["owner-a", "harness-a"])).toMatchObject({
      ownerId: "owner-a",
      harnessId: "harness-a",
      connectionId: (result as { identity: { connectionId: string } }).identity.connectionId,
    });

    database.close();
    const reopened = new ProxxiedDexie(database.name);
    handles.push(reopened);
    expect(await reopened.mpcCalibrationLinkStates.get(["owner-a", "harness-a"])).toMatchObject({
      connectionId: (result as { identity: { connectionId: string } }).identity.connectionId,
    });
  });

  it("uses the actual Electron selector adapter over its fixed bridge DTO without fetch or legacy preferences", async () => {
    const database = freshDatabase();
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const execute = vi.fn(async () => ({ ok: true as const, value: { ownerId: "owner-e", harnessId: "harness-e" } }));
    const bridge = { calibrationHarnessExecute: execute, loadMpcPreferences: vi.fn(), saveMpcPreferences: vi.fn() };

    await expect(restoreMpcCalibrationSession({ database, target: "linked-electron", electronBridge: bridge })).resolves.toMatchObject({
      kind: "restored",
      target: "linked-electron",
      identity: { ownerId: "owner-e", harnessId: "harness-e" },
    });
    expect(execute).toHaveBeenCalledWith({ kind: "getSession" });
    expect(fetch).not.toHaveBeenCalled();
    expect(bridge.loadMpcPreferences).not.toHaveBeenCalled();
    expect(bridge.saveMpcPreferences).not.toHaveBeenCalled();
  });

  it("returns the request-free local default without selecting a bridge or writing identity/cache/protocol state", async () => {
    const database = freshDatabase();
    const webFactory = vi.fn();
    const bridge = { calibrationHarnessExecute: vi.fn(), loadMpcPreferences: vi.fn(), saveMpcPreferences: vi.fn() };
    const before = await protocolRows(database);

    await expect(restoreMpcCalibrationSession({ database, createWebTransport: webFactory, electronBridge: bridge })).resolves.toEqual({
      kind: "local",
      target: "local",
    });
    expect(webFactory).not.toHaveBeenCalled();
    expect(bridge.calibrationHarnessExecute).not.toHaveBeenCalled();
    expect(bridge.loadMpcPreferences).not.toHaveBeenCalled();
    expect(bridge.saveMpcPreferences).not.toHaveBeenCalled();
    expect(await database.mpcCalibrationLinkStates.count()).toBe(0);
    expect(await protocolRows(database)).toEqual(before);
  });

  it("rejects an unsupported pre-aborted target before cancellation without selecting or persisting", async () => {
    const database = freshDatabase();
    const controller = new AbortController();
    controller.abort();
    const secretTarget = "synthetic-private-origin-token";
    const webFactory = vi.fn(() => linkedTransport(async () => ({ ownerId: "owner", harnessId: "harness" })));
    const store = { resolve: vi.fn() };
    const before = await protocolRows(database);

    await expect(restoreMpcCalibrationSession({
      database,
      target: secretTarget as never,
      signal: controller.signal,
      createWebTransport: webFactory,
      linkStateStore: store,
    })).rejects.toEqual(new MpcCalibrationTransportError("invalid-operation"));
    expect(webFactory).not.toHaveBeenCalled();
    expect(store.resolve).not.toHaveBeenCalled();
    expect(await database.mpcCalibrationLinkStates.count()).toBe(0);
    expect(await protocolRows(database)).toEqual(before);
  });

  it("rejects null target rather than silently treating malformed state as local", async () => {
    const database = freshDatabase();
    const factory = vi.fn();
    await expect(restoreMpcCalibrationSession({ database, target: null as never, createWebTransport: factory }))
      .rejects.toEqual(new MpcCalibrationTransportError("invalid-operation"));
    expect(factory).not.toHaveBeenCalled();
    expect(await database.mpcCalibrationLinkStates.count()).toBe(0);
  });

  it("rejects a throwing initial target read with the bounded invalid-operation error", async () => {
    const database = freshDatabase();
    const webFactory = vi.fn();
    const input = Object.defineProperty({ database, createWebTransport: webFactory }, "target", {
      get() { throw new Error("synthetic-private-target-detail"); },
    });

    await expect(restoreMpcCalibrationSession(input as never)).rejects.toEqual(new MpcCalibrationTransportError("invalid-operation"));
    expect(webFactory).not.toHaveBeenCalled();
    expect(await database.mpcCalibrationLinkStates.count()).toBe(0);
  });

  it("maps a throwing selected getSession boundary getter to a closed linked failure", async () => {
    const database = freshDatabase();
    const privateDetail = "synthetic-private-provider-detail";
    const transport = Object.defineProperty({}, "getSession", {
      get() { throw new Error(privateDetail); },
    });
    const before = await protocolRows(database);

    await expect(restoreMpcCalibrationSession({
      database,
      target: "linked-web",
      createWebTransport: () => transport as MpcCalibrationTransport,
    })).resolves.toEqual({ kind: "rejected", target: "linked-web", status: "unavailable" });
    expect(await database.mpcCalibrationLinkStates.count()).toBe(0);
    expect(await protocolRows(database)).toEqual(before);
  });

  it("maps a throwing injected store resolve getter to a closed linked failure", async () => {
    const database = freshDatabase();
    const store = Object.defineProperty({}, "resolve", {
      get() { throw new Error("synthetic-private-store-detail"); },
    });
    const before = await protocolRows(database);

    await expect(restoreMpcCalibrationSession({
      database,
      target: "linked-web",
      createWebTransport: () => linkedTransport(async () => ({ ownerId: "owner", harnessId: "harness" })),
      linkStateStore: store as never,
    })).resolves.toEqual({ kind: "rejected", target: "linked-web", status: "unavailable" });
    expect(await database.mpcCalibrationLinkStates.count()).toBe(0);
    expect(await protocolRows(database)).toEqual(before);
  });

  it("preserves a known setup transport error as its allowlisted linked status", async () => {
    const database = freshDatabase();

    await expect(restoreMpcCalibrationSession({
      database,
      target: "linked-web",
      createWebTransport: () => { throw new MpcCalibrationTransportError("offline"); },
    })).resolves.toEqual({ kind: "rejected", target: "linked-web", status: "offline" });
    expect(await database.mpcCalibrationLinkStates.count()).toBe(0);
  });

  it("captures an allowlisted transport error code once before returning its status", async () => {
    const database = freshDatabase();
    const failure = new MpcCalibrationTransportError("offline");
    let reads = 0;
    Object.defineProperty(failure, "code", {
      get() { return reads++ === 0 ? "offline" : "synthetic-private-status"; },
    });

    await expect(restoreMpcCalibrationSession({
      database,
      target: "linked-web",
      createWebTransport: () => linkedTransport(async () => { throw failure; }),
    })).resolves.toEqual({ kind: "rejected", target: "linked-web", status: "offline" });
    expect(reads).toBe(1);
    expect(await database.mpcCalibrationLinkStates.count()).toBe(0);
  });

  it("maps a throwing transport error code accessor to unavailable without reflecting its detail", async () => {
    const database = freshDatabase();
    const failure = new MpcCalibrationTransportError("offline");
    Object.defineProperty(failure, "code", {
      get() { throw new Error("synthetic-private-error-code-detail"); },
    });

    await expect(restoreMpcCalibrationSession({
      database,
      target: "linked-web",
      createWebTransport: () => linkedTransport(async () => { throw failure; }),
    })).resolves.toEqual({ kind: "rejected", target: "linked-web", status: "unavailable" });
    expect(await database.mpcCalibrationLinkStates.count()).toBe(0);
  });

  it.each([
    ["offline", new MpcCalibrationTransportError("offline"), "offline"],
    ["unpaired", new MpcCalibrationTransportError("unpaired"), "unpaired"],
    ["authentication", new MpcCalibrationTransportError("authentication", 401), "authentication"],
    ["invalid-operation", new MpcCalibrationTransportError("invalid-operation"), "invalid-operation"],
    ["unexpected", new Error("credential=https://private.example"), "unavailable"],
  ] as const)("keeps linked-web actionable and non-reflecting when %s session discovery fails", async (_name, failure, status) => {
    const database = freshDatabase();
    const before = await protocolRows(database);
    const transport = linkedTransport(async () => { throw failure; });

    await expect(restoreMpcCalibrationSession({
      database,
      target: "linked-web",
      createWebTransport: () => transport,
    })).resolves.toEqual({ kind: "rejected", target: "linked-web", status });
    expect(await database.mpcCalibrationLinkStates.count()).toBe(0);
    expect(await protocolRows(database)).toEqual(before);
  });

  it("does not persist identity after malformed authenticated data", async () => {
    const database = freshDatabase();
    const malformed = linkedTransport(async () => ({ ownerId: "owner", harnessId: "harness", credential: "never" } as never));
    const seeded = { formatVersion: 1 as const, ownerId: "seed", harnessId: "seed", connectionId: "seed", updatedAt: 1 };
    await database.mpcCalibrationLinkStates.put(seeded);
    const before = await database.mpcCalibrationLinkStates.toArray();

    await expect(restoreMpcCalibrationSession({ database, target: "linked-web", createWebTransport: () => malformed })).resolves.toEqual({
      kind: "rejected", target: "linked-web", status: "unavailable",
    });
    expect(await database.mpcCalibrationLinkStates.toArray()).toEqual(before);
  });

  it("keeps the linked target and all existing link rows when actual identity persistence fails", async () => {
    const database = freshDatabase();
    const seeded = { formatVersion: 1 as const, ownerId: "seed", harnessId: "seed", connectionId: "seed", updatedAt: 1 };
    await database.mpcCalibrationLinkStates.put(seeded);
    const before = await database.mpcCalibrationLinkStates.toArray();
    vi.spyOn(database.mpcCalibrationLinkStates, "put").mockRejectedValueOnce(new Error("storage authority"));

    await expect(restoreMpcCalibrationSession({
      database,
      target: "linked-web",
      createWebTransport: () => linkedTransport(async () => ({ ownerId: "owner", harnessId: "harness" })),
    })).resolves.toEqual({ kind: "rejected", target: "linked-web", status: "unavailable" });
    expect(await database.mpcCalibrationLinkStates.toArray()).toEqual(before);
  });

  it("returns cancelled before request when aborted or obsolete and does not resolve identity after a deferred cancellation", async () => {
    const database = freshDatabase();
    const preAborted = new AbortController();
    preAborted.abort();
    const webFactory = vi.fn();
    await expect(restoreMpcCalibrationSession({ database, target: "linked-web", createWebTransport: webFactory, signal: preAborted.signal })).resolves.toEqual({
      kind: "cancelled", target: "linked-web",
    });
    expect(webFactory).not.toHaveBeenCalled();

    let release!: (value: { ownerId: string; harnessId: string }) => void;
    const deferred = new Promise<{ ownerId: string; harnessId: string }>(resolve => { release = resolve; });
    const controller = new AbortController();
    const resolvingStore = { resolve: vi.fn() };
    const pending = restoreMpcCalibrationSession({
      database,
      target: "linked-web",
      createWebTransport: () => linkedTransport(async () => deferred),
      signal: controller.signal,
      linkStateStore: resolvingStore,
    });
    controller.abort();
    release({ ownerId: "owner", harnessId: "harness" });
    await expect(pending).resolves.toEqual({ kind: "cancelled", target: "linked-web" });
    expect(resolvingStore.resolve).not.toHaveBeenCalled();
  });

  it("does not resolve identity after a deferred session becomes obsolete through the captured operation receiver", async () => {
    const database = freshDatabase();
    let release!: (value: { ownerId: string; harnessId: string }) => void;
    const deferred = new Promise<{ ownerId: string; harnessId: string }>(resolve => { release = resolve; });
    const operation = {
      current: true,
      isCurrent(this: { current: boolean }) { return this.current; },
    };
    const resolvingStore = { resolve: vi.fn() };
    const pending = restoreMpcCalibrationSession({
      database,
      target: "linked-web",
      createWebTransport: () => linkedTransport(async () => deferred),
      operation,
      linkStateStore: resolvingStore,
    });
    operation.current = false;
    release({ ownerId: "owner", harnessId: "harness" });

    await expect(pending).resolves.toEqual({ kind: "cancelled", target: "linked-web" });
    expect(resolvingStore.resolve).not.toHaveBeenCalled();
  });

  it("captures target, transport receiver, identity store, and operation fence before awaiting session discovery", async () => {
    const database = freshDatabase();
    let release!: (value: { ownerId: string; harnessId: string }) => void;
    const deferred = new Promise<{ ownerId: string; harnessId: string }>(resolve => { release = resolve; });
    const firstReceiver = { marker: "first", getSession: vi.fn(function (this: { marker: string }) {
      expect(this.marker).toBe("first");
      return deferred;
    }) };
    const first: MpcCalibrationTransport = Object.assign(linkedTransport(firstReceiver.getSession), { marker: "first" });
    const second = linkedTransport(async () => ({ ownerId: "second", harnessId: "second" }));
    const firstStore = { resolve: vi.fn(async () => ({ ownerId: "owner", harnessId: "harness", connectionId: "first" })) };
    const secondStore = { resolve: vi.fn(async () => ({ ownerId: "second", harnessId: "second", connectionId: "second" })) };
    const operation = { current: true, isCurrent(this: { current: boolean }) { return this.current; } };
    const input = {
      database,
      target: "linked-web" as const,
      createWebTransport: () => first,
      linkStateStore: firstStore,
      operation,
    };
    const pending = restoreMpcCalibrationSession(input);
    input.target = "linked-web";
    input.createWebTransport = () => second;
    input.linkStateStore = secondStore;
    first.getSession = async () => ({ ownerId: "mutated", harnessId: "mutated" });
    release({ ownerId: "owner", harnessId: "harness" });

    await expect(pending).resolves.toEqual({
      kind: "restored",
      target: "linked-web",
      identity: { ownerId: "owner", harnessId: "harness", connectionId: "first" },
    });
    expect(firstStore.resolve).toHaveBeenCalledWith({ ownerId: "owner", harnessId: "harness" });
    expect(secondStore.resolve).not.toHaveBeenCalled();
  });

  it("does not call any snapshot, blob, pair, unpair, recovery, or publish method", async () => {
    const database = freshDatabase();
    const transport = linkedTransport(async () => ({ ownerId: "owner", harnessId: "harness" }));

    await restoreMpcCalibrationSession({ database, target: "linked-web", createWebTransport: () => transport });

    expect(transport.pair).not.toHaveBeenCalled();
    expect(transport.unpair).not.toHaveBeenCalled();
    expect(transport.getSnapshot).not.toHaveBeenCalled();
    expect(transport.publishSnapshot).not.toHaveBeenCalled();
    expect(transport.getBlob).not.toHaveBeenCalled();
    expect(transport.putBlob).not.toHaveBeenCalled();
    expect(transport.missingBlobs).not.toHaveBeenCalled();
  });
});
