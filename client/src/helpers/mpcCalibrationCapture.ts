import type {
  Image,
  MpcCalibrationAssetRole,
  MpcCalibrationAssetRecord,
  MpcCalibrationCaseRecord,
  MpcCalibrationFrozenCandidate,
  MpcCalibrationSourceCardSnapshot,
} from "@/db";
import type { CardOption } from "@/types";
import { getMpcAutofillImageUrl, type MpcAutofillCard } from "./mpcAutofillApi";
import { toArtCrop, toProxied } from "./imageHelper";

export interface CaptureMpcCalibrationCaseInput {
  datasetId: string;
  card: CardOption;
  imageRecord?: Image | null;
  candidates: MpcAutofillCard[];
  expectedIdentifier?: string;
  notes?: string;
  candidateImageSize?: "small" | "large" | "full";
}

export interface CapturedMpcCalibrationCase {
  caseRecord: MpcCalibrationCaseRecord;
  assets: MpcCalibrationAssetRecord[];
  assetErrors: MpcCalibrationAssetError[];
}

export interface MpcCalibrationAssetError {
  role: MpcCalibrationAssetRole;
  sourceUrl: string;
  candidateIdentifier?: string;
  message: string;
}

function createSourceSnapshot(
  card: CardOption,
  imageRecord?: Image | null
): MpcCalibrationSourceCardSnapshot {
  const sourceImageUrl =
    imageRecord?.sourceUrl || imageRecord?.imageUrls?.[0] || undefined;
  const sourceArtImageUrl = sourceImageUrl ? toArtCrop(sourceImageUrl) : null;

  return {
    cardUuid: card.uuid,
    projectId: card.projectId,
    imageId: card.imageId,
    name: card.name,
    set: card.set,
    collectorNumber: card.number,
    sourceImageUrl,
    sourceArtImageUrl: sourceArtImageUrl ?? undefined,
  };
}

function freezeCandidate(
  card: MpcAutofillCard,
  size: "small" | "large" | "full"
): MpcCalibrationFrozenCandidate {
  return {
    identifier: card.identifier,
    name: card.name,
    rawName: card.rawName,
    smallThumbnailUrl: card.smallThumbnailUrl,
    mediumThumbnailUrl: card.mediumThumbnailUrl,
    imageUrl: getMpcAutofillImageUrl(card.identifier, size),
    dpi: card.dpi,
    tags: card.tags,
    sourceName: card.sourceName,
    source: card.source,
    extension: card.extension,
    size: card.size,
  };
}

async function fetchAssetBlob(
  url: string
): Promise<{ blob: Blob; mimeType: string }> {
  const response = await fetch(toProxied(url));
  if (!response.ok) {
    throw new Error(`Failed to fetch calibration asset: ${response.status}`);
  }

  const blob = await response.blob();
  return {
    blob,
    mimeType: blob.type || "application/octet-stream",
  };
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function tryAppendAsset(
  assets: MpcCalibrationAssetRecord[],
  assetErrors: MpcCalibrationAssetError[],
  input: {
    datasetId: string;
    caseId: string;
    role: MpcCalibrationAssetRole;
    sourceUrl: string;
    createdAt: number;
    candidateIdentifier?: string;
  }
) {
  try {
    const { blob, mimeType } = await fetchAssetBlob(input.sourceUrl);
    assets.push({
      id: crypto.randomUUID(),
      datasetId: input.datasetId,
      caseId: input.caseId,
      role: input.role,
      candidateIdentifier: input.candidateIdentifier,
      sourceUrl: input.sourceUrl,
      mimeType,
      blob,
      createdAt: input.createdAt,
    });
  } catch (error) {
    assetErrors.push({
      role: input.role,
      candidateIdentifier: input.candidateIdentifier,
      sourceUrl: input.sourceUrl,
      message: getErrorMessage(error),
    });
  }
}

export async function captureMpcCalibrationCase(
  input: CaptureMpcCalibrationCaseInput
): Promise<CapturedMpcCalibrationCase> {
  const caseId = crypto.randomUUID();
  const createdAt = Date.now();
  const candidateImageSize = input.candidateImageSize ?? "small";
  const source = createSourceSnapshot(input.card, input.imageRecord);
  const candidates = input.candidates.map((candidate) =>
    freezeCandidate(candidate, candidateImageSize)
  );

  const caseRecord: MpcCalibrationCaseRecord = {
    id: caseId,
    datasetId: input.datasetId,
    createdAt,
    updatedAt: createdAt,
    source,
    candidates,
    expectedIdentifier: input.expectedIdentifier,
    notes: input.notes,
  };

  const assets: MpcCalibrationAssetRecord[] = [];
  const assetErrors: MpcCalibrationAssetError[] = [];

  if (source.sourceImageUrl) {
    await tryAppendAsset(assets, assetErrors, {
      datasetId: input.datasetId,
      caseId,
      role: "source",
      sourceUrl: source.sourceImageUrl,
      createdAt,
    });
  }

  if (source.sourceArtImageUrl) {
    await tryAppendAsset(assets, assetErrors, {
      datasetId: input.datasetId,
      caseId,
      role: "source-art",
      sourceUrl: source.sourceArtImageUrl,
      createdAt,
    });
  }

  for (const candidate of candidates) {
    await tryAppendAsset(assets, assetErrors, {
      datasetId: input.datasetId,
      caseId,
      role: "candidate-small",
      candidateIdentifier: candidate.identifier,
      sourceUrl: candidate.imageUrl,
      createdAt,
    });
  }

  return { caseRecord, assets, assetErrors };
}
