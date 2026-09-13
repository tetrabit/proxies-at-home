import { db } from "@/db";
import type { CardOption } from "@/types";
import { inferImageSource, inferSourceFromUrl } from "./imageSourceUtils";
import {
  batchSearchMpcAutofill,
  getMpcAutofillImageUrl,
  type MpcAutofillCard,
} from "./mpcAutofillApi";
import { addRemoteImage } from "./dbUtils";
import { normalizeDfcName } from "../../../shared/cardNameUtils";
import {
  createSsimCompare,
  FULL_CARD_NORMALIZED_SIZE,
  selectBestCandidate,
  filterByExactName,
} from "./mpcBulkUpgradeMatcher";
import {
  getMpcCalibrationPreferenceProfile,
  getMpcCalibrationPreferredIdentifier,
  listDefaultMpcCalibrationCases,
} from "./mpcCalibrationStorage";
import {
  buildMpcPreferenceScoreMap,
  trainMpcPreferenceModel,
  type MpcPreferenceModel,
} from "./mpcPreferenceModel";
import {
  hydrateMpcPreferences,
  type MpcHarvestedSourceExample,
} from "./mpcPreferenceBootstrap";
import {
  buildMpcSourceVisualProfiles,
  buildMpcVisualPreferenceScoreMap,
  type MpcSourceVisualProfile,
} from "./mpcVisualPreference";
import type { MpcCalibrationCaseRecord } from "@/db";
import { createMpcBulkUpgradeLogger } from "./mpcBulkUpgradeLogger";

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

/**
 * Shared state for the duration of a bulk upgrade to avoid redundant
 * DB lookups and bootstrap harvesting.
 */
interface PreferenceContext {
  calibrationCases: MpcCalibrationCaseRecord[];
  model: MpcPreferenceModel | null;
  profiles: Record<string, MpcSourceVisualProfile>;
}

type BulkImageRecord =
  | { source?: string; sourceUrl?: string; imageUrls?: string[] }
  | undefined;

type MpcCardType = "CARD" | "TOKEN";

const PREFERENCE_PROFILE_SOURCES = new Set([
  "Hathwellcrisping",
  "Chilli_Axe",
]);
const MAX_VISUAL_SAMPLES_PER_SOURCE = 8;

function getCardType(card: CardOption): MpcCardType {
  return card.isToken ||
    (card.type_line && card.type_line.toLowerCase().includes("token"))
    ? "TOKEN"
    : "CARD";
}

function getImageSource(imageId: string, imageRecord: BulkImageRecord) {
  return (
    imageRecord?.source ??
    inferSourceFromUrl(imageRecord?.sourceUrl || imageRecord?.imageUrls?.[0]) ??
    inferImageSource(imageId)
  );
}

function getSearchKey(cardType: MpcCardType, normalizedName: string) {
  return `${cardType}:${normalizedName}`;
}

function buildStoredPreferenceExamples(
  calibrationCases: MpcCalibrationCaseRecord[]
): MpcHarvestedSourceExample[] {
  const sampleCounts = new Map<string, number>();
  const examples: MpcHarvestedSourceExample[] = [];

  for (const calibrationCase of calibrationCases) {
    const expected = calibrationCase.expectedIdentifier
      ? calibrationCase.candidates.find(
          (candidate) =>
            candidate.identifier === calibrationCase.expectedIdentifier
        )
      : undefined;
    if (
      !expected ||
      !PREFERENCE_PROFILE_SOURCES.has(expected.sourceName) ||
      !expected.imageUrl
    ) {
      continue;
    }

    const sampleCount = sampleCounts.get(expected.sourceName) ?? 0;
    if (sampleCount >= MAX_VISUAL_SAMPLES_PER_SOURCE) continue;

    sampleCounts.set(expected.sourceName, sampleCount + 1);
    examples.push({
      cardName: calibrationCase.source.name,
      sourceName: expected.sourceName,
      candidates: [
        {
          identifier: expected.identifier,
          name: expected.name,
          rawName: expected.rawName ?? expected.name,
          dpi: expected.dpi,
          tags: expected.tags,
          sourceName: expected.sourceName,
          imageUrl: expected.imageUrl,
        },
      ],
    });
  }

  return examples;
}

