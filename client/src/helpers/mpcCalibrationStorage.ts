import {
  db,
  type MpcCalibrationAssetRecord,
  type MpcCalibrationCaseRecord,
  type MpcCalibrationDatasetRecord,
  type MpcCalibrationRunRecord,
} from "@/db";

export const MPC_CALIBRATION_DATASET_VERSION = 1;
export const MPC_CALIBRATION_TARGET_CASE_COUNT = 9;

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
