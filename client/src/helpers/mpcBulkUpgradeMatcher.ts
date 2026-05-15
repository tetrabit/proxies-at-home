/**
 * MPC Bulk Upgrade Matcher
 *
 * Pure decision logic for candidate bucketing and selection. The optional
 * SSIM tie-breaker receives an injectable comparison function so callers
 * can swap in the real image-loading path or a test stub.
 */

import type { MpcAutofillCard } from "./mpcAutofillApi";
import { loadImage } from "./imageProcessing";
import { toArtCrop, toProxied } from "./imageHelper";
import { parseMpcCardName, parseMpcSetCollector } from "./mpcUtils";
import type { MpcCalibrationPreferenceProfile } from "./mpcCalibrationStorage";
import { normalizeDfcName } from "../../../shared/cardNameUtils";

export type MatchReason =
  | "set_collector_only"
  | "set_collector_ssim"
  | "set_collector_dpi_fallback"
  | "set_only"
  | "set_ssim"
  | "set_dpi_fallback"
  | "name_only"
  | "name_ssim"
  | "name_dpi_fallback";

export interface MatchResult {
  card: MpcAutofillCard;
  reason: MatchReason;
}

export interface EnsembleScoreBreakdown {
  total: number;
  metadata: number;
  visual: number;
  preference: number;
  dpi: number;
}

export interface ScoredCandidate {
  card: MpcAutofillCard;
  score: number;
}

export interface RankedCandidate {
  card: MpcAutofillCard;
  reason: MatchReason;
  score?: number;
  bucket: "set_collector" | "set" | "name";
  breakdown?: EnsembleScoreBreakdown;
}

export interface RankedRecommendations {
  fullProcess: RankedCandidate[];
  exactPrinting: RankedCandidate[];
  artMatch: RankedCandidate[];
  fullCard: RankedCandidate[];
  allMatches: RankedCandidate[];
}

/**
 * Returns similarity score 0-1, or `null` when comparison cannot be
 * performed (image load failure, canvas issues, etc.).
 */
export type SsimCompareFn = (
  sourceImageUrl: string,
  candidateImageUrl: string,
  signal?: AbortSignal
) => Promise<number | null>;

export interface MatcherInput {
  candidates: MpcAutofillCard[];
  set?: string;
  collectorNumber?: string;
  sourceImageUrl?: string;
  signal?: AbortSignal;
  ssimCompare?: SsimCompareFn;
  artMatchCompare?: SsimCompareFn;
  getMpcImageUrl?: (identifier: string) => string;
  preferredIdentifier?: string;
  preferenceProfile?: MpcCalibrationPreferenceProfile;
  unseenPreferenceScores?: Record<string, number>;
}

type NormalizedImage = {
  pixels: Float32Array;
  width: number;
  height: number;
};

type CropSpec = {
  top: number;
  right: number;
  bottom: number;
  left: number;
};

type ImageCache = Map<string, Promise<NormalizedImage | null>>;
type EdgeCache = Map<string, Promise<Float32Array | null>>;

export function prioritizePreferredCandidate(
  layer: RankedCandidate[],
  candidates: MpcAutofillCard[],
  preferredIdentifier?: string
): RankedCandidate[] {
  if (!preferredIdentifier) {
    return layer;
  }

  const existing = layer.find(
    (candidate) => candidate.card.identifier === preferredIdentifier
  );
  if (existing) {
    return [
      { ...existing, reason: "name_only", score: undefined },
      ...layer.filter(
        (candidate) => candidate.card.identifier !== preferredIdentifier
      ),
    ];
  }

  const preferredCard = candidates.find(
    (candidate) => candidate.identifier === preferredIdentifier
  );
  if (!preferredCard) {
    return layer;
  }

  return [
    {
      card: preferredCard,
      reason: "name_only",
      bucket: "name",
    },
    ...layer,
  ];
}

export function scoreCalibrationPreference(
  card: MpcAutofillCard,
  profile: MpcCalibrationPreferenceProfile
): number {
  const rawName = card.rawName ?? card.name;
  let score = 0;

  if (profile.sourceName && card.sourceName === profile.sourceName) {
    score += 100;
  }

  const cardTags = new Set(card.tags);
  for (const tag of profile.tags) {
    if (cardTags.has(tag)) {
      score += 20;
    }
  }

  if (/\[[^\]]+\]\s*\{[^}]+\}/.test(rawName) === profile.hasBracketSet) {
    score += 15;
  }

  const parenText = rawName.match(/\(([^)]+)\)/)?.[1]?.toLowerCase();
  if (profile.parenText && parenText === profile.parenText) {
    score += 25;
  }
  if (!profile.parenText && !parenText) {
    score += 10;
  }

  if (rawName === profile.rawName) {
    score += 40;
  }

  return score;
}

