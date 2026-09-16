import type {
  MpcCalibrationAssetRecord,
  MpcCalibrationCaseRecord,
  MpcCalibrationDatasetRecord,
  MpcCalibrationRunRecord,
  ProxxiedDexie,
} from "@/db";
import type {
  CalibrationHarnessSnapshot,
} from "../../../shared/calibrationHarness";
import {
  validateCalibrationHarnessPersistenceIdentity,
  type CalibrationHarnessPersistenceIdentity,
} from "../../../shared/calibrationHarnessLocalState";
import {
  buildLocalCalibrationSnapshot,
  MPC_CALIBRATION_CACHE_BINDING_ID,
} from "./mpcCalibrationMutations";
import { createMpcCalibrationSyncStateStore } from "./mpcCalibrationSyncState";
import {
  unionMergeCalibrationSnapshots,
  type MpcCalibrationUnionMergeDelta,
} from "./mpcCalibrationReconciliation";
import type { MpcCalibrationTransport } from "./mpcCalibrationTransport";
import { mpcCalibrationLogError, mpcCalibrationLogInfo } from "./mpcCalibrationLog";

export type MpcCalibrationReconciliationErrorCode =
  | "missing-binding"
  | "identity-mismatch"
  | "no-remote-snapshot"
  | "invalid-local-snapshot"
  | "invalid-remote-snapshot"
  | "invalid-merged-snapshot"
  | "blob-verification-failed";

export class MpcCalibrationReconciliationError extends Error {
  readonly code: MpcCalibrationReconciliationErrorCode;

  constructor(code: MpcCalibrationReconciliationErrorCode, message: string) {
    super(message);
    this.name = "MpcCalibrationReconciliationError";
    this.code = code;
  }
}

function reconciliationError(code: MpcCalibrationReconciliationErrorCode, message: string): never {
  throw new MpcCalibrationReconciliationError(code, message);
}

export type MpcCalibrationReconcileMergeResult = Readonly<{
  /** The observed remote revision; the merged snapshot is queued on top of it. */
  baseRevision: number;
  delta: MpcCalibrationUnionMergeDelta;
}>;

export type MpcCalibrationReconcileResetResult = Readonly<{
  clearedTables: number;
}>;

