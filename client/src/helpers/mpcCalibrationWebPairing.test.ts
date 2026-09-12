import "fake-indexeddb/auto";
import { Blob as NodeBlob } from "node:buffer";
import { webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProxxiedDexie } from "@/db";
import { createMpcCalibrationLinkStateStore } from "./mpcCalibrationLinkState";
import { hydrateMpcCalibrationCache } from "./mpcCalibrationCache";
import { createMpcCalibrationMutationCoordinator } from "./mpcCalibrationMutations";
import { createMpcCalibrationSyncStateStore } from "./mpcCalibrationSyncState";
import type { CalibrationHarnessSnapshot } from "../../../shared/calibrationHarness";
import { createMpcCalibrationOperationScope } from "./mpcCalibrationOperationScope";
import { MpcCalibrationTransportError, type MpcCalibrationTransport } from "./mpcCalibrationTransport";
import { createMpcCalibrationWebTransport } from "./mpcCalibrationWebTransport";
import { pairMpcCalibrationWeb } from "./mpcCalibrationWebPairing";

const pairCredential = `calibration_pair_${"p".repeat(43)}`;
const handles: ProxxiedDexie[] = [];

type CredentialInput = {
  marker: string;
  value: string;
  takes: number;
  clears: number;
  take(this: CredentialInput): string;
  clear(this: CredentialInput): void;
};

function credential(value = pairCredential, marker = "credential"): CredentialInput {
  return {
    marker,
    value,
    takes: 0,
    clears: 0,
    take() {
      expect(this.marker).toBe(marker);
      this.takes += 1;
      return this.value;
    },
    clear() {
      expect(this.marker).toBe(marker);
      this.clears += 1;
      this.value = "";
    },
  };
}

function freshDatabase(): ProxxiedDexie {
  const database = new ProxxiedDexie(`web-pairing-${crypto.randomUUID()}`);
  handles.push(database);
  return database;
}

function transport(pair: MpcCalibrationTransport["pair"], getSession: MpcCalibrationTransport["getSession"]): MpcCalibrationTransport {
  const unsupported = vi.fn(async (): Promise<never> => { throw new Error("unexpected transport operation"); });
  return { pair, getSession, unpair: unsupported, getSnapshot: unsupported, publishSnapshot: unsupported, getBlob: unsupported, putBlob: unsupported, missingBlobs: unsupported };
}

function operation(target: "linked-web" | "linked-electron" | "local" = "linked-web") {
  const controller = new AbortController();
  const current = { value: true };
  return {
    target,
    signal: controller.signal,
    isCurrent(this: { target: string; signal: AbortSignal; isCurrent: () => boolean }) {
      return current.value;
    },
    controller,
    current,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const database of handles.splice(0)) database.close();
});