const DEFAULT_NORMALIZED_SIZE = 192;
export const FULL_CARD_NORMALIZED_SIZE = 1024;
const EDGE_INSET_RATIO = 0.08;
const BLOCK_SIZE = 8;
const LUMINANCE_WEIGHT = 0.75;
const EDGE_WEIGHT = 0.25;
const ART_MATCH_CANDIDATE_CROP: CropSpec = {
  top: 0.14,
  right: 0.08,
  bottom: 0.25,
  left: 0.08,
};

/** Minimum absolute score to accept an SSIM result as an 'automatic' match. */
const SSIM_MIN_SCORE = 0.8;

/** Minimum lead over runner-up to declare a decisive SSIM winner. */
const SSIM_MIN_MARGIN = 0.01;

function createCanvas(size: number): HTMLCanvasElement | OffscreenCanvas {
  if (typeof OffscreenCanvas !== "undefined") {
    return new OffscreenCanvas(size, size);
  }

  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  return canvas;
}

function get2dContext(canvas: HTMLCanvasElement | OffscreenCanvas) {
  return canvas.getContext("2d", { willReadFrequently: true });
}

function computeInset(size: number): number {
  return Math.max(0, Math.floor(size * EDGE_INSET_RATIO));
}

function encodeCropSpecInUrl(url: string, cropSpec: CropSpec): string {
  const cropPayload = [
    cropSpec.top,
    cropSpec.right,
    cropSpec.bottom,
    cropSpec.left,
  ].join(",");
  return `${url}#crop=${cropPayload}`;
}

function decodeCropSpecFromUrl(url: string): {
  imageUrl: string;
  cropSpec?: CropSpec;
} {
  const [imageUrl, fragment] = url.split("#crop=");
  if (!fragment) {
    return { imageUrl };
  }

  const parts = fragment.split(",").map(Number);
  if (parts.length !== 4 || parts.some(isNaN)) {
    return { imageUrl };
  }

  return {
    imageUrl,
    cropSpec: {
      top: parts[0],
      right: parts[1],
      bottom: parts[2],
      left: parts[3],
    },
  };
}

async function loadNormalizedImage(
  url: string,
  signal: AbortSignal | undefined,
  cache: ImageCache,
  normalizedSize: number
): Promise<NormalizedImage | null> {
  const cacheKey = `${normalizedSize}:${url}`;
  const cached = cache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const loadPromise = (async () => {
    try {
      const decoded = decodeCropSpecFromUrl(url);
      const bitmap = await loadImage(
        toProxied(decoded.imageUrl),
        signal ? { signal } : undefined,
        1
      );
      try {
        return normalizeBitmap(bitmap, decoded.cropSpec, normalizedSize);
      } finally {
        bitmap.close();
      }
    } catch {
      return null;
    }
  })();

  cache.set(cacheKey, loadPromise);
  return loadPromise;
}

async function loadEdgeMap(
  imageUrl: string,
  signal: AbortSignal | undefined,
  imageCache: ImageCache,
  edgeCache: EdgeCache,
  normalizedSize: number
): Promise<Float32Array | null> {
  const cacheKey = `${normalizedSize}:${imageUrl}`;
  const cached = edgeCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const edgePromise = (async () => {
    const normalized = await loadNormalizedImage(
      imageUrl,
      signal,
      imageCache,
      normalizedSize
    );
    if (!normalized) {
      return null;
    }

    return computeSobelMagnitude(
      normalized.pixels,
      normalized.width,
      normalized.height
    );
  })();

  edgeCache.set(cacheKey, edgePromise);
  return edgePromise;
}