async function prefetchMpcCandidates(
  entries: Array<[string, CardOption[]]>,
  imageById: Map<string, BulkImageRecord>,
  signal?: AbortSignal
): Promise<{ candidates: Map<string, MpcAutofillCard[]>; queryCount: number; candidateCount: number }> {
  const queriesByType: Record<MpcCardType, string[]> = {
    CARD: [],
    TOKEN: [],
  };

  for (const [imageId, group] of entries) {
    if (signal?.aborted) break;
    if (getImageSource(imageId, imageById.get(imageId)) !== "scryfall") {
      continue;
    }

    const representative = group[0];
    const cardType = getCardType(representative);
    const normalizedName = normalizeDfcName(representative.name);
    if (!queriesByType[cardType].includes(normalizedName)) {
      queriesByType[cardType].push(normalizedName);
    }
  }

  const prefetched = new Map<string, MpcAutofillCard[]>();
  for (const cardType of ["CARD", "TOKEN"] as const) {
    if (signal?.aborted) break;
    const queries = queriesByType[cardType];
    if (queries.length === 0) continue;

    const results = await batchSearchMpcAutofill(queries, cardType);
    for (const query of queries) {
      prefetched.set(getSearchKey(cardType, query), results[query] ?? []);
    }
  }

  return {
    candidates: prefetched,
    queryCount: queriesByType.CARD.length + queriesByType.TOKEN.length,
    candidateCount: Array.from(prefetched.values()).reduce(
      (total, candidates) => total + candidates.length,
      0
    ),
  };
}

/**
 * Prepares the preference context (trained model and visual profiles)
 * used to score candidates when no explicit user replay exists.
 */
async function preparePreferenceContext(
  signal?: AbortSignal
): Promise<PreferenceContext> {
  await hydrateMpcPreferences();
  const calibrationCases = await listDefaultMpcCalibrationCases();

  const model = trainMpcPreferenceModel(calibrationCases, {
    emphasizedSources: ["Hathwellcrisping", "Chilli_Axe"],
  });

  if (!model) {
    return { calibrationCases, model: null, profiles: {} };
  }

  const harvested = buildStoredPreferenceExamples(calibrationCases);

  const profiles = await buildMpcSourceVisualProfiles(harvested, signal);

  return { calibrationCases, model, profiles };
}

// ── Main bulk upgrade ────────────────────────────────────────────────────

/**
 * Process a single image group: search MPC, find best match, apply upgrade.
 * Returns the number of cards upgraded, skipped, or errored.
 */
