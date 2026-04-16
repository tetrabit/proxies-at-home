import type {
  Image,
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

  if (source.sourceImageUrl) {
    const { blob, mimeType } = await fetchAssetBlob(source.sourceImageUrl);
    assets.push({
      id: crypto.randomUUID(),
      datasetId: input.datasetId,
      caseId,
      role: "source",
      sourceUrl: source.sourceImageUrl,
      mimeType,
      blob,
      createdAt,
    });
  }

  if (source.sourceArtImageUrl) {
    const { blob, mimeType } = await fetchAssetBlob(source.sourceArtImageUrl);
    assets.push({
      id: crypto.randomUUID(),
      datasetId: input.datasetId,
      caseId,
      role: "source-art",
      sourceUrl: source.sourceArtImageUrl,
      mimeType,
      blob,
      createdAt,
    });
  }

  for (const candidate of candidates) {
    const { blob, mimeType } = await fetchAssetBlob(candidate.imageUrl);
    assets.push({
      id: crypto.randomUUID(),
      datasetId: input.datasetId,
      caseId,
      role: "candidate-small",
      candidateIdentifier: candidate.identifier,
      sourceUrl: candidate.imageUrl,
      mimeType,
      blob,
      createdAt,
    });
  }

  return { caseRecord, assets };
}