export function createSsimCompare(
  cache: ImageCache = new Map(),
  normalizedSize = DEFAULT_NORMALIZED_SIZE
): SsimCompareFn {
  const edgeCache: EdgeCache = new Map();

  return async (
    sourceImageUrl: string,
    candidateImageUrl: string,
    signal?: AbortSignal
  ) => {
    const [source, candidate] = await Promise.all([
      loadNormalizedImage(sourceImageUrl, signal, cache, normalizedSize),
      loadNormalizedImage(candidateImageUrl, signal, cache, normalizedSize),
    ]);

    if (!source || !candidate) return null;
    if (
      source.width !== candidate.width ||
      source.height !== candidate.height
    ) {
      return null;
    }

    const luminanceScore = computeBlockScore(
      source.pixels,
      candidate.pixels,
      source.width,
      source.height
    );

    try {
      const [sourceEdges, candidateEdges] = await Promise.all([
        loadEdgeMap(sourceImageUrl, signal, cache, edgeCache, normalizedSize),
        loadEdgeMap(
          candidateImageUrl,
          signal,
          cache,
          edgeCache,
          normalizedSize
        ),
      ]);

      if (!sourceEdges || !candidateEdges) {
        return luminanceScore;
      }

      return blendVisualScores(
        luminanceScore,
        computeEdgeScore(sourceEdges, candidateEdges)
      );
    } catch {
      return luminanceScore;
    }
  };
}

export function normalizeBitmap(
  bitmap: ImageBitmap,
  cropSpec: CropSpec | undefined,
  size: number
): NormalizedImage {
  const canvas = createCanvas(size);
  const ctx = get2dContext(canvas);
  if (!ctx) {
    throw new Error("Failed to get 2D context");
  }

  if (cropSpec) {
    const sx = cropSpec.left * bitmap.width;
    const sy = cropSpec.top * bitmap.height;
    const sw = (1 - cropSpec.left - cropSpec.right) * bitmap.width;
    const sh = (1 - cropSpec.top - cropSpec.bottom) * bitmap.height;
    ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, size, size);
  } else {
    ctx.drawImage(bitmap, 0, 0, size, size);
  }

  const { data } = ctx.getImageData(0, 0, size, size);
  const pixels = new Float32Array(size * size);

  for (let i = 0; i < pixels.length; i += 1) {
    const offset = i * 4;
    const r = data[offset] / 255;
    const g = data[offset + 1] / 255;
    const b = data[offset + 2] / 255;
    pixels[i] = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  return { pixels, width: size, height: size };
}
export function computeSobelMagnitude(
  pixels: Float32Array,
  width: number,
  height: number
): Float32Array {
  const magnitude = new Float32Array(width * height);
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const idx = y * width + x;
      const gx =
        pixels[idx - width + 1] +
        2 * pixels[idx + 1] +
        pixels[idx + width + 1] -
        (pixels[idx - width - 1] + 2 * pixels[idx - 1] + pixels[idx + width - 1]);
      const gy =
        pixels[idx + width - 1] +
        2 * pixels[idx + width] +
        pixels[idx + width + 1] -
        (pixels[idx - width - 1] + 2 * pixels[idx - width] + pixels[idx - width + 1]);
      magnitude[idx] = Math.sqrt(gx * gx + gy * gy);
    }
  }
  return magnitude;
}

export function computeBlockScore(
  a: Float32Array,
  b: Float32Array,
  width: number,
  height: number
): number {
  const inset = computeInset(width);
  let scoreSum = 0;
  let blockCount = 0;

  for (let y = inset; y < height - inset - BLOCK_SIZE; y += BLOCK_SIZE) {
    for (let x = inset; x < width - inset - BLOCK_SIZE; x += BLOCK_SIZE) {
      scoreSum += computeSsimBlock(a, b, x, y, width);
      blockCount += 1;
    }
  }

  return blockCount > 0 ? scoreSum / blockCount : 0;
}

export function computeSsimBlock(
  a: Float32Array,
  b: Float32Array,
  startX: number,
  startY: number,
  width: number
): number {
  let meanA = 0;
  let meanB = 0;
  const pixels = [];

  for (let dy = 0; dy < BLOCK_SIZE; dy += 1) {
    for (let dx = 0; dx < BLOCK_SIZE; dx += 1) {
      const idx = (startY + dy) * width + (startX + dx);
      meanA += a[idx];
      meanB += b[idx];
      pixels.push([a[idx], b[idx]]);
    }
  }
  meanA /= pixels.length;
  meanB /= pixels.length;

  let varA = 0;
  let varB = 0;
  let covAB = 0;
  for (const [pa, pb] of pixels) {
    varA += (pa - meanA) ** 2;
    varB += (pb - meanB) ** 2;
    covAB += (pa - meanA) * (pb - meanB);
  }
  varA /= pixels.length - 1;
  varB /= pixels.length - 1;
  covAB /= pixels.length - 1;

  const c1 = (0.01 * 1) ** 2;
  const c2 = (0.03 * 1) ** 2;

  return (
    ((2 * meanA * meanB + c1) * (2 * covAB + c2)) /
    ((meanA ** 2 + meanB ** 2 + c1) * (varA + varB + c2))
  );
}

