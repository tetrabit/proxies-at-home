import {
  db,
  type MpcCalibrationAssetRecord,
  type MpcCalibrationCaseRecord,
  type MpcCalibrationDatasetRecord,
  type MpcCalibrationRunRecord,
} from "@/db";
import {
  CALIBRATION_HARNESS_LIMITS,
} from "../../../shared/calibrationHarness";
import { markMpcPreferenceSyncDirty } from "./mpcPreferenceSync";
import {
  createMpcCalibrationMutationCoordinator,
  MpcCalibrationMutationError,
  type MpcCalibrationMutationScope,
} from "./mpcCalibrationMutations";

export type { MpcCalibrationMutationScope } from "./mpcCalibrationMutations";
const mpcCalibrationMutations = createMpcCalibrationMutationCoordinator(db);

/** Captures the non-secret physical-cache fence before caller-owned awaits. */
export function captureMpcCalibrationMutationScope(): Promise<MpcCalibrationMutationScope> {
  return mpcCalibrationMutations.captureScope();
}

export const MPC_CALIBRATION_DATASET_VERSION = 1;
export const MPC_CALIBRATION_TARGET_CASE_COUNT = 9;
export const MPC_CALIBRATION_DEFAULT_DATASET_NAME = "MPC Calibration Harness";

export interface MpcCalibrationPreferenceProfile {
  sourceName?: string;
  tags: string[];
  rawName: string;
  hasBracketSet: boolean;
  parenText?: string;
}

export interface CreateMpcCalibrationDatasetInput {
  name: string;
  description?: string;
  targetCaseCount?: number;
}

function now() {
  return Date.now();
}

export async function createMpcCalibrationDataset(
  input: CreateMpcCalibrationDatasetInput,
  scope?: MpcCalibrationMutationScope
): Promise<MpcCalibrationDatasetRecord> {
  const capturedInput = structuredClone(input);
  const timestamp = now();
  const dataset: MpcCalibrationDatasetRecord = {
    id: crypto.randomUUID(),
    name: capturedInput.name,
    description: capturedInput.description,
    targetCaseCount: capturedInput.targetCaseCount ?? MPC_CALIBRATION_TARGET_CASE_COUNT,
    createdAt: timestamp,
    updatedAt: timestamp,
    version: MPC_CALIBRATION_DATASET_VERSION,
  };

  await mpcCalibrationMutations.mutate(async () => {
    await db.mpcCalibrationDatasets.add(dataset);
    return { value: undefined, changed: true };
  }, scope);
  return dataset;
}

export async function updateMpcCalibrationDataset(
  datasetId: string,
  updates: Partial<
    Pick<
      MpcCalibrationDatasetRecord,
      "name" | "description" | "targetCaseCount"
    >
  >,
  scope?: MpcCalibrationMutationScope
): Promise<void> {
  const capturedUpdates = structuredClone(updates);
  await mpcCalibrationMutations.mutate(async () => {
    const existing = await db.mpcCalibrationDatasets.get(datasetId);
    if (existing === undefined) return { value: undefined, changed: false };
    const changed = Object.entries(capturedUpdates).some(([key, value]) =>
      existing[key as keyof typeof updates] !== value
    );
    if (!changed) return { value: undefined, changed: false };
    await db.mpcCalibrationDatasets.update(datasetId, {
      ...capturedUpdates,
      updatedAt: now(),
    });
    return { value: undefined, changed: true };
  }, scope);
}

export async function getMpcCalibrationDataset(
  datasetId: string
): Promise<MpcCalibrationDatasetRecord | undefined> {
  return db.mpcCalibrationDatasets.get(datasetId);
}

export async function listMpcCalibrationDatasets(): Promise<
  MpcCalibrationDatasetRecord[]
> {
  return db.mpcCalibrationDatasets.orderBy("updatedAt").reverse().toArray();
}

