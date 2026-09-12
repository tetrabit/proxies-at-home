import "fake-indexeddb/auto";
import { Blob as NodeBlob } from "node:buffer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProxxiedDexie } from "@/db";
import { validateCalibrationHarnessRecoveryState } from "../../../shared/calibrationHarnessRecoveryState";
import {
  createMpcCalibrationOperationScope as createOperationScope,
  type MpcCalibrationCapturedOperation,
  type MpcCalibrationOperationScope,
} from "./mpcCalibrationOperationScope";
import { MpcCalibrationTransportError, type MpcCalibrationTransport } from "./mpcCalibrationTransport";
import { disableMpcCalibrationLink } from "./mpcCalibrationDisable";

const handles: ProxxiedDexie[] = [];
const scopes: MpcCalibrationOperationScope[] = [];
const identity = Object.freeze({ ownerId: "owner", harnessId: "harness", connectionId: "connection" });

function createMpcCalibrationOperationScope(options: Parameters<typeof createOperationScope>[0]) {
  const scope = createOperationScope(options);
  scopes.push(scope);
  return scope;
}

function freshDatabase(): ProxxiedDexie {
  const database = new ProxxiedDexie(`disable-unpair-${crypto.randomUUID()}`);
  handles.push(database);
  return database;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
  return { promise, resolve, reject };
}

function transport(options: {
  getSession?: MpcCalibrationTransport["getSession"];
  unpair?: MpcCalibrationTransport["unpair"];
} = {}): MpcCalibrationTransport {
  const unsupported = vi.fn(async (): Promise<never> => { throw new Error("unexpected transport operation"); });
  return {
    pair: unsupported,
    getSession: options.getSession ?? (async () => ({ ownerId: identity.ownerId, harnessId: identity.harnessId })),
    unpair: options.unpair ?? (async () => {}),
    getSnapshot: unsupported,
    publishSnapshot: unsupported,
    getBlob: unsupported,
    putBlob: unsupported,
    missingBlobs: unsupported,
  };
}

async function seedPreservedState(database: ProxxiedDexie) {
  const snapshot = (retained: string) => ({
    version: 1 as const,
    datasets: [{ id: "dataset", name: "C1", targetCaseCount: 1, createdAt: 1, updatedAt: 2, version: 1 }],
    cases: [{ id: "case", datasetId: "dataset", createdAt: 3, updatedAt: 4, source: { name: "C1 Card" }, candidates: [] }],
    assets: [{
      id: "asset", datasetId: "dataset", caseId: "case", role: "source" as const,
      mimeType: "application/octet-stream", createdAt: 5,
      sha256: "9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a", byteLength: 4,
    }],
    runs: [{
      id: "run", datasetId: "dataset", algorithmId: "algorithm", createdAt: 6,
      summary: { totalCases: 1, matchedCases: 1, mismatchedCases: 0, accuracy: 1 },
      results: [{ caseId: "case", matched: true }],
    }],
    retained,
  });
  const state = {
    formatVersion: 2 as const, ...identity,
    base: { revision: 1, snapshot: snapshot("base") },
    queued: { generation: 2, snapshot: snapshot("G2") },
    inFlight: { generation: 1, expectedBaseRevision: 1, snapshot: snapshot("G1") },
    lastAcknowledgement: null, settledGeneration: 0, lastRecovery: null,
    dirtyGeneration: 2, sentGeneration: 1, acknowledgedGeneration: 0, updatedAt: 3,
  };
  expect(validateCalibrationHarnessRecoveryState(state)).toBe(state);
  await database.mpcCalibrationLinkStates.put({ formatVersion: 1, ...identity, updatedAt: 1 });
  await database.mpcCalibrationCacheBindings.put({ id: "mpc-calibration-cache-binding", ...identity, revision: 3, updatedAt: 2 });
  await database.mpcCalibrationSyncStates.put(state);
  await database.mpcCalibrationDatasets.put({ id: "dataset", name: "C1", targetCaseCount: 1, createdAt: 1, updatedAt: 2, version: 1 });
  await database.mpcCalibrationCases.put({ id: "case", datasetId: "dataset", createdAt: 3, updatedAt: 4, source: { name: "C1 Card" }, candidates: [] });
  await database.mpcCalibrationAssets.put({ id: "asset", datasetId: "dataset", caseId: "case", role: "source", mimeType: "application/octet-stream", blob: new NodeBlob([new Uint8Array([1, 2, 3, 4])], { type: "application/octet-stream" }), createdAt: 5, hash: "legacy" });
  await database.mpcCalibrationRuns.put({ id: "run", datasetId: "dataset", algorithmId: "algorithm", createdAt: 6, summary: { totalCases: 1, matchedCases: 1, mismatchedCases: 0, accuracy: 1 }, results: [{ caseId: "case", matched: true }] });
}