export function computeEdgeScore(a: Float32Array, b: Float32Array): number {
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i += 1) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  if (normA === 0 && normB === 0) return 1;
  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

function blendVisualScores(luminance: number, edge: number): number {
  return luminance * LUMINANCE_WEIGHT + edge * EDGE_WEIGHT;
}

export function sortByDpiThenId(candidates: MpcAutofillCard[]): MpcAutofillCard[] {
  return [...candidates].sort(
    (left, right) =>
      right.dpi - left.dpi || left.identifier.localeCompare(right.identifier)
  );
}

function normalizeCollectorNumberForMatch(cn: string): string {
  return cn.replace(/^0+/, "");
}

export function normalizeName(name: string): string {
  return name.trim().toLowerCase();
}

export function filterByExactName(
  candidates: MpcAutofillCard[],
  targetName: string
): MpcAutofillCard[] {
  const normalizedTarget = normalizeName(normalizeDfcName(targetName));
  return candidates.filter((card) => {
    // Test mocks often pass variants in 'name', so we parse it.
    const parsed = parseMpcCardName(card.name);
    return normalizeName(parsed) === normalizedTarget;
  });
}

export function bucketBySetCollector(
  candidates: MpcAutofillCard[],
  set?: string,
  collectorNumber?: string
): MpcAutofillCard[] {
  if (!set || !collectorNumber) return [];
  const normalizedSet = set.toUpperCase();
  const normalizedCN = normalizeCollectorNumberForMatch(collectorNumber);

  return candidates.filter((card) => {
    const parsed = parseMpcSetCollector(card.rawName || card.name);
    if (!parsed) return false;
    return (
      parsed.set === normalizedSet &&
      normalizeCollectorNumberForMatch(parsed.collectorNumber) === normalizedCN
    );
  });
}

export function bucketBySetOnly(
  candidates: MpcAutofillCard[],
  set?: string
): MpcAutofillCard[] {
  if (!set) return [];
  const normalizedSet = set.toUpperCase();

  return candidates.filter((card) => {
    const parsed = parseMpcSetCollector(card.rawName || card.name);
    return parsed?.set === normalizedSet;
  });
}

export async function scoreCandidatesBySsim(
  candidates: MpcAutofillCard[],
  sourceImageUrl: string,
  ssimCompare: SsimCompareFn,
  getMpcImageUrl: (identifier: string) => string,
  signal?: AbortSignal
): Promise<ScoredCandidate[]> {
  const limited = sortByDpiThenId(candidates).slice(0, MAX_SSIM_CANDIDATES);
  const scores = await Promise.all(
    limited.map((card) =>
      ssimCompare(sourceImageUrl, getMpcImageUrl(card.identifier), signal).catch(
        () => null
      )
    )
  );

  const scored: ScoredCandidate[] = [];
  for (let i = 0; i < scores.length; i++) {
    const score = scores[i];
    if (score !== null) {
      scored.push({ card: limited[i], score });
    }
  }

  return scored.sort((a, b) => b.score - a.score);
}

export async function scoreCandidatesByArtCrop(
  candidates: MpcAutofillCard[],
  sourceImageUrl: string,
  ssimCompare: SsimCompareFn,
  getMpcImageUrl: (identifier: string) => string,
  signal?: AbortSignal
): Promise<ScoredCandidate[]> {
  const limited = sortByDpiThenId(candidates).slice(0, MAX_SSIM_CANDIDATES);
  const scores = await Promise.all(
    limited.map((card) =>
      ssimCompare(
        toArtCrop(sourceImageUrl) || sourceImageUrl,
        encodeCropSpecInUrl(
          getMpcImageUrl(card.identifier),
          ART_MATCH_CANDIDATE_CROP
        ),
        signal
      ).catch(() => null)
    )
  );

  const scored: ScoredCandidate[] = [];
  for (let i = 0; i < scores.length; i++) {
    const score = scores[i];
    if (score !== null) {
      scored.push({ card: limited[i], score });
    }
  }

  return scored.sort((a, b) => b.score - a.score);
}
const MAX_RECOMMENDATIONS = 6;
const MAX_SSIM_CANDIDATES = 30;

