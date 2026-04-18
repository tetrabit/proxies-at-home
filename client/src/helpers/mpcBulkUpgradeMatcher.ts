/**
 * MPC Bulk Upgrade Matcher
 *
 * Pure decision logic for candidate bucketing and selection. The optional
 * SSIM tie-breaker receives an injectable comparison function so callers
 * can swap in the real image-loading path or a test stub.
 *
 * Bucket priority (first non-empty wins):
 *   1. Set + Collector Number
 *   2. Set-only
 *   3. All exact-name matches
 *
 * Within the winning bucket: single candidate → return it; multiple →
 * SSIM tie-break if available & decisive, else highest-DPI fallback.
 */

import type { MpcAutofillCard } from "./mpcAutofillApi";
import { loadImage } from "./imageProcessing";
import { toArtCrop, toProxied } from "./imageHelper";
import { parseMpcCardName, parseMpcSetCollector } from "./mpcUtils";
import type { MpcCalibrationPreferenceProfile } from "./mpcCalibrationStorage";

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

export interface ScoredCandidate {
  card: MpcAutofillCard;
  score: number;
}

export interface RankedCandidate {
  card: MpcAutofillCard;
  reason: MatchReason;
  score?: number;
  bucket: "set_collector" | "set" | "name";
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

function prioritizePreferredCandidate(
  layer: RankedCandidate[],
  candidates: MpcAutofillCard[],
  preferredIdentifier: string | undefined
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

function scoreCalibrationPreference(
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

  score += Math.min(card.dpi / 400, 5);

  return score;
}

function prioritizePreferenceProfile(
  layer: RankedCandidate[],
  candidates: MpcAutofillCard[],
  preferenceProfile: MpcCalibrationPreferenceProfile | undefined
): RankedCandidate[] {
  if (!preferenceProfile) {
    return layer;
  }

  const rankedByPreference = candidates
    .map((candidate) => ({
      candidate,
      preferenceScore: scoreCalibrationPreference(candidate, preferenceProfile),
    }))
    .sort(
      (left, right) =>
        right.preferenceScore - left.preferenceScore ||
        right.candidate.dpi - left.candidate.dpi ||
        left.candidate.identifier.localeCompare(right.candidate.identifier)
    );

  const preferred = rankedByPreference[0];
  if (!preferred || preferred.preferenceScore <= 0) {
    return layer;
  }

  const existing = layer.find(
    (candidate) => candidate.card.identifier === preferred.candidate.identifier
  );
  if (existing) {
    return [
      { ...existing, reason: "name_only", score: undefined },
      ...layer.filter(
        (candidate) =>
          candidate.card.identifier !== preferred.candidate.identifier
      ),
    ];
  }

  return [
    {
      card: preferred.candidate,
      reason: "name_only",
      bucket: "name",
    },
    ...layer,
  ];
}

function prioritizeUnseenPreferenceScores(
  layer: RankedCandidate[],
  candidates: MpcAutofillCard[],
  unseenPreferenceScores: Record<string, number> | undefined
): RankedCandidate[] {
  if (!unseenPreferenceScores) {
    return layer;
  }

  const ranked = candidates
    .map((candidate) => ({
      candidate,
      score: unseenPreferenceScores[candidate.identifier],
    }))
    .filter((entry) => typeof entry.score === "number")
    .sort(
      (left, right) =>
        (right.score ?? 0) - (left.score ?? 0) ||
        right.candidate.dpi - left.candidate.dpi ||
        left.candidate.identifier.localeCompare(right.candidate.identifier)
    );

  const preferred = ranked[0];
  if (!preferred) {
    return layer;
  }

  const existing = layer.find(
    (candidate) => candidate.card.identifier === preferred.candidate.identifier
  );
  if (existing) {
    return [
      { ...existing, reason: "name_only", score: undefined },
      ...layer.filter(
        (candidate) =>
          candidate.card.identifier !== preferred.candidate.identifier
      ),
    ];
  }

  return [
    {
      card: preferred.candidate,
      reason: "name_only",
      bucket: "name",
    },
    ...layer,
  ];
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

/** Minimum absolute score to accept an SSIM result. */
const SSIM_MIN_SCORE = 0.92;

/** Minimum lead over runner-up to declare a decisive SSIM winner. */
const SSIM_MIN_MARGIN = 0.01;

/**
 * Cap the number of candidates that get expensive SSIM scoring. Cards like
 * Sol Ring can have hundreds of MPC variants — scoring them all stalls the
 * upgrader. Top-N by DPI keeps the highest-quality scans, which is also the
 * pool any DPI fallback would prefer.
 */
const MAX_SSIM_CANDIDATES = 30;

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

  const values = fragment.split(",").map((part) => Number(part));
  if (values.length !== 4 || values.some((value) => Number.isNaN(value))) {
    return { imageUrl };
  }

  const [top, right, bottom, left] = values;
  return {
    imageUrl,
    cropSpec: { top, right, bottom, left },
  };
}

function normalizeBitmap(
  bitmap: ImageBitmap,
  cropSpec?: CropSpec,
  normalizedSize = DEFAULT_NORMALIZED_SIZE
): NormalizedImage | null {
  const cropX = cropSpec
    ? Math.max(0, Math.floor(bitmap.width * cropSpec.left))
    : computeInset(bitmap.width);
  const cropY = cropSpec
    ? Math.max(0, Math.floor(bitmap.height * cropSpec.top))
    : computeInset(bitmap.height);
  const cropWidth = cropSpec
    ? Math.max(
        1,
        bitmap.width - cropX - Math.floor(bitmap.width * cropSpec.right)
      )
    : Math.max(1, bitmap.width - cropX * 2);
  const cropHeight = cropSpec
    ? Math.max(
        1,
        bitmap.height - cropY - Math.floor(bitmap.height * cropSpec.bottom)
      )
    : Math.max(1, bitmap.height - cropY * 2);

  const canvas = createCanvas(normalizedSize);
  const context = get2dContext(canvas);
  if (!context) return null;

  context.drawImage(
    bitmap,
    cropX,
    cropY,
    cropWidth,
    cropHeight,
    0,
    0,
    normalizedSize,
    normalizedSize
  );

  const { data, width, height } = context.getImageData(
    0,
    0,
    normalizedSize,
    normalizedSize
  );
  const pixels = new Float32Array(width * height);

  for (let i = 0; i < pixels.length; i += 1) {
    const offset = i * 4;
    const r = data[offset] / 255;
    const g = data[offset + 1] / 255;
    const b = data[offset + 2] / 255;
    pixels[i] = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  return { pixels, width, height };
}

function computeBlockScore(
  a: Float32Array,
  b: Float32Array,
  width: number,
  height: number
): number {
  const c1 = 0.01 * 0.01;
  const c2 = 0.03 * 0.03;
  let totalScore = 0;
  let blockCount = 0;

  for (let startY = 0; startY < height; startY += BLOCK_SIZE) {
    for (let startX = 0; startX < width; startX += BLOCK_SIZE) {
      let meanA = 0;
      let meanB = 0;
      let count = 0;

      const endY = Math.min(startY + BLOCK_SIZE, height);
      const endX = Math.min(startX + BLOCK_SIZE, width);

      for (let y = startY; y < endY; y += 1) {
        for (let x = startX; x < endX; x += 1) {
          const index = y * width + x;
          meanA += a[index];
          meanB += b[index];
          count += 1;
        }
      }

      if (count === 0) continue;

      meanA /= count;
      meanB /= count;

      let varianceA = 0;
      let varianceB = 0;
      let covariance = 0;

      for (let y = startY; y < endY; y += 1) {
        for (let x = startX; x < endX; x += 1) {
          const index = y * width + x;
          const deltaA = a[index] - meanA;
          const deltaB = b[index] - meanB;
          varianceA += deltaA * deltaA;
          varianceB += deltaB * deltaB;
          covariance += deltaA * deltaB;
        }
      }

      varianceA /= count;
      varianceB /= count;
      covariance /= count;

      const numerator = (2 * meanA * meanB + c1) * (2 * covariance + c2);
      const denominator =
        (meanA * meanA + meanB * meanB + c1) * (varianceA + varianceB + c2);

      if (denominator === 0) continue;

      totalScore += Math.max(0, Math.min(1, numerator / denominator));
      blockCount += 1;
    }
  }

  if (blockCount === 0) return 0;
  return totalScore / blockCount;
}

export function computeSobelMagnitude(
  pixels: Float32Array,
  width: number,
  height: number
): Float32Array {
  if (pixels.length !== width * height || width < 3 || height < 3) {
    return new Float32Array(pixels.length);
  }

  const edges = new Float32Array(pixels.length);
  let maxMagnitude = 0;

  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const topLeft = pixels[(y - 1) * width + (x - 1)];
      const top = pixels[(y - 1) * width + x];
      const topRight = pixels[(y - 1) * width + (x + 1)];
      const left = pixels[y * width + (x - 1)];
      const right = pixels[y * width + (x + 1)];
      const bottomLeft = pixels[(y + 1) * width + (x - 1)];
      const bottom = pixels[(y + 1) * width + x];
      const bottomRight = pixels[(y + 1) * width + (x + 1)];

      const gradientX =
        -topLeft + topRight - 2 * left + 2 * right - bottomLeft + bottomRight;
      const gradientY =
        -topLeft - 2 * top - topRight + bottomLeft + 2 * bottom + bottomRight;
      const magnitude = Math.hypot(gradientX, gradientY);
      const index = y * width + x;
      edges[index] = magnitude;
      if (magnitude > maxMagnitude) {
        maxMagnitude = magnitude;
      }
    }
  }

  if (maxMagnitude <= 0) {
    return edges;
  }

  for (let i = 0; i < edges.length; i += 1) {
    edges[i] /= maxMagnitude;
  }

  return edges;
}

export function computeEdgeScore(
  sourceEdges: Float32Array,
  candidateEdges: Float32Array
): number {
  if (
    sourceEdges.length !== candidateEdges.length ||
    sourceEdges.length === 0
  ) {
    return 0;
  }

  let dotProduct = 0;
  let sourceNorm = 0;
  let candidateNorm = 0;

  for (let i = 0; i < sourceEdges.length; i += 1) {
    const source = sourceEdges[i];
    const candidate = candidateEdges[i];
    dotProduct += source * candidate;
    sourceNorm += source * source;
    candidateNorm += candidate * candidate;
  }

  if (sourceNorm === 0 && candidateNorm === 0) {
    return 1;
  }

  if (sourceNorm === 0 || candidateNorm === 0) {
    return 0;
  }

  return Math.max(
    0,
    Math.min(1, dotProduct / Math.sqrt(sourceNorm * candidateNorm))
  );
}

function blendVisualScores(luminanceScore: number, edgeScore: number): number {
  return luminanceScore * LUMINANCE_WEIGHT + edgeScore * EDGE_WEIGHT;
}

async function loadNormalizedImage(
  imageUrl: string,
  signal: AbortSignal | undefined,
  cache: ImageCache,
  normalizedSize: number
): Promise<NormalizedImage | null> {
  const cacheKey = `${normalizedSize}:${imageUrl}`;
  const cached = cache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const loadPromise = (async () => {
    try {
      const decoded = decodeCropSpecFromUrl(imageUrl);
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

export function normalizeName(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeCanonicalCardName(value: string): string {
  return normalizeName(value)
    .replace(/\s*\[[^\]]+\]\s*\{[^}]+\}\s*/g, " ")
    .replace(/\s*\[[^\]]+\]\s*/g, " ")
    .replace(/\s*\{[^}]+\}\s*/g, " ")
    .replace(/\s*\([^)]*\)\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function filterByExactName(
  cards: MpcAutofillCard[],
  cardName: string
): MpcAutofillCard[] {
  const normalized = normalizeCanonicalCardName(cardName);
  return cards.filter(
    (card) =>
      normalizeCanonicalCardName(parseMpcCardName(card.name, card.name)) ===
      normalized
  );
}

/**
 * DPI descending, then identifier ascending for deterministic
 * tie-breaking when DPI values are equal.
 */
function sortByDpiThenId(cards: MpcAutofillCard[]): MpcAutofillCard[] {
  return [...cards].sort((a, b) => {
    const dpiDiff = (b.dpi || 0) - (a.dpi || 0);
    if (dpiDiff !== 0) return dpiDiff;
    return a.identifier.localeCompare(b.identifier);
  });
}

function normalizeCollectorNumberForMatch(collectorNumber: string): string {
  if (!/^\d+$/.test(collectorNumber)) {
    return collectorNumber;
  }

  const normalized = collectorNumber.replace(/^0+/, "");
  return normalized === "" ? "0" : normalized;
}

function bucketBySetCollector(
  candidates: MpcAutofillCard[],
  set?: string,
  collectorNumber?: string
): MpcAutofillCard[] {
  if (!set && !collectorNumber) return [];

  const normalizedSet = set?.toUpperCase() ?? "";
  const normalizedCN = collectorNumber
    ? normalizeCollectorNumberForMatch(collectorNumber)
    : "";

  return candidates.filter((card) => {
    const parsed = parseMpcSetCollector(card.rawName || card.name);
    if (!parsed) return false;

    const parsedCollectorNumber = normalizeCollectorNumberForMatch(
      parsed.collectorNumber
    );

    if (normalizedSet && normalizedCN) {
      return (
        parsed.set === normalizedSet && parsedCollectorNumber === normalizedCN
      );
    }
    if (normalizedSet && parsed.set) {
      return parsed.set === normalizedSet;
    }
    // CN-only is too ambiguous to match reliably
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

export async function scoreCandidatesBySsim(
  bucket: MpcAutofillCard[],
  sourceImageUrl: string,
  ssimCompare: SsimCompareFn,
  getMpcImageUrl: (identifier: string) => string,
  signal?: AbortSignal
): Promise<ScoredCandidate[]> {
  const limited = sortByDpiThenId(bucket).slice(0, MAX_SSIM_CANDIDATES);
  const scores: (number | null)[] = await Promise.all(
    limited.map((card) =>
      ssimCompare(
        sourceImageUrl,
        getMpcImageUrl(card.identifier),
        signal
      ).catch(() => null)
    )
  );

  const scored: ScoredCandidate[] = [];
  for (let i = 0; i < scores.length; i++) {
    const s = scores[i];
    if (s !== null) {
      scored.push({ card: limited[i], score: s });
    }
  }

  return scored.sort((a, b) => b.score - a.score);
}

async function scoreCandidatesByArtCrop(
  bucket: MpcAutofillCard[],
  sourceImageUrl: string,
  ssimCompare: SsimCompareFn,
  getMpcImageUrl: (identifier: string) => string,
  signal?: AbortSignal
): Promise<ScoredCandidate[]> {
  const sourceArtCropUrl = toArtCrop(sourceImageUrl);
  if (!sourceArtCropUrl) {
    return await scoreCandidatesBySsim(
      bucket,
      sourceImageUrl,
      ssimCompare,
      getMpcImageUrl,
      signal
    );
  }

  const limited = sortByDpiThenId(bucket).slice(0, MAX_SSIM_CANDIDATES);
  const scores: (number | null)[] = await Promise.all(
    limited.map((card) =>
      ssimCompare(
        sourceArtCropUrl,
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

function resolveFullProcessCandidates(
  candidates: MpcAutofillCard[],
  artScoredCandidates: ScoredCandidate[]
): MpcAutofillCard[] {
  if (candidates.length <= 1) {
    return candidates;
  }

  const topCandidate = artScoredCandidates[0];
  if (!topCandidate || topCandidate.score < SSIM_MIN_SCORE) {
    return candidates;
  }

  if (artScoredCandidates.length < 2) {
    return candidates;
  }

  const runnerUp = artScoredCandidates[1];
  if (topCandidate.score - runnerUp.score < SSIM_MIN_MARGIN) {
    return candidates;
  }

  const shortlisted = artScoredCandidates
    .filter(
      (candidate) => topCandidate.score - candidate.score < SSIM_MIN_MARGIN
    )
    .map((candidate) => candidate.card);

  return shortlisted.length > 0 ? shortlisted : candidates;
}

export async function rankCandidates(
  input: MatcherInput
): Promise<RankedRecommendations> {
  const { candidates } = input;
  const artMatchCompare = input.artMatchCompare ?? input.ssimCompare;
  let artScoredCandidates: ScoredCandidate[] = [];

  let artMatch: RankedCandidate[] = [];
  if (input.sourceImageUrl && artMatchCompare && input.getMpcImageUrl) {
    try {
      artScoredCandidates = await scoreCandidatesByArtCrop(
        candidates,
        input.sourceImageUrl,
        artMatchCompare,
        input.getMpcImageUrl,
        input.signal
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
      // SSIM infrastructure failure — artMatch stays empty
    }
  }

  const fullProcessCandidates = resolveFullProcessCandidates(
    candidates,
    artScoredCandidates
  );

  const fullCard = await buildFullCardLayer(input);
  const exactPrinting = await buildExactPrintingLayer(input);

  const fullProcess = prioritizePreferredCandidate(
    prioritizeUnseenPreferenceScores(
      prioritizePreferenceProfile(
        await buildFullProcessLayer({
          ...input,
          candidates: fullProcessCandidates,
        }),
        candidates,
        input.preferenceProfile
      ),
      candidates,
      input.unseenPreferenceScores
    ),
    candidates,
    input.preferredIdentifier
  );
  const allMatches = buildAllMatchesLayer(
    candidates,
    artMatch,
    exactPrinting,
    fullCard
  );

  return {
    fullProcess,
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

async function buildExactPrintingLayer(
  input: MatcherInput
): Promise<RankedCandidate[]> {
  const {
    candidates,
    set,
    collectorNumber,
    sourceImageUrl,
    signal,
    ssimCompare,
    getMpcImageUrl,
  } = input;

  const setCollectorBucket = bucketBySetCollector(
    candidates,
    set,
    collectorNumber
  );
  const setOnlyBucket = set ? bucketBySetOnly(candidates, set) : [];
  const remainingSetOnly = setOnlyBucket.filter(
    (candidate) =>
      !setCollectorBucket.some(
        (exactCandidate) => exactCandidate.identifier === candidate.identifier
      )
  );

  const rankedSetCollector = await rankWithinBucket(
    setCollectorBucket,
    "set_collector",
    sourceImageUrl,
    signal,
    ssimCompare,
    getMpcImageUrl
  );
  const rankedSetOnly = await rankWithinBucket(
    remainingSetOnly,
    "set",
    sourceImageUrl,
    signal,
    ssimCompare,
    getMpcImageUrl
  );

  return [...rankedSetCollector, ...rankedSetOnly].slice(
    0,
    MAX_RECOMMENDATIONS
  );
}

async function buildFullCardLayer(
  input: MatcherInput
): Promise<RankedCandidate[]> {
  // Preserve the existing full-card comparison path for ranked recommendations.
  // Until a distinct art-crop scorer exists, this reuses the current full-card
  // SSIM comparator and only falls back to DPI ordering when comparison is
  // unavailable or inconclusive.
  return await rankWithinBucket(
    input.candidates,
    "name",
    input.sourceImageUrl,
    input.signal,
    input.ssimCompare,
    input.getMpcImageUrl
  );
}

async function buildFullProcessLayer(
  input: MatcherInput
): Promise<RankedCandidate[]> {
  const {
    candidates,
    set,
    collectorNumber,
    sourceImageUrl,
    signal,
    ssimCompare,
    getMpcImageUrl,
  } = input;

  if (candidates.length === 0) return [];

  const setCollectorBucket = bucketBySetCollector(
    candidates,
    set,
    collectorNumber
  );
  if (setCollectorBucket.length > 0) {
    return await rankWithinBucket(
      setCollectorBucket,
      "set_collector",
      sourceImageUrl,
      signal,
      ssimCompare,
      getMpcImageUrl
    );
  }

  if (set) {
    const setOnlyBucket = bucketBySetOnly(candidates, set);
    if (setOnlyBucket.length > 0) {
      return await rankWithinBucket(
        setOnlyBucket,
        "set",
        sourceImageUrl,
        signal,
        ssimCompare,
        getMpcImageUrl
      );
    }
  }

  return await rankWithinBucket(
    candidates,
    "name",
    sourceImageUrl,
    signal,
    ssimCompare,
    getMpcImageUrl
  );
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

export async function selectBestCandidate(
  input: MatcherInput
): Promise<MatchResult | null> {
  const { candidates, preferredIdentifier } = input;
  if (candidates.length === 0) return null;

  if (preferredIdentifier) {
    const preferredCard = candidates.find(
      (candidate) => candidate.identifier === preferredIdentifier
    );
    if (preferredCard) {
      return { card: preferredCard, reason: "name_only" };
    }
  }

  const ranked = await rankCandidates(input);
  const top = ranked.fullProcess[0];
  if (!top) return null;

  // When the top two SSIM scores are within SSIM_MIN_MARGIN, the match is
  // inconclusive — fall back to DPI ordering to preserve pre-refactor behavior.
  const second = ranked.fullProcess[1];
  if (
    top.score !== undefined &&
    second?.score !== undefined &&
    top.score - second.score < SSIM_MIN_MARGIN
  ) {
    const bucket = ranked.fullProcess.map((r) => r.card);
    const byDpi = sortByDpiThenId(bucket);
    const reason = `${top.bucket ?? "name"}_dpi_fallback` as MatchReason;
    return { card: byDpi[0], reason };
  }

  return { card: top.card, reason: top.reason };
}
