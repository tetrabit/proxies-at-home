import type {
  MpcCalibrationAssetRecord,
  MpcCalibrationCaseRecord,
  MpcCalibrationDatasetRecord,
  MpcCalibrationRunResult,
  MpcCalibrationRunSummary,
} from "@/db";
import {
  createSsimCompare,
  FULL_CARD_NORMALIZED_SIZE,
  rankCandidates,
  type RankedRecommendations,
  type SsimCompareFn,
} from "./mpcBulkUpgradeMatcher";

export interface MpcCalibrationAlgorithmConfig {
  id: string;
  label?: string;
  ssimCompare?: SsimCompareFn;
  artMatchCompare?: SsimCompareFn;
}

export interface MpcCalibrationCaseEvaluation {
  caseId: string;
  expectedIdentifier?: string;
  predictedIdentifier?: string;
  matched: boolean;
  selectedReason?: string;
  recommendations: RankedRecommendations;
}

export interface MpcCalibrationEvaluationResult {
  algorithmId: string;
  algorithmLabel?: string;
  summary: MpcCalibrationRunSummary;
  cases: MpcCalibrationCaseEvaluation[];
}

function createLookupCompare(
  imageUrlsByIdentifier: Map<string, string>,
  hints: Record<string, number | null>
): SsimCompareFn {
  return async (_inputSourceUrl, candidateUrl) => {
    for (const [identifier, imageUrl] of imageUrlsByIdentifier) {
      if (
        candidateUrl === imageUrl ||
        candidateUrl.startsWith(`${imageUrl}#crop=`)
      ) {
        return hints[identifier] ?? null;
      }
    }

    return null;
  };
}

function indexAssets(
  assets: MpcCalibrationAssetRecord[] | undefined,
  caseId: string
): {
  source?: MpcCalibrationAssetRecord;
  sourceArt?: MpcCalibrationAssetRecord;
  candidates: Map<string, MpcCalibrationAssetRecord>;
} {
  const scoped = assets?.filter((asset) => asset.caseId === caseId) ?? [];
  const candidates = new Map<string, MpcCalibrationAssetRecord>();
  let source: MpcCalibrationAssetRecord | undefined;
  let sourceArt: MpcCalibrationAssetRecord | undefined;

  for (const asset of scoped) {
    if (asset.role === "source") {
      source = asset;
    } else if (asset.role === "source-art") {
      sourceArt = asset;
    } else if (asset.role === "candidate-small" && asset.candidateIdentifier) {
      candidates.set(asset.candidateIdentifier, asset);
    }
  }

  return { source, sourceArt, candidates };
}

async function withResolvedCaseAssets<T>(
  calibrationCase: MpcCalibrationCaseRecord,
  assets: MpcCalibrationAssetRecord[] | undefined,
  callback: (resolved: {
    sourceImageUrl?: string;
    sourceArtImageUrl?: string;
    candidateImageUrls: Map<string, string>;
  }) => Promise<T>
): Promise<T> {
  const indexed = indexAssets(assets, calibrationCase.id);
  const revokers: string[] = [];
  const candidateImageUrls = new Map<string, string>();

  const sourceImageUrl = indexed.source
    ? (() => {
        const url = URL.createObjectURL(indexed.source.blob);
        revokers.push(url);
        return url;
      })()
    : calibrationCase.source.sourceImageUrl;

  const sourceArtImageUrl = indexed.sourceArt
    ? (() => {
        const url = URL.createObjectURL(indexed.sourceArt.blob);
        revokers.push(url);
        return url;
      })()
    : calibrationCase.source.sourceArtImageUrl;

  for (const candidate of calibrationCase.candidates) {
    const asset = indexed.candidates.get(candidate.identifier);
    if (asset) {
      const url = URL.createObjectURL(asset.blob);
      revokers.push(url);
      candidateImageUrls.set(candidate.identifier, url);
    } else {
      candidateImageUrls.set(candidate.identifier, candidate.imageUrl);
    }
  }

  try {
    return await callback({
      sourceImageUrl,
      sourceArtImageUrl,
      candidateImageUrls,
    });
  } finally {
    for (const url of revokers) {
      URL.revokeObjectURL(url);
    }
  }
}