export function scoreCandidateEnsemble(
  card: MpcAutofillCard,
  input: MatcherInput,
  ssimScore?: number
): EnsembleScoreBreakdown {
  // 1. Metadata Score (Bucket Match)
  let metadataScore = 400; // Base for name-only match
  const parsed = parseMpcSetCollector(card.rawName || card.name);
  if (parsed) {
    const normalizedSet = input.set?.toUpperCase();
    const normalizedCN = input.collectorNumber
      ? normalizeCollectorNumberForMatch(input.collectorNumber)
      : "";
    const parsedCN = normalizeCollectorNumberForMatch(parsed.collectorNumber);

    if (normalizedSet && normalizedCN && parsed.set === normalizedSet && parsedCN === normalizedCN) {
      metadataScore = 600; // Perfect match
    } else if (normalizedSet && parsed.set === normalizedSet) {
      metadataScore = 500;  // Set match
    }
  }

  // 2. Visual Score (SSIM)
  const visualScore = ssimScore ? (ssimScore * 5000) : 0;

  // 3. Preference Score (Source Reliability + Model + Calibration Replay)
  let prefScore = 0;
  const rawUnseen = input.unseenPreferenceScores?.[card.identifier] ?? 0;
  if (rawUnseen > 0) {
    // Large bonus to ensure user-preferred art overrides metadata buckets
    prefScore += 1000 + (rawUnseen * 2.5);
  }

  if (input.preferenceProfile) {
    const replayScore = scoreCalibrationPreference(card, input.preferenceProfile);
    if (replayScore > 0) {
      // Large bonus for art matching a stored calibration replay
      prefScore += 1000 + (replayScore * 2.5);
    }
  }

  // 4. DPI Score (Tie-breaker)
  const dpiScore = (card.dpi || 0) / 100;

  return {
    total: metadataScore + visualScore + prefScore + dpiScore,
    metadata: metadataScore,
    visual: visualScore,
    preference: prefScore,
    dpi: dpiScore,
  };
}

async function rankWithinBucket(
  bucket: MpcAutofillCard[],
  prefix: "set_collector" | "set" | "name",
  sourceImageUrl?: string,
  signal?: AbortSignal,
  ssimCompare?: SsimCompareFn,
  getMpcImageUrl?: (identifier: string) => string
): Promise<RankedCandidate[]> {
  if (sourceImageUrl && ssimCompare && getMpcImageUrl) {
    try {
      const scored = await scoreCandidatesBySsim(
        bucket,
        sourceImageUrl,
        ssimCompare,
        getMpcImageUrl,
        signal
      );
      if (scored.length > 0 && scored[0].score >= SSIM_MIN_SCORE) {
        return scored.slice(0, MAX_RECOMMENDATIONS).map(
          (sc): RankedCandidate => ({
            card: sc.card,
            reason: `${prefix}_ssim` as MatchReason,
            score: sc.score,
            bucket: prefix,
          })
        );
      }
    } catch {
      // SSIM failure — fall through to DPI
    }
  }

  return sortByDpiThenId(bucket)
    .slice(0, MAX_RECOMMENDATIONS)
    .map(
      (card): RankedCandidate => ({
        card,
        reason:
          bucket.length === 1
            ? (`${prefix}_only` as MatchReason)
            : (`${prefix}_dpi_fallback` as MatchReason),
        bucket: prefix,
      })
    );
}

