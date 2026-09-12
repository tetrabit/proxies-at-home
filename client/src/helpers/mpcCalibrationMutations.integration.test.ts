import "fake-indexeddb/auto";
import { Blob as NodeBlob } from "node:buffer";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

const privateTestDatabaseName = vi.hoisted(() => `c6-integration-${crypto.randomUUID()}`);
const mockMarkMpcPreferenceSyncDirty = vi.hoisted(() => vi.fn());

vi.mock("@/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/db")>();
  return { ...actual, db: new actual.ProxxiedDexie(privateTestDatabaseName) };
});
vi.mock("./mpcPreferenceSync", () => ({ markMpcPreferenceSyncDirty: mockMarkMpcPreferenceSyncDirty }));

import { db, ProxxiedDexie } from "@/db";
import type { MpcCalibrationAssetRecord, MpcCalibrationSourceCardSnapshot } from "@/db";
import { CALIBRATION_HARNESS_LIMITS, validateCalibrationHarnessSnapshot, type CalibrationHarnessRevision, type CalibrationHarnessSnapshot } from "../../../shared/calibrationHarness";
import { validateCalibrationHarnessLocalState } from "../../../shared/calibrationHarnessLocalState";
import { validateCalibrationHarnessRecoveryState } from "../../../shared/calibrationHarnessRecoveryState";
import type { CardOption } from "../../../shared/types";
import { hydrateMpcCalibrationCache } from "./mpcCalibrationCache";
import { flushMpcCalibrationOutbox } from "./mpcCalibrationOutbox";
import { recoverAndFlushMpcCalibration } from "./mpcCalibrationRecovery";
import { createMpcCalibrationSyncStateStore } from "./mpcCalibrationSyncState";
import { MpcCalibrationTransportError, type MpcCalibrationTransport } from "./mpcCalibrationTransport";
import {
  captureMpcCalibrationMutationScope,
  createMpcCalibrationDataset,
  deleteMpcCalibrationCase,
  deleteMpcCalibrationDataset,
  saveMpcCalibrationAssets,
  saveMpcCalibrationCaseWithAssets,
  saveMpcCalibrationRun,
  updateMpcCalibrationDataset,
} from "./mpcCalibrationStorage";

const identity = { ownerId: "owner", harnessId: "harness", connectionId: "connection" };

type Deferred = Readonly<{ promise: Promise<void>; resolve: () => void }>;

