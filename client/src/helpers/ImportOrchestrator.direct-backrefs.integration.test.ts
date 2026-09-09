import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScryfallCard } from "../../../shared/types";

vi.mock("./mpcAutofillApi", () => ({
  getMpcAutofillImageUrl: (id: string) => `https://mpc.example/${id}.jpg`,
}));

vi.mock("./scryfallApi", () => ({
  fetchCardBySetAndNumber: vi.fn(),
  fetchCardWithPrints: vi.fn(),
  fetchCardsMetadataBatch: vi.fn(async (queries: Array<{ name: string }>) => new Map(
    queries.map(({ name }) => [name.toLowerCase(), {
      name: `${name} // ${name} Back`,
      card_faces: [
        { name },
        { name: `${name} Back`, imageUrl: `https://scryfall.example/${name.toLowerCase().replaceAll(" ", "-")}-back.jpg` },
      ],
    }]),
  )),
}));

import { db } from "../db";
import { useCardsStore } from "../store/cards";
import { useProjectStore } from "../store/projectStore";
import { ImportOrchestrator } from "./ImportOrchestrator";

const settings = {
  preferredArtSource: "mpc" as const,
  globalLanguage: "en",
  autoImportTokens: false,
};

async function importAndReadBackReferences(
  quantity: number,
  overrides: { name: string; mpcId: string; linkedBackImageId?: string; linkedBackName?: string },
) {
  const projectId = `direct-backrefs-${overrides.mpcId}-${quantity}`;
  await ImportOrchestrator.process([{
    ...overrides,
    quantity,
    isToken: false,
  }], { settings: { ...settings, projectId } });

  const cards = await db.cards.where("projectId").equals(projectId).toArray();
  const fronts = cards.filter((card) => !card.linkedFrontId);
  const backs = cards.filter((card) => card.linkedFrontId);
  const backImageIds = new Set(backs.map((back) => back.imageId));

  expect(fronts).toHaveLength(quantity);
  expect(backs).toHaveLength(quantity);
  expect(backImageIds.size).toBe(1);

  const [backImageId] = backImageIds;
  expect(backImageId).toBeTruthy();
  const image = await db.images.get(backImageId!);
  expect(image?.refCount).toBe(quantity);
  expect(await db.images.toArray()).toEqual(
    expect.not.arrayContaining([expect.objectContaining({ refCount: 0 })]),
  );
}

describe("ImportOrchestrator direct back image persistence", () => {
  beforeEach(async () => {
    await db.open();
    await db.cards.clear();
    await db.images.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([1, 4])("stores exactly one DFC fallback image reference per linked direct MPC back at quantity %i", async (quantity) => {
    await importAndReadBackReferences(quantity, {
      name: "Fallback Front",
      mpcId: "fallback-front",
    });
  });

  it.each([1, 4])("stores exactly one explicit image reference per linked direct MPC back at quantity %i", async (quantity) => {
    await importAndReadBackReferences(quantity, {
      name: "Explicit Front",
      mpcId: "explicit-front",
      linkedBackImageId: "explicit-back",
      linkedBackName: "Explicit Back",
    });
  });

  it("does not restore cards, images, links, or refcounts after clear races deferred direct resolution", async () => {
    const projectId = "direct-clear-persistence-fence";
    useProjectStore.setState({ currentProjectId: projectId });

    let resolveMetadata!: (value: Map<string, ScryfallCard>) => void;
    vi.mocked(await import("./scryfallApi")).fetchCardsMetadataBatch.mockImplementationOnce(() => new Promise((resolve) => {
      resolveMetadata = resolve;
    }));

    const processing = ImportOrchestrator.process([{
      name: "Cleared Front",
      quantity: 1,
      isToken: false,
      mpcId: "cleared-front",
      linkedBackImageId: "cleared-back",
      linkedBackName: "Cleared Back",
    }], { settings: { ...settings, projectId } });

    await vi.waitFor(async () => {
      expect(await db.cards.where("projectId").equals(projectId).count()).toBeGreaterThan(0);
    });

    await useCardsStore.getState().clearAllCardsAndImages();
    resolveMetadata(new Map());

    await expect(processing).rejects.toMatchObject({ name: "AbortError" });
    expect(await db.cards.where("projectId").equals(projectId).count()).toBe(0);
    expect(await db.images.count()).toBe(0);
  });
});
