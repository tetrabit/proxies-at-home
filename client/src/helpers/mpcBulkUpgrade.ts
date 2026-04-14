import { db } from "@/db";
import type { CardOption } from "@/types";
import { inferImageSource } from "./imageSourceUtils";
import { searchMpcAutofill, getMpcAutofillImageUrl } from "./mpcAutofillApi";
import { addRemoteImage } from "./dbUtils";
import { loadImage } from "./imageProcessing";
import { toProxied } from "./imageHelper";
import {
  computeColorProfile,
  computeColorProfileSimilarity,
  type ColorProfile,
} from "./mpcColorScoring";
import {
  filterByExactName,
  type HashDistanceFn,
  selectBestCandidate,
  type VisualCompareFn,
} from "./mpcBulkUpgradeMatcher";

export type BulkMpcUpgradeSummary = {
  totalCards: number;
  upgraded: number;
  skipped: number;
  errors: number;
};

export type BulkUpgradeProgress = {
  /** Unique images processed so far (1-indexed) */
  processedImages: number;
  /** Total unique images to process */
  totalImages: number;
  /** 0-1 fraction complete */
  fraction: number;
  /** Name of the card currently being processed */
  currentCardName: string;
  /** Running summary */
  summary: BulkMpcUpgradeSummary;
};

export type BulkUpgradeOptions = {
  projectId?: string;
  /** Called after each unique image is processed */
  onProgress?: (progress: BulkUpgradeProgress) => void;
  /** AbortSignal to cancel the upgrade */
  signal?: AbortSignal;
};

export type BulkUpgradeDiagnostic = {
  projectId?: string;
  imageId: string;
  cardName: string;
  cardUuids: string[];
  set?: string;
  collectorNumber?: string;
  status: "matched" | "ambiguous" | "skipped" | "error";
  reason: string;
  candidateCount: number;
  matchedIdentifier?: string;
  confidence?: number;
  runnerUpConfidence?: number;
  createdAt: number;
};

// ── Visual matching constants ────────────────────────────────────────────
const SSIM_SIZE = 128; // Up from 64 — more detail for visual comparison
const SSIM_CHANNELS = 3; // RGB instead of grayscale
const MAX_CANDIDATES = 25;
const HASH_ROWS = 8;
const HASH_COLUMNS = 9;
const STRUCTURE_WEIGHT = 0.8;
const COLOR_PROFILE_WEIGHT = 0.2;
const BULK_UPGRADE_DIAGNOSTIC_PREFIX = "mpc-bulk-upgrade-diagnostic";

// ── Layer 2: Color-aware SSIM visual matching ────────────────────────────

/**
 * Compute per-channel (RGB) pixel data at SSIM_SIZE × SSIM_SIZE.
 * Returns 3 Float32Arrays [R, G, B], each length SSIM_SIZE².
 */
async function computeImageChannels(
  url: string,
  cache: Map<string, Float32Array[]>
): Promise<Float32Array[] | null> {
  if (!url) return null;
  const cached = cache.get(url);
  if (cached) return cached;

  try {
    const bitmap = await loadImage(toProxied(url));
    const canvas = document.createElement("canvas");
    canvas.width = SSIM_SIZE;
    canvas.height = SSIM_SIZE;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      bitmap.close();
      return null;
    }

    ctx.drawImage(bitmap, 0, 0, SSIM_SIZE, SSIM_SIZE);
    bitmap.close();

    const data = ctx.getImageData(0, 0, SSIM_SIZE, SSIM_SIZE).data;
    const n = SSIM_SIZE * SSIM_SIZE;
    const channels: Float32Array[] = [];
    for (let ch = 0; ch < SSIM_CHANNELS; ch++) {
      const values = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        values[i] = data[i * 4 + ch] / 255;
      }
      channels.push(values);
    }

    cache.set(url, channels);
    return channels;
  } catch (error) {
    console.warn("[MPC Bulk Upgrade] Failed to read image:", url, error);
    return null;
  }
}

