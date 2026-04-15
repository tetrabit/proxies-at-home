import { db } from "@/db";
import type { CardOption } from "@/types";
import { inferImageSource, inferSourceFromUrl } from "./imageSourceUtils";
import { searchMpcAutofill, getMpcAutofillImageUrl } from "./mpcAutofillApi";
import { addRemoteImage } from "./dbUtils";
import {
  createSsimCompare,
  selectBestCandidate,
  filterByExactName,
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
  ssimCompare: ReturnType<typeof createSsimCompare>,
  signal?: AbortSignal
): Promise<{ upgraded: number; skipped: number; errors: number }> {
  const result = { upgraded: 0, skipped: 0, errors: 0 };

  const imageRecord = imageById.get(imageId);
  const source =
    imageRecord?.source ??
    inferSourceFromUrl(imageRecord?.sourceUrl || imageRecord?.imageUrls?.[0]) ??
    inferImageSource(imageId);
  if (source !== "scryfall") {
    console.debug(
      `[MPC Bulk Upgrade] Skipping "${group[0].name}": source is "${source}", not scryfall`
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
    result.skipped = group.length;
    return result;
  }

  // ── Find best candidate via matcher ──
  const matchResult = await selectBestCandidate({
    candidates: exactMatches,
    set: representative.set,
    collectorNumber: representative.number,
    sourceImageUrl:
      imageRecord?.sourceUrl || imageRecord?.imageUrls?.[0] || imageId,
    signal,
    ssimCompare,
    getMpcImageUrl: (identifier) => getMpcAutofillImageUrl(identifier, "small"),
  });

  if (!matchResult) {
    // Should not happen (exactMatches is non-empty), but guard for TypeScript
    result.skipped = group.length;
    return result;
  }

  const bestCard = matchResult.card;

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
    console.warn(
      "[MPC Bulk Upgrade] Failed to apply upgrade:",
      representative.name,
      error
    );
    result.errors = group.length;
  }

  return result;
}

export async function bulkUpgradeToMpcAutofill(
  options: BulkUpgradeOptions = {}
): Promise<BulkMpcUpgradeSummary> {
  const { projectId, onProgress, signal } = options;
  const cards = projectId
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
  const ssimCompare = createSsimCompare();

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
      ssimCompare,
      signal
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
