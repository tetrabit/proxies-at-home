import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../db";
import { importProject, type ProjectBackup } from "./projectBackup";

let sequence = 0;

function unique(prefix: string): string {
  sequence += 1;
  return `${prefix}-${sequence}`;
}

function createBackup(
  suffix: string,
  userImages: ProjectBackup["userImages"],
  cards: ProjectBackup["cards"] = []
): ProjectBackup {
  return {
    version: 1,
    exportedAt: "2026-04-04T12:00:00.000Z",
    app: "proxxied",
    project: { name: `Atomic ${suffix}`, createdAt: 100, settings: { columns: 3 } },
    cards,
    userImages,
  };
}

async function snapshotTables() {
  return {
    userImages: await db.user_images.toArray(),
    projects: await db.projects.toArray(),
    cards: await db.cards.toArray(),
    images: await db.images.toArray(),
    userPreferences: await db.userPreferences.toArray(),
  };
}

async function seedUnrelatedState(suffix: string) {
  const existingHash = unique(`existing-image-${suffix}`);
  const cacheImageId = unique(`cache-image-${suffix}`);
  const preferenceId = unique(`preferences-${suffix}`);

  await db.user_images.add({
    hash: existingHash,
    data: new Blob(["existing"], { type: "text/plain" }),
    type: "text/existing",
    createdAt: 1,
  });
  await db.images.add({ id: cacheImageId, refCount: 7 });
  await db.userPreferences.add({
    id: preferenceId as "default",
    settings: { untouched: true },
    favoriteCardbacks: [],
  });

  return { existingHash, cacheImageId, preferenceId };
}