/**
 * SSIM between two Float32Arrays of equal length.
 */
function computeSsim(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) return 0;

  let meanA = 0;
  let meanB = 0;
  for (let i = 0; i < a.length; i += 1) {
    meanA += a[i];
    meanB += b[i];
  }
  meanA /= a.length;
  meanB /= b.length;

  let varA = 0;
  let varB = 0;
  let cov = 0;
  for (let i = 0; i < a.length; i += 1) {
    const da = a[i] - meanA;
    const db = b[i] - meanB;
    varA += da * da;
    varB += db * db;
    cov += da * db;
  }

  varA /= a.length;
  varB /= b.length;
  cov /= a.length;

  const c1 = 0.01 * 0.01;
  const c2 = 0.03 * 0.03;

  const numerator = (2 * meanA * meanB + c1) * (2 * cov + c2);
  const denominator = (meanA * meanA + meanB * meanB + c1) * (varA + varB + c2);
  if (denominator === 0) return 0;
  return Math.max(0, Math.min(1, numerator / denominator));
}

/**
 * Compute average SSIM across RGB channels.
 */
function computeColorSsim(a: Float32Array[], b: Float32Array[]): number {
  if (a.length !== SSIM_CHANNELS || b.length !== SSIM_CHANNELS) return 0;

  let total = 0;
  for (let ch = 0; ch < SSIM_CHANNELS; ch++) {
    total += computeSsim(a[ch], b[ch]);
  }
  return total / SSIM_CHANNELS;
}

// ── Helpers ──────────────────────────────────────────────────────────────

function createVisualCompare(
  channelCache: Map<string, Float32Array[]>,
  colorProfileCache: Map<string, ColorProfile>
): VisualCompareFn {
  return async (sourceImageUrl, candidate) => {
    const baseChannels = await computeImageChannels(
      sourceImageUrl,
      channelCache
    );
    if (!baseChannels) return null;
    const baseProfile = getOrComputeColorProfile(
      sourceImageUrl,
      baseChannels,
      colorProfileCache
    );

    const thumbnailUrl = getMpcAutofillImageUrl(candidate.identifier, "small");
    if (!thumbnailUrl) return null;

    const candidateChannels = await computeImageChannels(
      thumbnailUrl,
      channelCache
    );
    if (!candidateChannels) return null;
    const candidateProfile = getOrComputeColorProfile(
      thumbnailUrl,
      candidateChannels,
      colorProfileCache
    );

    const structuralScore = computeColorSsim(baseChannels, candidateChannels);
    const colorProfileScore = computeColorProfileSimilarity(
      baseProfile,
      candidateProfile
    );

    return (
      structuralScore * STRUCTURE_WEIGHT +
      colorProfileScore * COLOR_PROFILE_WEIGHT
    );
  };
}

function getOrComputeColorProfile(
  imageUrl: string,
  channels: Float32Array[],
  colorProfileCache: Map<string, ColorProfile>
): ColorProfile {
  const cachedProfile = colorProfileCache.get(imageUrl);
  if (cachedProfile) {
    return cachedProfile;
  }

  const profile = computeColorProfile(channels);
  colorProfileCache.set(imageUrl, profile);
  return profile;
}

