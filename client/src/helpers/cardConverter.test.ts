import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CardOption, ScryfallCard } from "../../../shared/types";

const hoisted = vi.hoisted(() => ({
  addRemoteImage: vi.fn(),
  createLinkedBackCardsBulk: vi.fn(),
  undoableAddCards: vi.fn(),
}));

vi.mock("./dbUtils", () => ({
  addRemoteImage: hoisted.addRemoteImage,
  createLinkedBackCardsBulk: hoisted.createLinkedBackCardsBulk,
}));

vi.mock("./undoableActions", () => ({
  undoableAddCards: hoisted.undoableAddCards,
}));

import {
  convertScryfallToCardOptions,
  persistResolvedCards,
} from "./cardConverter";

const baseCard = (overrides: Partial<ScryfallCard> = {}): ScryfallCard =>
  ({
    name: "Lightning Bolt",
    set: "clu",
    number: "141",
    scryfall_id: "sf-1",
    oracle_id: "oracle-1",
    lang: "en",
    imageUrls: ["https://img/front.jpg"],
    prints: ["print-a"],
    colors: ["R"],
    cmc: 1,
    type_line: "Instant",
    rarity: "common",
    mana_cost: "{R}",
    token_parts: [{ name: "Goblin" }],
    needs_token: false,
    ...overrides,
  }) as ScryfallCard;

describe("convertScryfallToCardOptions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.addRemoteImage.mockResolvedValue("image-main");
  });

  it("creates quantity copies with resolved image and import metadata", async () => {
    const result = await convertScryfallToCardOptions(baseCard(), 2, {
      category: "Main",
      projectId: "project-1",
    });

    expect(hoisted.addRemoteImage).toHaveBeenCalledWith(
      ["https://img/front.jpg"],
      2,
      ["print-a"]
    );
    expect(result.backCardTasks).toEqual([]);
    expect(result.cardsToAdd).toHaveLength(2);
    expect(result.cardsToAdd).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "Lightning Bolt",
          imageId: "image-main",
          category: "Main",
          projectId: "project-1",
          isUserUpload: false,
          needsEnrichment: false,
          isToken: false,
          isFlipped: undefined,
        }),
      ])
    );
  });

  it("detects token cards from explicit option or type line", async () => {
    await expect(
      convertScryfallToCardOptions(baseCard({ type_line: "Token Creature — Goblin" }), 1)
    ).resolves.toMatchObject({
      cardsToAdd: [expect.objectContaining({ isToken: true })],
    });

    await expect(
      convertScryfallToCardOptions(baseCard({ type_line: undefined }), 1, {
        isToken: true,
      })
    ).resolves.toMatchObject({
      cardsToAdd: [expect.objectContaining({ isToken: true })],
    });
  });

  it("resolves double-faced card back tasks and flipped back-face imports", async () => {
    hoisted.addRemoteImage
      .mockResolvedValueOnce("image-back")
      .mockResolvedValueOnce("image-front");

    const result = await convertScryfallToCardOptions(
      baseCard({
        name: "Invasion of Zendikar",
        card_faces: [
          { name: "Invasion of Zendikar", imageUrl: "https://img/front-face.jpg" },
          { name: "Awakened Skyclave", imageUrl: "https://img/back-face.jpg" },
        ],
      }),
      2,
      { isBackFaceImport: true }
    );

    expect(hoisted.addRemoteImage).toHaveBeenNthCalledWith(
      1,
      ["https://img/back-face.jpg"],
      1
    );
    expect(hoisted.addRemoteImage).toHaveBeenNthCalledWith(
      2,
      ["https://img/front-face.jpg"],
      2,
      ["print-a"]
    );
    expect(result.cardsToAdd).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ imageId: "image-front", isFlipped: true }),
      ])
    );
    expect(result.backCardTasks).toEqual([
      { frontIndex: 0, backImageId: "image-back", backName: "Awakened Skyclave" },
      { frontIndex: 1, backImageId: "image-back", backName: "Awakened Skyclave" },
    ]);
  });

  it("skips back tasks when a double-faced back image is unavailable", async () => {
    const result = await convertScryfallToCardOptions(
      baseCard({
        card_faces: [
          { name: "Front", imageUrl: "https://img/front-face.jpg" },
          { name: "Back" },
        ],
      }),
      1
    );

    expect(hoisted.addRemoteImage).toHaveBeenCalledTimes(1);
    expect(result.backCardTasks).toEqual([]);
  });

  it("falls back to empty image URL input and generic back-face label", async () => {
    hoisted.addRemoteImage
      .mockResolvedValueOnce("image-back")
      .mockResolvedValueOnce("image-main");

    const result = await convertScryfallToCardOptions(
      baseCard({
        imageUrls: undefined,
        card_faces: [
          { name: "Front" },
          { imageUrl: "https://img/back-face.jpg" },
        ],
      }),
      1
    );

    expect(hoisted.addRemoteImage).toHaveBeenNthCalledWith(
      2,
      [],
      1,
      ["print-a"]
    );
    expect(result.backCardTasks).toEqual([
      { frontIndex: 0, backImageId: "image-back", backName: "Back" },
    ]);
  });
});

describe("persistResolvedCards", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.undoableAddCards.mockResolvedValue([
      { uuid: "front-1" },
      { uuid: "front-2" },
    ] satisfies Partial<CardOption>[]);
  });

  it("returns early when there are no cards to add", async () => {
    await expect(
      persistResolvedCards({ cardsToAdd: [], backCardTasks: [] })
    ).resolves.toEqual([]);

    expect(hoisted.undoableAddCards).not.toHaveBeenCalled();
    expect(hoisted.createLinkedBackCardsBulk).not.toHaveBeenCalled();
  });

  it("persists cards with optional start order and linked back tasks", async () => {
    const cardsToAdd = [
      { name: "Front A", isUserUpload: false },
      { name: "Front B", isUserUpload: false },
    ] as Omit<CardOption, "uuid" | "order">[];

    await expect(
      persistResolvedCards(
        {
          cardsToAdd,
          backCardTasks: [
            { frontIndex: 0, backImageId: "back-image-1", backName: "Back A" },
            { frontIndex: 1, backImageId: "back-image-2", backName: "Back B" },
          ],
        },
        { startOrder: 42 }
      )
    ).resolves.toEqual([{ uuid: "front-1" }, { uuid: "front-2" }]);

    expect(hoisted.undoableAddCards).toHaveBeenCalledWith(cardsToAdd, {
      startOrder: 42,
    });
    expect(hoisted.createLinkedBackCardsBulk).toHaveBeenCalledWith([
      { frontUuid: "front-1", backImageId: "back-image-1", backName: "Back A" },
      { frontUuid: "front-2", backImageId: "back-image-2", backName: "Back B" },
    ]);
  });

  it("omits add-card options and linked back creation when not needed", async () => {
    const cardsToAdd = [{ name: "Solo", isUserUpload: false }] as Omit<
      CardOption,
      "uuid" | "order"
    >[];

    await persistResolvedCards({ cardsToAdd, backCardTasks: [] });

    expect(hoisted.undoableAddCards).toHaveBeenCalledWith(cardsToAdd, undefined);
    expect(hoisted.createLinkedBackCardsBulk).not.toHaveBeenCalled();
  });
});
