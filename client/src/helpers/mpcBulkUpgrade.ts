import { db } from "@/db";
import type { CardOption } from "@/types";
import { inferImageSource } from "./imageSourceUtils";
import { searchMpcAutofill, getMpcAutofillImageUrl, type MpcAutofillCard } from "./mpcAutofillApi";
import { addRemoteImage } from "./dbUtils";
import { loadImage } from "./imageProcessing";
import { toProxied } from "./imageHelper";
import { parseMpcCardName, parseMpcSetCollector } from "./mpcUtils";

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

// ── Visual matching constants ────────────────────────────────────────────
const SSIM_SIZE = 128;          // Up from 64 — more detail for visual comparison
const SSIM_CHANNELS = 3;       // RGB instead of grayscale
const MAX_CANDIDATES = 25;
const MIN_CONFIDENCE = 0.7;

// ── Layer 1: Set code + collector number matching ────────────────────────

/**
 * Try to find an MPC card that matches the Scryfall card's set + collector number.
 * This is the most reliable matching method — exact printing identification.
 *
 * When multiple candidates match set+CN, prefer the highest DPI version.
 */
function findBySetCollector(
  candidates: MpcAutofillCard[],
  set?: string,
  collectorNumber?: string
): MpcAutofillCard | null {
  if (!set && !collectorNumber) return null;

  const normalizedSet = set?.toUpperCase() ?? "";
  const normalizedCN = collectorNumber ?? "";

  const matches = candidates.filter((card) => {
    const parsed = parseMpcSetCollector(card.rawName || card.name);
    if (!parsed) return false;

    // Both set and CN available → require both to match
    if (normalizedSet && normalizedCN) {
      return parsed.set === normalizedSet && parsed.collectorNumber === normalizedCN;
    }
    // Only set available → match set (weak, but better than nothing)
    if (normalizedSet && parsed.set) {
      return parsed.set === normalizedSet;
    }
    // Only CN available → match CN (even weaker, skip — too ambiguous)
    return false;
  });

  if (matches.length === 0) return null;

  // Prefer highest DPI among matches
  matches.sort((a, b) => (b.dpi || 0) - (a.dpi || 0));
  return matches[0];
}


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

/**
 * Pick the MPC card visually closest to the source image using color SSIM.
 */
async function pickClosestMpcMatch(
  baseChannels: Float32Array[],
  candidates: MpcAutofillCard[],
  channelCache: Map<string, Float32Array[]>
): Promise<{ card: MpcAutofillCard; confidence: number } | null> {
  let best: MpcAutofillCard | null = null;
  let bestScore = -1;

  for (const candidate of candidates) {
    const thumbUrl = candidate.mediumThumbnailUrl || candidate.smallThumbnailUrl;
    if (!thumbUrl) continue;

    const candidateChannels = await computeImageChannels(thumbUrl, channelCache);
    if (!candidateChannels) continue;

    const score = computeColorSsim(baseChannels, candidateChannels);
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }

  if (!best || bestScore < 0) return null;

  return { card: best, confidence: bestScore };
}


// ── Helpers ──────────────────────────────────────────────────────────────

function normalizeName(value: string): string {
  return value.trim().toLowerCase();
}

function filterByExactName(cards: MpcAutofillCard[], cardName: string): MpcAutofillCard[] {
  const normalized = normalizeName(cardName);
  return cards.filter((card) => normalizeName(parseMpcCardName(card.name, card.name)) === normalized);
}


// ── Main bulk upgrade ────────────────────────────────────────────────────

/**
 * Process a single image group: search MPC, find best match, apply upgrade.
 * Returns the number of cards upgraded, skipped, or errored.
 */
async function processImageGroup(
  imageId: string,
  group: CardOption[],
  imageById: Map<string, { source?: string; sourceUrl?: string; imageUrls?: string[] } | undefined>,
  channelCache: Map<string, Float32Array[]>,
): Promise<{ upgraded: number; skipped: number; errors: number }> {
  const result = { upgraded: 0, skipped: 0, errors: 0 };

  const imageRecord = imageById.get(imageId);
  const source = imageRecord?.source ?? inferImageSource(imageId);
  if (source !== "scryfall") {
    console.debug(`[MPC Bulk Upgrade] Skipping "${group[0].name}": source is "${source}", not scryfall`);
    result.skipped = group.length;
    return result;
  }

  const representative = group[0];
  const cardType = representative.isToken ? "TOKEN" : "CARD";
  const results = await searchMpcAutofill(representative.name, cardType, true);
  const exactMatches = results ? filterByExactName(results, representative.name) : [];
  if (!results || results.length === 0 || exactMatches.length === 0) {
    console.debug(`[MPC Bulk Upgrade] Skipping "${representative.name}": no MPC results (searched=${results?.length ?? 0}, exactMatches=${exactMatches.length})`);
    result.skipped = group.length;
    return result;
  }

  // ── Layer 1: Set + Collector Number match ──
  let bestCard: MpcAutofillCard | null = null;
  const setCodeMatch = findBySetCollector(
    exactMatches,
    representative.set,
    representative.number
  );

  if (setCodeMatch) {
    bestCard = setCodeMatch;
  }

  // ── Layer 2: Color SSIM visual match (fallback) ──
  if (!bestCard) {
    const imageUrl = imageRecord?.sourceUrl || imageRecord?.imageUrls?.[0] || imageId;
    const baseChannels = await computeImageChannels(imageUrl, channelCache);
    if (!baseChannels) {
      result.skipped = group.length;
      return result;
    }

    const candidates = exactMatches.slice(0, MAX_CANDIDATES);
    const best = await pickClosestMpcMatch(baseChannels, candidates, channelCache);
    if (!best || best.confidence < MIN_CONFIDENCE) {
      result.skipped = group.length;
      return result;
    }
    bestCard = best.card;
  }

  // ── Apply the upgrade ──
  const imageUrlMpc = getMpcAutofillImageUrl(bestCard.identifier);
  const newImageId = await addRemoteImage([imageUrlMpc], group.length);
  if (!newImageId) {
    result.skipped = group.length;
    return result;
  }

  try {
    await db.transaction("rw", db.cards, db.images, async () => {
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
    });

    result.upgraded = group.length;
  } catch (error) {
    console.warn("[MPC Bulk Upgrade] Failed to apply upgrade:", representative.name, error);
    result.errors = group.length;
  }

  return result;
}

export async function bulkUpgradeToMpcAutofill(options: BulkUpgradeOptions = {}): Promise<BulkMpcUpgradeSummary> {
  const { projectId, onProgress, signal } = options;
  const cards = projectId
    ? await db.cards.where("projectId").equals(projectId).toArray()
    : await db.cards.toArray();

  const cardsWithImages = cards.filter((card) => card.imageId);
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

    const result = await processImageGroup(imageId, group, imageById, channelCache);
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
