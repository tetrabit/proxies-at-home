import "fake-indexeddb/auto";
import { Blob as NativeBlob } from "node:buffer";
import { webcrypto } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProxxiedDexie } from "@/db";
import { createMpcCalibrationOperationScope } from "./mpcCalibrationOperationScope";
import { hydrateMpcCalibrationCache } from "./mpcCalibrationCache";
import { MpcCalibrationTransportError, type MpcCalibrationTransport } from "./mpcCalibrationTransport";
import {
  createMpcCalibrationRefreshScheduler as createRefreshScheduler,
  type MpcCalibrationRefreshSchedulerOptions,
} from "./mpcCalibrationRefreshScheduler";

if (!globalThis.crypto) globalThis.crypto = webcrypto as Crypto;
// Keep C3's staged-Blob persistence test on the platform Blob brand that
// fake-indexeddb can structured-clone, matching browser IndexedDB behavior.
globalThis.Blob = NativeBlob as unknown as typeof Blob;

type Handle = { database: ProxxiedDexie; scope: ReturnType<typeof createMpcCalibrationOperationScope> };
const handles: Handle[] = [];
const schedulers: ReturnType<typeof createRefreshScheduler>[] = [];

function createMpcCalibrationRefreshScheduler(...args: Parameters<typeof createRefreshScheduler>) {
  const scheduler = createRefreshScheduler(...args);
  schedulers.push(scheduler);
  return scheduler;
}

const identity = { ownerId: "refresh-owner", harnessId: "refresh-harness", connectionId: "refresh-connection" };
const initialBytes = new Uint8Array([1, 2, 3, 4]);
const nextBytes = new Uint8Array([4, 3, 2, 1]);
const initialHash = "9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a";
const nextHash = "ee10da4aefe61a37df1dee937ca3221afa3b2351f9ea34edbbb769573c6785f7";

function snapshot(hash = initialHash, bytes = initialBytes) {
  return {
    version: 1 as const,
    retainedRoot: { refresh: hash },
    datasets: [{ id: "dataset", name: "Refresh", targetCaseCount: 1, createdAt: 1, updatedAt: 2, version: 1 }],
    cases: [{
      id: "case", datasetId: "dataset", createdAt: 3, updatedAt: 4, source: { name: "Source" },
      candidates: [{ identifier: "candidate", name: "Candidate", rawName: "Candidate", smallThumbnailUrl: "small", mediumThumbnailUrl: "medium", imageUrl: "image", dpi: 72, tags: [], sourceName: "source", source: "source", extension: "png", size: 4 }],
      expectedIdentifier: "candidate", notes: "note", comparisonHints: {},
    }],
    assets: [{ id: "asset", datasetId: "dataset", caseId: "case", role: "source" as const, mimeType: "image/png", createdAt: 5, hash: "legacy", sha256: hash, byteLength: bytes.byteLength }],
    runs: [],
  };
}

function transport(revision = 1, remote = snapshot()): MpcCalibrationTransport {
  return {
    pair: async () => ({ ownerId: identity.ownerId, harnessId: identity.harnessId }),
    unpair: async () => undefined,
    getSession: async () => ({ ownerId: identity.ownerId, harnessId: identity.harnessId }),
    getSnapshot: async () => ({ revision, snapshot: remote }),
    publishSnapshot: async () => { throw new Error("not a C3 publish"); },
    getBlob: async hash => hash === initialHash ? initialBytes.slice() : nextBytes.slice(),
    putBlob: async () => { throw new Error("not a C3 upload"); },
    missingBlobs: async () => ({ missing: [] }),
  };
}

