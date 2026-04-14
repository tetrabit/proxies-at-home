import type { MpcAutofillCard } from "./mpcAutofillApi";
import { parseMpcCardName, parseMpcSetCollector } from "./mpcUtils";

export type MatchReason =
  | "set_collector_only"
  | "set_collector_visual"
  | "set_only"
  | "set_visual"
  | "name_only"
  | "name_visual";

export type AmbiguousReason =
  | "set_collector_ambiguous"
  | "set_collector_visual_unavailable"
  | "set_collector_visual_low_confidence"
  | "set_collector_visual_tie"
  | "set_ambiguous"
  | "set_visual_unavailable"
  | "set_visual_low_confidence"
  | "set_visual_tie"
  | "name_ambiguous"
  | "name_visual_unavailable"
  | "name_visual_low_confidence"
  | "name_visual_tie";

export type MatchResult =
  | {
      status: "matched";
      card: MpcAutofillCard;
      reason: MatchReason;
      confidence?: number;
    }
  | {
      status: "ambiguous";
      reason: AmbiguousReason;
      candidates: MpcAutofillCard[];
      bestConfidence?: number;
      runnerUpConfidence?: number;
    };

export type VisualCompareFn = (
  sourceImageUrl: string,
  candidate: MpcAutofillCard,
  signal?: AbortSignal
) => Promise<number | null>;

export interface MatcherInput {
  candidates: MpcAutofillCard[];
  set?: string;
  collectorNumber?: string;
  sourceImageUrl?: string;
  signal?: AbortSignal;
  visualCompare?: VisualCompareFn;
}

const MIN_VISUAL_CONFIDENCE = 0.7;
const MIN_VISUAL_MARGIN = 0.03;

type BucketPrefix = "set_collector" | "set" | "name";

export function normalizeName(value: string): string {
  return value.trim().toLowerCase();
}

export function filterByExactName(
  cards: MpcAutofillCard[],
  cardName: string
): MpcAutofillCard[] {
  const normalized = normalizeName(cardName);
  return cards.filter(
    (card) =>
      normalizeName(parseMpcCardName(card.name, card.name)) === normalized
  );
}

function bucketBySetCollector(
  candidates: MpcAutofillCard[],
  set?: string,
  collectorNumber?: string
): MpcAutofillCard[] {
  if (!set && !collectorNumber) return [];

  const normalizedSet = set?.toUpperCase() ?? "";
  const normalizedCN = collectorNumber ?? "";

  return candidates.filter((card) => {
    const parsed = parseMpcSetCollector(card.rawName || card.name);
    if (!parsed) return false;

    if (normalizedSet && normalizedCN) {
      return (
        parsed.set === normalizedSet && parsed.collectorNumber === normalizedCN
      );
    }

    if (normalizedSet && parsed.set) {
      return parsed.set === normalizedSet;
    }

    return false;
  });
}

function bucketBySetOnly(
  candidates: MpcAutofillCard[],
  set: string
): MpcAutofillCard[] {
  const normalizedSet = set.toUpperCase();
  return candidates.filter((card) => {
    const parsed = parseMpcSetCollector(card.rawName || card.name);
    return parsed?.set === normalizedSet;
  });
}

function buildMatchedResult(
  card: MpcAutofillCard,
  reason: MatchReason,
  confidence?: number
): MatchResult {
  return {
    status: "matched",
    card,
    reason,
    confidence,
  };
}

function buildAmbiguousResult(
  candidates: MpcAutofillCard[],
  reason: AmbiguousReason,
  bestConfidence?: number,
  runnerUpConfidence?: number
): MatchResult {
  return {
    status: "ambiguous",
    reason,
    candidates,
    bestConfidence,
    runnerUpConfidence,
  };
}

async function resolveWithinBucket(
  bucket: MpcAutofillCard[],
  prefix: BucketPrefix,
  sourceImageUrl?: string,
  signal?: AbortSignal,
  visualCompare?: VisualCompareFn
): Promise<MatchResult> {
  if (bucket.length === 1) {
    return buildMatchedResult(bucket[0], `${prefix}_only` as MatchReason, 1);
  }

  if (!sourceImageUrl || !visualCompare) {
    return buildAmbiguousResult(
      bucket,
      `${prefix}_ambiguous` as AmbiguousReason
    );
  }

  const scored = await Promise.all(
    bucket.map(async (candidate) => ({
      candidate,
      score: await visualCompare(sourceImageUrl, candidate, signal),
    }))
  );

  const usableScores = scored
    .filter(
      (entry): entry is { candidate: MpcAutofillCard; score: number } =>
        entry.score !== null
    )
    .sort((a, b) => b.score - a.score);

  if (usableScores.length === 0) {
    return buildAmbiguousResult(
      bucket,
      `${prefix}_visual_unavailable` as AmbiguousReason
    );
  }

  const [best, runnerUp] = usableScores;

  if (best.score < MIN_VISUAL_CONFIDENCE) {
    return buildAmbiguousResult(
      bucket,
      `${prefix}_visual_low_confidence` as AmbiguousReason,
      best.score,
      runnerUp?.score
    );
  }

  if (runnerUp && best.score - runnerUp.score < MIN_VISUAL_MARGIN) {
    return buildAmbiguousResult(
      bucket,
      `${prefix}_visual_tie` as AmbiguousReason,
      best.score,
      runnerUp.score
    );
  }

  return buildMatchedResult(
    best.candidate,
    `${prefix}_visual` as MatchReason,
    best.score
  );
}

export async function selectBestCandidate(
  input: MatcherInput
): Promise<MatchResult | null> {
  const {
    candidates,
    set,
    collectorNumber,
    sourceImageUrl,
    signal,
    visualCompare,
  } = input;

  if (candidates.length === 0) return null;

  const setCollectorBucket = bucketBySetCollector(
    candidates,
    set,
    collectorNumber
  );
  if (setCollectorBucket.length > 0) {
    return resolveWithinBucket(
      setCollectorBucket,
      "set_collector",
      sourceImageUrl,
      signal,
      visualCompare
    );
  }

  if (set) {
    const setOnlyBucket = bucketBySetOnly(candidates, set);
    if (setOnlyBucket.length > 0) {
      return resolveWithinBucket(
        setOnlyBucket,
        "set",
        sourceImageUrl,
        signal,
        visualCompare
      );
    }
  }

  return resolveWithinBucket(
    candidates,
    "name",
    sourceImageUrl,
    signal,
    visualCompare
  );
}