async function preservedState(database: ProxxiedDexie) {
  const assets = await Promise.all((await database.mpcCalibrationAssets.toArray()).map(async ({ blob, ...row }) => ({
    row,
    type: blob.type,
    bytes: Array.from(new Uint8Array(await blob.arrayBuffer())),
  })));
  return {
    bindings: await database.mpcCalibrationCacheBindings.toArray(),
    sync: await database.mpcCalibrationSyncStates.toArray(),
    datasets: await database.mpcCalibrationDatasets.toArray(),
    cases: await database.mpcCalibrationCases.toArray(),
    assets,
    runs: await database.mpcCalibrationRuns.toArray(),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const scope of scopes.splice(0)) scope.dispose();
  for (const database of handles.splice(0)) database.close();
});

describe("disableMpcCalibrationLink", () => {
  it("fences pending app and UI work, gets the web session before unpair, and removes only the matching link while preserving nonempty cache and outbox bytes", async () => {
    const database = freshDatabase();
    await seedPreservedState(database);
    const before = await preservedState(database);
    const scope = createMpcCalibrationOperationScope({ target: "linked-web", identity });
    const app = scope.captureAppOperation();
    const ui = scope.captureUiOperation();
    const calls: string[] = [];
    const selected = transport({
      getSession: vi.fn(async function (this: { marker: string }, options) {
        expect(this.marker).toBe("web");
        expect(options).toEqual({ signal: expect.any(AbortSignal) });
        calls.push("getSession");
        return { ownerId: identity.ownerId, harnessId: identity.harnessId };
      }),
      unpair: vi.fn(async function (this: { marker: string }, options) {
        expect(this.marker).toBe("web");
        expect(options).toEqual({ signal: expect.any(AbortSignal) });
        calls.push("unpair");
      }),
    });
    Object.assign(selected, { marker: "web" });

    await expect(disableMpcCalibrationLink({ target: "linked-web", scope, identity, database, createWebTransport: () => selected }))
      .resolves.toEqual({ kind: "disabled", target: "local", previousTarget: "linked-web" });
    expect(app.isCurrent()).toBe(false);
    expect(ui.isCurrent()).toBe(false);
    expect(calls).toEqual(["getSession", "unpair"]);
    expect(await database.mpcCalibrationLinkStates.get([identity.ownerId, identity.harnessId])).toBeUndefined();
    expect(await preservedState(database)).toEqual(before);
    scope.dispose();
  });

  it.each(["local", "linked-electron"] as const)("is request-free for %s and does not read inactive web or database capabilities", async target => {
    const scope = createMpcCalibrationOperationScope({ target, identity });
    const input = { target, scope, identity } as Record<string, unknown>;
    Object.defineProperty(input, "database", { get() { throw new Error("inactive database capability read"); } });
    Object.defineProperty(input, "createWebTransport", { get() { throw new Error("inactive web capability read"); } });

    await expect(disableMpcCalibrationLink(input as never)).resolves.toEqual({ kind: "disabled", target: "local", previousTarget: target });
    scope.dispose();
  });

  it("keeps matching metadata and all nonempty local state when supported web unpair rejects", async () => {
    const database = freshDatabase();
    await seedPreservedState(database);
    const before = await preservedState(database);
    const scope = createMpcCalibrationOperationScope({ target: "linked-web", identity });
    const sentinel = "offline secret-like detail";
    const selected = transport({ unpair: async () => { throw new MpcCalibrationTransportError("offline"); } });

    const result = await disableMpcCalibrationLink({ target: "linked-web", scope, identity, database, createWebTransport: () => selected });
    expect(result).toEqual({ kind: "rejected", target: "linked-web", status: "offline" });
    expect(JSON.stringify(result)).not.toContain(sentinel);
    expect(await database.mpcCalibrationLinkStates.get([identity.ownerId, identity.harnessId])).toMatchObject(identity);
    expect(await preservedState(database)).toEqual(before);
    scope.dispose();
  });

  it("never deletes absent-intent, wrong-session, foreign, or replaced link metadata", async () => {
    const database = freshDatabase();
    await database.mpcCalibrationLinkStates.bulkPut([
      { formatVersion: 1, ...identity, updatedAt: 1 },
      { formatVersion: 1, ownerId: "foreign", harnessId: "harness", connectionId: "foreign", updatedAt: 1 },
    ]);
    const scope = createMpcCalibrationOperationScope({ target: "linked-web", identity });
    const wrongSession = transport({ getSession: async () => ({ ownerId: "other", harnessId: identity.harnessId }) });
    await expect(disableMpcCalibrationLink({ target: "linked-web", scope, identity, database, createWebTransport: () => wrongSession }))
      .resolves.toEqual({ kind: "rejected", target: "linked-web", status: "authentication" });
    expect(await database.mpcCalibrationLinkStates.toArray()).toHaveLength(2);
    scope.dispose();

    const preauthScope = createMpcCalibrationOperationScope({ target: "linked-web", identity: null });
    const preauthInput = { target: "linked-web" as const, scope: preauthScope, identity: null, createWebTransport: () => transport() } as Record<string, unknown>;
    Object.defineProperty(preauthInput, "database", { get() { throw new Error("pre-auth metadata namespace must not be read"); } });
    await expect(disableMpcCalibrationLink(preauthInput as never))
      .resolves.toEqual({ kind: "disabled", target: "local", previousTarget: "linked-web" });
    expect(await database.mpcCalibrationLinkStates.get([identity.ownerId, identity.harnessId])).toMatchObject(identity);
    preauthScope.dispose();
  });

  it("uses captured options and methods, and preserves a newer same-key row after async unpair", async () => {
    const database = freshDatabase();
    await database.mpcCalibrationLinkStates.put({ formatVersion: 1, ...identity, updatedAt: 1 });
    const scope = createMpcCalibrationOperationScope({ target: "linked-web", identity });
    const held = deferred<void>();
    const entered = deferred<void>();
    const originalUnpair = vi.fn(async () => { entered.resolve(); await held.promise; });
    const original = transport({ unpair: originalUnpair });
    const replacement = vi.fn(async () => { throw new Error("must not retarget"); });
    const input = { target: "linked-web" as const, scope, identity, database, createWebTransport: () => original };
    const pending = disableMpcCalibrationLink(input);
    await entered.promise;
    original.unpair = replacement;
    input.createWebTransport = () => transport({ unpair: replacement });
    await database.mpcCalibrationLinkStates.put({ formatVersion: 1, ...identity, connectionId: "newer", updatedAt: 2 });
    held.resolve();

    await expect(pending).resolves.toEqual({ kind: "disabled", target: "local", previousTarget: "linked-web" });
    expect(originalUnpair).toHaveBeenCalledOnce();
    expect(replacement).not.toHaveBeenCalled();
    expect(await database.mpcCalibrationLinkStates.get([identity.ownerId, identity.harnessId])).toMatchObject({ connectionId: "newer", updatedAt: 2 });
    scope.dispose();
  });

  it("rolls back an actual post-delete stale transaction instead of deleting metadata", async () => {
    const database = freshDatabase();
    await database.mpcCalibrationLinkStates.put({ formatVersion: 1, ...identity, updatedAt: 1 });
    const scope = createMpcCalibrationOperationScope({ target: "linked-web", identity });
    const remove = database.mpcCalibrationLinkStates.delete.bind(database.mpcCalibrationLinkStates);
    vi.spyOn(database.mpcCalibrationLinkStates, "delete").mockImplementation(async key => {
      const outcome = await remove(key);
      scope.replaceAuthentication({ replacement: true });
      return outcome;
    });

    await expect(disableMpcCalibrationLink({ target: "linked-web", scope, identity, database, createWebTransport: () => transport() }))
      .resolves.toEqual({ kind: "cancelled", target: "linked-web" });
    expect(await database.mpcCalibrationLinkStates.get([identity.ownerId, identity.harnessId])).toMatchObject(identity);
    scope.dispose();
  });

  it.each(["session", "unpair"] as const)("retains linked authority after a %s failure while fencing older operations", async failure => {
    const database = freshDatabase();
    await seedPreservedState(database);
    const before = await preservedState(database);
    const scope = createMpcCalibrationOperationScope({ target: "linked-web", identity });
    const older = scope.captureAppOperation();
    const selected = transport({
      getSession: async () => {
        if (failure === "session") throw new MpcCalibrationTransportError("authentication");
        return { ownerId: identity.ownerId, harnessId: identity.harnessId };
      },
      unpair: async () => { throw new MpcCalibrationTransportError("offline"); },
    });

    const result = await disableMpcCalibrationLink({ target: "linked-web", scope, identity, database, createWebTransport: () => selected });
    expect(result).toMatchObject({ kind: "rejected", target: "linked-web" });
    expect(older.isCurrent()).toBe(false);
    expect(await preservedState(database)).toEqual(before);
    const after = scope.captureAppOperation();
    expect(after.target).toBe("linked-web");
    expect(after.identity).toEqual(identity);
  });

  it("releases its prior inspection token on early identity rejection without ending unrelated work", async () => {
    const scope = createMpcCalibrationOperationScope({ target: "linked-web", identity });
    const unrelated = scope.captureUiOperation();
    const capture = scope.captureAppOperation.bind(scope);
    const captured: MpcCalibrationCapturedOperation[] = [];
    vi.spyOn(scope, "captureAppOperation").mockImplementation(() => {
      const operation = capture();
      captured.push(operation);
      return operation;
    });

    await expect(disableMpcCalibrationLink({ target: "linked-web", scope, identity: { ...identity, connectionId: "other" } }))
      .resolves.toMatchObject({ kind: "rejected", status: "invalid-operation" });
    expect(unrelated.isCurrent()).toBe(true);
    expect(captured).toHaveLength(1);
    expect(captured[0].signal.aborted).toBe(true);
  });

  it("reports cancellation after actual metadata transaction settlement without pretending the committed delete rolled back", async () => {
    const database = freshDatabase();
    await seedPreservedState(database);
    const before = await preservedState(database);
    const scope = createMpcCalibrationOperationScope({ target: "linked-web", identity });
    const transact = database.transaction.bind(database);
    const completed = vi.fn();
    vi.spyOn(database, "transaction").mockImplementation((...args) => transact(...args).then(value => {
      completed();
      scope.replaceAuthentication({ newer: true });
      return value;
    }));

    const result = await disableMpcCalibrationLink({ target: "linked-web", scope, identity, database, createWebTransport: () => transport() });
    expect(completed).toHaveBeenCalledOnce();
    expect(await database.mpcCalibrationLinkStates.get([identity.ownerId, identity.harnessId])).toBeUndefined();
    expect(await preservedState(database)).toEqual(before);
    expect(result).toEqual({ kind: "cancelled", target: "linked-web" });
  });

  it("captures the original action cleanup before an asynchronous unpair", async () => {
    const scope = createMpcCalibrationOperationScope({ target: "linked-web", identity: null });
    const capture = scope.captureAppOperation.bind(scope);
    const captured: MpcCalibrationCapturedOperation[] = [];
    vi.spyOn(scope, "captureAppOperation").mockImplementation(() => {
      const operation = capture();
      captured.push(operation);
      return operation;
    });
    const entered = deferred<void>();
    const held = deferred<void>();
    const selected = transport({ unpair: async () => { entered.resolve(); await held.promise; } });
    const pending = disableMpcCalibrationLink({ target: "linked-web", scope, identity: null, createWebTransport: () => selected });
    await entered.promise;
    const action = captured[captured.length - 1];
    const replacement = vi.fn(() => { throw new Error("raw late cleanup detail"); });
    Object.defineProperty(action, "dispose", { get: replacement });
    held.resolve();

    await expect(pending).resolves.toEqual({ kind: "disabled", target: "local", previousTarget: "linked-web" });
    expect(replacement).not.toHaveBeenCalled();
    expect(action.signal.aborted).toBe(true);
  });

  it("treats a literal-true predicate that synchronously aborts its action as cancelled before transport activity", async () => {
    const scope = createMpcCalibrationOperationScope({ target: "linked-web", identity: null });
    const capture = scope.captureAppOperation.bind(scope);
    let captures = 0;
    vi.spyOn(scope, "captureAppOperation").mockImplementation(() => {
      const operation = capture();
      captures += 1;
      if (captures === 2) {
        vi.spyOn(operation, "isCurrent").mockImplementation(() => {
          scope.replaceAuthentication({ synchronous: "replacement" });
          return true;
        });
      }
      return operation;
    });
    const createWebTransport = vi.fn(() => transport());

    await expect(disableMpcCalibrationLink({ target: "linked-web", scope, identity: null, createWebTransport }))
      .resolves.toEqual({ kind: "cancelled", target: "linked-web" });
    expect(createWebTransport).not.toHaveBeenCalled();
  });

  it.each(["target", "identity"] as const)("does not adopt a reentrant %s replacement while fencing previous work", async replacement => {
    const database = freshDatabase();
    await seedPreservedState(database);
    const before = await preservedState(database);
    const scope = createMpcCalibrationOperationScope({ target: "linked-web", identity });
    const previous = scope.captureAppOperation();
    previous.onCancel(() => {
      if (replacement === "target") scope.replaceTarget("linked-electron");
      else scope.replaceIdentity({ ownerId: "new-owner", harnessId: "new-harness", connectionId: "new-connection" });
    });
    const getSession = vi.fn(async () => ({ ownerId: identity.ownerId, harnessId: identity.harnessId }));
    const unpair = vi.fn(async () => {});
    const result = await disableMpcCalibrationLink({ target: "linked-web", scope, identity, database, createWebTransport: () => transport({ getSession, unpair }) });

    expect(getSession).not.toHaveBeenCalled();
    expect(unpair).not.toHaveBeenCalled();
    expect(result).toEqual({ kind: "cancelled", target: "linked-web" });
    expect(await database.mpcCalibrationLinkStates.get([identity.ownerId, identity.harnessId])).toMatchObject(identity);
    expect(await preservedState(database)).toEqual(before);
  });
});
