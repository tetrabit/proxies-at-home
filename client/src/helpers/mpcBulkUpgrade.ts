import { db } from "@/db";
import type { CardOption } from "@/types";
import { inferImageSource } from "./imageSourceUtils";
import { searchMpcAutofill, getMpcAutofillImageUrl, type MpcAutofillCard } from "./mpcAutofillApi";
import { addRemoteImage } from "./dbUtils";
import { loadImage } from "./imageProcessing";
import { toProxied } from "./imageHelper";
import { parseMpcCardName } from "./mpcUtils";

export type BulkMpcUpgradeSummary = {
  totalCards: number;
  upgraded: number;
  skipped: number;
  errors: number;
};

const SSIM_SIZE = 64;
const MAX_CANDIDATES = 25;
const MIN_CONFIDENCE = 0.7;

async function computeImageLuma(url: string, cache: Map<string, Float32Array>): Promise<Float32Array | null> {
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
    const values = new Float32Array(SSIM_SIZE * SSIM_SIZE);
    for (let i = 0; i < values.length; i += 1) {
      const idx = i * 4;
      const gray = 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
      values[i] = gray / 255;
    }

    cache.set(url, values);
    return values;
  } catch (error) {
    console.warn("[MPC Bulk Upgrade] Failed to read image:", url, error);
    return null;
  }
}

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

async function pickClosestMpcMatch(
  baseLuma: Float32Array,
  candidates: MpcAutofillCard[],
  lumaCache: Map<string, Float32Array>
): Promise<{ card: MpcAutofillCard; confidence: number } | null> {
  let best: MpcAutofillCard | null = null;
  let bestScore = -1;

  for (const candidate of candidates) {
    const thumbUrl = candidate.mediumThumbnailUrl || candidate.smallThumbnailUrl;
    if (!thumbUrl) continue;

    const candidateLuma = await computeImageLuma(thumbUrl, lumaCache);
    if (!candidateLuma) continue;

    const score = computeSsim(baseLuma, candidateLuma);
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }

  if (!best || bestScore < 0) return null;

  return { card: best, confidence: bestScore };
}

function normalizeName(value: string): string {
  return value.trim().toLowerCase();
}

function filterByExactName(cards: MpcAutofillCard[], cardName: string): MpcAutofillCard[] {
  const normalized = normalizeName(cardName);
  return cards.filter((card) => normalizeName(parseMpcCardName(card.name, card.name)) === normalized);
}

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

  const lumaCache = new Map<string, Float32Array>();

  for (const [imageId, group] of cardsByImageId.entries()) {
    const imageRecord = imageById.get(imageId);
    const source = imageRecord?.source ?? inferImageSource(imageId);
    if (source !== "scryfall") {
      summary.skipped += group.length;
      continue;
    }

    const imageUrl = imageRecord?.sourceUrl || imageRecord?.imageUrls?.[0] || imageId;
    const baseLuma = await computeImageLuma(imageUrl, lumaCache);
    if (!baseLuma) {
      summary.skipped += group.length;
      continue;
    }

    const representative = group[0];
    const cardType = representative.isToken ? "TOKEN" : "CARD";
    const results = await searchMpcAutofill(representative.name, cardType, true);
    const exactMatches = results ? filterByExactName(results, representative.name) : [];
    if (!results || results.length === 0 || exactMatches.length === 0) {
      summary.skipped += group.length;
      continue;
    }

    const candidates = exactMatches.slice(0, MAX_CANDIDATES);
    const best = await pickClosestMpcMatch(baseLuma, candidates, lumaCache);
    if (!best || best.confidence < MIN_CONFIDENCE) {
      summary.skipped += group.length;
      continue;
    }

    const imageUrlMpc = getMpcAutofillImageUrl(best.card.identifier);
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