function fresh(): Handle {
  const database = new ProxxiedDexie(`refresh-scheduler-${crypto.randomUUID()}`);
  const scope = createMpcCalibrationOperationScope({ target: "linked-web", identity });
  const handle = { database, scope };
  handles.push(handle);
  return handle;
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function manualTriggers() {
  type Timer = ReturnType<typeof setTimeout>;
  type Entry = { callback: () => void; delayMs: number };
  const timeouts = new Map<Timer, Entry>();
  const intervals = new Map<Timer, Entry>();
  let nextId = 0;
  const register = (map: Map<Timer, Entry>, callback: () => void, delayMs: number) => {
    // The injected host owns opaque handles; these never reach native timers.
    const handle = { id: nextId++ } as unknown as Timer;
    map.set(handle, { callback, delayMs });
    return handle;
  };
  const timers = {
    setTimeout: (callback: () => void, delayMs: number) => register(timeouts, callback, delayMs),
    clearTimeout: (handle: Timer) => { timeouts.delete(handle); },
    setInterval: (callback: () => void, delayMs: number) => register(intervals, callback, delayMs),
    clearInterval: (handle: Timer) => { intervals.delete(handle); },
  } satisfies NonNullable<MpcCalibrationRefreshSchedulerOptions["timers"]>;
  return {
    timers,
    events: new EventTarget(),
    timeouts,
    intervals,
    async fireIntervals() {
      for (const { callback } of [...intervals.values()]) await callback();
      await settle();
    },
    async fireTimeouts() {
      const pending = [...timeouts.values()];
      timeouts.clear();
      for (const { callback } of pending) await callback();
      await settle();
    },
  };
}

async function preservedRows(database: ProxxiedDexie) {
  return {
    datasets: await database.mpcCalibrationDatasets.toArray(),
    cases: await database.mpcCalibrationCases.toArray(),
    runs: await database.mpcCalibrationRuns.toArray(),
    bindings: await database.mpcCalibrationCacheBindings.toArray(),
    sync: await database.mpcCalibrationSyncStates.toArray(),
    assets: await Promise.all((await database.mpcCalibrationAssets.toArray()).map(async ({ blob, ...row }) => ({
      ...row,
      blobType: blob.type,
      blobBytes: Array.from(new Uint8Array(await blob.arrayBuffer())),
    }))),
  };
}

afterEach(() => {
  for (const scheduler of schedulers.splice(0)) scheduler.dispose();
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const { database, scope } of handles.splice(0)) {
    scope.dispose();
    database.close();
  }
});