describe("pairMpcCalibrationWeb", () => {
  it("moves credential ownership out of deferred continuation after pair dispatch", async () => {
    const source = readFileSync(resolve(process.cwd(), "src/helpers/mpcCalibrationWebPairing.ts"), "utf8");
    expect(source).toMatch(/export function pairMpcCalibrationWeb\(/);
    expect(source).toMatch(/function prepareMpcCalibrationWebPairing\(/);
    expect(source).toMatch(/async function finishMpcCalibrationWebPairing\(/);
    const preparationType = source.match(/type PairPreparation = Readonly<\{[\s\S]*?\n\}>;/)?.[0];
    expect(preparationType).toContain("pairPromise:");
    expect(preparationType).not.toContain("source:");
    expect(source).toMatch(/const credential = capturedCredential\.credential;\s+capturedCredential = undefined;\s+capturedClear = undefined;\s+try \{\s+return \{\s+kind: "ready",[\s\S]*pairPromise: dispatchPair\(pair, credential, operation\.signal\)/);

    const database = freshDatabase();
    const input = credential();
    const scope = operation();
    let ownerReads = 0;
    let releaseSession!: (value: { ownerId: string; harnessId: string }) => void;
    let releaseResolve!: (value: { ownerId: string; harnessId: string; connectionId: string }) => void;
    let enteredSession!: () => void;
    let enteredResolve!: () => void;
    const sessionHeld = new Promise<{ ownerId: string; harnessId: string }>(resolve => { releaseSession = resolve; });
    const resolveHeld = new Promise<{ ownerId: string; harnessId: string; connectionId: string }>(resolve => { releaseResolve = resolve; });
    const sessionEntered = new Promise<void>(resolve => { enteredSession = resolve; });
    const resolveEntered = new Promise<void>(resolve => { enteredResolve = resolve; });
    const deferredSession = vi.fn(async () => { enteredSession(); return await sessionHeld; });
    const deferredResolve = vi.fn(async () => { enteredResolve(); return await resolveHeld; });
    const pairingInput = {
      database, target: "linked-web" as const, operation: scope, transientCredential: input,
      createWebTransport: () => transport(async () => ({ ownerId: "owner-a", harnessId: "harness-a" }), deferredSession),
      linkStateStore: { resolve: deferredResolve },
    };
    Object.defineProperty(pairingInput, "transientCredential", { get() { ownerReads += 1; return input; } });

    const pending = pairMpcCalibrationWeb(pairingInput);
    await sessionEntered;
    expect(ownerReads).toBe(1);
    releaseSession({ ownerId: "owner-a", harnessId: "harness-a" });
    await resolveEntered;
    expect(ownerReads).toBe(1);
    releaseResolve({ ownerId: "owner-a", harnessId: "harness-a", connectionId: "connection-a" });

    await expect(pending).resolves.toEqual({ kind: "paired", target: "linked-web", identity: { ownerId: "owner-a", harnessId: "harness-a", connectionId: "connection-a" } });
    expect(input).toMatchObject({ value: "", takes: 1, clears: 1 });
    expect(deferredSession).toHaveBeenCalledOnce();
    expect(deferredResolve).toHaveBeenCalledOnce();
  });

  it.each(["local", "linked-electron"] as const)("does not report linked-web for %s when clear capture is unavailable", async target => {
    const database = freshDatabase();
    const input = credential();
    Object.defineProperty(input, "clear", { get() { throw new Error("synthetic-private-clear"); } });
    const factory = vi.fn();
    await expect(pairMpcCalibrationWeb({ database, target, operation: operation(target), transientCredential: input, createWebTransport: factory })).resolves.toEqual({ kind: "rejected", status: "invalid-operation" });
    expect(input.takes).toBe(0);
    expect(factory).not.toHaveBeenCalled();
  });

  it("takes and clears the same captured credential owner when the input accessor changes", async () => {
    const database = freshDatabase();
    const first = credential(pairCredential, "first-owner");
    const later = credential(`calibration_pair_${"q".repeat(43)}`, "later-owner");
    const pair = vi.fn(async () => ({ ownerId: "owner-a", harnessId: "harness-a" }));
    const input = {
      database, target: "linked-web" as const, operation: operation(), transientCredential: first,
      createWebTransport: () => transport(pair, async () => ({ ownerId: "owner-a", harnessId: "harness-a" })),
    };
    let reads = 0;
    Object.defineProperty(input, "transientCredential", { get() { return reads++ === 0 ? first : later; } });

    await expect(pairMpcCalibrationWeb(input)).resolves.toMatchObject({ kind: "paired" });
    expect(reads).toBe(1);
    expect(first).toMatchObject({ value: "", takes: 1, clears: 1 });
    expect(later).toMatchObject({ value: `calibration_pair_${"q".repeat(43)}`, takes: 0, clears: 0 });
    expect(pair).toHaveBeenCalledWith(pairCredential, { signal: input.operation.signal });
  });

  it("rejects a missing required operation signal before taking or selecting", async () => {
    const database = freshDatabase();
    const input = credential();
    const factory = vi.fn(() => transport(async () => ({ ownerId: "owner-a", harnessId: "harness-a" }), async () => ({ ownerId: "owner-a", harnessId: "harness-a" })));
    const invalidOperation = { ...operation(), signal: undefined as never };

    expect((await pairMpcCalibrationWeb({ database, target: "linked-web", operation: invalidOperation, transientCredential: input, createWebTransport: factory })).kind).toBe("rejected");
    expect(factory).not.toHaveBeenCalled();
    expect(input).toMatchObject({ value: "", takes: 0, clears: 1 });
  });

  it("does not admit a callable operation predicate that returns no currentness proof", async () => {
    const database = freshDatabase();
    const input = credential();
    const factory = vi.fn(() => transport(async () => ({ ownerId: "owner-a", harnessId: "harness-a" }), async () => ({ ownerId: "owner-a", harnessId: "harness-a" })));
    const invalidOperation = { ...operation(), isCurrent: () => undefined as never };

    await expect(pairMpcCalibrationWeb({ database, target: "linked-web", operation: invalidOperation, transientCredential: input, createWebTransport: factory })).resolves.toEqual({ kind: "cancelled", target: "linked-web" });
    expect(factory).not.toHaveBeenCalled();
    expect(input).toMatchObject({ value: "", clears: 1 });
  });

  it("preserves a newer entry in the same credential cell after an old operation settles", async () => {
    const database = freshDatabase();
    const input = credential();
    const owner = createMpcCalibrationOperationScope({ target: "linked-web", identity: null });
    let release!: (value: { ownerId: string; harnessId: string }) => void;
    const held = new Promise<{ ownerId: string; harnessId: string }>(resolve => { release = resolve; });
    const getSession = vi.fn(async () => ({ ownerId: "owner-a", harnessId: "harness-a" }));
    const pending = pairMpcCalibrationWeb({ database, target: "linked-web", operation: owner.captureAppOperation(), transientCredential: input, createWebTransport: () => transport(async () => held, getSession) });
    try {
      expect(input).toMatchObject({ value: "", takes: 1, clears: 1 });
      input.value = `calibration_pair_${"r".repeat(43)}`;
      owner.replaceAuthentication({ newer: true });
      release({ ownerId: "owner-a", harnessId: "harness-a" });
      await expect(pending).resolves.toEqual({ kind: "cancelled", target: "linked-web" });
      expect(input).toMatchObject({ value: `calibration_pair_${"r".repeat(43)}`, takes: 1, clears: 1 });
      expect(getSession).not.toHaveBeenCalled();
    } finally {
      release({ ownerId: "owner-a", harnessId: "harness-a" });
      await pending;
      owner.dispose();
    }
  });

  it("transfers a transient credential exactly once, clears it synchronously, confirms session identity, and persists only non-secret link metadata", async () => {
    const database = freshDatabase();
    const input = credential();
    const scope = operation();
    const pair = vi.fn(async function (this: { marker: string }, supplied: string, options?: { signal?: AbortSignal }) {
      expect(this.marker).toBe("transport");
      expect(supplied).toBe(pairCredential);
      expect(options).toEqual({ signal: scope.signal });
      return { ownerId: "owner-a", harnessId: "harness-a" };
    });
    const getSession = vi.fn(async function (this: { marker: string }, options?: { signal?: AbortSignal }) {
      expect(this.marker).toBe("transport");
      expect(options).toEqual({ signal: scope.signal });
      return { ownerId: "owner-a", harnessId: "harness-a" };
    });
    const selected = Object.assign(transport(pair, getSession), { marker: "transport" });

    const result = await pairMpcCalibrationWeb({
      database,
      target: "linked-web",
      operation: scope,
      transientCredential: input,
      createWebTransport: () => selected,
    });

    expect(result).toEqual({ kind: "paired", target: "linked-web", identity: { ownerId: "owner-a", harnessId: "harness-a", connectionId: expect.any(String) } });
    expect(pair).toHaveBeenCalledOnce();
    expect(getSession).toHaveBeenCalledOnce();
    expect(input).toMatchObject({ value: "", takes: 1, clears: 1 });
    expect(JSON.stringify(result)).not.toContain(pairCredential);
    expect(await database.mpcCalibrationLinkStates.get(["owner-a", "harness-a"])).toMatchObject({ ownerId: "owner-a", harnessId: "harness-a", connectionId: (result as { identity: { connectionId: string } }).identity.connectionId });
    expect(await Promise.all([database.mpcCalibrationCacheBindings.count(), database.mpcCalibrationSyncStates.count(), database.mpcCalibrationDatasets.count(), database.mpcCalibrationCases.count(), database.mpcCalibrationAssets.count(), database.mpcCalibrationRuns.count()])).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it("clears its captured credential input when pairing rejects without exposing the failure", async () => {
    const database = freshDatabase();
    const input = credential();
    const pair = vi.fn(async () => { throw new Error("synthetic-private-credential-detail"); });
    const getSession = vi.fn();

    await expect(pairMpcCalibrationWeb({ database, target: "linked-web", operation: operation(), transientCredential: input, createWebTransport: () => transport(pair, getSession) }))
      .resolves.toEqual({ kind: "rejected", target: "linked-web", status: "unavailable" });
    expect(input).toMatchObject({ value: "", takes: 1, clears: 1 });
    expect(getSession).not.toHaveBeenCalled();
  });

  it("clears its captured credential before a selected web transport setup failure", async () => {
    const database = freshDatabase();
    const input = credential();
    const factory = vi.fn(() => { throw new Error("synthetic-private-setup-detail"); });

    await expect(pairMpcCalibrationWeb({ database, target: "linked-web", operation: operation(), transientCredential: input, createWebTransport: factory }))
      .resolves.toEqual({ kind: "rejected", target: "linked-web", status: "unavailable" });
    expect(input).toMatchObject({ value: "", takes: 1, clears: 1 });
    expect(factory).toHaveBeenCalledOnce();
  });

  it("clears an invalid supplied credential without repairing it or dispatching a fixed-web fetch", async () => {
    const database = freshDatabase();
    const input = credential("not-a-calibration-pair-credential");
    const fetch = vi.fn();

    await expect(pairMpcCalibrationWeb({
      database,
      target: "linked-web",
      operation: operation(),
      transientCredential: input,
      createWebTransport: () => createMpcCalibrationWebTransport({ fetch }),
    })).resolves.toEqual({ kind: "rejected", target: "linked-web", status: "invalid-operation" });
    expect(input).toMatchObject({ value: "", takes: 1, clears: 1 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("clears before a pre-aborted web operation and dispatches no pair request", async () => {
    const database = freshDatabase();
    const input = credential();
    const scope = operation();
    scope.controller.abort();
    const factory = vi.fn();

    await expect(pairMpcCalibrationWeb({ database, target: "linked-web", operation: scope, transientCredential: input, createWebTransport: factory }))
      .resolves.toEqual({ kind: "cancelled", target: "linked-web" });
    expect(input).toMatchObject({ value: "", takes: 1, clears: 1 });
    expect(factory).not.toHaveBeenCalled();
  });

  it("fails closed without pairing when captured clear setup fails", async () => {
    const database = freshDatabase();
    const input = credential();
    input.clear = function () { this.clears += 1; throw new Error("synthetic-private-clear-detail"); };
    const factory = vi.fn();

    await expect(pairMpcCalibrationWeb({ database, target: "linked-web", operation: operation(), transientCredential: input, createWebTransport: factory }))
      .resolves.toEqual({ kind: "rejected", target: "linked-web", status: "invalid-operation" });
    expect(input).toMatchObject({ takes: 1, clears: 1 });
    expect(factory).not.toHaveBeenCalled();
  });

  it("never lets a stale settlement clear a later transient input", async () => {
    const database = freshDatabase();
    const firstInput = credential(pairCredential, "first");
    const laterInput = credential(pairCredential, "later");
    let release!: (session: { ownerId: string; harnessId: string }) => void;
    const deferred = new Promise<{ ownerId: string; harnessId: string }>(resolve => { release = resolve; });
    const scope = operation();
    const pair = vi.fn(async () => deferred);
    const getSession = vi.fn(async () => ({ ownerId: "owner-a", harnessId: "harness-a" }));
    const pending = pairMpcCalibrationWeb({ database, target: "linked-web", operation: scope, transientCredential: firstInput, createWebTransport: () => transport(pair, getSession) });

    expect(firstInput).toMatchObject({ value: "", clears: 1 });
    expect(laterInput).toMatchObject({ value: pairCredential, clears: 0 });
    scope.current.value = false;
    release({ ownerId: "owner-a", harnessId: "harness-a" });

    await expect(pending).resolves.toEqual({ kind: "cancelled", target: "linked-web" });
    expect(laterInput).toMatchObject({ value: pairCredential, clears: 0 });
    expect(getSession).not.toHaveBeenCalled();
  });

  it("clears local, Electron, null, and unknown targets without taking, selecting web pairing, or renderer credential DTOs", async () => {
    const database = freshDatabase();
    const factory = vi.fn();
    for (const target of [undefined, "linked-electron", null, "unknown"] as const) {
      const input = credential();
      const scope = operation(target === "linked-electron" ? "linked-electron" : "linked-web");
      const result = await pairMpcCalibrationWeb({ database, target: target as never, operation: scope, transientCredential: input, createWebTransport: factory });
      expect(result.kind).not.toBe("paired");
      expect(input).toMatchObject({ value: "", takes: 0, clears: 1 });
    }
    expect(factory).not.toHaveBeenCalled();
  });

  it("uses the actual pre-auth scope to clear unsupported and mismatched operations before any transport DTO", async () => {
    const database = freshDatabase();
    const factory = vi.fn();
    const owner = createMpcCalibrationOperationScope({ target: "linked-web", identity: null });
    const otherOwner = createMpcCalibrationOperationScope({ target: "linked-electron", identity: null });
    try {
      for (const target of [undefined, "local", "linked-electron", null, "untrusted-mode"] as const) {
        const input = credential();
        const result = await pairMpcCalibrationWeb({
          database, target: target as never, operation: owner.captureAppOperation(), transientCredential: input, createWebTransport: factory,
        });
        expect(result.kind).toBe("rejected");
        expect(input).toMatchObject({ value: "", takes: 0, clears: 1 });
      }
      const input = credential();
      await expect(pairMpcCalibrationWeb({
        database, target: "linked-web", operation: otherOwner.captureAppOperation(), transientCredential: input, createWebTransport: factory,
      })).resolves.toMatchObject({ kind: "rejected" });
      expect(input).toMatchObject({ value: "", takes: 0, clears: 1 });
      expect(factory).not.toHaveBeenCalled();
    } finally {
      owner.dispose();
      otherOwner.dispose();
    }
  });

  it("clears a captured input when operation or take capture fails and never selects a transport", async () => {
    const database = freshDatabase();
    const factory = vi.fn();
    const operationInput = credential();
    const throwingOperation = {
      database, target: "linked-web" as const, operation: operation(), transientCredential: operationInput, createWebTransport: factory,
    };
    Object.defineProperty(throwingOperation, "operation", {
      get(): never { throw new Error("synthetic-private-operation"); },
    });
    await expect(pairMpcCalibrationWeb(throwingOperation as never)).resolves.toMatchObject({ kind: "rejected" });
    expect(operationInput).toMatchObject({ value: "", takes: 0, clears: 1 });

    const takeInput = credential();
    Object.defineProperty(takeInput, "take", { get() { throw new Error("synthetic-private-take"); } });
    await expect(pairMpcCalibrationWeb({
      database, target: "linked-web", operation: operation(), transientCredential: takeInput, createWebTransport: factory,
    })).resolves.toMatchObject({ kind: "rejected" });
    expect(takeInput).toMatchObject({ value: "", clears: 1 });
    expect(factory).not.toHaveBeenCalled();
  });

  it.each(["pair", "session", "store"] as const)("cancels an actual scope after stale malformed %s settlement before the next stage", async stage => {
    const database = freshDatabase();
    const owner = createMpcCalibrationOperationScope({ target: "linked-web", identity: null });
    let entered!: () => void;
    let release!: (value: unknown) => void;
    const reached = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<unknown>(resolve => { release = resolve; });
    const deferred = async () => { entered(); return await held as never; };
    const forbidden = vi.fn(async (): Promise<never> => { throw new Error("unexpected transport operation"); });
    const selected = transport(
      stage === "pair" ? deferred : async () => ({ ownerId: "owner-a", harnessId: "harness-a" }),
      stage === "session" ? deferred : async () => ({ ownerId: "owner-a", harnessId: "harness-a" }),
    );
    const resolve = vi.fn(stage === "store" ? deferred : async () => ({ ownerId: "owner-a", harnessId: "harness-a", connectionId: "connection-a" }));
    selected.unpair = forbidden;
    const pending = pairMpcCalibrationWeb({
      database, target: "linked-web", operation: owner.captureAppOperation(), transientCredential: credential(), createWebTransport: () => selected, linkStateStore: { resolve },
    });
    try {
      await reached;
      owner.replaceAuthentication({ replacement: true });
      release(undefined);
      await expect(pending).resolves.toEqual({ kind: "cancelled", target: "linked-web" });
      expect(forbidden).not.toHaveBeenCalled();
      if (stage !== "store") expect(resolve).not.toHaveBeenCalled();
    } finally {
      release(undefined);
      await pending;
      owner.dispose();
    }
  });

  it("preserves complete same-owner nonempty C1/C3/C6 rows, unknown metadata, and Blob bytes while persisting no credential", async () => {
    vi.stubGlobal("Blob", NodeBlob);
    vi.stubGlobal("crypto", webcrypto);
    const database = freshDatabase();
    const identity = { ownerId: "owner-retained", harnessId: "harness-retained", connectionId: "connection-retained" };
    const assetBytes = new Uint8Array([1, 2, 3, 4]);
    const digest = await crypto.subtle.digest("SHA-256", assetBytes);
    const sha256 = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
    const remote: CalibrationHarnessSnapshot = {
      version: 1, retainedRoot: { order: [3, 1, 2] },
      datasets: [{ id: "dataset-retained", name: "Retained", targetCaseCount: 1, createdAt: 1, updatedAt: 2, version: 1, retained: { dataset: true } }],
      cases: [{ id: "case-retained", datasetId: "dataset-retained", createdAt: 3, updatedAt: 4, source: { name: "Retained card", retained: { source: true } }, candidates: [], notes: "base", retained: { calibrationCase: true } }],
      assets: [{ id: "asset-retained", datasetId: "dataset-retained", caseId: "case-retained", role: "source", mimeType: "image/png", createdAt: 5, hash: "retained-hash", sha256, byteLength: assetBytes.byteLength, retained: { asset: true } }],
      runs: [{ id: "run-retained", datasetId: "dataset-retained", algorithmId: "retained", algorithmLabel: "Retained", createdAt: 6, summary: { totalCases: 1, matchedCases: 1, mismatchedCases: 0, accuracy: 1 }, results: [{ caseId: "case-retained", matched: true, retained: { result: true } }], retained: { run: true } }],
    };
    const session = { ownerId: identity.ownerId, harnessId: identity.harnessId };
    await expect(hydrateMpcCalibrationCache({ database, identity, now: () => 8, transport: {
      getSession: async () => session,
      getSnapshot: async () => ({ revision: 3, snapshot: remote }),
      getBlob: async hash => { expect(hash).toBe(sha256); return assetBytes.slice(); },
    } })).resolves.toMatchObject({ status: "hydrated", revision: 3 });
    const state = createMpcCalibrationSyncStateStore(database, { now: () => 10 });
    const coordinator = createMpcCalibrationMutationCoordinator(database, { now: () => 11 });
    await coordinator.mutate(async () => {
      await database.mpcCalibrationCases.update("case-retained", { notes: "G1 pending" });
      return { value: undefined, changed: true };
    });
    await state.markSnapshotSent(identity, 1);
    await coordinator.mutate(async () => {
      await database.mpcCalibrationCases.update("case-retained", { notes: "G2 newer" });
      return { value: undefined, changed: true };
    });
    const pendingState = await state.load(identity);
    expect(pendingState).toMatchObject({ base: { revision: 3 }, queued: { generation: 2 }, inFlight: { generation: 1 }, acknowledgedGeneration: 0 });
    expect(pendingState!.queued!.snapshot).not.toEqual(pendingState!.inFlight!.snapshot);
    const readPreserved = async () => {
      const assets = [];
      for (const row of await database.mpcCalibrationAssets.toArray()) {
        const { blob, ...metadata } = row;
        assets.push({ metadata, size: blob.size, mimeType: blob.type, bytes: Array.from(new Uint8Array(await blob.arrayBuffer())) });
      }
      return { assets, rows: await Promise.all([
        database.mpcCalibrationDatasets.toArray(), database.mpcCalibrationCases.toArray(), database.mpcCalibrationRuns.toArray(),
        database.mpcCalibrationSyncStates.toArray(), database.mpcCalibrationCacheBindings.toArray(),
      ]) };
    };
    const before = await readPreserved();
    expect(before.assets).toHaveLength(1);
    expect(before.assets[0]).toMatchObject({ mimeType: "image/png", size: 4, bytes: [1, 2, 3, 4], metadata: { sha256, retained: { asset: true } } });
    const owner = createMpcCalibrationOperationScope({ target: "linked-web", identity: null });
    const selected = transport(async () => session, async () => session);
    try {
      await expect(pairMpcCalibrationWeb({ database, target: "linked-web", operation: owner.captureAppOperation(), transientCredential: credential(), createWebTransport: () => selected })).resolves.toEqual({ kind: "paired", target: "linked-web", identity });
      expect(selected.getSnapshot).not.toHaveBeenCalled();
      expect(selected.publishSnapshot).not.toHaveBeenCalled();
      expect(selected.unpair).not.toHaveBeenCalled();
      await expect(readPreserved()).resolves.toEqual(before);
      expect(await state.load(identity)).toEqual(pendingState);
      expect(await database.mpcCalibrationLinkStates.toArray()).toEqual([{ formatVersion: 1, ...identity, updatedAt: expect.any(Number) }]);
      expect(JSON.stringify(await readPreserved())).not.toContain(pairCredential);
      expect(JSON.stringify(await database.mpcCalibrationLinkStates.toArray())).not.toContain(pairCredential);
    } finally {
      owner.dispose();
    }
  });

  it("uses the originally captured operation, transport methods, store, and database after pair awaits", async () => {
    const database = freshDatabase();
    const replacementDatabase = freshDatabase();
    const scope = operation();
    let release!: (value: { ownerId: string; harnessId: string }) => void;
    const held = new Promise<{ ownerId: string; harnessId: string }>(resolve => { release = resolve; });
    const originalSession = vi.fn(async () => ({ ownerId: "owner-captured", harnessId: "harness-captured" }));
    const replacementSession = vi.fn(async () => ({ ownerId: "owner-replacement", harnessId: "harness-replacement" }));
    const originalResolve = vi.fn(async () => ({ ownerId: "owner-captured", harnessId: "harness-captured", connectionId: "connection-captured" }));
    const replacementResolve = vi.fn(async () => ({ ownerId: "owner-replacement", harnessId: "harness-replacement", connectionId: "connection-replacement" }));
    const selected = transport(async () => held, originalSession);
    const store = { resolve: originalResolve };
    const input = {
      database, target: "linked-web" as const, operation: scope, transientCredential: credential(),
      createWebTransport: () => selected, linkStateStore: store,
    };
    const pending = pairMpcCalibrationWeb(input);
    selected.getSession = replacementSession;
    store.resolve = replacementResolve;
    (input as { database: ProxxiedDexie }).database = replacementDatabase;
    (input as { target: "linked-web" | "local" }).target = "local";
    release({ ownerId: "owner-captured", harnessId: "harness-captured" });

    await expect(pending).resolves.toEqual({
      kind: "paired", target: "linked-web", identity: { ownerId: "owner-captured", harnessId: "harness-captured", connectionId: "connection-captured" },
    });
    expect(originalSession).toHaveBeenCalledOnce();
    expect(replacementSession).not.toHaveBeenCalled();
    expect(originalResolve).toHaveBeenCalledOnce();
    expect(replacementResolve).not.toHaveBeenCalled();
    expect(await database.mpcCalibrationLinkStates.count()).toBe(0);
    expect(await replacementDatabase.mpcCalibrationLinkStates.count()).toBe(0);
  });

  it("bounds hostile target, store, and provider accessors without reflecting their details", async () => {
    const database = freshDatabase();
    const sentinel = "synthetic-private-accessor-detail";
    const targetInput = { database, target: "linked-web" as const, operation: operation(), transientCredential: credential(), createWebTransport: vi.fn() };
    Object.defineProperty(targetInput, "target", { get() { throw new Error(sentinel); } });
    const targetResult = await pairMpcCalibrationWeb(targetInput as never);
    expect(targetResult).toEqual({ kind: "rejected", status: "invalid-operation" });
    expect(JSON.stringify(targetResult)).not.toContain(sentinel);

    const storeInput = credential();
    const throwingStore = { database, target: "linked-web" as const, operation: operation(), transientCredential: storeInput, createWebTransport: () => transport(async () => ({ ownerId: "owner-a", harnessId: "harness-a" }), async () => ({ ownerId: "owner-a", harnessId: "harness-a" })) };
    Object.defineProperty(throwingStore, "linkStateStore", { get() { throw new Error(sentinel); } });
    const storeResult = await pairMpcCalibrationWeb(throwingStore as never);
    expect(storeResult).toEqual({ kind: "rejected", target: "linked-web", status: "unavailable" });
    expect(storeInput).toMatchObject({ value: "", takes: 1, clears: 1 });
    expect(JSON.stringify(storeResult)).not.toContain(sentinel);
  });

  it("rejects pair/session identity disagreement before the non-secret store", async () => {
    const database = freshDatabase();
    const resolve = vi.fn();
    const store = { resolve };

    await expect(pairMpcCalibrationWeb({
      database,
      target: "linked-web",
      operation: operation(),
      transientCredential: credential(),
      createWebTransport: () => transport(async () => ({ ownerId: "owner-a", harnessId: "harness-a" }), async () => ({ ownerId: "owner-b", harnessId: "harness-a" })),
      linkStateStore: store,
    })).resolves.toEqual({ kind: "rejected", target: "linked-web", status: "authentication" });
    expect(resolve).not.toHaveBeenCalled();
    expect(await database.mpcCalibrationLinkStates.count()).toBe(0);
  });

  it("uses the fixed web transport pair and session routes, retaining the credential only on pair", async () => {
    const database = freshDatabase();
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ ownerId: "owner-route", harnessId: "harness-route" }), { headers: { "content-type": "application/json" } });
    });
    const result = await pairMpcCalibrationWeb({
      database,
      target: "linked-web",
      operation: operation(),
      transientCredential: credential(),
      createWebTransport: () => createMpcCalibrationWebTransport({ fetch }),
      linkStateStore: createMpcCalibrationLinkStateStore(database, { createConnectionId: () => "connection-route", now: () => 1 }),
    });

    expect(result).toEqual({ kind: "paired", target: "linked-web", identity: { ownerId: "owner-route", harnessId: "harness-route", connectionId: "connection-route" } });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ url: "/api/calibration-harness/pair", init: { method: "POST", headers: { authorization: `Bearer ${pairCredential}` }, credentials: "include", redirect: "error" } });
    expect(calls[1]).toMatchObject({ url: "/api/calibration-harness/session", init: { method: "GET", credentials: "include", redirect: "error" } });
    expect(calls[1]!.init!.headers).not.toHaveProperty("authorization");
  });

  it("maps typed transport failure codes once without leaking credentials", async () => {
    const database = freshDatabase();
    const failure = new MpcCalibrationTransportError("offline");
    let reads = 0;
    Object.defineProperty(failure, "code", { get() { return reads++ === 0 ? "offline" : "synthetic-private-status"; } });

    const result = await pairMpcCalibrationWeb({ database, target: "linked-web", operation: operation(), transientCredential: credential(), createWebTransport: () => transport(async () => { throw failure; }, async () => ({ ownerId: "x", harnessId: "x" })) });
    expect(result).toEqual({ kind: "rejected", target: "linked-web", status: "offline" });
    expect(reads).toBe(1);
    expect(JSON.stringify(result)).not.toContain(pairCredential);
  });
});
