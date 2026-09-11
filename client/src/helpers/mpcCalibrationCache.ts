import Dexie from "dexie";
import type {
  MpcCalibrationAssetRecord,
  MpcCalibrationCacheBindingRecord,
  MpcCalibrationCaseRecord,
  MpcCalibrationDatasetRecord,
  MpcCalibrationHydrationStagingRecord,
  MpcCalibrationRunRecord,
  ProxxiedDexie,
} from "@/db";
import {
  CALIBRATION_HARNESS_LIMITS,
  validateCalibrationHarnessSnapshot,
  type CalibrationHarnessAsset,
  type CalibrationHarnessRevision,
  type CalibrationHarnessSnapshot,
} from "../../../shared/calibrationHarness";
import type {
  CalibrationHarnessLocalState,
  CalibrationHarnessPersistenceIdentity,
} from "../../../shared/calibrationHarnessLocalState";
import {
  captureCalibrationHarnessRevision,
  validateCalibrationHarnessPersistenceIdentity,
} from "../../../shared/calibrationHarnessLocalState";
import { createMpcCalibrationSyncStateStore } from "./mpcCalibrationSyncState";
import type { MpcCalibrationTransport } from "./mpcCalibrationTransport";
import { buildBootstrapPreferenceFixture } from "./mpcPreferenceBootstrap";

const BINDING_ID = "mpc-calibration-cache-binding" as const;

type HarnessRows = Readonly<{
  datasets: MpcCalibrationDatasetRecord[];
  cases: MpcCalibrationCaseRecord[];
  assets: MpcCalibrationAssetRecord[];
  runs: MpcCalibrationRunRecord[];
}>;

export type MpcCalibrationHydrationStatus =
  | "hydrated"
  | "no-remote-snapshot"
  | "needs-reconciliation"
  | "blocked"
  | "cancelled"
  | "failed";

/** A caller-owned fence. C3 cannot make a browser cookie identity atomic across tabs. */
export type MpcCalibrationHydrationOperation = Readonly<{
  id?: string;
  isCurrent?: () => boolean;
}>;

export type MpcCalibrationCacheHydrationInput = Readonly<{
  database: ProxxiedDexie;
  transport: Pick<MpcCalibrationTransport, "getSession" | "getSnapshot" | "getBlob">;
  identity: CalibrationHarnessPersistenceIdentity;
  signal?: AbortSignal;
  operation?: MpcCalibrationHydrationOperation;
  now?: () => number;
}>;

export type MpcCalibrationCacheHydrationResult = Readonly<{
  status: MpcCalibrationHydrationStatus;
  revision?: number;
  reason?: string;
}>;

class HydrationFenceError extends Error {}
class HydrationBlockedError extends Error {}

type CapturedHydrationContext = Readonly<{
  database: ProxxiedDexie;
  getSession: MpcCalibrationCacheHydrationInput["transport"]["getSession"];
  getSnapshot: MpcCalibrationCacheHydrationInput["transport"]["getSnapshot"];
  getBlob: MpcCalibrationCacheHydrationInput["transport"]["getBlob"];
  identity: CalibrationHarnessPersistenceIdentity;
  signal?: AbortSignal;
  isCurrent?: () => boolean;
  now: () => number;
}>;


function checkedIdentity(identity: CalibrationHarnessPersistenceIdentity): CalibrationHarnessPersistenceIdentity {
  const valid = validateCalibrationHarnessPersistenceIdentity(identity);
  return { ownerId: valid.ownerId, harnessId: valid.harnessId, connectionId: valid.connectionId };
}

function sameIdentity(
  left: Pick<CalibrationHarnessPersistenceIdentity, "ownerId" | "harnessId" | "connectionId">,
  right: Pick<CalibrationHarnessPersistenceIdentity, "ownerId" | "harnessId" | "connectionId">
): boolean {
  return left.ownerId === right.ownerId && left.harnessId === right.harnessId && left.connectionId === right.connectionId;
}

function operationIsCurrent(context: CapturedHydrationContext): boolean {
  return !context.signal?.aborted && context.isCurrent?.() !== false;
}

