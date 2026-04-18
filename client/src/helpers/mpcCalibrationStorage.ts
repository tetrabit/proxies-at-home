import {
  db,
  type MpcCalibrationAssetRecord,
  type MpcCalibrationCaseRecord,
  type MpcCalibrationDatasetRecord,
  type MpcCalibrationRunRecord,
} from "@/db";
import { markMpcPreferenceSyncDirty } from "./mpcPreferenceSync";

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
  input: CreateMpcCalibrationDatasetInput
): Promise<MpcCalibrationDatasetRecord> {
  const timestamp = now();
  const dataset: MpcCalibrationDatasetRecord = {
    id: crypto.randomUUID(),
    name: input.name,
    description: input.description,
    targetCaseCount: input.targetCaseCount ?? MPC_CALIBRATION_TARGET_CASE_COUNT,
    createdAt: timestamp,
    updatedAt: timestamp,
    version: MPC_CALIBRATION_DATASET_VERSION,
  };

  await db.mpcCalibrationDatasets.add(dataset);
  return dataset;
}

export async function updateMpcCalibrationDataset(
  datasetId: string,
  updates: Partial<
    Pick<
      MpcCalibrationDatasetRecord,
      "name" | "description" | "targetCaseCount"
    >
  >
): Promise<void> {
  await db.mpcCalibrationDatasets.update(datasetId, {
    ...updates,
    updatedAt: now(),
  });
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
  }
): Promise<MpcCalibrationCaseRecord> {
  const timestamp = now();
  const existing = await db.mpcCalibrationCases.get(input.id);
  const record: MpcCalibrationCaseRecord = {
    ...input,
    createdAt: existing?.createdAt ?? input.createdAt ?? timestamp,
    updatedAt: input.updatedAt ?? timestamp,
  };

  await db.transaction(
    "rw",
    db.mpcCalibrationCases,
    db.mpcCalibrationDatasets,
    async () => {
      await db.mpcCalibrationCases.put(record);
      await db.mpcCalibrationDatasets.update(record.datasetId, {
        updatedAt: timestamp,
      });
    }
  );

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
  const expected = calibrationCase.expectedIdentifier
    ? calibrationCase.candidates.find(
        (candidate) =>
          candidate.identifier === calibrationCase.expectedIdentifier
      )
    : undefined;

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

export async function deleteMpcCalibrationCase(caseId: string): Promise<void> {
  const existing = await db.mpcCalibrationCases.get(caseId);
  if (!existing) return;

  await db.transaction(
    "rw",
    db.mpcCalibrationCases,
    db.mpcCalibrationAssets,
    db.mpcCalibrationRuns,
    db.mpcCalibrationDatasets,
    async () => {
      await db.mpcCalibrationCases.delete(caseId);

      const assetIds = await db.mpcCalibrationAssets
        .where("caseId")
        .equals(caseId)
        .primaryKeys();
      if (assetIds.length > 0) {
        await db.mpcCalibrationAssets.bulkDelete(assetIds);
      }

      const runs = await db.mpcCalibrationRuns
        .where("datasetId")
        .equals(existing.datasetId)
        .toArray();
      const affectedRunIds = runs
        .filter((run) => run.results.some((result) => result.caseId === caseId))
        .map((run) => run.id);
      if (affectedRunIds.length > 0) {
        await db.mpcCalibrationRuns.bulkDelete(affectedRunIds);
      }

      await db.mpcCalibrationDatasets.update(existing.datasetId, {
        updatedAt: now(),
      });
    }
  );

  markMpcPreferenceSyncDirty();
}

export async function saveMpcCalibrationAssets(
  assets: MpcCalibrationAssetRecord[]
): Promise<void> {
  if (assets.length === 0) return;

  await db.transaction(
    "rw",
    db.mpcCalibrationAssets,
    db.mpcCalibrationDatasets,
    async () => {
      await db.mpcCalibrationAssets.bulkPut(assets);
      await db.mpcCalibrationDatasets.update(assets[0].datasetId, {
        updatedAt: now(),
      });
    }
  );
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
  input: Omit<MpcCalibrationRunRecord, "createdAt"> & { createdAt?: number }
): Promise<MpcCalibrationRunRecord> {
  const record: MpcCalibrationRunRecord = {
    ...input,
    createdAt: input.createdAt ?? now(),
  };

  await db.transaction(
    "rw",
    db.mpcCalibrationRuns,
    db.mpcCalibrationDatasets,
    async () => {
      await db.mpcCalibrationRuns.put(record);
      await db.mpcCalibrationDatasets.update(record.datasetId, {
        updatedAt: now(),
      });
    }
  );

  return record;
}

export async function listMpcCalibrationRuns(
  datasetId: string
): Promise<MpcCalibrationRunRecord[]> {
  return db.mpcCalibrationRuns.where("datasetId").equals(datasetId).toArray();
}

export async function deleteMpcCalibrationDataset(
  datasetId: string
): Promise<void> {
  await db.transaction(
    "rw",
    db.mpcCalibrationDatasets,
    db.mpcCalibrationCases,
    db.mpcCalibrationAssets,
    db.mpcCalibrationRuns,
    async () => {
      await db.mpcCalibrationDatasets.delete(datasetId);

      const caseIds = await db.mpcCalibrationCases
        .where("datasetId")
        .equals(datasetId)
        .primaryKeys();
      if (caseIds.length > 0) {
        await db.mpcCalibrationCases.bulkDelete(caseIds);
      }

      const assetIds = await db.mpcCalibrationAssets
        .where("datasetId")
        .equals(datasetId)
        .primaryKeys();
      if (assetIds.length > 0) {
        await db.mpcCalibrationAssets.bulkDelete(assetIds);
      }

      const runIds = await db.mpcCalibrationRuns
        .where("datasetId")
        .equals(datasetId)
        .primaryKeys();
      if (runIds.length > 0) {
        await db.mpcCalibrationRuns.bulkDelete(runIds);
      }
    }
  );
}