export async function saveMpcCalibrationCase(
  input: Omit<MpcCalibrationCaseRecord, "createdAt" | "updatedAt"> & {
    createdAt?: number;
    updatedAt?: number;
  },
  scope?: MpcCalibrationMutationScope
): Promise<MpcCalibrationCaseRecord> {
  const capturedInput = structuredClone(input);
  const timestamp = now();
  const record = await mpcCalibrationMutations.mutate(async () => {
    const existing = await db.mpcCalibrationCases.get(capturedInput.id);
    const next: MpcCalibrationCaseRecord = {
      ...capturedInput,
      createdAt: existing?.createdAt ?? capturedInput.createdAt ?? timestamp,
      updatedAt: capturedInput.updatedAt ?? timestamp,
    };
    await db.mpcCalibrationCases.put(next);
    await db.mpcCalibrationDatasets.update(next.datasetId, { updatedAt: timestamp });
    return { value: next, changed: true };
  }, scope);
  markMpcPreferenceSyncDirty();
  return record;
}

/** Saves a case and its complete asset set under one queue generation. */
export async function saveMpcCalibrationCaseWithAssets(
  input: Parameters<typeof saveMpcCalibrationCase>[0],
  assets: readonly MpcCalibrationAssetRecord[],
  scope?: MpcCalibrationMutationScope
): Promise<MpcCalibrationCaseRecord> {
  const capturedInput = structuredClone(input);
  const capturedAssets = structuredClone(assets);
  // Pre-calculate SHA-256 for assets serially outside of the Dexie transaction
  for (const asset of capturedAssets) {
    if (asset.blob.size > CALIBRATION_HARNESS_LIMITS.maxAssetBytes) {
      throw new MpcCalibrationMutationError("local blob exceeds the per-asset limit");
    }
    const raw = asset as MpcCalibrationAssetRecord & { sha256?: string; byteLength?: number };
    if (!raw.sha256 || raw.byteLength !== asset.blob.size) {
      const buffer = await asset.blob.arrayBuffer();
      const digest = await crypto.subtle.digest("SHA-256", buffer);
      raw.sha256 = Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, "0")
      ).join("");
      raw.byteLength = asset.blob.size;
    }
  }

  const timestamp = now();
  const record = await mpcCalibrationMutations.mutate(async () => {
    if (capturedAssets.some((asset) => asset.datasetId !== capturedInput.datasetId || asset.caseId !== capturedInput.id)) {
      throw new Error("grouped calibration assets must belong to the saved case");
    }
    const existing = await db.mpcCalibrationCases.get(capturedInput.id);
    const next: MpcCalibrationCaseRecord = {
      ...capturedInput,
      createdAt: existing?.createdAt ?? capturedInput.createdAt ?? timestamp,
      updatedAt: capturedInput.updatedAt ?? timestamp,
    };
    await db.mpcCalibrationCases.put(next);
    if (capturedAssets.length > 0) {
      await db.mpcCalibrationAssets.bulkPut(capturedAssets);
    }
    await db.mpcCalibrationDatasets.update(next.datasetId, { updatedAt: timestamp });
    return { value: next, changed: true };
  }, scope);
  markMpcPreferenceSyncDirty();
  return record;
}

export async function getMpcCalibrationCase(
  caseId: string
): Promise<MpcCalibrationCaseRecord | undefined> {
  return db.mpcCalibrationCases.get(caseId);
}

export async function listMpcCalibrationCases(
  datasetId: string
): Promise<MpcCalibrationCaseRecord[]> {
  return db.mpcCalibrationCases.where("datasetId").equals(datasetId).toArray();
}

export async function listDefaultMpcCalibrationCases(): Promise<
  MpcCalibrationCaseRecord[]
> {
  if (!db.mpcCalibrationDatasets || !db.mpcCalibrationCases) {
    return [];
  }

  const datasets = await listMpcCalibrationDatasets();
  const calibrationDatasets = datasets.filter(
    (dataset) => dataset.name === MPC_CALIBRATION_DEFAULT_DATASET_NAME
  );

  const cases = await Promise.all(
    calibrationDatasets.map((dataset) => listMpcCalibrationCases(dataset.id))
  );

  return cases.flat();
}

