import "fake-indexeddb/auto";
import Dexie from "dexie";
import { describe, expect, it } from "vitest";
import { ProxxiedDexie } from "./db";
import type { CardOption } from "@/types";

const cardsV21Schema =
  "&uuid, imageId, order, name, needsEnrichment, needs_token, linkedFrontId, linkedBackId, projectId, oracle_id, scryfall_id";

function createCard(
  uuid: string,
  projectId: string,
  order: number
): CardOption & { migrationMarker: { source: string; values: number[] } } {
  return {
    uuid,
    projectId,
    order,
    name: `Card ${uuid}`,
    imageId: `image-${uuid}`,
    isUserUpload: true,
    hasBuiltInBleed: true,
    bleedMode: "existing",
    existingBleedMm: 3,
    generateBleedMm: 2,
    set: "TST",
    number: "123",
    scryfall_id: `scryfall-${uuid}`,
    oracle_id: `oracle-${uuid}`,
    lang: "en",
    colors: ["U", "R"],
    mana_cost: "{1}{U}{R}",
    cmc: 3,
    type_line: "Creature — Wizard",
    rarity: "rare",
    category: "Mainboard",
    needsEnrichment: false,
    enrichmentRetryCount: 2,
    enrichmentNextRetryAt: 123456,
    lookupError: "prior lookup",
    linkedFrontId: `front-${uuid}`,
    linkedBackId: `back-${uuid}`,
    usesDefaultCardback: false,
    isFlipped: true,
    overrides: { brightness: 0.1, contrast: 0.2 },
    token_parts: [{ id: `token-${uuid}`, name: "Treasure", type_line: "Token Artifact" }],
    needs_token: true,
    isToken: false,
    tokenAddedFrom: ["Source Card"],
    migrationMarker: { source: "v21", values: [1, 2, 3] },
  };
}

describe("ProxxiedDexie project order index upgrade", () => {
  it("retains v21 cards and queries duplicate per-project order values through the compound index", async () => {
    const databaseName = `project-order-index-${crypto.randomUUID()}`;
    const v21 = new Dexie(databaseName);

    v21.version(21).stores({
      cards: cardsV21Schema,
      images:
        "&id, refCount, displayDpi, displayBleedWidth, exportDpi, exportBleedWidth",
      cardbacks: "&id",
      settings: "&id",
      imageCache: "&url, cachedAt",
      cardMetadataCache:
        "id, name, set, number, oracle_id, scryfall_id, cachedAt",
      effectCache: "&key, cachedAt",
      mpcSearchCache: "&[query+cardType], cachedAt",
      projects: "&id, shareId, lastOpenedAt",
      userPreferences: "&id",
      user_images: "&hash",
      mpcCalibrationDatasets: "&id, updatedAt",
      mpcCalibrationCases: "&id, datasetId, updatedAt",
      mpcCalibrationAssets: "&id, datasetId, caseId, candidateIdentifier, role",
      mpcCalibrationRuns: "&id, datasetId, createdAt, algorithmId",
      fsAccessHandles: "&id, updatedAt",
    });

    const seededCards = [
      createCard("project-a-first", "project-a", 7),
      createCard("project-a-second", "project-a", 7),
      createCard("project-b-first", "project-b", 7),
    ];

    await v21.open();
    await v21.table("cards").bulkAdd(seededCards);
    v21.close();

    const upgraded = new ProxxiedDexie(databaseName);
    await upgraded.open();

    expect(await upgraded.cards.toArray()).toEqual(seededCards);
    await expect(
      upgraded.cards.where("[projectId+order]").equals(["project-a", 7]).toArray()
    ).resolves.toEqual([seededCards[0], seededCards[1]]);
    await expect(
      upgraded.cards.where("[projectId+order]").equals(["project-b", 7]).toArray()
    ).resolves.toEqual([seededCards[2]]);

    upgraded.close();
  });
});