export async function evaluateMpcCalibrationCase(
  calibrationCase: MpcCalibrationCaseRecord,
  config: MpcCalibrationAlgorithmConfig,
  assets?: MpcCalibrationAssetRecord[]
): Promise<MpcCalibrationCaseEvaluation> {
  return withResolvedCaseAssets(calibrationCase, assets, async (resolved) => {
    const imageUrlsByIdentifier = resolved.candidateImageUrls;
    const fullCompare =
      config.ssimCompare ??
      (calibrationCase.comparisonHints?.fullCard
        ? createLookupCompare(
            imageUrlsByIdentifier,
            calibrationCase.comparisonHints.fullCard
          )
        : createSsimCompare(undefined, FULL_CARD_NORMALIZED_SIZE));

    const artCompare =
      config.artMatchCompare ??
      (calibrationCase.comparisonHints?.artMatch
        ? createLookupCompare(
            imageUrlsByIdentifier,
            calibrationCase.comparisonHints.artMatch
          )
        : createSsimCompare());

    const recommendations = await rankCandidates({
      candidates: calibrationCase.candidates,
      set: calibrationCase.source.set,
      collectorNumber: calibrationCase.source.collectorNumber,
      sourceImageUrl: resolved.sourceImageUrl,
      ssimCompare: fullCompare,
      artMatchCompare: artCompare,
      getMpcImageUrl: (identifier) =>
        imageUrlsByIdentifier.get(identifier) ?? "",
    });

    const selected = recommendations.fullProcess[0];

    return {
      caseId: calibrationCase.id,
      expectedIdentifier: calibrationCase.expectedIdentifier,
      predictedIdentifier: selected?.card.identifier,
      matched:
        Boolean(calibrationCase.expectedIdentifier) &&
        selected?.card.identifier === calibrationCase.expectedIdentifier,
      selectedReason: selected?.reason,
      recommendations,
    };
  });
}

export async function evaluateMpcCalibrationDataset(
  _dataset: MpcCalibrationDatasetRecord,
  cases: MpcCalibrationCaseRecord[],
  config: MpcCalibrationAlgorithmConfig,
  assets?: MpcCalibrationAssetRecord[]
): Promise<MpcCalibrationEvaluationResult> {
  const evaluations: MpcCalibrationCaseEvaluation[] = [];

  for (const calibrationCase of cases) {
    evaluations.push(
      await evaluateMpcCalibrationCase(calibrationCase, config, assets)
    );
  }

  const matchedCases = evaluations.filter((item) => item.matched).length;
  const summary: MpcCalibrationRunSummary = {
    totalCases: cases.length,
    matchedCases,
    mismatchedCases: cases.length - matchedCases,
    accuracy: cases.length === 0 ? 0 : matchedCases / cases.length,
  };

  return {
    algorithmId: config.id,
    algorithmLabel: config.label,
    summary,
    cases: evaluations,
  };
}

export function toMpcCalibrationRunResults(
  evaluations: MpcCalibrationCaseEvaluation[]
): MpcCalibrationRunResult[] {
  return evaluations.map((evaluation) => ({
    caseId: evaluation.caseId,
    expectedIdentifier: evaluation.expectedIdentifier,
    predictedIdentifier: evaluation.predictedIdentifier,
    matched: evaluation.matched,
    selectedReason: evaluation.selectedReason,
    fullProcessIdentifier:
      evaluation.recommendations.fullProcess[0]?.card.identifier,
    artMatchIdentifier: evaluation.recommendations.artMatch[0]?.card.identifier,
    exactPrintingIdentifier:
      evaluation.recommendations.exactPrinting[0]?.card.identifier,
    fullCardIdentifier: evaluation.recommendations.fullCard[0]?.card.identifier,
  }));
}