export async function getMpcCalibrationPreferredIdentifier(input: {
  name: string;
  set?: string;
  collectorNumber?: string;
}): Promise<string | undefined> {
  if (!db.mpcCalibrationDatasets || !db.mpcCalibrationCases) {
    return undefined;
  }

  const datasets = await listMpcCalibrationDatasets();
  const calibrationDatasets = datasets.filter(
    (dataset) => dataset.name === MPC_CALIBRATION_DEFAULT_DATASET_NAME
  );

  for (const dataset of calibrationDatasets) {
    const cases = await listMpcCalibrationCases(dataset.id);
    const exact = cases.find(
      (calibrationCase) =>
        calibrationCase.expectedIdentifier &&
        calibrationCase.source.name === input.name &&
        calibrationCase.source.set === input.set &&
        calibrationCase.source.collectorNumber === input.collectorNumber
    );
    if (exact?.expectedIdentifier) {
      return exact.expectedIdentifier;
    }

    const byName = cases.find(
      (calibrationCase) =>
        calibrationCase.expectedIdentifier &&
        calibrationCase.source.name === input.name
    );
    if (byName?.expectedIdentifier) {
      return byName.expectedIdentifier;
    }
  }

  return undefined;
}

function toPreferenceProfile(
  calibrationCase: MpcCalibrationCaseRecord
): MpcCalibrationPreferenceProfile | undefined {
  const expected = calibrationCase.candidates.find(
    (candidate) => candidate.identifier === calibrationCase.expectedIdentifier
  );

  if (!expected) {
    return undefined;
  }

  const rawName = expected.rawName ?? expected.name;
  const parenText = rawName.match(/\(([^)]+)\)/)?.[1]?.toLowerCase();

  return {
    sourceName: expected.sourceName,
    tags: expected.tags,
    rawName,
    hasBracketSet: /\[[^\]]+\]\s*\{[^}]+\}/.test(rawName),
    parenText,
  };
}

export async function getMpcCalibrationPreferenceProfile(input: {
  name: string;
  set?: string;
  collectorNumber?: string;
}): Promise<MpcCalibrationPreferenceProfile | undefined> {
  if (!db.mpcCalibrationDatasets || !db.mpcCalibrationCases) {
    return undefined;
  }

  const datasets = await listMpcCalibrationDatasets();
  const calibrationDatasets = datasets.filter(
    (dataset) => dataset.name === MPC_CALIBRATION_DEFAULT_DATASET_NAME
  );

  for (const dataset of calibrationDatasets) {
    const cases = await listMpcCalibrationCases(dataset.id);
    const exact = cases.find(
      (calibrationCase) =>
        calibrationCase.expectedIdentifier &&
        calibrationCase.source.name === input.name &&
        calibrationCase.source.set === input.set &&
        calibrationCase.source.collectorNumber === input.collectorNumber
    );
    const exactProfile = exact ? toPreferenceProfile(exact) : undefined;
    if (exactProfile) {
      return exactProfile;
    }

    const byName = cases.find(
      (calibrationCase) =>
        calibrationCase.expectedIdentifier &&
        calibrationCase.source.name === input.name
    );
    const byNameProfile = byName ? toPreferenceProfile(byName) : undefined;
    if (byNameProfile) {
      return byNameProfile;
    }
  }

  return undefined;
}