export async function rankCandidates(
  input: MatcherInput
): Promise<RankedRecommendations> {
  const { candidates, sourceImageUrl, signal, ssimCompare, getMpcImageUrl } =
    input;
  if (candidates.length === 0) {
    return {
      fullProcess: [],
      exactPrinting: [],
      artMatch: [],
      fullCard: [],
      allMatches: [],
    };
  }

  // 1. Exact Printing (Metadata only)
  const setCollectorBucket = bucketBySetCollector(
    candidates,
    input.set,
    input.collectorNumber
  );
  const setOnlyBucket = input.set ? bucketBySetOnly(candidates, input.set) : [];
  const remainingSetOnly = setOnlyBucket.filter(
    (candidate) =>
      !setCollectorBucket.some(
        (exactCandidate) => exactCandidate.identifier === candidate.identifier
      )
  );

  const exactPrinting = [
    ...sortByDpiThenId(setCollectorBucket).map(
      (card): RankedCandidate => ({
        card,
        reason:
          setCollectorBucket.length === 1
            ? "set_collector_only"
            : "set_collector_dpi_fallback",
        bucket: "set_collector",
      })
    ),
    ...sortByDpiThenId(remainingSetOnly).map(
      (card): RankedCandidate => ({
        card,
        reason:
          setOnlyBucket.length === 1 ? "set_only" : "set_dpi_fallback",
        bucket: "set",
      })
    ),
  ].slice(0, MAX_RECOMMENDATIONS);

  // 2. Full Card SSIM
  const fullCardBucket =
    setCollectorBucket.length > 0
      ? setCollectorBucket
      : setOnlyBucket.length > 0
        ? setOnlyBucket
        : candidates;

  const fullCard = await rankWithinBucket(
    fullCardBucket,
    setCollectorBucket.length > 0
      ? "set_collector"
      : setOnlyBucket.length > 0
        ? "set"
        : "name",
    sourceImageUrl,
    signal,
    ssimCompare,
    getMpcImageUrl
  );

  // 3. Art Match SSIM (Art-crop only)
  let artMatch: RankedCandidate[] = [];
  const artMatchCompare = input.artMatchCompare ?? input.ssimCompare;
  if (sourceImageUrl && artMatchCompare && getMpcImageUrl) {
    try {
      const artScoredCandidates = await scoreCandidatesByArtCrop(
        candidates,
        sourceImageUrl,
        artMatchCompare,
        getMpcImageUrl,
        signal
      );
      artMatch = artScoredCandidates.slice(0, MAX_RECOMMENDATIONS).map(
        (sc): RankedCandidate => ({
          card: sc.card,
          reason: "name_ssim",
          score: sc.score,
          bucket: "name",
        })
      );
    } catch {
      // SSIM failure
    }
  }

  // 4. Full Process (Committee Ensemble)
  let artScored: ScoredCandidate[] = [];
  if (sourceImageUrl && artMatchCompare && getMpcImageUrl) {
    try {
      artScored = await scoreCandidatesByArtCrop(
        candidates,
        sourceImageUrl,
        artMatchCompare,
        getMpcImageUrl,
        signal
      );
    } catch {
      // SSIM failed
    }
  }

  const artMatchCards = artScored.slice(0, 3).map((s) => s.card);
  const decisiveArtMatches = artScored.filter(s => s.score >= 0.95).map(s => s.card);

  const bestMetadataBucket = setCollectorBucket.length > 0 
    ? setCollectorBucket 
    : (input.set ? bucketBySetOnly(candidates, input.set) : candidates);

  const pool = decisiveArtMatches.length > 0 ? decisiveArtMatches : [...bestMetadataBucket, ...artMatchCards];

  const preferredCandidates = candidates.filter(c => 
    (input.preferenceProfile && scoreCalibrationPreference(c, input.preferenceProfile) > 0) ||
    (input.unseenPreferenceScores && (input.unseenPreferenceScores[c.identifier] ?? 0) > 0)
  );

  const activeBucketSet = new Set([
    ...pool,
    ...preferredCandidates,
  ]);
  const activeBucket = Array.from(activeBucketSet);

  let scoredSsim: ScoredCandidate[] = [];
  if (sourceImageUrl && ssimCompare && getMpcImageUrl) {
    try {
      scoredSsim = await scoreCandidatesBySsim(
        activeBucket,
        sourceImageUrl,
        ssimCompare,
        getMpcImageUrl,
        signal
      );
    } catch {
      // SSIM failed
    }
  }

  const ssimMap = new Map<string, number>();
  for (const sc of scoredSsim) {
    ssimMap.set(sc.card.identifier, sc.score);
  }
  for (const sc of artScored) {
    const existing = ssimMap.get(sc.card.identifier) ?? 0;
    ssimMap.set(sc.card.identifier, Math.max(existing, sc.score));
  }

  const ensembleResults = activeBucket.map(card => {
    const ssimScore = ssimMap.get(card.identifier);
    const breakdown = scoreCandidateEnsemble(card, input, ssimScore);
    
    let prefix: "set_collector" | "set" | "name" = "name";
    if (setCollectorBucket.some(c => c.identifier === card.identifier)) {
      prefix = "set_collector";
    } else if (setOnlyBucket.some(c => c.identifier === card.identifier)) {
      prefix = "set";
    }

    return {
      card,
      breakdown,
      ssimScore,
      prefix
    };
  }).sort((a, b) => 
    b.breakdown.total - a.breakdown.total ||
    (b.card.dpi || 0) - (a.card.dpi || 0) ||
    a.card.identifier.localeCompare(b.card.identifier)
  );

  const fullProcess: RankedCandidate[] = ensembleResults.slice(0, MAX_RECOMMENDATIONS).map((res, idx) => {
    const second = ensembleResults[idx + 1];
    const decisive = !second || (res.breakdown.total - second.breakdown.total) > 
      ((res.ssimScore !== undefined && res.ssimScore >= SSIM_MIN_SCORE && second?.ssimScore !== undefined && second.ssimScore >= SSIM_MIN_SCORE ? (SSIM_MIN_MARGIN * 5000) : 0.1) + 1e-9);

    const reason: MatchReason = (res.ssimScore !== undefined && res.ssimScore >= SSIM_MIN_SCORE && decisive)
      ? `${res.prefix}_ssim` as MatchReason
      : (activeBucket.length === 1 ? `${res.prefix}_only` as MatchReason : `${res.prefix}_dpi_fallback` as MatchReason);

    return {
      card: res.card,
      reason,
      score: (reason.endsWith("_ssim") && res.ssimScore !== undefined) ? res.ssimScore : res.breakdown.total,
      bucket: res.prefix,
      breakdown: res.breakdown
    };
  });

  // User-pinned favorite always wins first slot in fullProcess immediately
  let finalFullProcess = fullProcess;
  if (input.preferredIdentifier) {
    const preferredCard = candidates.find(c => c.identifier === input.preferredIdentifier);
    if (preferredCard) {
      finalFullProcess = [
        { card: preferredCard, reason: "name_only", bucket: "name" },
        ...fullProcess.filter(r => r.card.identifier !== input.preferredIdentifier)
      ].slice(0, MAX_RECOMMENDATIONS);
    }
  }

  const allMatches = buildAllMatchesLayer(
    candidates,
    artMatch,
    exactPrinting,
    fullCard
  );

  return {
    fullProcess: finalFullProcess,
    exactPrinting,
    artMatch,
    fullCard,
    allMatches,
  };
}