function clone<T>(value: T): T {
  return structuredClone(value);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const digest = await crypto.subtle.digest("SHA-256", copy);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

function identityFromBinding(binding: {
  ownerId: unknown;
  harnessId: unknown;
  connectionId: unknown;
}): CalibrationHarnessPersistenceIdentity {
  try {
    return validateCalibrationHarnessPersistenceIdentity({
      ownerId: binding.ownerId,
      harnessId: binding.harnessId,
      connectionId: binding.connectionId,
    });
  } catch {
    return reconciliationError("missing-binding", "The calibration cache binding is malformed; use Reset to remote.");
  }
}

/**
 * Reconciles the local calibration cache with the remote snapshot by union.
 *
 * The local rows are the system of record: same-id divergences keep the local
 * copy, and the remote contributes only the rows the local cache lacks. The
 * merged snapshot is queued for the existing queue-recovery machinery, which
 * publishes it as the next remote revision (CAS against the observed base),
 * performs the designed 3-way merge if the remote advanced meanwhile, and
 * acknowledges the result back to a clean state. Nothing local is discarded.
 *
 * After this action returns, the caller must re-select the linked target so
 * the app lifecycle re-admits and starts the queue controller for the queued
 * snapshot.
 */
export async function reconcileMpcCalibrationMerge(supplied: Readonly<{
  database: ProxxiedDexie;
  transport: MpcCalibrationTransport;
  now?: () => number;
}>): Promise<MpcCalibrationReconcileMergeResult> {
  try {
    const result = await reconcileMpcCalibrationMergeImpl(supplied);
    mpcCalibrationLogInfo("merge outcome", {
      status: "ok",
      baseRevision: result.baseRevision,
      datasets: result.delta.datasets,
      cases: result.delta.cases,
      runs: result.delta.runs,
      assets: result.delta.assets,
      localWins: result.delta.localWins,
    });
    return result;
  } catch (error) {
    if (error instanceof MpcCalibrationReconciliationError) {
      mpcCalibrationLogError("merge failed", error, { code: error.code });
    }
    throw error;
  }
}

async function reconcileMpcCalibrationMergeImpl(supplied: Readonly<{
  database: ProxxiedDexie;
  transport: MpcCalibrationTransport;
  now?: () => number;
}>): Promise<MpcCalibrationReconcileMergeResult> {
  const database = supplied.database;
  const transport = supplied.transport;
  const now = supplied.now ?? Date.now;

  const binding = await database.mpcCalibrationCacheBindings.get(MPC_CALIBRATION_CACHE_BINDING_ID);
  if (binding === undefined) {
    return reconciliationError("missing-binding", "No calibration cache binding exists; connect the service first.");
  }
  const identity = identityFromBinding(binding);

  let session;
  try {
    session = await transport.getSession();
  } catch (error) {
    return reconciliationError("identity-mismatch", `The configured service is unreachable: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (session.ownerId !== identity.ownerId || session.harnessId !== identity.harnessId) {
    return reconciliationError(
      "identity-mismatch",
      "The service identity does not match this local cache; use Reset to remote instead.",
    );
  }

  let remote;
  try {
    remote = await transport.getSnapshot();
  } catch (error) {
    return reconciliationError("no-remote-snapshot", `Could not read the remote snapshot: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (remote === null) {
    return reconciliationError("no-remote-snapshot", "The remote has no snapshot yet; nothing to merge into.");
  }

  let local: CalibrationHarnessSnapshot;
  try {
    local = await buildLocalCalibrationSnapshot(database);
  } catch (error) {
    return reconciliationError("invalid-local-snapshot", `The local calibration rows are not a valid snapshot: ${error instanceof Error ? error.message : String(error)}`);
  }

  const merged = unionMergeCalibrationSnapshots(local, remote.snapshot);
  if (!merged.ok) {
    return reconciliationError(
      merged.code === "invalid-remote-snapshot" ? "invalid-remote-snapshot"
        : merged.code === "invalid-merged-snapshot" ? "invalid-merged-snapshot"
        : "invalid-local-snapshot",
      merged.message,
    );
  }

  // Remote-origin rows are exactly the rows the union added from the remote:
  // cases the local cache lacks, and every asset of those cases.
  const localCaseIds = new Set(local.cases.map((record) => record.id));
  const incomingCases = remote.snapshot.cases.filter((record) => !localCaseIds.has(record.id));
  const incomingCaseIds = new Set(incomingCases.map((record) => record.id));
  const localDatasetIds = new Set(local.datasets.map((record) => record.id));
  const incomingDatasets = remote.snapshot.datasets.filter((record) => !localDatasetIds.has(record.id));
  const localRunIds = new Set(local.runs.map((record) => record.id));
  const incomingRuns = remote.snapshot.runs.filter((record) => !localRunIds.has(record.id));
  const localAssetIds = new Set(local.assets.map((record) => record.id));
  const incomingAssets = remote.snapshot.assets.filter(
    (record) => incomingCaseIds.has(record.caseId) && !localAssetIds.has(record.id),
  );

  const blobsBySha256 = new Map<string, Blob>();
  for (const asset of incomingAssets) {
    if (blobsBySha256.has(asset.sha256)) continue;
    let bytes: Uint8Array;
    try {
      bytes = await transport.getBlob(asset.sha256);
    } catch (error) {
      return reconciliationError("blob-verification-failed", `Could not download remote asset ${asset.sha256}: ${error instanceof Error ? error.message : String(error)}`);
    }
    let digest: string;
    try {
      digest = await sha256Hex(bytes);
    } catch {
      digest = "";
    }
    if (digest !== asset.sha256) {
      return reconciliationError("blob-verification-failed", `Remote asset ${asset.sha256} failed sha256 verification.`);
    }
    blobsBySha256.set(
      asset.sha256,
      new Blob([bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer], {
        type: asset.mimeType,
      }),
    );
  }

  const stateStore = createMpcCalibrationSyncStateStore(database, { now });
  await database.transaction(
    "rw",
    [
      database.mpcCalibrationDatasets,
      database.mpcCalibrationCases,
      database.mpcCalibrationAssets,
      database.mpcCalibrationRuns,
      database.mpcCalibrationSyncStates,
      database.mpcCalibrationCacheBindings,
    ],
    async () => {
      const datasetRecords = incomingDatasets.map((record) => clone(record)) as MpcCalibrationDatasetRecord[];
      if (datasetRecords.length > 0) await database.mpcCalibrationDatasets.bulkPut(datasetRecords);
      const caseRecords = incomingCases.map((record) => clone(record)) as MpcCalibrationCaseRecord[];
      if (caseRecords.length > 0) await database.mpcCalibrationCases.bulkPut(caseRecords);
      const runRecords = incomingRuns.map((record) => clone(record)) as MpcCalibrationRunRecord[];
      if (runRecords.length > 0) await database.mpcCalibrationRuns.bulkPut(runRecords);
      const assetRecords: MpcCalibrationAssetRecord[] = [];
      for (const asset of incomingAssets) {
        const blob = blobsBySha256.get(asset.sha256);
        if (blob === undefined || blob.size !== asset.byteLength) {
          throw new MpcCalibrationReconciliationError(
            "blob-verification-failed",
            `Remote asset ${asset.sha256} failed byte-length verification.`,
          );
        }
        assetRecords.push({ ...clone(asset), blob } as MpcCalibrationAssetRecord);
      }
      if (assetRecords.length > 0) await database.mpcCalibrationAssets.bulkPut(assetRecords);

      // Anchor the base at the observed remote revision, align the binding,
      // then queue the merged snapshot. The existing queue-recovery owner
      // publishes it against this base and settles the state to clean.
      await stateStore.storeBaseWhenClean(identity, {
        revision: remote.revision,
        snapshot: remote.snapshot,
      });
      await database.mpcCalibrationCacheBindings.put({
        id: MPC_CALIBRATION_CACHE_BINDING_ID,
        ownerId: identity.ownerId,
        harnessId: identity.harnessId,
        connectionId: identity.connectionId,
        revision: remote.revision,
        updatedAt: now(),
      });
      await stateStore.queueSnapshot(identity, merged.snapshot);
    },
  );

  return { baseRevision: remote.revision, delta: merged.delta };
}

/**
 * Discards the local calibration cache so the next admission re-pairs and
 * re-hydrates from the remote snapshot. Data, sync state, binding, link
 * state, and hydration staging are cleared; every other table is untouched.
 */
export async function resetMpcCalibrationToRemote(
  database: ProxxiedDexie,
): Promise<MpcCalibrationReconcileResetResult> {
  await database.transaction(
    "rw",
    [
      database.mpcCalibrationDatasets,
      database.mpcCalibrationCases,
      database.mpcCalibrationAssets,
      database.mpcCalibrationRuns,
      database.mpcCalibrationSyncStates,
      database.mpcCalibrationCacheBindings,
      database.mpcCalibrationLinkStates,
      database.mpcCalibrationHydrationStaging,
    ],
    async () => {
      await Promise.all([
        database.mpcCalibrationDatasets.clear(),
        database.mpcCalibrationCases.clear(),
        database.mpcCalibrationAssets.clear(),
        database.mpcCalibrationRuns.clear(),
        database.mpcCalibrationSyncStates.clear(),
        database.mpcCalibrationCacheBindings.clear(),
        database.mpcCalibrationLinkStates.clear(),
        database.mpcCalibrationHydrationStaging.clear(),
      ]);
    },
  );
  mpcCalibrationLogInfo("reset outcome", { status: "ok", clearedTables: 8 });
  return { clearedTables: 8 };
}