export async function deleteMpcCalibrationCase(
  caseId: string,
  scope?: MpcCalibrationMutationScope
): Promise<void> {
  const changed = await mpcCalibrationMutations.mutate(async () => {
    const existing = await db.mpcCalibrationCases.get(caseId);
    if (existing === undefined) return { value: false, changed: false };
    await db.mpcCalibrationCases.delete(caseId);
    const assetIds = await db.mpcCalibrationAssets.where("caseId").equals(caseId).primaryKeys();
    if (assetIds.length > 0) await db.mpcCalibrationAssets.bulkDelete(assetIds);
    const runs = await db.mpcCalibrationRuns.where("datasetId").equals(existing.datasetId).toArray();
    const affectedRunIds = runs.filter((run) => run.results.some((result) => result.caseId === caseId)).map((run) => run.id);
    if (affectedRunIds.length > 0) await db.mpcCalibrationRuns.bulkDelete(affectedRunIds);
    await db.mpcCalibrationDatasets.update(existing.datasetId, { updatedAt: now() });
    return { value: true, changed: true };
  }, scope);
  if (changed) markMpcPreferenceSyncDirty();
}

export async function saveMpcCalibrationAssets(
  assets: MpcCalibrationAssetRecord[],
  scope?: MpcCalibrationMutationScope
): Promise<void> {
  const capturedAssets = structuredClone(assets);
  if (capturedAssets.length === 0) return;
  for (const asset of capturedAssets) {
    if (asset.blob.size > CALIBRATION_HARNESS_LIMITS.maxAssetBytes) {
      throw new MpcCalibrationMutationError("local blob exceeds the per-asset limit");
    }
  }
  await mpcCalibrationMutations.mutate(async () => {
    await db.mpcCalibrationAssets.bulkPut(capturedAssets);
    await db.mpcCalibrationDatasets.update(capturedAssets[0]!.datasetId, { updatedAt: now() });
    return { value: undefined, changed: true };
  }, scope);
}

export async function listMpcCalibrationAssets(
  datasetId: string,
  caseId?: string
): Promise<MpcCalibrationAssetRecord[]> {
  const assets = await db.mpcCalibrationAssets
    .where("datasetId")
    .equals(datasetId)
    .toArray();

  if (!caseId) {
    return assets;
  }

  return assets.filter((asset) => asset.caseId === caseId);
}

export async function saveMpcCalibrationRun(
  input: Omit<MpcCalibrationRunRecord, "createdAt"> & { createdAt?: number },
  scope?: MpcCalibrationMutationScope
): Promise<MpcCalibrationRunRecord> {
  const capturedInput = structuredClone(input);
  const record: MpcCalibrationRunRecord = {
    ...capturedInput,
    createdAt: capturedInput.createdAt ?? now(),
  };
  return mpcCalibrationMutations.mutate(async () => {
    await db.mpcCalibrationRuns.put(record);
    await db.mpcCalibrationDatasets.update(record.datasetId, { updatedAt: now() });
    return { value: record, changed: true };
  }, scope);
}

export async function listMpcCalibrationRuns(
  datasetId: string
): Promise<MpcCalibrationRunRecord[]> {
  return db.mpcCalibrationRuns.where("datasetId").equals(datasetId).toArray();
}

export async function deleteMpcCalibrationDataset(
  datasetId: string,
  scope?: MpcCalibrationMutationScope
): Promise<void> {
  await mpcCalibrationMutations.mutate(async () => {
    const existing = await db.mpcCalibrationDatasets.get(datasetId);
    if (existing === undefined) return { value: undefined, changed: false };
    await db.mpcCalibrationDatasets.delete(datasetId);
    const caseIds = await db.mpcCalibrationCases.where("datasetId").equals(datasetId).primaryKeys();
    if (caseIds.length > 0) await db.mpcCalibrationCases.bulkDelete(caseIds);
    const assetIds = await db.mpcCalibrationAssets.where("datasetId").equals(datasetId).primaryKeys();
    if (assetIds.length > 0) await db.mpcCalibrationAssets.bulkDelete(assetIds);
    const runIds = await db.mpcCalibrationRuns.where("datasetId").equals(datasetId).primaryKeys();
    if (runIds.length > 0) await db.mpcCalibrationRuns.bulkDelete(runIds);
    return { value: undefined, changed: true };
  }, scope);
}
