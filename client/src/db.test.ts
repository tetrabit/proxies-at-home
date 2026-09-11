import "fake-indexeddb/auto";
import { Blob as NodeBlob } from "node:buffer";
import Dexie from "dexie";
import { describe, expect, it } from "vitest";
import { ProxxiedDexie } from "./db";
import type { CardOption } from "@/types";
import { validateCalibrationHarnessLocalState } from "../../shared/calibrationHarnessLocalState";

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

describe("ProxxiedDexie v24 calibration cache support", () => {
  it("upgrades a real v23 predecessor without altering complete C1, harness, or unrelated records", async () => {
    const databaseName = `calibration-cache-v24-${crypto.randomUUID()}`;
    const v23 = new Dexie(databaseName);
    v23.version(22).stores({
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
    v23.version(23).stores({
      mpcCalibrationSyncStates: "&[ownerId+harnessId+connectionId], ownerId, harnessId, connectionId, updatedAt",
    });
    const assetBytes = new Uint8Array([1, 2, 3, 4]);
    const predecessorSnapshot = {
      version: 1 as const, retainedRoot: { unknown: ["root"] },
      datasets: [{ id: "dataset", name: "Dataset", targetCaseCount: 1, createdAt: 1, updatedAt: 2, version: 1, retained: { dataset: true } }],
      cases: [{ id: "case", datasetId: "dataset", createdAt: 3, updatedAt: 4, source: { name: "Card" }, candidates: [], retained: { case: true } }],
      assets: [{ id: "asset", datasetId: "dataset", caseId: "case", role: "source" as const, mimeType: "image/png", createdAt: 5, hash: "legacy", sha256: "9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a", byteLength: 4, retained: { asset: true } }],
      runs: [{ id: "run", datasetId: "dataset", algorithmId: "algorithm", algorithmLabel: "Algorithm", createdAt: 6, summary: { totalCases: 0, matchedCases: 0, mismatchedCases: 0, accuracy: 0 }, results: [], retained: { run: true } }],
    };
    const syncState = {
      formatVersion: 1 as const,
      ownerId: "owner", harnessId: "harness", connectionId: "connection", updatedAt: 7,
      dirtyGeneration: 5, sentGeneration: 4, acknowledgedGeneration: 3,
      base: { revision: 7, snapshot: structuredClone(predecessorSnapshot) },
      queued: { generation: 5, snapshot: { ...structuredClone(predecessorSnapshot), queuedSentinel: true } },
      inFlight: { generation: 4, expectedBaseRevision: 7, snapshot: { ...structuredClone(predecessorSnapshot), inFlightSentinel: true } },
      lastAcknowledgement: {
        generation: 3, expectedBaseRevision: 6, snapshot: structuredClone(predecessorSnapshot),
        base: { revision: 7, snapshot: structuredClone(predecessorSnapshot) },
      },
    };
    validateCalibrationHarnessLocalState(syncState);
    await v23.open();
    expect(v23.verno).toBe(23);
    await Promise.all([
      v23.table("cards").add(createCard("card", "project", 3)), v23.table("images").add({ id: "image", refCount: 1, retained: true }),
      v23.table("cardbacks").add({ id: "cardback", retained: true }), v23.table("settings").add({ id: "settings", value: { sentinel: true } }),
      v23.table("imageCache").add({ url: "cache", cachedAt: 1, retained: true }), v23.table("cardMetadataCache").add({ id: "metadata", name: "n", set: "s", number: "1", cachedAt: 1, data: {}, retained: true }),
      v23.table("effectCache").add({ key: "effect", cachedAt: 1, retained: true }), v23.table("mpcSearchCache").add({ query: "q", cardType: "CARD", cachedAt: 1, retained: true }),
      v23.table("projects").add({ id: "project", lastOpenedAt: 1, retained: true }), v23.table("userPreferences").add({ id: "default", retained: true }),
      v23.table("user_images").add({ hash: "hash", retained: true }), v23.table("fsAccessHandles").add({ id: "handle", updatedAt: 1, retained: true }),
      v23.table("mpcCalibrationDatasets").add(predecessorSnapshot.datasets[0]), v23.table("mpcCalibrationCases").add(predecessorSnapshot.cases[0]),
      v23.table("mpcCalibrationAssets").add({ ...predecessorSnapshot.assets[0], blob: new NodeBlob([assetBytes], { type: "image/png" }) }),
      v23.table("mpcCalibrationRuns").add(predecessorSnapshot.runs[0]), v23.table("mpcCalibrationSyncStates").add(syncState),
    ]);
    const predecessorRows = new Map<string, unknown[]>();
    const predecessorIndexes = new Map<string, { primary: string; indexes: string[] }>();
    for (const table of v23.tables) {
      predecessorRows.set(table.name, await table.toArray());
      predecessorIndexes.set(table.name, { primary: table.schema.primKey.src, indexes: table.schema.indexes.map(index => index.src).sort() });
    }
    v23.close();

    const upgraded = new ProxxiedDexie(databaseName);
    await upgraded.open();
    expect(upgraded.verno).toBe(24);
    expect(upgraded.tables.map((table) => table.name)).toEqual(expect.arrayContaining(["mpcCalibrationCacheBindings", "mpcCalibrationHydrationStaging"]));
    expect(await Promise.all([upgraded.mpcCalibrationCacheBindings.count(), upgraded.mpcCalibrationHydrationStaging.count()])).toEqual([0, 0]);
    upgraded.close();

    const reopened = new ProxxiedDexie(databaseName);
    await reopened.open();
    for (const [name, rows] of predecessorRows) {
      expect(await reopened.table(name).toArray(), `${name} predecessor records`).toEqual(rows);
      const schema = reopened.table(name).schema;
      expect({ primary: schema.primKey.src, indexes: schema.indexes.map(index => index.src).sort() }, `${name} predecessor indexes`).toEqual(predecessorIndexes.get(name));
    }
    expect(await Promise.all(["cards", "images", "cardbacks", "settings", "imageCache", "cardMetadataCache", "effectCache", "mpcSearchCache", "projects", "userPreferences", "user_images", "fsAccessHandles", "mpcCalibrationDatasets", "mpcCalibrationCases", "mpcCalibrationAssets", "mpcCalibrationRuns", "mpcCalibrationSyncStates"].map(table => reopened.table(table).count()))).toEqual(Array(17).fill(1));
    expect(await reopened.mpcCalibrationSyncStates.get(["owner", "harness", "connection"])).toEqual(syncState);
    expect(await reopened.table("settings").get("settings")).toEqual({ id: "settings", value: { sentinel: true } });
    const restoredAsset = await reopened.mpcCalibrationAssets.get("asset");
    expect(restoredAsset).toMatchObject({ ...predecessorSnapshot.assets[0], blob: expect.any(Blob) });
    expect(await blobBytes(restoredAsset!.blob)).toEqual([...assetBytes]);
    expect(restoredAsset!.blob.type).toBe("image/png");
    expect(await Promise.all([reopened.mpcCalibrationCacheBindings.count(), reopened.mpcCalibrationHydrationStaging.count()])).toEqual([0, 0]);
    reopened.close();
  });
});
