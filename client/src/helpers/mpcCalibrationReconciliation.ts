import {
  CALIBRATION_HARNESS_FORMAT_VERSION,
  canonicalHarnessJson,
  validateCalibrationHarnessSnapshot,
  type CalibrationHarnessDataset,
  type CalibrationHarnessRun,
  type CalibrationHarnessSnapshot,
} from "../../../shared/calibrationHarness";

const ROOT_TABLE_KEYS = new Set(["version", "datasets", "cases", "assets", "runs"]);

export type MpcCalibrationUnionMergeDelta = Readonly<{
  /** Remote-only rows adopted into the merged snapshot. */
  datasets: number;
  cases: number;
  runs: number;
  assets: number;
  /** Same-id records whose remote copy diverged; the local copy won. */
  localWins: number;
}>;

export type MpcCalibrationUnionMergeSuccess = Readonly<{
  ok: true;
  snapshot: CalibrationHarnessSnapshot;
  delta: MpcCalibrationUnionMergeDelta;
}>;

export type MpcCalibrationUnionMergeFailureCode =
  | "invalid-local-snapshot"
  | "invalid-remote-snapshot"
  | "invalid-merged-snapshot";

export type MpcCalibrationUnionMergeFailure = Readonly<{
  ok: false;
  code: MpcCalibrationUnionMergeFailureCode;
  message: string;
}>;

export type MpcCalibrationUnionMergeResult =
  | MpcCalibrationUnionMergeSuccess
  | MpcCalibrationUnionMergeFailure;

function clone<T>(value: T): T {
  return structuredClone(value);
}

function indexById<T extends { id: string }>(rows: readonly T[]): Map<string, T> {
  const byId = new Map<string, T>();
  for (const row of rows) byId.set(row.id, row);
  return byId;
}

function fail(code: MpcCalibrationUnionMergeFailureCode, message: string): MpcCalibrationUnionMergeFailure {
  return { ok: false, code, message };
}

function unionById<T extends { id: string }>(
  localRows: readonly T[],
  remoteRows: readonly T[],
): { rows: T[]; added: number; localWins: number } {
  const localById = indexById(localRows);
  const remoteById = indexById(remoteRows);
  const rows: T[] = [];
  let added = 0;
  let localWins = 0;
  // Local rows keep local order and content; the local copy wins on divergence.
  for (const row of localRows) {
    const remoteRow = remoteById.get(row.id);
    if (remoteRow !== undefined && canonicalHarnessJson(remoteRow) !== canonicalHarnessJson(row)) {
      localWins += 1;
    }
    rows.push(clone(row));
  }
  // Remote-only rows are appended in remote order.
  for (const row of remoteRows) {
    if (localById.has(row.id)) continue;
    rows.push(clone(row));
    added += 1;
  }
  return { rows, added, localWins };
}

function groupAssetsByCase<T extends { id: string; caseId: string }>(
  rows: readonly T[],
): Map<string, T[]> {
  const byCase = new Map<string, T[]>();
  for (const row of rows) {
    const bucket = byCase.get(row.caseId);
    if (bucket === undefined) byCase.set(row.caseId, [row]);
    else bucket.push(row);
  }
  return byCase;
}

/**
 * Unions two calibration snapshots that share no common base.
 *
 * Rows are united by id. When the same id exists on both sides with different
 * content, the local copy wins: the user's live cache is the system of record
 * and the remote side may only contribute rows the local cache lacks. Assets
 * are adopted per case — the merged asset set for a case comes entirely from
 * the side that provided that case — which preserves the case/candidate/asset
 * slot invariants that snapshot validation enforces (a divergent case would
 * otherwise mix its candidates with the other side's asset slots).
 *
 * Ordering is deterministic: merged rows keep local order, and remote-only
 * rows are appended in remote order. The merged snapshot adopts the remote
 * root metadata (format/schema identifiers), recomputes `assetBytes` when
 * present, and is validated before being returned.
 */
export function unionMergeCalibrationSnapshots(
  local: CalibrationHarnessSnapshot,
  remote: CalibrationHarnessSnapshot,
): MpcCalibrationUnionMergeResult {
  let validatedLocal: CalibrationHarnessSnapshot;
  let validatedRemote: CalibrationHarnessSnapshot;
  try {
    validatedLocal = validateCalibrationHarnessSnapshot(clone(local));
  } catch (error) {
    return fail("invalid-local-snapshot", error instanceof Error ? error.message : String(error));
  }
  try {
    validatedRemote = validateCalibrationHarnessSnapshot(clone(remote));
  } catch (error) {
    return fail("invalid-remote-snapshot", error instanceof Error ? error.message : String(error));
  }

  const datasets = unionById(validatedLocal.datasets, validatedRemote.datasets);
  const cases = unionById(validatedLocal.cases, validatedRemote.cases);
  const runs = unionById(validatedLocal.runs, validatedRemote.runs);

  const localAssetsByCase = groupAssetsByCase(validatedLocal.assets);
  const remoteAssetsByCase = groupAssetsByCase(validatedRemote.assets);
  const localCaseIds = new Set(validatedLocal.cases.map((record) => record.id));
  const mergedAssets: CalibrationHarnessSnapshot["assets"] = [];
  let addedAssets = 0;
  for (const record of cases.rows) {
    const origin = localCaseIds.has(record.id) ? localAssetsByCase : remoteAssetsByCase;
    const sourceAssets = origin.get(record.id) ?? [];
    for (const asset of sourceAssets) mergedAssets.push(clone(asset));
    if (!localCaseIds.has(record.id)) addedAssets += sourceAssets.length;
  }

  const mergedDatasets = datasets.rows as CalibrationHarnessDataset[];
  const mergedRuns = runs.rows as CalibrationHarnessRun[];
  const root: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(validatedRemote)) {
    if (!ROOT_TABLE_KEYS.has(key)) root[key] = value;
  }
  const snapshot = {
    ...root,
    version: CALIBRATION_HARNESS_FORMAT_VERSION,
    datasets: mergedDatasets,
    cases: cases.rows,
    assets: mergedAssets,
    runs: mergedRuns,
  } as CalibrationHarnessSnapshot;
  if (typeof snapshot.assetBytes === "number") {
    snapshot.assetBytes = mergedAssets.reduce((total, asset) => total + asset.byteLength, 0);
  }

  try {
    validateCalibrationHarnessSnapshot(snapshot);
  } catch (error) {
    return fail("invalid-merged-snapshot", error instanceof Error ? error.message : String(error));
  }

  return {
    ok: true,
    snapshot,
    delta: {
      datasets: datasets.added,
      cases: cases.added,
      runs: runs.added,
      assets: addedAssets,
      localWins: datasets.localWins + cases.localWins + runs.localWins,
    },
  };
}