function buildAllMatchesLayer(
  candidates: MpcAutofillCard[],
  artMatch: RankedCandidate[],
  exactPrinting: RankedCandidate[],
  fullCard: RankedCandidate[]
): RankedCandidate[] {
  const ordered: RankedCandidate[] = [];
  const seen = new Set<string>();

  const pushUnique = (items: RankedCandidate[]) => {
    for (const item of items) {
      if (seen.has(item.card.identifier)) continue;
      seen.add(item.card.identifier);
      ordered.push(item);
      if (ordered.length >= MAX_RECOMMENDATIONS) return;
    }
  };

  pushUnique(artMatch);
  if (ordered.length < MAX_RECOMMENDATIONS) pushUnique(exactPrinting);
  if (ordered.length < MAX_RECOMMENDATIONS) pushUnique(fullCard);

  if (ordered.length < MAX_RECOMMENDATIONS) {
    const remainder = sortByDpiThenId(candidates)
      .filter((card) => !seen.has(card.identifier))
      .map(
        (card): RankedCandidate => ({
          card,
          reason: "name_dpi_fallback",
          bucket: "name",
        })
      );
    pushUnique(remainder);
  }

  return ordered.slice(0, MAX_RECOMMENDATIONS);
}

export async function selectBestCandidate(
  input: MatcherInput
): Promise<MatchResult | null> {
  const { candidates, preferredIdentifier } = input;
  if (candidates.length === 0) return null;

  // User-pinned favorite always wins immediately
  if (preferredIdentifier) {
    const preferredCard = candidates.find(
      (candidate) => candidate.identifier === preferredIdentifier
    );
    if (preferredCard) {
      return { card: preferredCard, reason: "name_only" };
    }
  }

  // Determine which bucket we are working in
  const setCollectorBucket = bucketBySetCollector(candidates, input.set, input.collectorNumber);
  const setOnlyBucket = input.set ? bucketBySetOnly(candidates, input.set) : [];
  
  const bestMetadataBucket = setCollectorBucket.length > 0 
    ? setCollectorBucket 
    : (input.set ? bucketBySetOnly(candidates, input.set) : candidates);

  const preferredCandidates = candidates.filter(c => 
    (input.preferenceProfile && scoreCalibrationPreference(c, input.preferenceProfile) > 0) ||
    (input.unseenPreferenceScores && (input.unseenPreferenceScores[c.identifier] ?? 0) > 0)
  );

  let artScored: ScoredCandidate[] = [];
  const artMatchCompare = input.artMatchCompare ?? input.ssimCompare;
  if (input.sourceImageUrl && artMatchCompare && input.getMpcImageUrl) {
    try {
      artScored = await scoreCandidatesByArtCrop(
        candidates,
        input.sourceImageUrl,
        artMatchCompare,
        input.getMpcImageUrl,
        input.signal
      );
    } catch {
      // SSIM failed
    }
  }

  const artMatchCards = artScored.slice(0, 3).map((s) => s.card);
  const decisiveArtMatches = artScored.filter(s => s.score >= 0.95).map(s => s.card);

  const pool = decisiveArtMatches.length > 0 ? decisiveArtMatches : [...bestMetadataBucket, ...artMatchCards];

  const activeBucketSet = new Set([
    ...pool,
    ...preferredCandidates,
  ]);
  const activeBucket = Array.from(activeBucketSet);

  // 1. Run SSIM for top candidates in the bucket
  let scoredSsim: ScoredCandidate[] = [];
  if (input.sourceImageUrl && input.ssimCompare && input.getMpcImageUrl) {
    try {
      scoredSsim = await scoreCandidatesBySsim(
        activeBucket,
        input.sourceImageUrl,
        input.ssimCompare,
        input.getMpcImageUrl,
        input.signal
      );
    } catch {
      // SSIM failed
    }
  }

  const ssimMap = new Map<string, number>();
  for (const sc of scoredSsim) {
    ssimMap.set(sc.card.identifier, sc.score);
  }
  for (const sc of artScored) {
    const existing = ssimMap.get(sc.card.identifier) ?? 0;
    ssimMap.set(sc.card.identifier, Math.max(existing, sc.score));
  }

  // 2. Compute full Ensemble Score (The "Committee" Decision)
  const ensembleResults = activeBucket.map(card => ({
    card,
    ensembleScore: scoreCandidateEnsemble(card, input, ssimMap.get(card.identifier)).total
  })).sort((a, b) => 
    b.ensembleScore - a.ensembleScore ||
    (b.card.dpi || 0) - (a.card.dpi || 0) ||
    a.card.identifier.localeCompare(b.card.identifier)
  );

  const top = ensembleResults[0];
  if (!top) return null;

  let prefix: "set_collector" | "set" | "name" = "name";
  if (setCollectorBucket.some(c => c.identifier === top.card.identifier)) {
    prefix = "set_collector";
  } else if (setOnlyBucket.some(c => c.identifier === top.card.identifier)) {
    prefix = "set";
  }

  const second = ensembleResults[1];
  const topHasSsim = ssimMap.has(top.card.identifier);
  const secondHasSsim = second && ssimMap.has(second.card.identifier);
  const marginNeeded = (topHasSsim && secondHasSsim) ? (SSIM_MIN_MARGIN * 5000) : 0.1;

  const decisive = !second || (top.ensembleScore - second.ensembleScore) > (marginNeeded + 1e-9);

  if (!decisive) {
    const byDpi = sortByDpiThenId(activeBucket);
    return { card: byDpi[0], reason: `${prefix}_dpi_fallback` as MatchReason };
  }

  const ssimWin = ssimMap.has(top.card.identifier) && (ssimMap.get(top.card.identifier) ?? 0) >= SSIM_MIN_SCORE;
  const reason: MatchReason = ssimWin
    ? `${prefix}_ssim` as MatchReason
    : (activeBucket.length === 1 ? `${prefix}_only` as MatchReason : `${prefix}_dpi_fallback` as MatchReason);

  return { card: top.card, reason };
}