function assertOperationCurrent(context: CapturedHydrationContext): void {
  if (!operationIsCurrent(context)) throw new HydrationFenceError("hydration operation is no longer current");
}

function stableJson(value: unknown): string {
  const visit = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(visit);
    if (entry !== null && typeof entry === "object") {
      if (Object.prototype.toString.call(entry) === "[object Blob]") {
        const blob = entry as Blob;
        return { $blob: { size: blob.size, type: blob.type } };
      }
      const source = entry as Record<string, unknown>;
      return Object.fromEntries(Object.keys(source).sort().map(key => [key, visit(source[key])]));
    }
    return entry;
  };
  return JSON.stringify(visit(value));
}

function unorderedJson(values: readonly unknown[]): string {
  return values.map(stableJson).sort().join("\n");
}

async function blobFingerprint(blob: Blob, transactionHeld = false): Promise<string> {
  if (blob.size > CALIBRATION_HARNESS_LIMITS.maxAssetBytes) {
    throw new HydrationBlockedError("local blob exceeds the per-asset limit");
  }
  const buffer = await (transactionHeld ? Dexie.waitFor(blob.arrayBuffer()) : blob.arrayBuffer());
  const digest = await (transactionHeld
    ? Dexie.waitFor(sha256(new Uint8Array(buffer)))
    : sha256(new Uint8Array(buffer)));
  return `${blob.size}:${blob.type}:${digest}`;
}

async function rowsFingerprint(rows: HarnessRows, transactionHeld = false): Promise<string> {
  // Retain only fingerprints, not an all-assets fan-out of live byte buffers.
  const assets = [];
  for (const asset of rows.assets) {
    assets.push({ ...asset, blob: await blobFingerprint(asset.blob, transactionHeld) });
  }
  return [
    unorderedJson(rows.datasets),
    unorderedJson(rows.cases),
    unorderedJson(assets),
    unorderedJson(rows.runs),
  ].join("\u001f");
}

async function rowsMatchSnapshot(rows: HarnessRows, snapshot: CalibrationHarnessSnapshot, transactionHeld = false): Promise<boolean> {
  if (
    unorderedJson(rows.datasets) !== unorderedJson(snapshot.datasets) ||
    unorderedJson(rows.cases) !== unorderedJson(snapshot.cases) ||
    unorderedJson(rows.runs) !== unorderedJson(snapshot.runs) ||
    unorderedJson(rows.assets.map(({ blob: _blob, ...asset }) => asset)) !== unorderedJson(snapshot.assets)
  ) return false;
  const assetById = new Map(snapshot.assets.map(asset => [asset.id, asset]));
  for (const asset of rows.assets) {
    const expected = assetById.get(asset.id);
    if (expected === undefined || asset.blob.size !== expected.byteLength || asset.blob.type !== expected.mimeType || await blobFingerprint(asset.blob, transactionHeld) !== `${expected.byteLength}:${expected.mimeType}:${expected.sha256}`) return false;
  }
  return true;
}