function computePerceptualHash(channels: Float32Array[]): bigint {
  const [red, green, blue] = channels;
  const cellWidth = SSIM_SIZE / HASH_COLUMNS;
  const cellHeight = SSIM_SIZE / HASH_ROWS;
  const sampled = new Array<number>(HASH_COLUMNS * HASH_ROWS).fill(0);

  for (let row = 0; row < HASH_ROWS; row += 1) {
    const startY = Math.floor(row * cellHeight);
    const endY = Math.max(startY + 1, Math.floor((row + 1) * cellHeight));

    for (let column = 0; column < HASH_COLUMNS; column += 1) {
      const startX = Math.floor(column * cellWidth);
      const endX = Math.max(startX + 1, Math.floor((column + 1) * cellWidth));
      let total = 0;
      let count = 0;

      for (let y = startY; y < endY; y += 1) {
        for (let x = startX; x < endX; x += 1) {
          const index = y * SSIM_SIZE + x;
          total +=
            0.2126 * red[index] + 0.7152 * green[index] + 0.0722 * blue[index];
          count += 1;
        }
      }

      sampled[row * HASH_COLUMNS + column] = count === 0 ? 0 : total / count;
    }
  }

  let hash = 0n;
  for (let row = 0; row < HASH_ROWS; row += 1) {
    for (let column = 0; column < HASH_COLUMNS - 1; column += 1) {
      const left = sampled[row * HASH_COLUMNS + column];
      const right = sampled[row * HASH_COLUMNS + column + 1];
      hash = (hash << 1n) | (left > right ? 1n : 0n);
    }
  }

  return hash;
}

function computeHammingDistance(left: bigint, right: bigint): number {
  let distance = 0;
  let value = left ^ right;

  while (value > 0n) {
    distance += Number(value & 1n);
    value >>= 1n;
  }

  return distance;
}

async function getOrComputeImageHash(
  imageUrl: string,
  channelCache: Map<string, Float32Array[]>,
  hashCache: Map<string, bigint>
): Promise<bigint | null> {
  const cachedHash = hashCache.get(imageUrl);
  if (cachedHash !== undefined) {
    return cachedHash;
  }

  const channels = await computeImageChannels(imageUrl, channelCache);
  if (!channels) return null;

  const hash = computePerceptualHash(channels);
  hashCache.set(imageUrl, hash);
  return hash;
}

function createHashDistance(
  channelCache: Map<string, Float32Array[]>,
  hashCache: Map<string, bigint>
): HashDistanceFn {
  return async (sourceImageUrl, candidate) => {
    const sourceHash = await getOrComputeImageHash(
      sourceImageUrl,
      channelCache,
      hashCache
    );
    if (sourceHash === null) return null;

    const thumbnailUrl = getMpcAutofillImageUrl(candidate.identifier, "small");
    if (!thumbnailUrl) return null;

    const candidateHash = await getOrComputeImageHash(
      thumbnailUrl,
      channelCache,
      hashCache
    );
    if (candidateHash === null) return null;

    return computeHammingDistance(sourceHash, candidateHash);
  };
}

function buildDiagnostic(
  group: CardOption[],
  imageId: string,
  status: BulkUpgradeDiagnostic["status"],
  reason: string,
  candidateCount: number,
  details: Partial<
    Pick<
      BulkUpgradeDiagnostic,
      "matchedIdentifier" | "confidence" | "runnerUpConfidence"
    >
  > = {}
): BulkUpgradeDiagnostic {
  const representative = group[0];

  return {
    projectId: representative.projectId,
    imageId,
    cardName: representative.name,
    cardUuids: group.map((card) => card.uuid),
    set: representative.set,
    collectorNumber: representative.number,
    status,
    reason,
    candidateCount,
    matchedIdentifier: details.matchedIdentifier,
    confidence: details.confidence,
    runnerUpConfidence: details.runnerUpConfidence,
    createdAt: Date.now(),
  };
}

async function persistDiagnostic(
  diagnostic: BulkUpgradeDiagnostic
): Promise<void> {
  const projectSegment = diagnostic.projectId ?? "global";
  const key = [
    BULK_UPGRADE_DIAGNOSTIC_PREFIX,
    projectSegment,
    diagnostic.createdAt,
    diagnostic.imageId,
  ].join(":");

  await db.settings.put({
    id: key,
    value: diagnostic,
  });
}

// ── Main bulk upgrade ────────────────────────────────────────────────────

