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
  CalibrationHarnessPersistenceIdentity,
} from "../../../shared/calibrationHarnessLocalState";
import {
  captureCalibrationHarnessRevision,
  validateCalibrationHarnessLocalState,
  validateCalibrationHarnessPersistenceIdentity,
} from "../../../shared/calibrationHarnessLocalState";
import {
  validateCalibrationHarnessRecoveryState,
  type CalibrationHarnessAnyLocalState,
  type CalibrationHarnessRecoveryState,
} from "../../../shared/calibrationHarnessRecoveryState";
import { mergeCalibrationHarnessSnapshots } from "../../../shared/calibrationHarnessMerge";
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

function revisionStateFingerprint(state: CalibrationHarnessAnyLocalState | undefined): string {
  return state === undefined ? "undefined" : stableJson(state);
}

function isCleanCurrentState(state: CalibrationHarnessAnyLocalState | undefined): state is CalibrationHarnessAnyLocalState {
  return state !== undefined && state.base !== null && state.queued === null && state.inFlight === null && state.dirtyGeneration ===
    (state.formatVersion === 2 ? state.settledGeneration : state.acknowledgedGeneration);
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

async function clearOwnedStaging(
  database: ProxxiedDexie,
  operationId: string,
  identity: CalibrationHarnessPersistenceIdentity,
  ids: readonly string[],
): Promise<void> {
  if (ids.length === 0) return;
  await database.transaction("rw", database.mpcCalibrationHydrationStaging, async () => {
    const ownedIds: string[] = [];
    for (const id of ids) {
      const staged = await database.mpcCalibrationHydrationStaging.get(id);
      if (staged !== undefined && staged.id === id && staged.operationId === operationId && sameIdentity(staged, identity)) {
        ownedIds.push(id);
      }
    }
    if (ownedIds.length > 0) await database.mpcCalibrationHydrationStaging.bulkDelete(ownedIds);
  });
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
    let initialState: CalibrationHarnessAnyLocalState | undefined;
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
        await clearOwnedStaging(context.database, operationId, identity, stageIds);
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
      await clearOwnedStaging(context.database, operationId, identity, stageIds);
    } catch {
      return { status: "hydrated", revision: revision.revision, reason: "committed-staging-cleanup-failed" };
    }
    return { status: "hydrated", revision: revision.revision };
  } catch (error) {
    let cleanupFailed = false;
    if (stageIds.length > 0) {
      try {
        await clearOwnedStaging(context.database, operationId, identity, stageIds);
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

export type MpcCalibrationRecoveryCacheInput = Readonly<{
  database: ProxxiedDexie;
  transport: Pick<MpcCalibrationTransport, "getSession" | "getBlob">;
  identity: CalibrationHarnessPersistenceIdentity;
  expectedState: CalibrationHarnessAnyLocalState;
  nextState: CalibrationHarnessRecoveryState;
  snapshot: CalibrationHarnessSnapshot;
  signal?: AbortSignal;
  operation?: MpcCalibrationHydrationOperation;
  now?: () => number;
}>;

export type MpcCalibrationRecoveryCacheResult = Readonly<{
  status: "applied" | "blocked" | "cancelled" | "failed";
  revision?: number;
  reason?: string;
}>;

type PreparedRecoveryAsset = Readonly<{
  asset: CalibrationHarnessAsset;
  /** Existing local handles are immutable after the full row fingerprint fence. */
  localBlob?: Blob;
  /** Newly fetched content is retained only by its persisted staging reference. */
  stageId?: string;
}>;

function captureAnyState(value: unknown): CalibrationHarnessAnyLocalState {
  try {
    return structuredClone(validateCalibrationHarnessLocalState(value));
  } catch {
    return structuredClone(validateCalibrationHarnessRecoveryState(value));
  }
}

function sameSnapshot(left: CalibrationHarnessSnapshot, right: CalibrationHarnessSnapshot): boolean {
  return stableJson(left) === stableJson(right);
}

function sameRevision(left: CalibrationHarnessRevision, right: CalibrationHarnessRevision): boolean {
  return left.revision === right.revision && sameSnapshot(left.snapshot, right.snapshot);
}

function assertRecoveryTransition(
  identity: CalibrationHarnessPersistenceIdentity,
  expected: CalibrationHarnessAnyLocalState,
  next: CalibrationHarnessRecoveryState,
  target: CalibrationHarnessSnapshot,
): void {
  if (!sameIdentity(expected, identity) || !sameIdentity(next, identity)) {
    throw new HydrationBlockedError("recovery state identity does not match the captured identity");
  }
  if (expected.base === null || expected.queued === null || next.base === null) {
    throw new HydrationBlockedError("recovery requires a based queued state and an installed next base");
  }
  if (next.acknowledgedGeneration !== expected.acknowledgedGeneration || next.sentGeneration !== expected.sentGeneration) {
    throw new HydrationBlockedError("recovery application cannot alter acknowledgement or sent counters");
  }
  if (next.base.revision < expected.base.revision ||
    (next.base.revision === expected.base.revision && !sameSnapshot(next.base.snapshot, expected.base.snapshot))) {
    throw new HydrationBlockedError("recovery base must be monotonic");
  }
  if (next.settledGeneration < (expected.formatVersion === 2 ? expected.settledGeneration : expected.acknowledgedGeneration) ||
    next.dirtyGeneration < expected.dirtyGeneration) {
    throw new HydrationBlockedError("recovery generations must be monotonic");
  }
  const intended = next.queued?.snapshot ?? next.base.snapshot;
  if (!sameSnapshot(intended, target)) {
    throw new HydrationBlockedError("target snapshot does not equal the next desired state");
  }
  if (next.queued === null) {
    if (next.settledGeneration < expected.queued.generation) {
      throw new HydrationBlockedError("recovery cannot drop an unsettled queued generation");
    }
  } else if (next.queued.generation === expected.queued.generation) {
    if (!sameSnapshot(next.queued.snapshot, expected.queued.snapshot)) {
      throw new HydrationBlockedError("preserved queued generation changed body");
    }
  } else if (next.queued.generation !== expected.dirtyGeneration + 1) {
    throw new HydrationBlockedError("replacement queue must use the exact next generation");
  }
  const expectedAcknowledgement = expected.lastAcknowledgement ?? null;
  if (stableJson(next.lastAcknowledgement) !== stableJson(expectedAcknowledgement)) {
    throw new HydrationBlockedError("recovery application cannot fabricate or replace acknowledgement evidence");
  }
  const expectedRecovery = expected.formatVersion === 2 ? expected.lastRecovery : null;
  if (stableJson(next.lastRecovery) !== stableJson(expectedRecovery) && next.lastRecovery !== null) {
    const proof = next.lastRecovery;
    if (expected.inFlight === null || !sameRevision(proof.priorBase, expected.base) ||
      proof.priorQueued.generation !== expected.queued.generation || !sameSnapshot(proof.priorQueued.snapshot, expected.queued.snapshot) ||
      proof.retiredInFlight === null || proof.retiredInFlight.generation !== expected.inFlight.generation ||
      proof.retiredInFlight.expectedBaseRevision !== expected.inFlight.expectedBaseRevision ||
      !sameSnapshot(proof.retiredInFlight.snapshot, expected.inFlight.snapshot)) {
      throw new HydrationBlockedError("new recovery proof does not bind the exact expected state");
    }
  }
  if (expected.inFlight === null && next.queued !== null && next.queued.generation !== expected.queued.generation) {
    const merged = mergeCalibrationHarnessSnapshots(expected.base.snapshot, expected.queued.snapshot, next.base.snapshot);
    if (!merged.ok || !sameSnapshot(next.queued.snapshot, merged.snapshot)) {
      throw new HydrationBlockedError("unsent recovery rebase must preserve the accepted merge result");
    }
  }
}

async function prepareRecoveryAssets(
  context: CapturedHydrationContext,
  target: CalibrationHarnessSnapshot,
  expectedSnapshot: CalibrationHarnessSnapshot,
  rows: HarnessRows,
  operationId: string,
  stageIds: string[],
): Promise<PreparedRecoveryAsset[]> {
  const localRows = new Map(rows.assets.map(row => [row.id, row]));
  const expectedAssets = new Map(expectedSnapshot.assets.map(asset => [asset.id, asset]));
  const verifiedStageByDigest = new Map<string, string>();
  const prepared: PreparedRecoveryAsset[] = [];
  for (let index = 0; index < target.assets.length; index += 1) {
    assertOperationCurrent(context);
    const asset = target.assets[index]!;
    if (asset.byteLength > CALIBRATION_HARNESS_LIMITS.maxAssetBytes) {
      throw new HydrationBlockedError("recovery asset exceeds the per-asset limit");
    }
    const digestKey = `${asset.sha256}:${asset.byteLength}`;
    const existingStageId = verifiedStageByDigest.get(digestKey);
    if (existingStageId !== undefined) {
      prepared.push({ asset, stageId: existingStageId });
      continue;
    }
    const expected = [...expectedAssets.values()].find(candidate => candidate.sha256 === asset.sha256 && candidate.byteLength === asset.byteLength);
    const local = expected === undefined ? undefined : localRows.get(expected.id);
    if (expected !== undefined && local !== undefined && local.blob.size === asset.byteLength &&
      await blobFingerprint(local.blob) === `${asset.byteLength}:${expected.mimeType}:${asset.sha256}`) {
      prepared.push({ asset, localBlob: local.blob });
      continue;
    }
    const bytes = await context.getBlob(asset.sha256, { signal: context.signal });
    assertOperationCurrent(context);
    if (bytes.byteLength !== asset.byteLength || await sha256(bytes) !== asset.sha256) {
      throw new HydrationBlockedError("recovery remote blob verification failed");
    }
    const id = stagingId(operationId, index);
    await context.database.mpcCalibrationHydrationStaging.add({
      id, operationId, ...context.identity, assetId: asset.id, sha256: asset.sha256,
      byteLength: asset.byteLength, mimeType: asset.mimeType,
      blob: new Blob([bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer], { type: asset.mimeType }),
    });
    // The database now owns remote bytes; retain only this stage reference in memory.
    stageIds.push(id);
    verifiedStageByDigest.set(digestKey, id);
    prepared.push({ asset, stageId: id });
    assertOperationCurrent(context);
  }
  return prepared;
}

/**
 * Applies a coordinator-produced, validated recovery state to the physical
 * cache. It never publishes or fabricates acknowledgement evidence.
 */
export async function applyMpcCalibrationRecoveryCache(
  input: MpcCalibrationRecoveryCacheInput,
): Promise<MpcCalibrationRecoveryCacheResult> {
  const database = input.database;
  const transport = input.transport;
  const signal = input.signal;
  const isCurrent = input.operation?.isCurrent?.bind(input.operation);
  const now = input.now ?? Date.now;
  let identity: CalibrationHarnessPersistenceIdentity;
  let expectedState: CalibrationHarnessAnyLocalState;
  let nextState: CalibrationHarnessRecoveryState;
  let target: CalibrationHarnessSnapshot;
  try {
    identity = checkedIdentity(input.identity);
    expectedState = captureAnyState(input.expectedState);
    nextState = structuredClone(validateCalibrationHarnessRecoveryState(input.nextState));
    validateCalibrationHarnessSnapshot(input.snapshot);
    target = structuredClone(input.snapshot);
    assertRecoveryTransition(identity, expectedState, nextState, target);
  } catch {
    return { status: "blocked", reason: "invalid-recovery-input" };
  }
  const context: CapturedHydrationContext = {
    database,
    getSession: transport.getSession.bind(transport),
    getSnapshot: async () => null,
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
    const stateStore = createMpcCalibrationSyncStateStore(database, { now });
    const storedState = await stateStore.load(identity);
    const rows = await readRows(database);
    const binding = await database.mpcCalibrationCacheBindings.get(BINDING_ID);
    if (revisionStateFingerprint(storedState) !== revisionStateFingerprint(expectedState) ||
      binding === undefined || !sameIdentity(binding, identity) ||
      !await rowsMatchSnapshot(rows, expectedState.queued!.snapshot)) {
      return { status: "blocked", reason: "current-cache-is-not-the-expected-queued-state" };
    }
    const rowsBefore = await rowsFingerprint(rows);
    const prepared = await prepareRecoveryAssets(context, target, expectedState.queued!.snapshot, rows, operationId, stageIds);
    const finalSession = await context.getSession({ signal: context.signal });
    if (!sessionMatches(finalSession, identity)) throw new HydrationFenceError("session identity replaced");
    assertOperationCurrent(context);
    await database.transaction("rw", [
      database.mpcCalibrationDatasets, database.mpcCalibrationCases, database.mpcCalibrationAssets,
      database.mpcCalibrationRuns, database.mpcCalibrationSyncStates, database.mpcCalibrationCacheBindings,
      database.mpcCalibrationHydrationStaging,
    ], async () => {
      assertOperationCurrent(context);
      const currentBinding = await database.mpcCalibrationCacheBindings.get(BINDING_ID);
      const currentRows = await readRowsInCurrentTransaction(database);
      const currentState = await stateStore.load(identity);
      if (currentBinding === undefined || !sameIdentity(currentBinding, identity) ||
        revisionStateFingerprint(currentState) !== revisionStateFingerprint(expectedState) ||
        await rowsFingerprint(currentRows, true) !== rowsBefore ||
        !await rowsMatchSnapshot(currentRows, expectedState.queued!.snapshot, true)) {
        throw new HydrationFenceError("current recovery inputs changed");
      }
      await database.mpcCalibrationDatasets.clear(); assertOperationCurrent(context);
      await database.mpcCalibrationCases.clear(); assertOperationCurrent(context);
      await database.mpcCalibrationAssets.clear(); assertOperationCurrent(context);
      await database.mpcCalibrationRuns.clear(); assertOperationCurrent(context);
      await database.mpcCalibrationDatasets.bulkPut(target.datasets as MpcCalibrationDatasetRecord[]); assertOperationCurrent(context);
      await database.mpcCalibrationCases.bulkPut(target.cases as MpcCalibrationCaseRecord[]); assertOperationCurrent(context);
      for (const entry of prepared) {
        let blob = entry.localBlob;
        if (entry.stageId !== undefined) {
          const staged = await database.mpcCalibrationHydrationStaging.get(entry.stageId);
          if (staged === undefined || !sameIdentity(staged, identity) || staged.operationId !== operationId ||
            staged.sha256 !== entry.asset.sha256 || staged.byteLength !== entry.asset.byteLength ||
            await blobFingerprint(staged.blob, true) !== `${staged.byteLength}:${staged.mimeType}:${staged.sha256}`) {
            throw new HydrationFenceError("recovery staging changed");
          }
          blob = staged.blob;
        }
        if (blob === undefined || blob.size !== entry.asset.byteLength) throw new HydrationFenceError("recovery asset was not prepared");
        await database.mpcCalibrationAssets.put(remoteAssetRecord(
          entry.asset,
          blob.type === entry.asset.mimeType ? blob : blob.slice(0, blob.size, entry.asset.mimeType),
        ));
        assertOperationCurrent(context);
      }
      await database.mpcCalibrationRuns.bulkPut(target.runs as MpcCalibrationRunRecord[]); assertOperationCurrent(context);
      await database.mpcCalibrationSyncStates.put(nextState); assertOperationCurrent(context);
      const timestamp = context.now();
      if (!Number.isSafeInteger(timestamp) || timestamp < 0) throw new HydrationBlockedError("invalid timestamp");
      await database.mpcCalibrationCacheBindings.put({ id: BINDING_ID, ...identity, revision: nextState.base!.revision, updatedAt: timestamp });
      assertOperationCurrent(context);
    });
    try {
      await clearOwnedStaging(database, operationId, identity, stageIds);
    } catch {
      return { status: "applied", revision: nextState.base!.revision, reason: "committed-staging-cleanup-failed" };
    }
    return { status: "applied", revision: nextState.base!.revision };
  } catch (error) {
    let cleanupFailed = false;
    if (stageIds.length > 0) {
      try { await clearOwnedStaging(database, operationId, identity, stageIds); } catch { cleanupFailed = true; }
    }
    if (cleanupFailed) return { status: "failed", reason: "staging-cleanup-failed" };
    if (error instanceof HydrationFenceError || !operationIsCurrent(context)) return { status: "cancelled", reason: "operation-or-current-state-changed" };
    if (error instanceof HydrationBlockedError) return { status: "blocked", reason: "invalid-recovery-content" };
    return { status: "failed", reason: "recovery-persistence-or-transport-failure" };
  }
}

export const MPC_CALIBRATION_CACHE_BINDING_ID = BINDING_ID;
