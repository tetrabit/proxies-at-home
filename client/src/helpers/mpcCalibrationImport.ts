import type {
  MpcCalibrationAssetRecord,
  MpcCalibrationCaseRecord,
  MpcCalibrationDatasetRecord,
  MpcCalibrationRunRecord,
} from "@/db";
import { db } from "@/db";
import {
  getMpcCalibrationDataset,
  listMpcCalibrationAssets,
  listMpcCalibrationCases,
  listMpcCalibrationRuns,
  saveMpcCalibrationAssets,
  saveMpcCalibrationCase,
  saveMpcCalibrationRun,
} from "./mpcCalibrationStorage";

export const MPC_CALIBRATION_FIXTURE_VERSION = 1;

export interface SerializedMpcCalibrationAsset {
  id: string;
  datasetId: string;
  caseId: string;
  role: MpcCalibrationAssetRecord["role"];
  candidateIdentifier?: string;
  sourceUrl?: string;
  mimeType: string;
  data: string;
  createdAt: number;
  hash?: string;
}

export interface MpcCalibrationFixture {
  version: number;
  exportedAt: string;
  dataset: MpcCalibrationDatasetRecord;
  cases: MpcCalibrationCaseRecord[];
  assets: SerializedMpcCalibrationAsset[];
  runs: MpcCalibrationRunRecord[];
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Response(blob)
    .arrayBuffer()
    .then((buffer) => Buffer.from(buffer).toString("base64"));
}

function base64ToBlob(base64: string, mimeType: string): Blob {
  const byteChars = atob(base64);
  const bytes = new Uint8Array(byteChars.length);
  for (let index = 0; index < byteChars.length; index += 1) {
    bytes[index] = byteChars.charCodeAt(index);
  }
  return new Blob([bytes], { type: mimeType });
}

export async function buildMpcCalibrationFixture(
  datasetId: string
): Promise<MpcCalibrationFixture> {
  const dataset = await getMpcCalibrationDataset(datasetId);
  if (!dataset) {
    throw new Error(`Calibration dataset ${datasetId} not found`);
  }

  const [cases, assets, runs] = await Promise.all([
    listMpcCalibrationCases(datasetId),
    listMpcCalibrationAssets(datasetId),
    listMpcCalibrationRuns(datasetId),
  ]);

  const serializedAssets = await Promise.all(
    assets.map(async (asset) => ({
      id: asset.id,
      datasetId: asset.datasetId,
      caseId: asset.caseId,
      role: asset.role,
      candidateIdentifier: asset.candidateIdentifier,
      sourceUrl: asset.sourceUrl,
      mimeType: asset.mimeType,
      data: await blobToBase64(asset.blob),
      createdAt: asset.createdAt,
      hash: asset.hash,
    }))
  );

  return {
    version: MPC_CALIBRATION_FIXTURE_VERSION,
    exportedAt: new Date().toISOString(),
    dataset,
    cases,
    assets: serializedAssets,
    runs,
  };
}

export function validateMpcCalibrationFixture(
  data: unknown
): MpcCalibrationFixture {
  if (!data || typeof data !== "object") {
    throw new Error("Invalid calibration fixture: not a JSON object");
  }

  const fixture = data as Partial<MpcCalibrationFixture>;
  if (typeof fixture.version !== "number") {
    throw new Error("Invalid calibration fixture: missing version");
  }

  if (fixture.version > MPC_CALIBRATION_FIXTURE_VERSION) {
    throw new Error("Unsupported calibration fixture version");
  }

  if (
    !fixture.dataset ||
    !Array.isArray(fixture.cases) ||
    !Array.isArray(fixture.assets) ||
    !Array.isArray(fixture.runs)
  ) {
    throw new Error("Invalid calibration fixture: missing dataset sections");
  }

  return fixture as MpcCalibrationFixture;
}

export function downloadMpcCalibrationFixture(
  fixture: MpcCalibrationFixture
): void {
  const blob = new Blob([JSON.stringify(fixture, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  const safeName = fixture.dataset.name.replace(/[^a-zA-Z0-9_-]/g, "_");
  anchor.href = url;
  anchor.download = `mpc-calibration_${safeName}.json`;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function importMpcCalibrationFixture(
  fixture: MpcCalibrationFixture
): Promise<string> {
  const validFixture = validateMpcCalibrationFixture(fixture);

  await db.mpcCalibrationDatasets.put(validFixture.dataset);
  await Promise.all(
    validFixture.cases.map((calibrationCase) =>
      saveMpcCalibrationCase(calibrationCase)
    )
  );
  await saveMpcCalibrationAssets(
    validFixture.assets.map((asset) => ({
      id: asset.id,
      datasetId: asset.datasetId,
      caseId: asset.caseId,
      role: asset.role,
      candidateIdentifier: asset.candidateIdentifier,
      sourceUrl: asset.sourceUrl,
      mimeType: asset.mimeType,
      blob: base64ToBlob(asset.data, asset.mimeType),
      createdAt: asset.createdAt,
      hash: asset.hash,
    }))
  );
  await Promise.all(validFixture.runs.map((run) => saveMpcCalibrationRun(run)));

  return validFixture.dataset.id;
}
