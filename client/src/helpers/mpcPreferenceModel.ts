import type {
  MpcCalibrationCaseRecord,
  MpcCalibrationFrozenCandidate,
} from "@/db";

type PreferenceCandidate = Pick<
  MpcCalibrationFrozenCandidate,
  "identifier" | "name" | "rawName" | "dpi" | "tags" | "sourceName"
>;

export interface MpcPreferenceTrainingOptions {
  emphasizedSources?: string[];
  minCaseCount?: number;
}

export interface MpcBootstrappedSourceExample {
  caseId: string;
  cardName: string;
  expectedIdentifier?: string;
  sources: string[];
  emphasizedSourcesPresent: string[];
}

export interface MpcPreferenceModel {
  bias: number;
  sourceWeights: Record<string, number>;
  tagWeights: Record<string, number>;
  formatWeights: {
    hasBracketSet: number;
    hasParenText: number;
    plainName: number;
    dpi: number;
  };
  trainingCaseCount: number;
}

export interface MpcPreferencePrediction {
  candidate: PreferenceCandidate;
  score: number;
}

const DEFAULT_EMPHASIZED_SOURCES = ["Hathwellcrisping", "Chilli_Axe"];

function ensureWeight(map: Record<string, number>, key: string): number {
  return map[key] ?? 0;
}

function addWeight(map: Record<string, number>, key: string, delta: number) {
  map[key] = ensureWeight(map, key) + delta;
}

export function buildBootstrappedSourcePreferenceDataset(
  calibrationCases: MpcCalibrationCaseRecord[],
  emphasizedSources: string[] = DEFAULT_EMPHASIZED_SOURCES
): MpcBootstrappedSourceExample[] {
  const emphasized = new Set(emphasizedSources);

  return calibrationCases
    .map((calibrationCase) => {
      const sources = [
        ...new Set(
          calibrationCase.candidates.map((candidate) => candidate.sourceName)
        ),
      ]
        .filter(Boolean)
        .sort();
      const emphasizedSourcesPresent = sources.filter((source) =>
        emphasized.has(source)
      );

      return {
        caseId: calibrationCase.id,
        cardName: calibrationCase.source.name,
        expectedIdentifier: calibrationCase.expectedIdentifier,
        sources,
        emphasizedSourcesPresent,
      };
    })
    .filter((example) => example.emphasizedSourcesPresent.length > 0);
}

function hasBracketSet(rawName: string): boolean {
  return /\[[^\]]+\]\s*\{[^}]+\}/.test(rawName);
}

function hasParenText(rawName: string): boolean {
  return /\(([^)]+)\)/.test(rawName);
}

function featureDelta(
  expected: PreferenceCandidate,
  other: PreferenceCandidate,
  emphasizedSources: Set<string>
) {
  const expectedRawName = expected.rawName ?? expected.name;
  const otherRawName = other.rawName ?? other.name;

  return {
    sourceExpected: expected.sourceName,
    sourceOther: other.sourceName,
    expectedTags: expected.tags,
    otherTags: other.tags,
    expectedBracket: hasBracketSet(expectedRawName),
    otherBracket: hasBracketSet(otherRawName),
    expectedParen: hasParenText(expectedRawName),
    otherParen: hasParenText(otherRawName),
    expectedPlain:
      !hasParenText(expectedRawName) && !hasBracketSet(expectedRawName),
    otherPlain: !hasParenText(otherRawName) && !hasBracketSet(otherRawName),
    dpiDelta: (expected.dpi - other.dpi) / 1200,
    expectedEmphasized: emphasizedSources.has(expected.sourceName),
    otherEmphasized: emphasizedSources.has(other.sourceName),
  };
}