/**
 * Process a single image group: search MPC, find best match, apply upgrade.
 * Returns the number of cards upgraded, skipped, or errored.
 */
async function processImageGroup(
  imageId: string,
  group: CardOption[],
  imageById: Map<
    string,
    { source?: string; sourceUrl?: string; imageUrls?: string[] } | undefined
  >,
  channelCache: Map<string, Float32Array[]>,
  hashCache: Map<string, bigint>,
  colorProfileCache: Map<string, ColorProfile>
): Promise<{ upgraded: number; skipped: number; errors: number }> {
  const result = { upgraded: 0, skipped: 0, errors: 0 };

  const imageRecord = imageById.get(imageId);
  const source = imageRecord?.source ?? inferImageSource(imageId);
  if (source !== "scryfall") {
    console.debug(
      `[MPC Bulk Upgrade] Skipping "${group[0].name}": source is "${source}", not scryfall`
    );
    await persistDiagnostic(
      buildDiagnostic(group, imageId, "skipped", "source_not_scryfall", 0)
    );
    result.skipped = group.length;
    return result;
  }

  const representative = group[0];
  const cardType = representative.isToken ? "TOKEN" : "CARD";
  const results = await searchMpcAutofill(representative.name, cardType, true);
  const exactMatches = results
    ? filterByExactName(results, representative.name)
    : [];
  if (!results || results.length === 0 || exactMatches.length === 0) {
    console.debug(
      `[MPC Bulk Upgrade] Skipping "${representative.name}": no MPC results (searched=${results?.length ?? 0}, exactMatches=${exactMatches.length})`
    );
    await persistDiagnostic(
      buildDiagnostic(
        group,
        imageId,
        "skipped",
        "no_exact_name_match",
        exactMatches.length
      )
    );
    result.skipped = group.length;
    return result;
  }

  const bestCandidate = await selectBestCandidate({
    candidates: exactMatches.slice(0, MAX_CANDIDATES),
    set: representative.set,
    collectorNumber: representative.number,
    sourceImageUrl:
      imageRecord?.sourceUrl || imageRecord?.imageUrls?.[0] || imageId,
    hashDistance: createHashDistance(channelCache, hashCache),
    visualCompare: createVisualCompare(channelCache, colorProfileCache),
  });

  if (!bestCandidate || bestCandidate.status !== "matched") {
    await persistDiagnostic(
      buildDiagnostic(
        group,
        imageId,
        bestCandidate ? "ambiguous" : "skipped",
        bestCandidate ? bestCandidate.reason : "no_candidate_selected",
        exactMatches.length,
        bestCandidate?.status === "ambiguous"
          ? {
              confidence: bestCandidate.bestConfidence,
              runnerUpConfidence: bestCandidate.runnerUpConfidence,
            }
          : {}
      )
    );
    result.skipped = group.length;
    return result;
  }

  const bestCard = bestCandidate.card;

  // ── Apply the upgrade ──
  const imageUrlMpc = getMpcAutofillImageUrl(bestCard.identifier);
  const newImageId = await addRemoteImage([imageUrlMpc], group.length);
  if (!newImageId) {
    await persistDiagnostic(
      buildDiagnostic(
        group,
        imageId,
        "error",
        "image_store_failed",
        exactMatches.length,
        {
          matchedIdentifier: bestCard.identifier,
          confidence: bestCandidate.confidence,
        }
      )
    );
    result.skipped = group.length;
    return result;
  }

  try {
    await db.transaction("rw", db.cards, db.images, db.settings, async () => {
      await db.cards.bulkUpdate(
        group.map((card) => ({
          key: card.uuid,
          changes: {
            imageId: newImageId,
            isUserUpload: false,
            hasBuiltInBleed: true,
            lookupError: undefined,
            enrichmentRetryCount: undefined,
            enrichmentNextRetryAt: undefined,
          },
        }))
      );

      if (imageId !== newImageId) {
        const oldImage = await db.images.get(imageId);
        if (oldImage) {
          const newRefCount = oldImage.refCount - group.length;
          if (newRefCount > 0) {
            await db.images.update(imageId, { refCount: newRefCount });
          } else {
            await db.images.delete(imageId);
          }
        }
      }
      await persistDiagnostic(
        buildDiagnostic(
          group,
          imageId,
          "matched",
          bestCandidate.reason,
          exactMatches.length,
          {
            matchedIdentifier: bestCard.identifier,
            confidence: bestCandidate.confidence,
          }
        )
      );
    });

    result.upgraded = group.length;
  } catch (error) {
    console.warn(
      "[MPC Bulk Upgrade] Failed to apply upgrade:",
      representative.name,
      error
    );
    await persistDiagnostic(
      buildDiagnostic(
        group,
        imageId,
        "error",
        "apply_upgrade_failed",
        exactMatches.length,
        {
          matchedIdentifier: bestCard.identifier,
          confidence: bestCandidate.confidence,
        }
      )
    );
    result.errors = group.length;
  }

  return result;
}

