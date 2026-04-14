import type { MpcAutofillCard } from "./mpcAutofillApi";
import { parseMpcCardName, parseMpcSetCollector } from "./mpcUtils";

export type MatchReason =
  | "set_collector_only"
  | "set_collector_art_crop"
  | "set_collector_visual"
  | "set_only"
  | "set_art_crop"
  | "set_visual"
  | "name_only"
  | "name_art_crop"
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

export type HashDistanceFn = (
  sourceImageUrl: string,
  candidate: MpcAutofillCard,
  signal?: AbortSignal
) => Promise<number | null>;

export type ArtCropCompareFn = (
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
  artCropCompare?: ArtCropCompareFn;
  hashDistance?: HashDistanceFn;
  visualCompare?: VisualCompareFn;
}

const MIN_ART_CROP_CONFIDENCE = 0.75;
const MIN_ART_CROP_MARGIN = 0.05;
const MIN_VISUAL_CONFIDENCE = 0.7;
const MIN_VISUAL_MARGIN = 0.03;
const MAX_HASH_DISTANCE = 10;
const HASH_DISTANCE_MARGIN = 2;

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
  artCropCompare?: ArtCropCompareFn,
  hashDistance?: HashDistanceFn,
  visualCompare?: VisualCompareFn
): Promise<MatchResult> {
  if (bucket.length === 1) {
    return buildMatchedResult(bucket[0], `${prefix}_only` as MatchReason, 1);
  }

  if (!sourceImageUrl || (!artCropCompare && !visualCompare)) {
    return buildAmbiguousResult(
      bucket,
      `${prefix}_ambiguous` as AmbiguousReason
    );
  }

  if (artCropCompare) {
    const artCropScored = await Promise.all(
      bucket.map(async (candidate) => ({
        candidate,
        score: await artCropCompare(sourceImageUrl, candidate, signal),
      }))
    );

    const usableArtCropScores = artCropScored
      .filter(
        (entry): entry is { candidate: MpcAutofillCard; score: number } =>
          entry.score !== null
      )
      .sort((a, b) => b.score - a.score);

    const [bestArtCrop, runnerUpArtCrop] = usableArtCropScores;
    if (
      bestArtCrop &&
      bestArtCrop.score >= MIN_ART_CROP_CONFIDENCE &&
      (!runnerUpArtCrop ||
        bestArtCrop.score - runnerUpArtCrop.score >= MIN_ART_CROP_MARGIN)
    ) {
      return buildMatchedResult(
        bestArtCrop.candidate,
        `${prefix}_art_crop` as MatchReason,
        bestArtCrop.score
      );
    }
  }

  if (!visualCompare) {
    return buildAmbiguousResult(
      bucket,
      `${prefix}_ambiguous` as AmbiguousReason
    );
  }

  const comparisonBucket = await prefilterCandidatesByHash(
    bucket,
    sourceImageUrl,
    signal,
    hashDistance
  );

  const scored = await Promise.all(
    comparisonBucket.map(async (candidate) => ({
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
      comparisonBucket,
      `${prefix}_visual_unavailable` as AmbiguousReason
    );
  }

  const [best, runnerUp] = usableScores;

  if (best.score < MIN_VISUAL_CONFIDENCE) {
    return buildAmbiguousResult(
      comparisonBucket,
      `${prefix}_visual_low_confidence` as AmbiguousReason,
      best.score,
      runnerUp?.score
    );
  }

  if (runnerUp && best.score - runnerUp.score < MIN_VISUAL_MARGIN) {
    return buildAmbiguousResult(
      comparisonBucket,
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
    artCropCompare,
    hashDistance,
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
      artCropCompare,
      hashDistance,
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
        artCropCompare,
        hashDistance,
        visualCompare
      );
    }
  }

  return resolveWithinBucket(
    candidates,
    "name",
    sourceImageUrl,
    signal,
    artCropCompare,
    hashDistance,
    visualCompare
  );
}

async function prefilterCandidatesByHash(
  bucket: MpcAutofillCard[],
  sourceImageUrl: string,
  signal?: AbortSignal,
  hashDistance?: HashDistanceFn
): Promise<MpcAutofillCard[]> {
  if (!hashDistance) {
    return bucket;
  }

  const scored = await Promise.all(
    bucket.map(async (candidate) => ({
      candidate,
      distance: await hashDistance(sourceImageUrl, candidate, signal),
    }))
  );

  const usableDistances = scored
    .filter(
      (entry): entry is { candidate: MpcAutofillCard; distance: number } =>
        entry.distance !== null
    )
    .sort((a, b) => a.distance - b.distance);

  if (usableDistances.length === 0) {
    return bucket;
  }

  const bestDistance = usableDistances[0].distance;
  const maxDistance = Math.min(
    bestDistance + HASH_DISTANCE_MARGIN,
    MAX_HASH_DISTANCE
  );
  const narrowedBucket = usableDistances
    .filter((entry) => entry.distance <= maxDistance)
    .map((entry) => entry.candidate);

  return narrowedBucket.length > 0 ? narrowedBucket : bucket;
}