function deferred(): Deferred {
  let resolve!: () => void;
  return { promise: new Promise<void>((finish) => { resolve = finish; }), resolve };
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

function baseSnapshot(): CalibrationHarnessSnapshot {
  return {
    version: 1,
    unknownRoot: { preserve: ["root", { nested: true }] },
    datasets: [{ id: "remote-sentinel", name: "Remote sentinel", targetCaseCount: 1, createdAt: 1, updatedAt: 1, version: 1, unknownDataset: { retained: true } }],
    cases: [{ id: "remote-case", datasetId: "remote-sentinel", createdAt: 1, updatedAt: 1, source: { name: "Remote", unknownSource: ["ordered", "fields"] }, candidates: [], unknownCase: true }],
    assets: [],
    runs: [],
  };
}

function transport(initial: CalibrationHarnessRevision): MpcCalibrationTransport & {
  publications: CalibrationHarnessRevision[];
  uploads: string[];
  current(): CalibrationHarnessRevision;
} {
  let remote = structuredClone(initial);
  const blobs = new Map<string, Uint8Array>();
  const publications: CalibrationHarnessRevision[] = [];
  const uploads: string[] = [];
  return {
    publications,
    uploads,
    current: () => structuredClone(remote),
    pair: async () => ({ ownerId: identity.ownerId, harnessId: identity.harnessId }),
    unpair: async () => undefined,
    getSession: async () => ({ ownerId: identity.ownerId, harnessId: identity.harnessId }),
    getSnapshot: async () => structuredClone(remote),
    getBlob: async (hash) => {
      const bytes = blobs.get(hash);
      if (!bytes) throw new Error(`missing remote blob ${hash}`);
      return bytes.slice();
    },
    missingBlobs: async (hashes) => ({ missing: hashes.filter(hash => !blobs.has(hash)) }),
    putBlob: async (hash, bytes) => {
      const copy = new Uint8Array(bytes);
      const inserted = !blobs.has(hash);
      blobs.set(hash, copy);
      uploads.push(`${hash}:${copy.byteLength}`);
      return { sha256: hash, byteLength: copy.byteLength, inserted };
    },
    publishSnapshot: async (snapshot, expectedRevision) => {
      if (expectedRevision !== remote.revision) throw new MpcCalibrationTransportError("http", 412);
      remote = { revision: remote.revision + 1, snapshot: structuredClone(snapshot) };
      publications.push(structuredClone(remote));
      return structuredClone(remote);
    },
  };
}

async function hydrateBase(remote = transport({ revision: 1, snapshot: baseSnapshot() })) {
  await expect(hydrateMpcCalibrationCache({ database: db, transport: remote, identity, now: () => 10 }))
    .resolves.toEqual({ status: "hydrated", revision: 1 });
  return remote;
}

async function queuedGeneration(): Promise<number> {
  const state = await createMpcCalibrationSyncStateStore(db).load(identity);
  expect(state?.queued).not.toBeNull();
  return state!.queued!.generation;
}

async function clearOwnedDatabase(): Promise<void> {
  await db.transaction("rw", [
    db.mpcCalibrationRuns, db.mpcCalibrationAssets, db.mpcCalibrationCases, db.mpcCalibrationDatasets,
    db.mpcCalibrationSyncStates, db.mpcCalibrationCacheBindings, db.mpcCalibrationHydrationStaging,
  ], async () => {
    await db.mpcCalibrationRuns.clear();
    await db.mpcCalibrationAssets.clear();
    await db.mpcCalibrationCases.clear();
    await db.mpcCalibrationDatasets.clear();
    await db.mpcCalibrationSyncStates.clear();
    await db.mpcCalibrationCacheBindings.clear();
    await db.mpcCalibrationHydrationStaging.clear();
  });
  mockMarkMpcPreferenceSyncDirty.mockClear();
}

async function fullBoundReadback() {
  const assets = await db.mpcCalibrationAssets.toArray();
  return {
    datasets: await db.mpcCalibrationDatasets.toArray(),
    cases: await db.mpcCalibrationCases.toArray(),
    assets: await Promise.all(assets.map(async ({ blob, ...asset }) => ({
      ...asset,
      type: blob.type,
      bytes: Array.from(new Uint8Array(await blob.arrayBuffer())),
    }))),
    runs: await db.mpcCalibrationRuns.toArray(),
    rawState: await db.mpcCalibrationSyncStates.get([identity.ownerId, identity.harnessId, identity.connectionId]),
    binding: await db.mpcCalibrationCacheBindings.get("mpc-calibration-cache-binding"),
  };
}

async function expectQueuedRowsToMatchCanonical(): Promise<void> {
  const queued = (await createMpcCalibrationSyncStateStore(db).load(identity))!.queued!.snapshot;
  const assets = await db.mpcCalibrationAssets.toArray();
  expect(queued.datasets).toEqual(await db.mpcCalibrationDatasets.toArray());
  expect(queued.cases).toEqual(await db.mpcCalibrationCases.toArray());
  expect(queued.runs).toEqual(await db.mpcCalibrationRuns.toArray());
  expect(queued.assets).toEqual(assets.map(({ blob: _blob, ...asset }) => asset));
}

afterEach(async () => {
  await clearOwnedDatabase();
  vi.restoreAllMocks();
});
afterAll(() => db.close());

describe("C6 real bound storage mutation protocol", () => {
  it("queues one newest bound snapshot for real storage mutations without touching unrelated client rows", async () => {
    const remote = await hydrateBase();
    await db.projects.add({ id: "project-sentinel", name: "unrelated", createdAt: 1, lastOpenedAt: 1, cardCount: 0, settings: {} });
    const cardSentinel: CardOption = { uuid: "card-sentinel", projectId: "project-sentinel", name: "unrelated", order: 0, isUserUpload: false };
    await db.cards.add(cardSentinel);
    const scope = await captureMpcCalibrationMutationScope();
    const dataset = await createMpcCalibrationDataset({ name: "Bound dataset" }, scope);
    expect(await queuedGeneration()).toBe(1);
    await expectQueuedRowsToMatchCanonical();
    await updateMpcCalibrationDataset(dataset.id, { description: "updated", targetCaseCount: 2 }, scope);
    expect(await queuedGeneration()).toBe(2);
    await expectQueuedRowsToMatchCanonical();
    await updateMpcCalibrationDataset(dataset.id, { description: "updated", targetCaseCount: 2 }, scope);
    expect(await queuedGeneration()).toBe(2);

    await saveMpcCalibrationCaseWithAssets({ id: "case-zero", datasetId: dataset.id, source: { name: "Zero" }, candidates: [] }, [], scope);
    expect(await queuedGeneration()).toBe(3);
    await expectQueuedRowsToMatchCanonical();
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const asset: MpcCalibrationAssetRecord = {
      id: "asset-real", datasetId: dataset.id, caseId: "case-assets", role: "source", mimeType: "image/png",
      blob: new NodeBlob([bytes], { type: "image/png" }), createdAt: 2,
    };
    await saveMpcCalibrationCaseWithAssets({ id: "case-assets", datasetId: dataset.id, source: { name: "Assets" }, candidates: [] }, [asset], scope);
    expect(await queuedGeneration()).toBe(4);
    await expectQueuedRowsToMatchCanonical();
    await saveMpcCalibrationAssets([{
      id: "asset-extra", datasetId: dataset.id, caseId: "case-zero", role: "source",
      mimeType: "image/png", blob: new NodeBlob([new Uint8Array([5])], { type: "image/png" }), createdAt: 3,
    }], scope);
    expect(await queuedGeneration()).toBe(5);
    await expectQueuedRowsToMatchCanonical();
    await saveMpcCalibrationAssets([], scope);
    expect(await queuedGeneration()).toBe(5);
    await saveMpcCalibrationRun({ id: "run-real", datasetId: dataset.id, algorithmId: "real", summary: { totalCases: 2, matchedCases: 1, mismatchedCases: 1, accuracy: 0.5 }, results: [{ caseId: "case-zero", matched: true }] }, scope);
    expect(await queuedGeneration()).toBe(6);
    await expectQueuedRowsToMatchCanonical();
    await deleteMpcCalibrationCase("case-zero", scope);
    expect(await queuedGeneration()).toBe(7);
    await expectQueuedRowsToMatchCanonical();
    expect(await db.mpcCalibrationAssets.get("asset-extra")).toBeUndefined();
    expect(await db.mpcCalibrationRuns.get("run-real")).toBeUndefined();
    await deleteMpcCalibrationDataset(dataset.id, scope);
    expect(await queuedGeneration()).toBe(8);
    await deleteMpcCalibrationDataset("missing", scope);
    expect(await queuedGeneration()).toBe(8);

    const queued = (await createMpcCalibrationSyncStateStore(db).load(identity))!.queued!.snapshot;
    expect(queued).toMatchObject({ unknownRoot: { preserve: ["root", { nested: true }] }, datasets: [{ id: "remote-sentinel" }], cases: [{ id: "remote-case" }], assets: [], runs: [] });
    expect(await db.projects.get("project-sentinel")).toMatchObject({ name: "unrelated" });
    expect(await db.cards.get("card-sentinel")).toMatchObject({ projectId: "project-sentinel", name: "unrelated" });

    await expect(flushMpcCalibrationOutbox({ database: db, transport: remote, identity })).resolves.toMatchObject({ status: "published", generation: 8, revision: 2 });
    expect(remote.publications).toHaveLength(1);
    expect(remote.current().snapshot).toEqual(queued);
  });

  it("preserves unknown JSON and a same-size replacement asset through C4 acknowledgement and owned-handle reopen", async () => {
    const remote = await hydrateBase();
    const scope = await captureMpcCalibrationMutationScope();
    const dataset = await createMpcCalibrationDataset({ name: "Asset dataset" }, scope);
    const original = new Uint8Array([1, 2, 3, 4]);
    const replacement = new Uint8Array([4, 3, 2, 1]);
    const originalHash = await sha256(original);
    await saveMpcCalibrationCaseWithAssets({
      id: "asset-case", datasetId: dataset.id, source: { name: "Asset", nestedUnknown: { order: ["first", "second"] } } as MpcCalibrationSourceCardSnapshot & Record<string, unknown>, candidates: [], unknownCase: { retained: true },
    } as Parameters<typeof saveMpcCalibrationCaseWithAssets>[0] & Record<string, unknown>, [{ id: "asset", datasetId: dataset.id, caseId: "asset-case", role: "source", mimeType: "image/png", blob: new NodeBlob([original], { type: "image/png" }), createdAt: 1, unknownAsset: { preserve: true } } as MpcCalibrationAssetRecord], scope);
    await expect(flushMpcCalibrationOutbox({ database: db, transport: remote, identity })).resolves.toMatchObject({ status: "published", revision: 2 });
    await saveMpcCalibrationAssets([{ id: "asset", datasetId: dataset.id, caseId: "asset-case", role: "source", mimeType: "image/png", blob: new NodeBlob([replacement], { type: "image/png" }), createdAt: 1, unknownAsset: { preserve: true } } as MpcCalibrationAssetRecord], scope);
    const replacementHash = await sha256(replacement);
    const beforeFlush = (await createMpcCalibrationSyncStateStore(db).load(identity))!.queued!.snapshot;
    expect(beforeFlush.cases.find(entry => entry.id === "asset-case")).toMatchObject({ unknownCase: { retained: true }, source: { nestedUnknown: { order: ["first", "second"] } } });
    expect(beforeFlush.assets).toEqual([expect.objectContaining({ sha256: replacementHash, byteLength: 4, mimeType: "image/png", unknownAsset: { preserve: true } })]);

    await expect(flushMpcCalibrationOutbox({ database: db, transport: remote, identity })).resolves.toMatchObject({ status: "published", revision: 3 });
    expect(remote.uploads).toEqual([`${originalHash}:4`, `${replacementHash}:4`]);
    const persistedState = await createMpcCalibrationSyncStateStore(db).load(identity);
    db.close();
    const readHandle = new ProxxiedDexie(privateTestDatabaseName);
    try {
      const reopened = await readHandle.mpcCalibrationAssets.get("asset");
      expect(Array.from(new Uint8Array(await reopened!.blob.arrayBuffer()))).toEqual([...replacement]);
      expect(reopened).toMatchObject({ sha256: replacementHash, byteLength: 4, mimeType: "image/png", unknownAsset: { preserve: true } });
      expect(await readHandle.mpcCalibrationCases.get("asset-case")).toMatchObject({ source: { nestedUnknown: { order: ["first", "second"] } } });
      expect(await createMpcCalibrationSyncStateStore(readHandle).load(identity)).toEqual(persistedState);
      expect((await createMpcCalibrationSyncStateStore(readHandle).load(identity))!.base).toEqual(remote.current());
    } finally {
      readHandle.close();
      await db.open();
    }
    expect((await createMpcCalibrationSyncStateStore(db).load(identity))!.base).toEqual(remote.current());
  });

  it("keeps actual G2 storage mutation queued when a paused G1 C4 acknowledgement returns, then C5 does not echo", async () => {
    const remote = await hydrateBase();
    const scope = await captureMpcCalibrationMutationScope();
    const dataset = await createMpcCalibrationDataset({ name: "G1" }, scope);
    const entered = deferred();
    const release = deferred();
    const publish = remote.publishSnapshot.bind(remote);
    remote.publishSnapshot = async (snapshot, expected) => {
      entered.resolve();
      await release.promise;
      return publish(snapshot, expected);
    };
    const g1 = flushMpcCalibrationOutbox({ database: db, transport: remote, identity });
    let g1Settled = false;
    try {
      await entered.promise;
      await updateMpcCalibrationDataset(dataset.id, { name: "G2" }, scope);
      const stateDuringG1 = await createMpcCalibrationSyncStateStore(db).load(identity);
      const exactG2 = structuredClone(stateDuringG1!.queued!);
      expect(stateDuringG1).toMatchObject({ inFlight: { generation: 1 }, queued: { generation: 2 } });
      expect(stateDuringG1!.queued!.snapshot.datasets).toContainEqual(expect.objectContaining({ id: dataset.id, name: "G2" }));
      release.resolve();
      await expect(g1).resolves.toMatchObject({ status: "published", generation: 1, revision: 2 });
      g1Settled = true;
      const afterG1 = await createMpcCalibrationSyncStateStore(db).load(identity);
      expect(afterG1).toMatchObject({ base: { revision: 2 }, queued: { generation: 2 }, inFlight: null });
      expect(afterG1!.queued).toEqual(exactG2);
      expect(afterG1!.queued!.snapshot.datasets).toContainEqual(expect.objectContaining({ id: dataset.id, name: "G2" }));
    } finally {
      release.resolve();
      if (!g1Settled) await g1.catch(() => undefined);
    }

    await expect(recoverAndFlushMpcCalibration({ database: db, transport: remote, identity, maxCycles: 2 })).resolves.toMatchObject({ status: "published", generation: 2, revision: 3 });
    const publications = remote.publications.length;
    await expect(recoverAndFlushMpcCalibration({ database: db, transport: remote, identity, maxCycles: 2 })).resolves.toEqual({ status: "no-queued" });
    expect(remote.publications).toHaveLength(publications);
  });

  it("rejects a scope after real C3 physical replacement while retaining ACK-only scope validity", async () => {
    const remote = await hydrateBase();
    const stableScope = await captureMpcCalibrationMutationScope();
    const dataset = await createMpcCalibrationDataset({ name: "ACK scope" }, stableScope);
    await expect(flushMpcCalibrationOutbox({ database: db, transport: remote, identity })).resolves.toMatchObject({ status: "published", revision: 2 });
    await expect(updateMpcCalibrationDataset(dataset.id, { name: "after ACK" }, stableScope)).resolves.toBeUndefined();
    await expect(flushMpcCalibrationOutbox({ database: db, transport: remote, identity })).resolves.toMatchObject({ status: "published", revision: 3 });

    const replacement = transport({ revision: 4, snapshot: {
      ...remote.current().snapshot,
      datasets: [...remote.current().snapshot.datasets, { id: "remote-replacement", name: "replacement", targetCaseCount: 1, createdAt: 3, updatedAt: 3, version: 1 }],
    } });
    await expect(hydrateMpcCalibrationCache({ database: db, transport: replacement, identity, now: () => 11 })).resolves.toEqual({ status: "hydrated", revision: 4 });
    const before = await db.mpcCalibrationDatasets.toArray();
    await expect(createMpcCalibrationDataset({ name: "stale scope" }, stableScope)).rejects.toThrow("captured cache binding was replaced");
    expect(await db.mpcCalibrationDatasets.toArray()).toEqual(before);
    expect((await db.mpcCalibrationCacheBindings.get("mpc-calibration-cache-binding"))!.revision).toBe(4);
    const publishedBefore = replacement.publications.length;
    await expect(hydrateMpcCalibrationCache({ database: db, transport: replacement, identity, now: () => 12 })).resolves.toMatchObject({ status: "blocked", reason: "remote-revision-not-newer" });
    expect(replacement.publications).toHaveLength(publishedBefore);
  });

  it("rolls back populated C6 grouped rows, Blob bytes, raw C1 state, binding, and dirty notification after the real same-key state put", async () => {
    const remote = await hydrateBase();
    const scope = await captureMpcCalibrationMutationScope();
    const dataset = await createMpcCalibrationDataset({ name: "rollback dataset" }, scope);
    await saveMpcCalibrationCaseWithAssets({ id: "prior-case", datasetId: dataset.id, source: { name: "prior" }, candidates: [] }, [{
      id: "prior-asset", datasetId: dataset.id, caseId: "prior-case", role: "source", mimeType: "image/png", blob: new NodeBlob([new Uint8Array([1, 2, 3])], { type: "image/png" }), createdAt: 1,
    }], scope);
    await saveMpcCalibrationRun({ id: "prior-run", datasetId: dataset.id, algorithmId: "prior", summary: { totalCases: 1, matchedCases: 1, mismatchedCases: 0, accuracy: 1 }, results: [{ caseId: "prior-case", matched: true }] }, scope);
    await flushMpcCalibrationOutbox({ database: db, transport: remote, identity });
    const before = await fullBoundReadback();
    mockMarkMpcPreferenceSyncDirty.mockClear();
    const actualPut = db.mpcCalibrationSyncStates.put.bind(db.mpcCalibrationSyncStates);
    const put = vi.spyOn(db.mpcCalibrationSyncStates, "put").mockImplementation((async (...args: Parameters<typeof actualPut>) => {
      await actualPut(...args);
      throw new Error("injected C6 rejection after same-key C1 write");
    }) as unknown as typeof actualPut);
    try {
      await expect(saveMpcCalibrationCaseWithAssets({ id: "prior-case", datasetId: dataset.id, source: { name: "replaced" }, candidates: [] }, [{
        id: "prior-asset", datasetId: dataset.id, caseId: "prior-case", role: "source", mimeType: "image/png", blob: new NodeBlob([new Uint8Array([9, 8, 7])], { type: "image/png" }), createdAt: 2,
      }], scope)).rejects.toThrow("injected C6 rejection after same-key C1 write");
      expect(put).toHaveBeenCalledOnce();
    } finally {
      put.mockRestore();
    }
    expect(await fullBoundReadback()).toEqual(before);
    expect(mockMarkMpcPreferenceSyncDirty).not.toHaveBeenCalled();
  });

  it.each(["missing", "malformed", "overflow"] as const)("refuses present bound %s C1 state without local fallback while retaining populated rows", async kind => {
    const remote = await hydrateBase();
    const scope = await captureMpcCalibrationMutationScope();
    const dataset = await createMpcCalibrationDataset({ name: `state-${kind}` }, scope);
    await saveMpcCalibrationCaseWithAssets({ id: `case-${kind}`, datasetId: dataset.id, source: { name: kind }, candidates: [] }, [{
      id: `asset-${kind}`, datasetId: dataset.id, caseId: `case-${kind}`, role: "source", mimeType: "image/png", blob: new NodeBlob([new Uint8Array([4, 5, 6])], { type: "image/png" }), createdAt: 1,
    }], scope);
    await flushMpcCalibrationOutbox({ database: db, transport: remote, identity });
    const current = await db.mpcCalibrationSyncStates.get([identity.ownerId, identity.harnessId, identity.connectionId]);
    expect(current).toBeDefined();
    if (kind === "missing") await db.mpcCalibrationSyncStates.delete([identity.ownerId, identity.harnessId, identity.connectionId]);
    if (kind === "malformed") await db.mpcCalibrationSyncStates.put({ ...current!, queued: "not-a-queue" } as never);
    if (kind === "overflow") {
      const overflow = { ...current!, queued: { generation: Number.MAX_SAFE_INTEGER, snapshot: current!.base!.snapshot }, dirtyGeneration: Number.MAX_SAFE_INTEGER };
      expect(() => validateCalibrationHarnessRecoveryState(overflow)).not.toThrow();
      await db.mpcCalibrationSyncStates.put(overflow as never);
    }
    const before = await fullBoundReadback();
    mockMarkMpcPreferenceSyncDirty.mockClear();
    await expect(updateMpcCalibrationDataset(dataset.id, { name: `must-not-fallback-${kind}` }, scope)).rejects.toThrow();
    expect(await fullBoundReadback()).toEqual(before);
    expect(mockMarkMpcPreferenceSyncDirty).not.toHaveBeenCalled();
  });

  it("serially admits C6 Blob bytes and rejects an oversized local Blob before any byte read", async () => {
    const remote = await hydrateBase();
    const boundScope = await captureMpcCalibrationMutationScope();
    const dataset = await createMpcCalibrationDataset({ name: "blob admission" }, boundScope);
    const originalRead = NodeBlob.prototype.arrayBuffer;
    let active = 0;
    let maximum = 0;
    const read = vi.spyOn(NodeBlob.prototype, "arrayBuffer").mockImplementation(function (this: Blob) {
      active += 1;
      maximum = Math.max(maximum, active);
      return originalRead.call(this).finally(() => { active -= 1; });
    });
    try {
      await saveMpcCalibrationCaseWithAssets({ id: "blob-case", datasetId: dataset.id, source: { name: "blob" }, candidates: [] }, [
        { id: "blob-source", datasetId: dataset.id, caseId: "blob-case", role: "source", mimeType: "image/png", blob: new NodeBlob([new Uint8Array([1])], { type: "image/png" }), createdAt: 1 },
        { id: "blob-art", datasetId: dataset.id, caseId: "blob-case", role: "source-art", mimeType: "image/png", blob: new NodeBlob([new Uint8Array([2])], { type: "image/png" }), createdAt: 1 },
      ], boundScope);
      expect(maximum).toBe(1);
      expect(active).toBe(0);
      expect(read.mock.calls.length).toBeGreaterThanOrEqual(2);
    } finally {
      read.mockRestore();
    }
    const beforeOversize = await fullBoundReadback();
    const replacementBytes = new Uint8Array([3]);
    const validReplacement = structuredClone((await createMpcCalibrationSyncStateStore(db).load(identity))!.queued!.snapshot);
    const replacementHash = await sha256(replacementBytes);
    validReplacement.assets = validReplacement.assets.map(asset => asset.id === "blob-art"
      ? { ...asset, sha256: replacementHash, byteLength: replacementBytes.byteLength, createdAt: 2 }
      : asset);
    expect(() => validateCalibrationHarnessSnapshot(validReplacement)).not.toThrow();
    const oversizedRead = vi.spyOn(NodeBlob.prototype, "arrayBuffer").mockRejectedValue(new Error("oversized C6 byte admission"));
    const oversizedSize = vi.spyOn(NodeBlob.prototype, "size", "get").mockReturnValue(CALIBRATION_HARNESS_LIMITS.maxAssetBytes + 1);
    try {
      await expect(saveMpcCalibrationAssets([{ id: "blob-art", datasetId: dataset.id, caseId: "blob-case", role: "source-art", mimeType: "image/png", blob: new NodeBlob([replacementBytes], { type: "image/png" }), createdAt: 2 }], boundScope)).rejects.toThrow("per-asset limit");
      expect(oversizedRead).not.toHaveBeenCalled();
    } finally {
      oversizedSize.mockRestore();
      oversizedRead.mockRestore();
    }
    expect(await fullBoundReadback()).toEqual(beforeOversize);
    await expect(flushMpcCalibrationOutbox({ database: db, transport: remote, identity })).resolves.toMatchObject({ status: "published" });
  });

  it("keeps two simultaneous actual local mutations on distinct entities in the newest canonical queue", async () => {
    await hydrateBase();
    const scope = await captureMpcCalibrationMutationScope();
    const first = await createMpcCalibrationDataset({ name: "first" }, scope);
    const second = await createMpcCalibrationDataset({ name: "second" }, scope);
    await Promise.all([
      updateMpcCalibrationDataset(first.id, { name: "first-concurrent" }, scope),
      updateMpcCalibrationDataset(second.id, { description: "second-concurrent" }, scope),
    ]);
    const state = await createMpcCalibrationSyncStateStore(db).load(identity);
    expect(state).toMatchObject({ dirtyGeneration: 4, queued: { generation: 4 } });
    expect(await db.mpcCalibrationDatasets.get(first.id)).toMatchObject({ name: "first-concurrent" });
    expect(await db.mpcCalibrationDatasets.get(second.id)).toMatchObject({ description: "second-concurrent" });
    expect(state!.queued!.snapshot.datasets).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: first.id, name: "first-concurrent" }),
      expect.objectContaining({ id: second.id, description: "second-concurrent" }),
    ]));
    await expectQueuedRowsToMatchCanonical();
  });

  it("rebases an actual C6 queue, installs the advancing remote cache, and publishes no echo after recovery", async () => {
    const remote = await hydrateBase();
    const scope = await captureMpcCalibrationMutationScope();
    const dataset = await createMpcCalibrationDataset({ name: "local intent" }, scope);
    const remoteAdvance = remote.current().snapshot;
    remoteAdvance.cases[0]!.notes = "remote installed";
    await remote.publishSnapshot(remoteAdvance, 1);
    const clear = vi.spyOn(db.mpcCalibrationDatasets, "clear");
    const bind = vi.spyOn(db.mpcCalibrationCacheBindings, "put");
    try {
      await expect(recoverAndFlushMpcCalibration({ database: db, transport: remote, identity, maxCycles: 4 })).resolves.toMatchObject({ status: "published", generation: 2, revision: 3 });
      expect(clear).toHaveBeenCalled();
      expect(bind).toHaveBeenCalled();
    } finally {
      clear.mockRestore();
      bind.mockRestore();
    }
    expect(remote.publications).toHaveLength(2);
    expect(await db.mpcCalibrationCases.get("remote-case")).toMatchObject({ notes: "remote installed" });
    expect(await db.mpcCalibrationDatasets.get(dataset.id)).toMatchObject({ name: "local intent" });
    expect(await createMpcCalibrationSyncStateStore(db).load(identity)).toMatchObject({ base: { revision: 3 }, queued: null, inFlight: null, dirtyGeneration: 2, acknowledgedGeneration: 2, settledGeneration: 2 });
    await expect(recoverAndFlushMpcCalibration({ database: db, transport: remote, identity, maxCycles: 2 })).resolves.toEqual({ status: "no-queued" });
    expect(remote.publications).toHaveLength(2);
  });

  it("converts a strictly validated V1 state retaining an actual C4 receipt without changing its base or acknowledgement", async () => {
    const remote = await hydrateBase();
    const scope = await captureMpcCalibrationMutationScope();
    const dataset = await createMpcCalibrationDataset({ name: "legacy receipt" }, scope);
    await expect(flushMpcCalibrationOutbox({ database: db, transport: remote, identity })).resolves.toMatchObject({ status: "published", generation: 1, revision: 2 });
    const acknowledged = await createMpcCalibrationSyncStateStore(db).load(identity);
    const legacy = {
      formatVersion: 1 as const,
      ownerId: identity.ownerId,
      harnessId: identity.harnessId,
      connectionId: identity.connectionId,
      base: acknowledged!.base,
      queued: null,
      inFlight: null,
      lastAcknowledgement: acknowledged!.lastAcknowledgement,
      dirtyGeneration: acknowledged!.dirtyGeneration,
      sentGeneration: acknowledged!.sentGeneration,
      acknowledgedGeneration: acknowledged!.acknowledgedGeneration,
      updatedAt: acknowledged!.updatedAt,
    };
    expect(() => validateCalibrationHarnessLocalState(legacy)).not.toThrow();
    await db.mpcCalibrationSyncStates.put(legacy);
    await updateMpcCalibrationDataset(dataset.id, { description: "V2 preserves C4 receipt" }, scope);
    const converted = await createMpcCalibrationSyncStateStore(db).load(identity);
    expect(converted).toMatchObject({ formatVersion: 2, base: acknowledged!.base, lastAcknowledgement: acknowledged!.lastAcknowledgement, queued: { generation: 2 } });
    expect(converted!.base).toEqual(acknowledged!.base);
    expect(converted!.lastAcknowledgement).toEqual(acknowledged!.lastAcknowledgement);
  });
});