describe("importProject atomic persistence", () => {
  beforeEach(async () => {
    await db.open();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rolls back a new custom upload when project insertion fails", async () => {
    const suffix = unique("project-failure");
    const { existingHash } = await seedUnrelatedState(suffix);
    const newHash = unique("new-image");
    const backup = createBackup(suffix, [
      { hash: newHash, type: "text/plain", data: "bmV3" },
      { hash: existingHash, type: "text/plain", data: "aWdub3JlZA==" },
    ]);
    const before = await snapshotTables();

    vi.spyOn(db.projects, "add").mockRejectedValueOnce(new Error("project insertion failed"));

    await expect(importProject(backup)).rejects.toThrow("project insertion failed");
    await expect(snapshotTables()).resolves.toEqual(before);
  });

  it("rolls back new custom uploads and the project when card insertion fails", async () => {
    const suffix = unique("card-failure");
    const { existingHash } = await seedUnrelatedState(suffix);
    const newHash = unique("new-image");
    const backup = createBackup(
      suffix,
      [
        { hash: newHash, type: "text/plain", data: "bmV3" },
        { hash: existingHash, type: "text/plain", data: "aWdub3JlZA==" },
      ],
      [{ uuid: "card-old", name: "Card", order: 0, isUserUpload: true, imageId: newHash }]
    );
    const before = await snapshotTables();

    vi.spyOn(db.cards, "bulkAdd").mockRejectedValueOnce(new Error("card insertion failed"));

    await expect(importProject(backup)).rejects.toThrow("card insertion failed");
    await expect(snapshotTables()).resolves.toEqual(before);
  });

  it("imports only missing user images with reciprocal remapped card links", async () => {
    const suffix = unique("success");
    const { existingHash, cacheImageId, preferenceId } = await seedUnrelatedState(suffix);
    const newHash = unique("new-image");
    const backup = createBackup(
      suffix,
      [
        { hash: newHash, type: "text/plain", data: "bmV3" },
        { hash: existingHash, type: "text/plain", data: "aWdub3JlZA==" },
      ],
      [
        {
          uuid: "front-old",
          name: "Front",
          order: 0,
          isUserUpload: true,
          imageId: newHash,
          linkedBackId: "back-old",
        },
        {
          uuid: "back-old",
          name: "Back",
          order: 1,
          isUserUpload: true,
          imageId: existingHash,
          linkedFrontId: "front-old",
        },
      ]
    );
    const before = await snapshotTables();
    const transaction = vi.spyOn(db, "transaction");

    const projectId = await importProject(backup);

    expect(transaction).toHaveBeenCalledTimes(1);
    const transactionArgs = transaction.mock.calls[0];
    expect(transactionArgs[0]).toBe("rw");
    expect(transactionArgs[1]).toBe(db.user_images);
    expect(transactionArgs[2]).toBe(db.projects);
    expect(transactionArgs[3]).toBe(db.cards);
    expect(transactionArgs[4]).toEqual(expect.any(Function));
    expect(await db.user_images.get(existingHash)).toMatchObject({
      hash: existingHash,
      type: "text/existing",
    });
    await expect(db.user_images.get(newHash)).resolves.toMatchObject({
      hash: newHash,
      type: "text/plain",
    });
    const seededCacheImage = before.images.find((image) => image.id === cacheImageId);
    const seededPreferences = before.userPreferences.find(
      (preferences) => preferences.id === preferenceId
    );
    expect(await db.images.get(cacheImageId)).toEqual(seededCacheImage);
    await expect(db.userPreferences.get(preferenceId as "default")).resolves.toEqual(
      seededPreferences
    );
    await expect(db.projects.get(projectId)).resolves.toMatchObject({ id: projectId });

    const importedCards = await db.cards.where("projectId").equals(projectId).toArray();
    const front = importedCards.find((card) => card.name === "Front")!;
    const back = importedCards.find((card) => card.name === "Back")!;
    expect(front.linkedBackId).toBe(back.uuid);
    expect(back.linkedFrontId).toBe(front.uuid);
  });

  it("bulk-deduplicates image hashes, preserves stored collisions, and keeps card hash mappings", async () => {
    const suffix = unique("bulk-images");
    const { existingHash, cacheImageId } = await seedUnrelatedState(suffix);
    const firstNewHash = unique("first-new-image");
    const secondNewHash = unique("second-new-image");
    const backup = createBackup(
      suffix,
      [
        { hash: firstNewHash, type: "text/first", data: "Zmlyc3Q=" },
        { hash: existingHash, type: "text/replacement", data: "cmVwbGFjZWQ=" },
        { hash: firstNewHash, type: "text/duplicate", data: "ZHVwbGljYXRl" },
        { hash: secondNewHash, type: "text/second", data: "c2Vjb25k" },
        { hash: existingHash, type: "text/replacement-duplicate", data: "YWdhaW4=" },
      ],
      [
        {
          uuid: "first-card-old",
          name: "First",
          order: 0,
          isUserUpload: true,
          imageId: firstNewHash,
        },
        {
          uuid: "existing-card-old",
          name: "Existing",
          order: 1,
          isUserUpload: true,
          imageId: existingHash,
        },
        {
          uuid: "duplicate-card-old",
          name: "Duplicate",
          order: 2,
          isUserUpload: true,
          imageId: firstNewHash,
        },
      ]
    );
    const bulkGet = vi.spyOn(db.user_images, "bulkGet");
    const bulkPut = vi.spyOn(db.user_images, "bulkPut");
    const originalExistingImage = await db.user_images.get(existingHash);
    const originalCacheImage = await db.images.get(cacheImageId);

    const projectId = await importProject(backup);

    expect(bulkGet).toHaveBeenCalledTimes(1);
    expect(bulkGet).toHaveBeenCalledWith([firstNewHash, existingHash, secondNewHash]);
    expect(bulkPut).toHaveBeenCalledTimes(1);
    const [insertedImages] = bulkPut.mock.calls[0];
    expect(insertedImages).toHaveLength(2);
    expect(insertedImages.map((image) => ({ hash: image.hash, type: image.type }))).toEqual([
      { hash: firstNewHash, type: "text/first" },
      { hash: secondNewHash, type: "text/second" },
    ]);
    expect(insertedImages[0].data).toMatchObject({ size: 5, type: "text/first" });
    expect(insertedImages[1].data).toMatchObject({ size: 6, type: "text/second" });

    await expect(db.user_images.get(existingHash)).resolves.toMatchObject({
      hash: existingHash,
      type: "text/existing",
    });
    expect(await db.user_images.get(existingHash)).toEqual(originalExistingImage);
    expect(await db.images.get(cacheImageId)).toEqual(originalCacheImage);

    const importedCards = await db.cards.where("projectId").equals(projectId).toArray();
    expect(importedCards.map((card) => card.imageId)).toEqual([
      firstNewHash,
      existingHash,
      firstNewHash,
    ]);
  });
});
