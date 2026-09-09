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
});
