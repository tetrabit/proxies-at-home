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
import {
  buildMpcPreferenceScoreMap,
  trainMpcPreferenceModel,
  type MpcPreferenceTrainingOptions,
} from "./mpcPreferenceModel";
import {
  BOOTSTRAP_PREFERENCE_SEED_CARD_NAMES,
  harvestSourcePreferenceCandidates,
} from "./mpcPreferenceBootstrap";
import {
  buildMpcSourceVisualProfiles,
  buildMpcVisualPreferenceScoreMap,
} from "./mpcVisualPreference";
import { searchMpcAutofill } from "./mpcAutofillApi";

export interface MpcCalibrationAlgorithmConfig {
  id: string;
  label?: string;
  ssimCompare?: SsimCompareFn;
  artMatchCompare?: SsimCompareFn;
  usePreferenceProfile?: boolean;
}

function buildPreferenceProfileFromCase(
  calibrationCase: MpcCalibrationCaseRecord
) {
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

  return {
    sourceName: expected.sourceName,
    tags: expected.tags,
    rawName,
    hasBracketSet: /\[[^\]]+\]\s*\{[^}]+\}/.test(rawName),
    parenText: rawName.match(/\(([^)]+)\)/)?.[1]?.toLowerCase(),
  };
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

export async function evaluateHeldOutCalibrationDataset(
  _dataset: MpcCalibrationDatasetRecord,
  cases: MpcCalibrationCaseRecord[],
  options: MpcPreferenceTrainingOptions = {}
): Promise<MpcCalibrationEvaluationResult> {
  const evaluations: MpcCalibrationCaseEvaluation[] = [];

  for (const heldOutCase of cases) {
    if (!heldOutCase.expectedIdentifier || heldOutCase.candidates.length < 2) {
      continue;
    }

    const trainSet = cases.filter(
      (candidate) => candidate.id !== heldOutCase.id
    );
    const model = trainMpcPreferenceModel(trainSet, options);
    if (!model) {
      continue;
    }

    const metadataScores = buildMpcPreferenceScoreMap(
      model,
      heldOutCase.candidates
    );
    const harvested = await harvestSourcePreferenceCandidates(
      BOOTSTRAP_PREFERENCE_SEED_CARD_NAMES,
      async (name) => searchMpcAutofill(name, "CARD", true),
      options.emphasizedSources
    );
    const profiles = await buildMpcSourceVisualProfiles(harvested);
    const visualScores = await buildMpcVisualPreferenceScoreMap(
      heldOutCase.candidates,
      profiles,
      model
    );
    const unseenPreferenceScores = Object.fromEntries(
      heldOutCase.candidates.map((candidate) => [
        candidate.identifier,
        (metadataScores[candidate.identifier] ?? 0) +
          (visualScores[candidate.identifier] ?? 0),
      ])
    );
    const recommendations = await rankCandidates({
      candidates: heldOutCase.candidates,
      set: heldOutCase.source.set,
      collectorNumber: heldOutCase.source.collectorNumber,
      unseenPreferenceScores,
    });
    const selected = recommendations.fullProcess[0];

    evaluations.push({
      caseId: heldOutCase.id,
      expectedIdentifier: heldOutCase.expectedIdentifier,
      predictedIdentifier: selected?.card.identifier,
      matched:
        Boolean(heldOutCase.expectedIdentifier) &&
        selected?.card.identifier === heldOutCase.expectedIdentifier,
      selectedReason: selected?.reason,
      recommendations,
    });
  }

  const matchedCases = evaluations.filter((item) => item.matched).length;
  return {
    algorithmId: "held-out-unseen",
    algorithmLabel: "Held-out unseen predictor",
    summary: {
      totalCases: evaluations.length,
      matchedCases,
      mismatchedCases: evaluations.length - matchedCases,
      accuracy:
        evaluations.length === 0 ? 0 : matchedCases / evaluations.length,
    },
    cases: evaluations,
  };
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
  const preferredIdentifier =
    config.usePreferenceProfile === false
      ? undefined
      : calibrationCase.expectedIdentifier;
  const preferenceProfile =
    config.usePreferenceProfile === false
      ? undefined
      : buildPreferenceProfileFromCase(calibrationCase);

  if (preferredIdentifier || preferenceProfile) {
    const recommendations = await rankCandidates({
      candidates: calibrationCase.candidates,
      set: calibrationCase.source.set,
      collectorNumber: calibrationCase.source.collectorNumber,
      preferredIdentifier,
      preferenceProfile,
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
  }

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