export async function bulkUpgradeToMpcAutofill(
  options: BulkUpgradeOptions = {}
): Promise<BulkMpcUpgradeSummary> {
  const { projectId, onProgress, signal } = options;
  const cards: CardOption[] = projectId
    ? await db.cards.where("projectId").equals(projectId).toArray()
    : await db.cards.toArray();

  const cardsWithImages = cards.filter((card) => {
    if (!card.imageId) return false;
    // Skip cards using the default cardback (generic MTG back)
    if (card.usesDefaultCardback) return false;
    // Skip cards whose imageId is a cardback library entry (e.g. cardback_builtin_blank)
    if (card.imageId.startsWith("cardback_")) return false;
    return true;
  });
  // Sort by page order so upgrades visibly progress top-left → bottom-right
  cardsWithImages.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const summary: BulkMpcUpgradeSummary = {
    totalCards: cardsWithImages.length,
    upgraded: 0,
    skipped: 0,
    errors: 0,
  };

  if (cardsWithImages.length === 0) {
    return summary;
  }

  const cardsByImageId = new Map<string, CardOption[]>();
  for (const card of cardsWithImages) {
    const imageId = card.imageId!;
    const group = cardsByImageId.get(imageId) || [];
    group.push(card);
    cardsByImageId.set(imageId, group);
  }

  const imageIds = Array.from(cardsByImageId.keys());
  const images = await db.images.bulkGet(imageIds);
  const imageById = new Map<string, (typeof images)[number]>();
  imageIds.forEach((id, idx) => {
    imageById.set(id, images[idx]);
  });

  const allEntries = Array.from(cardsByImageId.entries());
  const totalImages = allEntries.length;
  const channelCache = new Map<string, Float32Array[]>();
  const hashCache = new Map<string, bigint>();
  const colorProfileCache = new Map<string, ColorProfile>();

  for (let i = 0; i < totalImages; i++) {
    if (signal?.aborted) break;

    const [imageId, group] = allEntries[i];
    const cardName = group[0].name;

    // Report progress BEFORE processing so the user sees which card is being worked on
    onProgress?.({
      processedImages: i,
      totalImages,
      fraction: i / totalImages,
      currentCardName: cardName,
      summary: { ...summary },
    });

    // Yield to the event loop so React can re-render the progress bar
    await new Promise((resolve) => setTimeout(resolve, 0));

    const result = await processImageGroup(
      imageId,
      group,
      imageById,
      channelCache,
      hashCache,
      colorProfileCache
    );
    summary.upgraded += result.upgraded;
    summary.skipped += result.skipped;
    summary.errors += result.errors;
  }

  // Final progress (100%)
  onProgress?.({
    processedImages: totalImages,
    totalImages,
    fraction: 1,
    currentCardName: "",
    summary: { ...summary },
  });

  return summary;
}