export function trainMpcPreferenceModel(
  calibrationCases: MpcCalibrationCaseRecord[],
  options: MpcPreferenceTrainingOptions = {}
): MpcPreferenceModel | null {
  const emphasizedSources = new Set(
    options.emphasizedSources ?? DEFAULT_EMPHASIZED_SOURCES
  );

  const labeledCases = calibrationCases.filter(
    (calibrationCase) =>
      calibrationCase.expectedIdentifier &&
      calibrationCase.candidates.length > 1
  );

  if (labeledCases.length < (options.minCaseCount ?? 3)) {
    return null;
  }

  const model: MpcPreferenceModel = {
    bias: 0,
    sourceWeights: {},
    tagWeights: {},
    formatWeights: {
      hasBracketSet: 0,
      hasParenText: 0,
      plainName: 0,
      dpi: 0,
    },
    trainingCaseCount: labeledCases.length,
  };

  for (const calibrationCase of labeledCases) {
    const expected = calibrationCase.candidates.find(
      (candidate) => candidate.identifier === calibrationCase.expectedIdentifier
    );
    if (!expected) continue;

    for (const other of calibrationCase.candidates) {
      if (other.identifier === expected.identifier) continue;

      const delta = featureDelta(expected, other, emphasizedSources);

      if (delta.sourceExpected) {
        addWeight(
          model.sourceWeights,
          delta.sourceExpected,
          delta.expectedEmphasized ? 2 : 1
        );
      }
      if (delta.sourceOther) {
        addWeight(
          model.sourceWeights,
          delta.sourceOther,
          delta.otherEmphasized ? -2 : -1
        );
      }

      for (const tag of delta.expectedTags) addWeight(model.tagWeights, tag, 1);
      for (const tag of delta.otherTags) addWeight(model.tagWeights, tag, -1);

      model.formatWeights.hasBracketSet +=
        (delta.expectedBracket ? 1 : 0) - (delta.otherBracket ? 1 : 0);
      model.formatWeights.hasParenText +=
        (delta.expectedParen ? 1 : 0) - (delta.otherParen ? 1 : 0);
      model.formatWeights.plainName +=
        (delta.expectedPlain ? 1 : 0) - (delta.otherPlain ? 1 : 0);
      model.formatWeights.dpi += delta.dpiDelta;
    }
  }

  return model;
}

export function scoreMpcCandidatePreference(
  model: MpcPreferenceModel,
  candidate: PreferenceCandidate
): number {
  const rawName = candidate.rawName ?? candidate.name;
  let score = model.bias;

  score += ensureWeight(model.sourceWeights, candidate.sourceName);
  for (const tag of candidate.tags) {
    score += ensureWeight(model.tagWeights, tag);
  }

  if (hasBracketSet(rawName)) {
    score += model.formatWeights.hasBracketSet;
  }
  if (hasParenText(rawName)) {
    score += model.formatWeights.hasParenText;
  }
  if (!hasBracketSet(rawName) && !hasParenText(rawName)) {
    score += model.formatWeights.plainName;
  }

  score += (candidate.dpi / 1200) * model.formatWeights.dpi;

  return score;
}

export function rankMpcCandidatesByPreference(
  model: MpcPreferenceModel,
  candidates: PreferenceCandidate[]
): MpcPreferencePrediction[] {
  return candidates
    .map((candidate) => ({
      candidate,
      score: scoreMpcCandidatePreference(model, candidate),
    }))
    .sort(
      (left, right) =>
        right.score - left.score ||
        right.candidate.dpi - left.candidate.dpi ||
        left.candidate.identifier.localeCompare(right.candidate.identifier)
    );
}

export function buildMpcPreferenceScoreMap(
  model: MpcPreferenceModel,
  candidates: PreferenceCandidate[]
): Record<string, number> {
  return Object.fromEntries(
    rankMpcCandidatesByPreference(model, candidates).map(
      ({ candidate, score }) => [candidate.identifier, score]
    )
  );
}

export function evaluateHeldOutPreferenceModel(
  calibrationCases: MpcCalibrationCaseRecord[],
  options: MpcPreferenceTrainingOptions = {}
): {
  total: number;
  top1: number;
} {
  let total = 0;
  let top1 = 0;

  for (const heldOut of calibrationCases) {
    if (!heldOut.expectedIdentifier || heldOut.candidates.length < 2) continue;

    const trainSet = calibrationCases.filter(
      (candidate) => candidate.id !== heldOut.id
    );
    const model = trainMpcPreferenceModel(trainSet, options);
    if (!model) continue;

    const ranked = rankMpcCandidatesByPreference(model, heldOut.candidates);
    total += 1;
    if (ranked[0]?.candidate.identifier === heldOut.expectedIdentifier) {
      top1 += 1;
    }
  }

  return { total, top1 };
}
