import "fake-indexeddb/auto";
import { Blob as NodeBlob } from "node:buffer";
import Dexie from "dexie";
import { describe, expect, it } from "vitest";
import { ProxxiedDexie } from "./db";
import type { CardOption } from "@/types";

const cardsV21Schema =
  "&uuid, imageId, order, name, needsEnrichment, needs_token, linkedFrontId, linkedBackId, projectId, oracle_id, scryfall_id";

function blobBytes(blob: Blob): Promise<number[]> {
  return (blob as unknown as { arrayBuffer(): Promise<ArrayBuffer> }).arrayBuffer().then(
    (value) => Array.from(new Uint8Array(value))
  );
}

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

describe("ProxxiedDexie v23 calibration sync state migration", () => {
  it("preserves every v22 store and harness Blob bytes through upgrade and reopen", async () => {
    const databaseName = `calibration-sync-v23-${crypto.randomUUID()}`;
    const v22 = new Dexie(databaseName);
    v22.version(22).stores({
      cards: `${cardsV21Schema}, [projectId+order]`,
      images: "&id, refCount, displayDpi, displayBleedWidth, exportDpi, exportBleedWidth",
      cardbacks: "&id", settings: "&id", imageCache: "&url, cachedAt",
      cardMetadataCache: "id, name, set, number, oracle_id, scryfall_id, cachedAt",
      effectCache: "&key, cachedAt", mpcSearchCache: "&[query+cardType], cachedAt",
      projects: "&id, shareId, lastOpenedAt", userPreferences: "&id", user_images: "&hash",
      mpcCalibrationDatasets: "&id, updatedAt", mpcCalibrationCases: "&id, datasetId, updatedAt",
      mpcCalibrationAssets: "&id, datasetId, caseId, candidateIdentifier, role",
      mpcCalibrationRuns: "&id, datasetId, createdAt, algorithmId", fsAccessHandles: "&id, updatedAt",
    });
    const assetBytes = new Uint8Array([11, 22, 33, 44]);
    const asset = { id: "asset", datasetId: "dataset", caseId: "case", role: "source", mimeType: "image/png", blob: new NodeBlob([assetBytes], { type: "image/png" }), createdAt: 10, hash: "legacy-hash", retained: { unknown: true } };
    await v22.open();
    await Promise.all([
      v22.table("cards").add(createCard("card", "project", 3)), v22.table("images").add({ id: "image", refCount: 1 }),
      v22.table("cardbacks").add({ id: "cardback", retained: true }), v22.table("settings").add({ id: "settings", value: { sentinel: "settings" } }),
      v22.table("imageCache").add({ url: "cache", cachedAt: 1 }), v22.table("cardMetadataCache").add({ id: "metadata", name: "n", set: "s", number: "1", cachedAt: 1, data: {} }),
      v22.table("effectCache").add({ key: "effect", cachedAt: 1 }), v22.table("mpcSearchCache").add({ query: "q", cardType: "CARD", cachedAt: 1 }),
      v22.table("projects").add({ id: "project", lastOpenedAt: 1 }), v22.table("userPreferences").add({ id: "default", retained: "preference" }),
      v22.table("user_images").add({ hash: "hash", retained: true }),
      v22.table("mpcCalibrationDatasets").add({ id: "dataset", name: "Dataset", targetCaseCount: 1, createdAt: 1, updatedAt: 2, version: 1, retained: { dataset: [1] } }),
      v22.table("mpcCalibrationCases").add({ id: "case", datasetId: "dataset", createdAt: 3, updatedAt: 4, source: { name: "Card" }, candidates: [], retained: { case: [2] } }),
      v22.table("mpcCalibrationAssets").add(asset),
      v22.table("mpcCalibrationRuns").add({ id: "run", datasetId: "dataset", algorithmId: "algorithm", createdAt: 5, summary: { totalCases: 0, matchedCases: 0, mismatchedCases: 0, accuracy: 0 }, results: [], retained: { run: [3] } }),
      v22.table("fsAccessHandles").add({ id: "handle", updatedAt: 1, retained: true }),
    ]);
    v22.close();

    const upgraded = new ProxxiedDexie(databaseName);
    await upgraded.open();
    expect(await upgraded.table("mpcCalibrationSyncStates").count()).toBe(0);
    expect(await upgraded.cards.where("[projectId+order]").equals(["project", 3]).count()).toBe(1);
    upgraded.close();

    const reopened = new ProxxiedDexie(databaseName);
    await reopened.open();
    const restoredAsset = await reopened.mpcCalibrationAssets.get("asset");
    expect(await Promise.all(["mpcCalibrationDatasets", "mpcCalibrationCases", "mpcCalibrationAssets", "mpcCalibrationRuns"].map((table) => reopened.table(table).count()))).toEqual([1, 1, 1, 1]);
    expect(await reopened.table("settings").get("settings")).toEqual({ id: "settings", value: { sentinel: "settings" } });
    expect(restoredAsset).toMatchObject({ id: "asset", hash: "legacy-hash", retained: { unknown: true } });
    expect(await blobBytes(restoredAsset!.blob)).toEqual(Array.from(assetBytes));
    expect(restoredAsset!.blob.type).toBe("image/png");
    expect(await reopened.table("mpcCalibrationSyncStates").count()).toBe(0);
    reopened.close();
  });
});