function withoutGeneratedBootstrapFields(value: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> {
  const copied = { ...value };
  for (const field of fields) delete copied[field];
  return copied;
}

/**
 * Bootstrap provenance is complete identity-bearing content, not a name/count
 * marker. Only builder/import timestamps are ignored; stable dataset and case
 * IDs, case-to-dataset linkage, every meaningful known and unknown JSON field,
 * candidate order, pick, hint, and multiplicity remain.
 */
function isExactBootstrapRows(rows: HarnessRows): boolean {
  if (rows.assets.length !== 0 || rows.runs.length !== 0) return false;
  const expected = buildBootstrapPreferenceFixture();
  const expectedDataset = expected.dataset as unknown as Record<string, unknown>;
  const expectedCases = expected.cases as unknown as Record<string, unknown>[];
  return rows.datasets.length === 1 &&
    stableJson(withoutGeneratedBootstrapFields(rows.datasets[0] as unknown as Record<string, unknown>, ["createdAt", "updatedAt"])) ===
      stableJson(withoutGeneratedBootstrapFields(expectedDataset, ["createdAt", "updatedAt"])) &&
    unorderedJson(rows.cases.map(entry => withoutGeneratedBootstrapFields(entry as unknown as Record<string, unknown>, ["createdAt", "updatedAt"]))) ===
      unorderedJson(expectedCases.map(entry => withoutGeneratedBootstrapFields(entry, ["createdAt", "updatedAt"])));
}

async function readRowsInCurrentTransaction(database: ProxxiedDexie): Promise<HarnessRows> {
  return {
    datasets: await database.mpcCalibrationDatasets.toArray(),
    cases: await database.mpcCalibrationCases.toArray(),
    assets: await database.mpcCalibrationAssets.toArray(),
    runs: await database.mpcCalibrationRuns.toArray(),
  };
}

async function readRows(database: ProxxiedDexie): Promise<HarnessRows> {
  return database.transaction(
    "r",
    database.mpcCalibrationDatasets,
    database.mpcCalibrationCases,
    database.mpcCalibrationAssets,
    database.mpcCalibrationRuns,
    () => readRowsInCurrentTransaction(database)
  );
}

function revisionStateFingerprint(state: CalibrationHarnessLocalState | undefined): string {
  return state === undefined ? "undefined" : stableJson(state);
}

function isCleanCurrentState(state: CalibrationHarnessLocalState | undefined): state is CalibrationHarnessLocalState {
  return state !== undefined && state.base !== null && state.queued === null && state.inFlight === null && state.dirtyGeneration === state.acknowledgedGeneration;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const digest = await crypto.subtle.digest("SHA-256", copy);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

function stagingId(operationId: string, index: number): string {
  return `${operationId}:${index}`;
}

async function stageAssets(
  context: CapturedHydrationContext,
  revision: CalibrationHarnessRevision,
  operationId: string,
  stageIds: string[]
): Promise<void> {
  for (let index = 0; index < revision.snapshot.assets.length; index += 1) {
    assertOperationCurrent(context);
    const asset = revision.snapshot.assets[index]!;
    const bytes = await context.getBlob(asset.sha256, { signal: context.signal });
    assertOperationCurrent(context);
    if (bytes.byteLength !== asset.byteLength || await sha256(bytes) !== asset.sha256) {
      throw new HydrationBlockedError("remote blob verification failed");
    }
    const id = stagingId(operationId, index);
    const staged: MpcCalibrationHydrationStagingRecord = {
      id,
      operationId,
      ...context.identity,
      assetId: asset.id,
      sha256: asset.sha256,
      byteLength: asset.byteLength,
      mimeType: asset.mimeType,
      blob: new Blob([bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer], { type: asset.mimeType }),
    };
    await context.database.mpcCalibrationHydrationStaging.add(staged);
    // The row already exists physically; record ownership before a fence can throw.
    stageIds.push(id);
    assertOperationCurrent(context);
  }
}

function remoteAssetRecord(asset: CalibrationHarnessAsset, blob: Blob): MpcCalibrationAssetRecord {
  return { ...asset, blob };
}

async function clearOwnedStaging(database: ProxxiedDexie, ids: readonly string[]): Promise<void> {
  if (ids.length > 0) await database.mpcCalibrationHydrationStaging.bulkDelete([...ids]);
}

function sessionMatches(
  session: { ownerId: string; harnessId: string },
  identity: CalibrationHarnessPersistenceIdentity
): boolean {
  return session.ownerId === identity.ownerId && session.harnessId === identity.harnessId;
}

/**
 * Explicitly reconcile a declared, authenticated identity with a remote full
 * harness. This helper neither pairs nor publishes. It serially stages one
 * verified Blob at a time and atomically replaces the four canonical tables
 * plus the C1 common base only after all operation, identity, local-data, and
 * revision fences are rechecked inside the final Dexie transaction.
 */
export async function hydrateMpcCalibrationCache(
  input: MpcCalibrationCacheHydrationInput
): Promise<MpcCalibrationCacheHydrationResult> {
  const database = input.database;
  const transport = input.transport;
  const signal = input.signal;
  const operation = input.operation;
  const isCurrent = operation?.isCurrent?.bind(operation);
  const now = input.now ?? Date.now;
  let identity: CalibrationHarnessPersistenceIdentity;
  try {
    identity = checkedIdentity(input.identity);
  } catch {
    return { status: "blocked", reason: "invalid-identity" };
  }
  const context: CapturedHydrationContext = {
    database,
    getSession: transport.getSession.bind(transport),
    getSnapshot: transport.getSnapshot.bind(transport),
    getBlob: transport.getBlob.bind(transport),
    identity,
    signal,
    isCurrent,
    now,
  };
  if (!operationIsCurrent(context)) return { status: "cancelled", reason: "operation-not-current" };

  const operationId = crypto.randomUUID();
  const stageIds: string[] = [];
  try {
    const session = await context.getSession({ signal: context.signal });
    if (!sessionMatches(session, identity)) return { status: "blocked", reason: "session-identity-mismatch" };
    assertOperationCurrent(context);

    const stateStore = createMpcCalibrationSyncStateStore(context.database, { now: context.now });
    let initialState: CalibrationHarnessLocalState | undefined;
    try {
      initialState = await stateStore.load(identity);
    } catch {
      return { status: "blocked", reason: "corrupt-sync-state" };
    }
    const initialRows = await readRows(context.database);
    const initialBinding = await context.database.mpcCalibrationCacheBindings.get(BINDING_ID);
    const initialRowsFingerprint = await rowsFingerprint(initialRows);
    const initialStateFingerprint = revisionStateFingerprint(initialState);

    if (initialBinding !== undefined && !sameIdentity(initialBinding, identity)) {
      return { status: "blocked", reason: "physical-cache-bound-to-different-identity" };
    }
    const empty = initialRows.datasets.length === 0 && initialRows.cases.length === 0 && initialRows.assets.length === 0 && initialRows.runs.length === 0;
    const bootstrap = !empty && (initialState === undefined || initialState.base === null) && isExactBootstrapRows(initialRows);
    const initialBase = isCleanCurrentState(initialState) ? initialState.base : null;
    const based = initialBase !== null && await rowsMatchSnapshot(initialRows, initialBase.snapshot);
    if (initialState !== undefined && !based && (initialState.queued !== null || initialState.inFlight !== null || initialState.base !== null)) {
      return { status: "needs-reconciliation", reason: "unbased-local-sync-state-is-not-clean" };
    }
    if (!empty && !bootstrap && !based) {
      return { status: "needs-reconciliation", reason: "unbased-or-dirty-local-harness" };
    }
    if (based && initialBinding === undefined) {
      return { status: "needs-reconciliation", reason: "unbound-physical-cache" };
    }

    const remote = await context.getSnapshot({ signal: context.signal });
    assertOperationCurrent(context);
    if (remote === null) return { status: "no-remote-snapshot" };
    const revision = captureCalibrationHarnessRevision(remote, "remote revision");
    validateCalibrationHarnessSnapshot(revision.snapshot);
    if (based && revision.revision <= initialBase!.revision) {
      return { status: "blocked", reason: "remote-revision-not-newer" };
    }

    await stageAssets(context, revision, operationId, stageIds);
    const finalSession = await context.getSession({ signal: context.signal });
    if (!sessionMatches(finalSession, identity)) {
      try {
        await clearOwnedStaging(context.database, stageIds);
      } catch {
        return { status: "failed", reason: "staging-cleanup-failed" };
      }
      return { status: "blocked", reason: "session-identity-replaced" };
    }
    assertOperationCurrent(context);

    await context.database.transaction(
      "rw",
      [
        context.database.mpcCalibrationDatasets,
        context.database.mpcCalibrationCases,
        context.database.mpcCalibrationAssets,
        context.database.mpcCalibrationRuns,
        context.database.mpcCalibrationSyncStates,
        context.database.mpcCalibrationCacheBindings,
        context.database.mpcCalibrationHydrationStaging,
      ],
      async () => {
        assertOperationCurrent(context);
        const currentBinding = await context.database.mpcCalibrationCacheBindings.get(BINDING_ID);
        if (currentBinding !== undefined && !sameIdentity(currentBinding, identity)) throw new HydrationFenceError("physical cache identity changed");
        const currentRows = await readRowsInCurrentTransaction(context.database);
        if (await rowsFingerprint(currentRows, true) !== initialRowsFingerprint) throw new HydrationFenceError("local harness data changed");
        const currentState = await stateStore.load(identity);
        if (revisionStateFingerprint(currentState) !== initialStateFingerprint) throw new HydrationFenceError("local sync state changed");
        if (based) {
          if (!isCleanCurrentState(currentState) || currentState.base === null || !await rowsMatchSnapshot(currentRows, currentState.base.snapshot, true)) {
            throw new HydrationFenceError("current local base is no longer clean");
          }
        }
        if (!based && currentState !== undefined && currentState.base !== null) throw new HydrationFenceError("local base appeared during hydration");

        await context.database.mpcCalibrationDatasets.clear();
        assertOperationCurrent(context);
        await context.database.mpcCalibrationCases.clear();
        assertOperationCurrent(context);
        await context.database.mpcCalibrationAssets.clear();
        assertOperationCurrent(context);
        await context.database.mpcCalibrationRuns.clear();
        assertOperationCurrent(context);
        await context.database.mpcCalibrationDatasets.bulkPut(revision.snapshot.datasets as MpcCalibrationDatasetRecord[]);
        assertOperationCurrent(context);
        await context.database.mpcCalibrationCases.bulkPut(revision.snapshot.cases as MpcCalibrationCaseRecord[]);
        assertOperationCurrent(context);
        for (let index = 0; index < revision.snapshot.assets.length; index += 1) {
          const asset = revision.snapshot.assets[index]!;
          const stagedAsset = await context.database.mpcCalibrationHydrationStaging.get(stagingId(operationId, index));
          if (stagedAsset === undefined || !sameIdentity(stagedAsset, identity) || stagedAsset.assetId !== asset.id || stagedAsset.sha256 !== asset.sha256 || stagedAsset.byteLength !== asset.byteLength || stagedAsset.mimeType !== asset.mimeType || stagedAsset.blob.size !== asset.byteLength || stagedAsset.blob.type !== asset.mimeType || await blobFingerprint(stagedAsset.blob, true) !== `${asset.byteLength}:${asset.mimeType}:${asset.sha256}`) {
            throw new HydrationFenceError("owned blob staging is incomplete or changed");
          }
          await context.database.mpcCalibrationAssets.put(remoteAssetRecord(asset, stagedAsset.blob));
          assertOperationCurrent(context);
        }
        await context.database.mpcCalibrationRuns.bulkPut(revision.snapshot.runs as MpcCalibrationRunRecord[]);
        assertOperationCurrent(context);
        await stateStore.storeBaseWhenClean(identity, revision);
        assertOperationCurrent(context);
        const timestamp = context.now();
        if (!Number.isSafeInteger(timestamp) || timestamp < 0) throw new HydrationBlockedError("invalid timestamp");
        const binding: MpcCalibrationCacheBindingRecord = { id: BINDING_ID, ...identity, revision: revision.revision, updatedAt: timestamp };
        await context.database.mpcCalibrationCacheBindings.put(binding);
        assertOperationCurrent(context);
      }
    );
    try {
      await clearOwnedStaging(context.database, stageIds);
    } catch {
      return { status: "hydrated", revision: revision.revision, reason: "committed-staging-cleanup-failed" };
    }
    return { status: "hydrated", revision: revision.revision };
  } catch (error) {
    let cleanupFailed = false;
    if (stageIds.length > 0) {
      try {
        await clearOwnedStaging(context.database, stageIds);
      } catch {
        cleanupFailed = true;
      }
    }
    if (cleanupFailed) return { status: "failed", reason: "staging-cleanup-failed" };
    if (error instanceof HydrationFenceError || !operationIsCurrent(context)) {
      return { status: "cancelled", reason: "operation-or-local-state-changed" };
    }
    if (error instanceof HydrationBlockedError) return { status: "blocked", reason: "invalid-remote-blob" };
    return { status: "failed", reason: "remote-or-persistence-failure" };
  }
}

export const MPC_CALIBRATION_CACHE_BINDING_ID = BINDING_ID;
