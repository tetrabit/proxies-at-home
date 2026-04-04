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

export async function bulkUpgradeToMpcAutofill(options: { projectId?: string } = {}): Promise<BulkMpcUpgradeSummary> {
  const { projectId } = options;
  const cards = projectId
    ? await db.cards.where("projectId").equals(projectId).toArray()
    : await db.cards.toArray();

  const cardsWithImages = cards.filter((card) => card.imageId);
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

  const channelCache = new Map<string, Float32Array[]>();

  for (const [imageId, group] of cardsByImageId.entries()) {
    const imageRecord = imageById.get(imageId);
    const source = imageRecord?.source ?? inferImageSource(imageId);
    if (source !== "scryfall") {
      summary.skipped += group.length;
      continue;
    }

    const representative = group[0];
    const cardType = representative.isToken ? "TOKEN" : "***";
    const results = await searchMpcAutofill(representative.name, cardType, true);
    const exactMatches = results ? filterByExactName(results, representative.name) : [];
    if (!results || results.length === 0 || exactMatches.length === 0) {
      summary.skipped += group.length;
      continue;
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
        summary.skipped += group.length;
        continue;
      }

      const candidates = exactMatches.slice(0, MAX_CANDIDATES);
      const best = await pickClosestMpcMatch(baseChannels, candidates, channelCache);
      if (!best || best.confidence < MIN_CONFIDENCE) {
        summary.skipped += group.length;
        continue;
      }
      bestCard = best.card;
    }

    // ── Apply the upgrade ──
    const imageUrlMpc = getMpcAutofillImageUrl(bestCard.identifier);
    const newImageId = await addRemoteImage([imageUrlMpc], group.length);
    if (!newImageId) {
      summary.skipped += group.length;
      continue;
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

      summary.upgraded += group.length;
    } catch (error) {
      console.warn("[MPC Bulk Upgrade] Failed to apply upgrade:", representative.name, error);
      summary.errors += group.length;
    }
  }

  return summary;
}