describe("createMpcCalibrationRefreshScheduler", () => {
  it.each(["authentication", "http", "wrong-owner"] as const)("does not retry terminal %s through periodic or online triggers", async failure => {
    const { database, scope } = fresh();
    const clock = manualTriggers();
    const selected = transport();
    const getSession = vi.fn(async () => {
      if (failure === "wrong-owner") return { ownerId: "other", harnessId: identity.harnessId };
      throw new MpcCalibrationTransportError(failure);
    });
    selected.getSession = getSession;
    const remove = vi.spyOn(clock.events, "removeEventListener");
    const scheduler = createMpcCalibrationRefreshScheduler({ database, operationScope: scope, target: "linked-web", createWebTransport: () => selected, ...clock });

    await scheduler.start();
    await clock.fireIntervals();
    clock.events.dispatchEvent(new Event("online"));
    await settle();
    expect(getSession).toHaveBeenCalledOnce();
    expect(clock.intervals.size + clock.timeouts.size).toBe(0);
    expect(remove).toHaveBeenCalledWith("online", expect.any(Function));
  });

  it.each(["identity", "authentication"] as const)("does not recapture an idle %s replacement for a queued retry", async replacement => {
    const { database, scope } = fresh();
    const clock = manualTriggers();
    const selected = transport();
    const getSession = vi.fn(async () => { throw new MpcCalibrationTransportError("offline"); });
    selected.getSession = getSession;
    const scheduler = createMpcCalibrationRefreshScheduler({ database, operationScope: scope, target: "linked-web", createWebTransport: () => selected, ...clock });
    await scheduler.start();

    if (replacement === "identity") scope.replaceIdentity({ ...identity, connectionId: "new-connection" });
    else scope.replaceAuthentication({ newSession: true });
    await clock.fireTimeouts();
    clock.events.dispatchEvent(new Event("online"));
    await settle();
    expect(getSession).toHaveBeenCalledOnce();
    expect(clock.intervals.size + clock.timeouts.size).toBe(0);
  });

  it("does not dispatch a session after the refreshing callback disposes the scheduler", async () => {
    const { database, scope } = fresh();
    const clock = manualTriggers();
    const selected = transport();
    const getSession = vi.fn(selected.getSession);
    selected.getSession = getSession;
    const scheduler = createMpcCalibrationRefreshScheduler({
      database, operationScope: scope, target: "linked-web", createWebTransport: () => selected, ...clock,
      onStatus(status) { if (status.kind === "refreshing") scheduler.dispose(); },
    });

    await scheduler.start();
    expect(getSession).not.toHaveBeenCalled();
    expect(clock.intervals.size + clock.timeouts.size).toBe(0);
  });

  it("does not create a retry timer after the retrying callback disposes the scheduler", async () => {
    const { database, scope } = fresh();
    const clock = manualTriggers();
    const selected = transport();
    selected.getSession = async () => { throw new MpcCalibrationTransportError("offline"); };
    const scheduler = createMpcCalibrationRefreshScheduler({
      database, operationScope: scope, target: "linked-web", createWebTransport: () => selected, ...clock,
      onStatus(status) { if (status.kind === "retrying") scheduler.dispose(); },
    });

    await scheduler.start();
    expect(clock.intervals.size + clock.timeouts.size).toBe(0);
  });

  it("does not read database or web capability getters for an already-ended scope", async () => {
    const { scope } = fresh();
    scope.dispose();
    const clock = manualTriggers();
    const databaseGetter = vi.fn((): ProxxiedDexie => { throw new Error("dormant database getter"); });
    const factoryGetter = vi.fn((): (() => MpcCalibrationTransport) => { throw new Error("dormant factory getter"); });
    let scheduler: ReturnType<typeof createRefreshScheduler> | undefined;
    expect(() => {
      scheduler = createMpcCalibrationRefreshScheduler({
        operationScope: scope, target: "linked-web", ...clock,
        get database() { return databaseGetter(); },
        get createWebTransport() { return factoryGetter(); },
      });
    }).not.toThrow();
    await scheduler!.start();
    expect(databaseGetter).not.toHaveBeenCalled();
    expect(factoryGetter).not.toHaveBeenCalled();
    expect(clock.intervals.size + clock.timeouts.size).toBe(0);
  });

  it("uses branded abort state rather than a shadowed signal flag before real C3 admission", async () => {
    const { database, scope } = fresh();
    const before = await preservedRows(database);
    const controller = new AbortController();
    controller.abort();
    Object.defineProperty(controller.signal, "aborted", { value: false });
    const capture = scope.captureAppOperation.bind(scope);
    vi.spyOn(scope, "captureAppOperation").mockImplementation(() => ({ ...capture(), signal: controller.signal, isCurrent: () => true }));
    const factory = vi.fn(() => transport());
    const scheduler = createMpcCalibrationRefreshScheduler({ database, operationScope: scope, target: "linked-web", createWebTransport: factory, ...manualTriggers() });

    await scheduler.start();
    expect(await preservedRows(database)).toEqual(before);
    expect(factory).not.toHaveBeenCalled();
  });

  it.each([["getSnapshot", "offline"], ["getBlob", "timeout"]] as const)("retries declared %s %s failures from real C3 without losing the prior cache", async (method, code) => {
    const { database, scope } = fresh();
    await expect(hydrateMpcCalibrationCache({ database, transport: transport(), identity })).resolves.toMatchObject({ status: "hydrated" });
    const before = await preservedRows(database);
    const clock = manualTriggers();
    const selected = transport(2, snapshot(nextHash, nextBytes));
    const failure = vi.fn(async () => { throw new MpcCalibrationTransportError(code); });
    selected[method] = failure;
    const statuses: string[] = [];
    const scheduler = createMpcCalibrationRefreshScheduler({ database, operationScope: scope, target: "linked-web", createWebTransport: () => selected, ...clock, onStatus: status => statuses.push(status.kind) });

    await scheduler.start();
    expect(failure).toHaveBeenCalledOnce();
    expect(await preservedRows(database)).toEqual(before);
    expect(statuses).toContain("retrying");
    expect(clock.timeouts.size).toBe(1);
  });

  it("uses actual C3 to install a genuine newer native-Blob revision", async () => {
    const { database, scope } = fresh();
    await expect(hydrateMpcCalibrationCache({ database, transport: transport(), identity })).resolves.toMatchObject({ status: "hydrated", revision: 1 });
    const statuses: string[] = [];
    const scheduler = createMpcCalibrationRefreshScheduler({
      database,
      operationScope: scope,
      target: "linked-web",
      createWebTransport: () => transport(2, snapshot(nextHash, nextBytes)),
      intervalMs: 60_000,
      onStatus(status) { statuses.push(status.kind); },
    });

    await scheduler.start();

    expect((await database.mpcCalibrationSyncStates.get([identity.ownerId, identity.harnessId, identity.connectionId]))!.base!.revision).toBe(2);
    const stored = (await database.mpcCalibrationAssets.get("asset"))!.blob;
    expect(stored).toBeInstanceOf(Blob);
    expect(Array.from(new Uint8Array(await stored.arrayBuffer()))).toEqual([...nextBytes]);
    expect(stored.type).toBe("image/png");
    expect(statuses).toContain("hydrated");
    scheduler.dispose();
  });

  it("reports no-newer only for equal legitimate content and preserves real C3 bytes", async () => {
    const { database, scope } = fresh();
    await hydrateMpcCalibrationCache({ database, transport: transport(), identity });
    const before = Array.from(new Uint8Array(await (await database.mpcCalibrationAssets.get("asset"))!.blob.arrayBuffer()));
    const statuses: string[] = [];
    const scheduler = createMpcCalibrationRefreshScheduler({ database, operationScope: scope, target: "linked-web", createWebTransport: () => transport(), intervalMs: 60_000, onStatus: status => statuses.push(status.kind) });

    await scheduler.start();

    expect(statuses).toContain("no-newer");
    expect(Array.from(new Uint8Array(await (await database.mpcCalibrationAssets.get("asset"))!.blob.arrayBuffer()))).toEqual(before);
    expect((await database.mpcCalibrationSyncStates.get([identity.ownerId, identity.harnessId, identity.connectionId]))!.base!.revision).toBe(1);
    scheduler.dispose();
  });

  it("keeps a different same-revision remote observation blocked without replacing C3 bytes", async () => {
    const { database, scope } = fresh();
    await hydrateMpcCalibrationCache({ database, transport: transport(), identity });
    const before = Array.from(new Uint8Array(await (await database.mpcCalibrationAssets.get("asset"))!.blob.arrayBuffer()));
    const statuses: string[] = [];
    const scheduler = createMpcCalibrationRefreshScheduler({
      database,
      operationScope: scope,
      target: "linked-web",
      createWebTransport: () => transport(1, snapshot(nextHash, nextBytes)),
      intervalMs: 60_000,
      onStatus: status => statuses.push(status.kind),
    });

    await scheduler.start();

    expect(statuses).toContain("blocked");
    expect(statuses).not.toContain("no-newer");
    expect(Array.from(new Uint8Array(await (await database.mpcCalibrationAssets.get("asset"))!.blob.arrayBuffer()))).toEqual(before);
    scheduler.dispose();
  });

  it("bounds offline retries across timer and online bursts without overlap or reset", async () => {
    vi.useFakeTimers();
    const { database, scope } = fresh();
    const events = new EventTarget();
    let calls = 0;
    const selected = transport();
    selected.getSession = async () => {
      calls += 1;
      throw new MpcCalibrationTransportError("offline");
    };
    const statuses: Array<{ kind: string; attempt?: number }> = [];
    const scheduler = createMpcCalibrationRefreshScheduler({ database, operationScope: scope, target: "linked-web", createWebTransport: () => selected, events, intervalMs: 60_000, onStatus: status => statuses.push(status) });

    scheduler.start();
    await settle();
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      events.dispatchEvent(new Event("online"));
      events.dispatchEvent(new Event("online"));
      await vi.advanceTimersByTimeAsync([1000, 2000, 4000, 8000][attempt - 1]!);
      await settle();
    }
    events.dispatchEvent(new Event("online"));
    await settle();

    expect(calls).toBe(5);
    expect(statuses.filter(status => status.kind === "retrying").map(status => status.attempt)).toEqual([1, 2, 3, 4]);
    expect(statuses.at(-1)?.kind).toBe("unavailable");
    scheduler.dispose();
  });

  it("captures a receiver-correct operation and suppresses stale completion after disposal", async () => {
    const { database, scope } = fresh();
    const events = new EventTarget();
    let release!: () => void;
    let calls = 0;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const selected = transport();
    selected.getSession = async function(this: { marker: string }) {
      expect(this.marker).toBe("transport");
      calls += 1;
      await gate;
      return { ownerId: identity.ownerId, harnessId: identity.harnessId };
    }.bind({ marker: "transport" });
    const statuses: string[] = [];
    const scheduler = createMpcCalibrationRefreshScheduler({ database, operationScope: scope, target: "linked-web", createWebTransport: () => selected, events, intervalMs: 60_000, onStatus: status => statuses.push(status.kind) });

    scheduler.start();
    await settle();
    events.dispatchEvent(new Event("online"));
    events.dispatchEvent(new Event("online"));
    expect(calls).toBe(1);
    scope.replaceIdentity({ ...identity, connectionId: "replacement-connection" });
    release();
    await settle();

    expect(statuses).toEqual(["refreshing"]);
    scheduler.dispose();
  });

  it("does not discover transport or database for local and pre-aborted scopes", async () => {
    const localScope = createMpcCalibrationOperationScope({ target: "local", identity: null });
    const localGetter = vi.fn(() => { throw new Error("unused transport"); });
    const local = createMpcCalibrationRefreshScheduler({ database: undefined as never, operationScope: localScope, target: "local", get createWebTransport() { return localGetter(); }, intervalMs: 60_000 });
    local.start();
    await settle();
    expect(localGetter).not.toHaveBeenCalled();
    local.dispose();
    localScope.dispose();

    const { database, scope } = fresh();
    scope.dispose();
    const factory = vi.fn(() => transport());
    const cancelled = createMpcCalibrationRefreshScheduler({ database, operationScope: scope, target: "linked-web", createWebTransport: factory, intervalMs: 60_000 });
    cancelled.start();
    await settle();
    expect(factory).not.toHaveBeenCalled();
    cancelled.dispose();
  });

  it.each(["identity", "authentication"] as const)("fences successful idle C3 refreshes after %s replacement", async replacement => {
    const { database, scope } = fresh();
    const clock = manualTriggers();
    const selected = transport();
    const getSession = vi.fn(selected.getSession);
    const getSnapshot = vi.fn(selected.getSnapshot);
    const getBlob = vi.fn(selected.getBlob);
    selected.getSession = getSession;
    selected.getSnapshot = getSnapshot;
    selected.getBlob = getBlob;
    const scheduler = createMpcCalibrationRefreshScheduler({ database, operationScope: scope, target: "linked-web", createWebTransport: () => selected, ...clock });

    await scheduler.start();
    const before = await preservedRows(database);
    const beforeCalls = {
      getSession: getSession.mock.calls.length,
      getSnapshot: getSnapshot.mock.calls.length,
      getBlob: getBlob.mock.calls.length,
    };
    if (replacement === "identity") scope.replaceIdentity({ ...identity, connectionId: "idle-replacement" });
    else scope.replaceAuthentication({ epoch: "idle-replacement" });
    await clock.fireIntervals();
    clock.events.dispatchEvent(new Event("online"));
    await settle();

    expect(getSession).toHaveBeenCalledTimes(beforeCalls.getSession);
    expect(getSnapshot).toHaveBeenCalledTimes(beforeCalls.getSnapshot);
    expect(getBlob).toHaveBeenCalledTimes(beforeCalls.getBlob);
    expect(await preservedRows(database)).toEqual(before);
    expect(clock.intervals.size + clock.timeouts.size).toBe(0);
  });

  it("does not discover C3 dependencies when a receiver-correct currentness predicate aborts its own signal", async () => {
    const { scope } = fresh();
    const capture = scope.captureAppOperation.bind(scope);
    let captures = 0;
    let currentChecks = 0;
    vi.spyOn(scope, "captureAppOperation").mockImplementation(() => {
      const base = capture();
      if (captures++ === 0) return base;
      const controller = new AbortController();
      const operation = {
        ...base,
        signal: controller.signal,
        isCurrent() {
          expect(this).toBe(operation);
          currentChecks += 1;
          controller.abort();
          return true;
        },
        dispose() {
          controller.abort();
          base.dispose();
        },
        onCancel(listener: () => void) {
          controller.signal.addEventListener("abort", listener, { once: true });
          return () => controller.signal.removeEventListener("abort", listener);
        },
      };
      return operation;
    });
    const databaseGetter = vi.fn((): ProxxiedDexie => { throw new Error("must remain dormant"); });
    const factoryGetter = vi.fn((): (() => MpcCalibrationTransport) => { throw new Error("must remain dormant"); });
    const scheduler = createMpcCalibrationRefreshScheduler({
      operationScope: scope,
      target: "linked-web",
      ...manualTriggers(),
      get database() { return databaseGetter(); },
      get createWebTransport() { return factoryGetter(); },
    });

    await scheduler.start();

    expect(currentChecks).toBe(1);
    expect(databaseGetter).not.toHaveBeenCalled();
    expect(factoryGetter).not.toHaveBeenCalled();
  });

  it("does not retain a retry after a receiver-correct currentness predicate disposes during failure handling", async () => {
    const { database, scope } = fresh();
    const clock = manualTriggers();
    const capture = scope.captureAppOperation.bind(scope);
    let captures = 0;
    let failureHandling = false;
    let currentChecks = 0;
    vi.spyOn(scope, "captureAppOperation").mockImplementation(() => {
      const base = capture();
      if (captures++ === 0) return base;
      const controller = new AbortController();
      const operation = {
        ...base,
        signal: controller.signal,
        isCurrent() {
          expect(this).toBe(operation);
          currentChecks += 1;
          if (failureHandling) scheduler.dispose();
          return true;
        },
        dispose() {
          controller.abort();
          base.dispose();
        },
        onCancel(listener: () => void) {
          controller.signal.addEventListener("abort", listener, { once: true });
          return () => controller.signal.removeEventListener("abort", listener);
        },
      };
      return operation;
    });
    const selected = transport();
    const getSession = vi.fn(async () => {
      failureHandling = true;
      throw new MpcCalibrationTransportError("offline");
    });
    selected.getSession = getSession;
    const scheduler = createMpcCalibrationRefreshScheduler({ database, operationScope: scope, target: "linked-web", createWebTransport: () => selected, ...clock });

    await scheduler.start();

    expect(getSession).toHaveBeenCalledOnce();
    expect(currentChecks).toBeLessThanOrEqual(5);
    expect(clock.intervals.size + clock.timeouts.size).toBe(0);
  });
});