async function processImageGroup(
  imageId: string,
  group: CardOption[],
  imageById: Map<string, BulkImageRecord>,
  prefetchedCandidates: Map<string, MpcAutofillCard[]>,
  ssimCompare: ReturnType<typeof createSsimCompare>,
  prefContext: PreferenceContext,
  logger: ReturnType<typeof createMpcBulkUpgradeLogger>,
  groupIndex: number,
  processedImages: number,
  signal?: AbortSignal
): Promise<{ upgraded: number; skipped: number; errors: number }> {
  const result = { upgraded: 0, skipped: 0, errors: 0 };

  const imageRecord = imageById.get(imageId);
  const representative = group[0];
  const source = getImageSource(imageId, imageRecord);
  const cardType = getCardType(representative);
  logger.phaseStarted("matching", {
    groupIndex,
    processedImages,
    cardName: representative.name,
    affectedCards: group.length,
    cardType,
  });

  if (source !== "scryfall") {
    result.skipped = group.length;
    logger.groupStarted({ reason: "source-not-scryfall" });
    logger.phaseCompleted("matching", { reason: "source-not-scryfall", skipped: result.skipped });
    logger.groupCompleted({ reason: "source-not-scryfall", skipped: result.skipped });
    return result;
  }

  const normalizedName = normalizeDfcName(representative.name);
  const results =
    prefetchedCandidates.get(getSearchKey(cardType, normalizedName)) ?? [];
  const exactMatches = results
    ? filterByExactName(results, normalizedName)
    : [];
  logger.groupStarted({
    candidateCount: results.length,
    exactMatchCount: exactMatches.length,
  });
  if (!results || results.length === 0 || exactMatches.length === 0) {
    result.skipped = group.length;
    const reason = results.length === 0 ? "no-candidates" : "no-exact-match";
    logger.phaseCompleted("matching", { reason, skipped: result.skipped });
    logger.groupCompleted({ reason, skipped: result.skipped });
    return result;
  }

  // ── Find best candidate via matcher ──
  const preferenceInput = {
    name: representative.name,
    set: representative.set,
    collectorNumber: representative.number,
  };
  const [preferredIdentifier, preferenceProfile] = await Promise.all([
    getMpcCalibrationPreferredIdentifier(preferenceInput),
    getMpcCalibrationPreferenceProfile(preferenceInput),
  ]);

  const unseenPreferenceScores =
    preferredIdentifier || preferenceProfile || !prefContext.model
      ? undefined
      : await (async () => {
          const { model, profiles } = prefContext;

          const metadataScores = buildMpcPreferenceScoreMap(
            model,
            exactMatches
          );

          const visualScores = await buildMpcVisualPreferenceScoreMap(
            exactMatches,
            profiles,
            model,
            signal
          );

          return Object.fromEntries(
            exactMatches.map((candidate) => [
              candidate.identifier,
              metadataScores[candidate.identifier] +
                (visualScores[candidate.identifier] ?? 0),
            ])
          );
        })();

  const matchResult = (await selectBestCandidate({
    candidates: exactMatches,
    set: representative.set,
    collectorNumber: representative.number,
    sourceImageUrl:
      imageRecord?.sourceUrl || imageRecord?.imageUrls?.[0] || imageId,
    signal,
    ssimCompare,
    getMpcImageUrl: (identifier) => getMpcAutofillImageUrl(identifier, "small"),
    preferredIdentifier,
    preferenceProfile,
    unseenPreferenceScores,
  }))!;

  const bestCard = matchResult.card;
  const scoringMode = preferredIdentifier || preferenceProfile
    ? "calibration-replay"
    : prefContext.model
      ? "computed-preference"
      : "default-selection";
  logger.phaseCompleted("matching", {
    reason: matchResult.reason,
    selectedIdentifier: bestCard.identifier,
    sourceName: bestCard.sourceName,
    dpi: bestCard.dpi,
    outcome: scoringMode,
  });

  // ── Apply the upgrade ──
  logger.phaseStarted("image-acquisition", {
    cardName: representative.name,
    groupIndex,
    affectedCards: group.length,
    selectedIdentifier: bestCard.identifier,
    sourceName: bestCard.sourceName,
    dpi: bestCard.dpi,
  });
  const imageUrlMpc = getMpcAutofillImageUrl(bestCard.identifier);
  const newImageId = await addRemoteImage([imageUrlMpc], group.length);
  logger.phaseCompleted("image-acquisition", {
    selectedIdentifier: bestCard.identifier,
    sourceName: bestCard.sourceName,
    dpi: bestCard.dpi,
    outcome: newImageId ? "acquired" : "unavailable",
  });
  if (!newImageId) {
    result.skipped = group.length;
    logger.groupCompleted({ reason: "image-unavailable", skipped: result.skipped });
    return result;
  }

  logger.phaseStarted("persistence", {
    cardName: representative.name,
    groupIndex,
    affectedCards: group.length,
    selectedIdentifier: bestCard.identifier,
  });

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
    logger.phaseCompleted("persistence", { outcome: "committed", upgraded: result.upgraded });
    logger.groupCompleted({
      reason: matchResult.reason,
      selectedIdentifier: bestCard.identifier,
      sourceName: bestCard.sourceName,
      dpi: bestCard.dpi,
      upgraded: result.upgraded,
    });
  } catch (error) {
    const errorName = error instanceof Error && error.name === "AbortError"
      ? "AbortError"
      : "Error";
    result.errors = group.length;
    logger.phaseCompleted("persistence", { reason: "persistence", errorName, errors: result.errors });
    logger.groupCompleted({ reason: "persistence", errorName, errors: result.errors });
  }

  return result;
}

export async function bulkUpgradeToMpcAutofill(
  options: BulkUpgradeOptions = {}
): Promise<BulkMpcUpgradeSummary> {
  const { projectId, onProgress, signal } = options;
  const logger = createMpcBulkUpgradeLogger({ signal });
  let summary: BulkMpcUpgradeSummary = { totalCards: 0, upgraded: 0, skipped: 0, errors: 0 };
  let totalImages = 0;
  let processedImages = 0;
  let stage = "card-loading";

  try {
    logger.started({ projectId });
    logger.phaseStarted(stage);
    const cards = projectId
      ? await db.cards.where("projectId").equals(projectId).toArray()
      : await db.cards.toArray();
    const cardsWithImages = cards.filter((card) =>
      Boolean(card.imageId) && !card.usesDefaultCardback && !card.imageId!.startsWith("cardback_")
    );
    cardsWithImages.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    summary = { totalCards: cardsWithImages.length, upgraded: 0, skipped: 0, errors: 0 };
    const cardsByImageId = new Map<string, CardOption[]>();
    for (const card of cardsWithImages) {
      const imageId = card.imageId!;
      const group = cardsByImageId.get(imageId) || [];
      group.push(card);
      cardsByImageId.set(imageId, group);
    }
    const allEntries = Array.from(cardsByImageId.entries());
    totalImages = allEntries.length;
    logger.phaseCompleted(stage, { inputCards: cards.length, eligibleCards: cardsWithImages.length, totalCards: summary.totalCards, totalImages, processedImages });
    if (cardsWithImages.length === 0) {
      logger.completed({ totalCards: 0, totalImages: 0, processedImages: 0, upgraded: 0, skipped: 0, errors: 0, outcome: "completed" });
      return summary;
    }

    stage = "image-loading";
    logger.phaseStarted(stage, { totalImages, processedImages });
    const imageIds = Array.from(cardsByImageId.keys());
    const images = await db.images.bulkGet(imageIds);
    const imageById = new Map<string, (typeof images)[number]>();
    imageIds.forEach((id, idx) => imageById.set(id, images[idx]));
    logger.phaseCompleted(stage, { totalImages, processedImages });

    stage = "prefetch";
    logger.phaseStarted(stage, { totalImages, processedImages });
    const prefetched = await prefetchMpcCandidates(allEntries, imageById, signal);
    logger.progress({ totalImages, processedImages });
    logger.phaseCompleted(stage, { queryCount: prefetched.queryCount, candidateCount: prefetched.candidateCount, totalImages, processedImages });
    if (signal?.aborted) {
      logger.cancelled({ totalCards: summary.totalCards, totalImages, processedImages, upgraded: 0, skipped: 0, errors: 0, reason: "aborted", outcome: "cancelled" });
      return summary;
    }

    stage = "preferences";
    logger.phaseStarted(stage, { totalImages, processedImages });
    const prefContext = await preparePreferenceContext(signal);
    logger.phaseCompleted(stage, { calibrationCases: prefContext.calibrationCases.length, profileCount: Object.keys(prefContext.profiles).length, outcome: prefContext.model ? "trained" : "no-model" });
    const ssimCompare = createSsimCompare(undefined, FULL_CARD_NORMALIZED_SIZE);

    for (let i = 0; i < totalImages; i++) {
      if (signal?.aborted) break;
      const [imageId, group] = allEntries[i];
      const cardName = group[0].name;
      logger.progress({ processedImages, totalImages, cardName, groupIndex: i + 1, upgraded: summary.upgraded, skipped: summary.skipped, errors: summary.errors });
      stage = "callback";
      onProgress?.({ processedImages, totalImages, fraction: processedImages / totalImages, currentCardName: cardName, summary: { ...summary } });
      stage = "matching";
      await new Promise((resolve) => setTimeout(resolve, 0));
      const result = await processImageGroup(imageId, group, imageById, prefetched.candidates, ssimCompare, prefContext, logger, i + 1, processedImages, signal);
      processedImages += 1;
      summary.upgraded += result.upgraded;
      summary.skipped += result.skipped;
      summary.errors += result.errors;
      logger.progress({ processedImages, totalImages, upgraded: summary.upgraded, skipped: summary.skipped, errors: summary.errors });
    }

    if (signal?.aborted) {
      logger.cancelled({ totalCards: summary.totalCards, totalImages, processedImages, upgraded: summary.upgraded, skipped: summary.skipped, errors: summary.errors, reason: "aborted", outcome: "cancelled" });
      return summary;
    }

    stage = "callback";
    onProgress?.({ processedImages, totalImages, fraction: processedImages / totalImages, currentCardName: "", summary: { ...summary } });
    const terminalFields = { totalCards: summary.totalCards, totalImages, processedImages, upgraded: summary.upgraded, skipped: summary.skipped, errors: summary.errors };
    if (summary.errors > 0) {
      logger.failed({ ...terminalFields, reason: "group-errors", errorName: "Error", outcome: "failed" });
    } else {
      logger.completed({ ...terminalFields, outcome: "completed" });
    }
    return summary;
  } catch (error) {
    const errorName = error instanceof Error && error.name === "AbortError" ? "AbortError" : "Error";
    const fields = { totalCards: summary.totalCards, totalImages, processedImages, upgraded: summary.upgraded, skipped: summary.skipped, errors: summary.errors, errorName };
    if (signal?.aborted && errorName === "AbortError") {
      logger.cancelled({ ...fields, reason: "aborted", outcome: "cancelled" });
    } else {
      logger.failed({ ...fields, ...(stage === "callback" ? { phase: stage, reason: stage } : {}), outcome: "failed" });
    }
    throw error;
  } finally {
    logger.close();
  }
}
