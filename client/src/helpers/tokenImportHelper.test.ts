import { describe, it, expect, vi, beforeEach } from "vitest";

const hoisted = vi.hoisted(() => ({
  importMissingTokens: vi.fn(),
  cardsToArray: vi.fn(),
  cardsBulkGet: vi.fn(),
  cardsBulkUpdate: vi.fn(),
  cardsBulkAdd: vi.fn(),
  imagesBulkGet: vi.fn(),
  imagesBulkUpdate: vi.fn(),
  imagesBulkDelete: vi.fn(),
  transaction: vi.fn((_mode, _cards, _images, cb: () => unknown) => cb()),
  settings: {
    autoImportTokens: false,
  },
  projectState: {
    currentProjectId: "project-1",
  },
}));

vi.mock("./ImportOrchestrator", () => ({
  ImportOrchestrator: {
    importMissingTokens: hoisted.importMissingTokens,
  },
}));

vi.mock("@/store/settings", () => ({
  useSettingsStore: {
    getState: vi.fn(() => hoisted.settings),
  },
}));

vi.mock("@/store/projectStore", () => ({
  useProjectStore: {
    getState: vi.fn(() => hoisted.projectState),
  },
}));

vi.mock("@/db", () => ({
  db: {
    cards: {
      bulkAdd: hoisted.cardsBulkAdd,
      bulkGet: hoisted.cardsBulkGet,
      bulkUpdate: hoisted.cardsBulkUpdate,
      toArray: hoisted.cardsToArray,
      where: vi.fn(() => ({
        equals: vi.fn(() => ({
          toArray: hoisted.cardsToArray,
        })),
      })),
    },
    images: {
      bulkDelete: hoisted.imagesBulkDelete,
      bulkGet: hoisted.imagesBulkGet,
      bulkUpdate: hoisted.imagesBulkUpdate,
    },
    transaction: hoisted.transaction,
  },
}));

vi.mock("./cardbackLibrary", () => ({
  isCardbackId: (id: string) => id.startsWith("cardback_"),
}));

import {
  createShuffledTwoSidedTokenPairs,
  handleAutoImportTokens,
  handleManualTokenImport,
  handleManualTwoSidedTokenImport,
  type PairableTokenCard,
} from "./tokenImportHelper";

describe("handleAutoImportTokens", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.settings.autoImportTokens = false;
    hoisted.projectState.currentProjectId = "project-1";
    hoisted.cardsToArray.mockResolvedValue([]);
    hoisted.cardsBulkGet.mockResolvedValue([]);
    hoisted.cardsBulkUpdate.mockResolvedValue(undefined);
    hoisted.cardsBulkAdd.mockResolvedValue(undefined);
    hoisted.imagesBulkGet.mockResolvedValue([]);
    hoisted.imagesBulkUpdate.mockResolvedValue(undefined);
    hoisted.imagesBulkDelete.mockResolvedValue(undefined);
    hoisted.transaction.mockImplementation((_mode, _cards, _images, cb) =>
      cb()
    );
  });

  it("does not run when autoImportTokens=false and force is not set", async () => {
    await handleAutoImportTokens();
    expect(hoisted.importMissingTokens).not.toHaveBeenCalled();
  });

  it("runs when autoImportTokens=false but force=true (manual action)", async () => {
    await handleAutoImportTokens({ force: true, silent: false });
    expect(hoisted.importMissingTokens).toHaveBeenCalledTimes(1);
  });

  it("passes through abort signal and callbacks", async () => {
    const controller = new AbortController();
    const onComplete = vi.fn();
    const onNoTokens = vi.fn();
    await handleAutoImportTokens({
      force: true,
      signal: controller.signal,
      onComplete,
      onNoTokens,
      silent: true,
    });
    expect(hoisted.importMissingTokens).toHaveBeenCalledWith(
      expect.objectContaining({
        signal: controller.signal,
        onComplete,
        onNoTokens,
      })
    );
  });

  it("ignores aborted auto imports", async () => {
    const abortError = new Error("stopped");
    abortError.name = "AbortError";
    hoisted.importMissingTokens.mockRejectedValueOnce(abortError);

    await expect(
      handleAutoImportTokens({ force: true })
    ).resolves.toBeUndefined();
  });

  it("logs and swallows non-abort auto import failures when silent", async () => {
    const failure = new Error("network down");
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    hoisted.importMissingTokens.mockRejectedValueOnce(failure);

    await expect(
      handleAutoImportTokens({ force: true, silent: true })
    ).resolves.toBeUndefined();

    expect(consoleError).toHaveBeenCalledWith(
      "Failed to auto-import tokens:",
      failure
    );
    consoleError.mockRestore();
  });

  it("rethrows non-abort auto import failures when not silent", async () => {
    const failure = new Error("network down");
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    hoisted.importMissingTokens.mockRejectedValueOnce(failure);

    await expect(
      handleAutoImportTokens({ force: true, silent: false })
    ).rejects.toThrow(failure);

    expect(consoleError).toHaveBeenCalledWith(
      "Failed to auto-import tokens:",
      failure
    );
    consoleError.mockRestore();
  });
});

describe("handleManualTokenImport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.settings.autoImportTokens = false;
    hoisted.projectState.currentProjectId = "project-1";
    hoisted.cardsToArray.mockResolvedValue([]);
    hoisted.cardsBulkGet.mockResolvedValue([]);
    hoisted.cardsBulkUpdate.mockResolvedValue(undefined);
    hoisted.cardsBulkAdd.mockResolvedValue(undefined);
    hoisted.imagesBulkGet.mockResolvedValue([]);
    hoisted.imagesBulkUpdate.mockResolvedValue(undefined);
    hoisted.imagesBulkDelete.mockResolvedValue(undefined);
    hoisted.transaction.mockImplementation((_mode, _cards, _images, cb) =>
      cb()
    );
  });

  it("always runs regardless of autoImportTokens setting", async () => {
    hoisted.settings.autoImportTokens = false;
    await handleManualTokenImport();
    expect(hoisted.importMissingTokens).toHaveBeenCalledTimes(1);
  });

  it("always uses skipExisting=true and forceRefresh=true", async () => {
    await handleManualTokenImport({ silent: false });
    expect(hoisted.importMissingTokens).toHaveBeenCalledWith(
      expect.objectContaining({
        skipExisting: true,
        forceRefresh: true,
      })
    );
  });

  it("passes through signal and callbacks", async () => {
    const controller = new AbortController();
    const onComplete = vi.fn();
    const onNoTokens = vi.fn();
    await handleManualTokenImport({
      signal: controller.signal,
      onComplete,
      onNoTokens,
    });
    expect(hoisted.importMissingTokens).toHaveBeenCalledWith(
      expect.objectContaining({
        skipExisting: true,
        forceRefresh: true,
        signal: controller.signal,
        onComplete,
        onNoTokens,
      })
    );
  });

  it("ignores aborted manual imports", async () => {
    const abortError = new Error("stopped");
    abortError.name = "AbortError";
    hoisted.importMissingTokens.mockRejectedValueOnce(abortError);

    await expect(handleManualTokenImport()).resolves.toBeUndefined();
  });

  it("logs and swallows non-abort manual import failures when silent", async () => {
    const failure = new Error("network down");
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    hoisted.importMissingTokens.mockRejectedValueOnce(failure);

    await expect(
      handleManualTokenImport({ silent: true })
    ).resolves.toBeUndefined();

    expect(consoleError).toHaveBeenCalledWith(
      "Failed to import tokens:",
      failure
    );
    consoleError.mockRestore();
  });

  it("rethrows non-abort manual import failures when not silent", async () => {
    const failure = new Error("network down");
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    hoisted.importMissingTokens.mockRejectedValueOnce(failure);

    await expect(handleManualTokenImport({ silent: false })).rejects.toThrow(
      failure
    );

    expect(consoleError).toHaveBeenCalledWith(
      "Failed to import tokens:",
      failure
    );
    consoleError.mockRestore();
  });
});

describe("createShuffledTwoSidedTokenPairs", () => {
  const token = (overrides: Partial<PairableTokenCard>): PairableTokenCard => ({
    uuid: "uuid",
    name: "Token",
    order: 0,
    isUserUpload: false,
    isToken: true,
    imageId: "image",
    ...overrides,
  });

  it("pairs every token with a different token identity and image", () => {
    const cards = [
      token({
        uuid: "treasure",
        name: "Treasure",
        imageId: "treasure-img",
        scryfall_id: "token-treasure",
        order: 10,
      }),
      token({
        uuid: "soldier",
        name: "Soldier",
        imageId: "soldier-img",
        scryfall_id: "token-soldier",
        order: 20,
      }),
      token({
        uuid: "zombie",
        name: "Zombie",
        imageId: "zombie-img",
        scryfall_id: "token-zombie",
        order: 30,
      }),
    ];

    const pairs = createShuffledTwoSidedTokenPairs(cards);

    expect(pairs).toHaveLength(cards.length);
    for (const pair of pairs) {
      expect(pair.front.uuid).not.toBe(pair.back.uuid);
      expect(pair.front.imageId).not.toBe(pair.back.imageId);
      expect(pair.front.scryfall_id).not.toBe(pair.back.scryfall_id);
    }
  });

  it("does not create an invalid pair when only same-token options exist", () => {
    const cards = [
      token({
        uuid: "treasure-1",
        name: "Treasure",
        imageId: "treasure-img-1",
        order: 10,
      }),
      token({
        uuid: "treasure-2",
        name: "Treasure",
        imageId: "treasure-img-2",
        order: 20,
      }),
    ];

    expect(createShuffledTwoSidedTokenPairs(cards)).toEqual([]);
  });

  it("returns no pairs for fewer than two tokens", () => {
    expect(createShuffledTwoSidedTokenPairs([token({ uuid: "solo" })])).toEqual(
      []
    );
  });

  it("falls back to recursive assignment after repeated invalid shuffles", () => {
    const random = vi.spyOn(Math, "random").mockReturnValue(0.99);
    const cards = [
      token({
        uuid: "treasure",
        name: "Treasure",
        imageId: "treasure-img",
        scryfall_id: "token-treasure",
        order: 10,
      }),
      token({
        uuid: "soldier",
        name: "Soldier",
        imageId: "soldier-img",
        scryfall_id: "token-soldier",
        order: 20,
      }),
      token({
        uuid: "zombie",
        name: "Zombie",
        imageId: "zombie-img",
        scryfall_id: "token-zombie",
        order: 30,
      }),
    ];

    const pairs = createShuffledTwoSidedTokenPairs(cards);

    expect(pairs).toHaveLength(3);
    expect(pairs.every((pair) => pair.front.uuid !== pair.back.uuid)).toBe(
      true
    );
    random.mockRestore();
  });
});

describe("handleManualTwoSidedTokenImport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.settings.autoImportTokens = false;
    hoisted.projectState.currentProjectId = "project-1";
    hoisted.cardsBulkUpdate.mockResolvedValue(undefined);
    hoisted.cardsBulkAdd.mockResolvedValue(undefined);
    hoisted.imagesBulkUpdate.mockResolvedValue(undefined);
    hoisted.imagesBulkDelete.mockResolvedValue(undefined);
    hoisted.transaction.mockImplementation((_mode, _cards, _images, cb) =>
      cb()
    );
  });

  it("imports missing tokens, then replaces their backs with shuffled token art", async () => {
    const beforeCards = [
      {
        uuid: "source",
        name: "Token Maker",
        order: 1,
        isUserUpload: false,
        projectId: "project-1",
      },
    ];
    const afterCards = [
      ...beforeCards,
      {
        uuid: "treasure-front",
        name: "Treasure",
        order: 10,
        isUserUpload: false,
        isToken: true,
        imageId: "treasure-img",
        scryfall_id: "token-treasure",
        projectId: "project-1",
      },
      {
        uuid: "treasure-back",
        name: "Default",
        order: 10,
        isUserUpload: false,
        imageId: "cardback_builtin_mtg",
        linkedFrontId: "treasure-front",
        projectId: "project-1",
      },
      {
        uuid: "soldier-front",
        name: "Soldier",
        order: 20,
        isUserUpload: false,
        isToken: true,
        imageId: "soldier-img",
        scryfall_id: "token-soldier",
        hasBuiltInBleed: false,
        projectId: "project-1",
      },
      {
        uuid: "soldier-back",
        name: "Default",
        order: 20,
        isUserUpload: false,
        imageId: "cardback_builtin_mtg",
        linkedFrontId: "soldier-front",
        projectId: "project-1",
      },
    ];

    hoisted.cardsToArray
      .mockResolvedValueOnce(beforeCards)
      .mockResolvedValueOnce(afterCards)
      .mockResolvedValueOnce(afterCards);
    hoisted.cardsBulkGet.mockResolvedValue([
      afterCards.find((card) => card.uuid === "treasure-front"),
      afterCards.find((card) => card.uuid === "soldier-front"),
    ]);
    hoisted.imagesBulkGet.mockResolvedValue([
      { id: "soldier-img", refCount: 1 },
      { id: "treasure-img", refCount: 1 },
    ]);
    hoisted.importMissingTokens.mockResolvedValue([
      {
        name: "Treasure",
        scryfallId: "token-treasure",
        quantity: 1,
        isToken: true,
      },
      {
        name: "Soldier",
        scryfallId: "token-soldier",
        quantity: 1,
        isToken: true,
      },
    ]);

    const onComplete = vi.fn();
    const result = await handleManualTwoSidedTokenImport({ onComplete });

    expect(hoisted.importMissingTokens).toHaveBeenCalledWith(
      expect.objectContaining({
        skipExisting: true,
        forceRefresh: true,
      })
    );
    expect(result).toEqual({
      importedTokenCount: 2,
      pairedTokenCount: 2,
      unpairedTokenCount: 0,
    });
    expect(hoisted.cardsBulkUpdate).toHaveBeenCalledWith([
      {
        key: "treasure-front",
        changes: { linkedBackId: "treasure-back" },
      },
      expect.objectContaining({
        key: "treasure-back",
        changes: expect.objectContaining({
          imageId: "soldier-img",
          name: "Soldier",
          usesDefaultCardback: false,
        }),
      }),
      {
        key: "soldier-front",
        changes: { linkedBackId: "soldier-back" },
      },
      expect.objectContaining({
        key: "soldier-back",
        changes: expect.objectContaining({
          imageId: "treasure-img",
          name: "Treasure",
          usesDefaultCardback: false,
        }),
      }),
    ]);
    expect(hoisted.imagesBulkUpdate).toHaveBeenCalledWith([
      {
        key: "soldier-img",
        changes: { refCount: 2 },
      },
      {
        key: "treasure-img",
        changes: { refCount: 2 },
      },
    ]);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("repairs and reshuffles existing associated tokens when no new tokens are imported", async () => {
    const projectCards = [
      {
        uuid: "source",
        name: "Token Maker",
        order: 1,
        isUserUpload: false,
        projectId: "project-1",
        token_parts: [
          { name: "Treasure", id: "token-treasure" },
          { name: "Soldier", id: "token-soldier" },
        ],
      },
      {
        uuid: "treasure-front",
        name: "Treasure",
        order: 10,
        isUserUpload: false,
        isToken: true,
        imageId: "treasure-img",
        scryfall_id: "token-treasure",
        linkedBackId: "treasure-back",
        projectId: "project-1",
      },
      {
        uuid: "treasure-back",
        name: "Default",
        order: 10,
        isUserUpload: false,
        imageId: "cardback_builtin_mtg",
        linkedFrontId: "treasure-front",
        usesDefaultCardback: true,
        projectId: "project-1",
      },
      {
        uuid: "soldier-front",
        name: "Soldier",
        order: 20,
        isUserUpload: false,
        isToken: true,
        imageId: "soldier-img",
        scryfall_id: "token-soldier",
        linkedBackId: "soldier-back",
        projectId: "project-1",
      },
      {
        uuid: "soldier-back",
        name: "Default",
        order: 20,
        isUserUpload: false,
        imageId: "cardback_builtin_mtg",
        linkedFrontId: "soldier-front",
        usesDefaultCardback: true,
        projectId: "project-1",
      },
    ];

    hoisted.cardsToArray
      .mockResolvedValueOnce(projectCards)
      .mockResolvedValueOnce(projectCards)
      .mockResolvedValueOnce(projectCards);
    hoisted.cardsBulkGet.mockResolvedValue([
      projectCards.find((card) => card.uuid === "treasure-front"),
      projectCards.find((card) => card.uuid === "soldier-front"),
    ]);
    hoisted.imagesBulkGet.mockResolvedValue([
      { id: "soldier-img", refCount: 1 },
      { id: "treasure-img", refCount: 1 },
    ]);
    hoisted.importMissingTokens.mockImplementation(async (options) => {
      options.onNoTokens?.();
      return [];
    });

    const onNoTokens = vi.fn();
    const result = await handleManualTwoSidedTokenImport({ onNoTokens });

    expect(result).toEqual({
      importedTokenCount: 2,
      pairedTokenCount: 2,
      unpairedTokenCount: 0,
    });
    expect(onNoTokens).not.toHaveBeenCalled();
    expect(hoisted.cardsBulkUpdate).toHaveBeenCalledWith([
      expect.objectContaining({
        key: "treasure-back",
        changes: expect.objectContaining({
          imageId: "soldier-img",
          usesDefaultCardback: false,
        }),
      }),
      expect.objectContaining({
        key: "soldier-back",
        changes: expect.objectContaining({
          imageId: "treasure-img",
          usesDefaultCardback: false,
        }),
      }),
    ]);
  });

  it("repairs existing imported token backs using tokenAddedFrom when source token_parts are unavailable", async () => {
    const projectCards = [
      {
        uuid: "source",
        name: "Token Maker",
        order: 1,
        isUserUpload: false,
        projectId: "project-1",
      },
      {
        uuid: "treasure-front",
        name: "Treasure",
        order: 10,
        isUserUpload: false,
        isToken: true,
        imageId: "treasure-img",
        scryfall_id: "token-treasure",
        linkedBackId: "treasure-back",
        tokenAddedFrom: ["Token Maker"],
        projectId: "project-1",
      },
      {
        uuid: "treasure-back",
        name: "Rose",
        order: 10,
        isUserUpload: false,
        imageId: "cardback_builtin_mtg",
        linkedFrontId: "treasure-front",
        usesDefaultCardback: true,
        projectId: "project-1",
      },
      {
        uuid: "soldier-front",
        name: "Soldier",
        order: 20,
        isUserUpload: false,
        isToken: true,
        imageId: "soldier-img",
        scryfall_id: "token-soldier",
        linkedBackId: "soldier-back",
        tokenAddedFrom: ["Token Maker"],
        projectId: "project-1",
      },
      {
        uuid: "soldier-back",
        name: "Rose",
        order: 20,
        isUserUpload: false,
        imageId: "cardback_builtin_mtg",
        linkedFrontId: "soldier-front",
        usesDefaultCardback: true,
        projectId: "project-1",
      },
    ];

    hoisted.cardsToArray
      .mockResolvedValueOnce(projectCards)
      .mockResolvedValueOnce(projectCards)
      .mockResolvedValueOnce(projectCards);
    hoisted.cardsBulkGet.mockResolvedValue([
      projectCards.find((card) => card.uuid === "treasure-front"),
      projectCards.find((card) => card.uuid === "soldier-front"),
    ]);
    hoisted.imagesBulkGet.mockResolvedValue([
      { id: "soldier-img", refCount: 1 },
      { id: "treasure-img", refCount: 1 },
    ]);
    hoisted.importMissingTokens.mockImplementation(async (options) => {
      options.onNoTokens?.();
      return [];
    });

    const result = await handleManualTwoSidedTokenImport();

    expect(result.pairedTokenCount).toBe(2);
    expect(hoisted.cardsBulkUpdate).toHaveBeenCalledWith([
      expect.objectContaining({
        key: "treasure-back",
        changes: expect.objectContaining({
          imageId: "soldier-img",
          usesDefaultCardback: false,
        }),
      }),
      expect.objectContaining({
        key: "soldier-back",
        changes: expect.objectContaining({
          imageId: "treasure-img",
          usesDefaultCardback: false,
        }),
      }),
    ]);
  });

  it("returns no tokens when no project is selected", async () => {
    hoisted.projectState.currentProjectId = "";
    const onNoTokens = vi.fn();

    const result = await handleManualTwoSidedTokenImport({ onNoTokens });

    expect(result).toEqual({
      importedTokenCount: 0,
      pairedTokenCount: 0,
      unpairedTokenCount: 0,
    });
    expect(onNoTokens).toHaveBeenCalledTimes(1);
    expect(hoisted.importMissingTokens).not.toHaveBeenCalled();
  });

  it("returns no tokens when import and existing associations find none", async () => {
    const projectCards = [
      {
        uuid: "source",
        name: "Plain Card",
        order: 1,
        isUserUpload: false,
        projectId: "project-1",
        token_parts: [{ name: "" }],
      },
    ];
    hoisted.cardsToArray.mockResolvedValue(projectCards);
    hoisted.importMissingTokens.mockImplementation(async (options) => {
      options.onNoTokens?.();
      return [];
    });
    const onNoTokens = vi.fn();

    const result = await handleManualTwoSidedTokenImport({ onNoTokens });

    expect(result).toEqual({
      importedTokenCount: 0,
      pairedTokenCount: 0,
      unpairedTokenCount: 0,
    });
    expect(onNoTokens).toHaveBeenCalledTimes(1);
    expect(hoisted.cardsBulkUpdate).not.toHaveBeenCalled();
  });

  it("creates new back cards for newly imported name-matched tokens without existing backs", async () => {
    const beforeCards = [
      {
        uuid: "source",
        name: "Token Maker",
        order: 1,
        isUserUpload: true,
        projectId: "project-1",
      },
    ];
    const afterCards = [
      ...beforeCards,
      {
        uuid: "ignored-old",
        name: "Treasure",
        order: 5,
        isUserUpload: false,
        isToken: true,
        imageId: "old-img",
        projectId: "project-1",
      },
      {
        uuid: "ignored-linked",
        name: "Treasure",
        order: 6,
        isUserUpload: false,
        isToken: true,
        imageId: "linked-img",
        linkedFrontId: "source",
        projectId: "project-1",
      },
      {
        uuid: "ignored-no-image",
        name: "Treasure",
        order: 7,
        isUserUpload: false,
        isToken: true,
        projectId: "project-1",
      },
      {
        uuid: "ignored-non-token",
        name: "Goblin",
        order: 8,
        isUserUpload: false,
        imageId: "goblin-img",
        projectId: "project-1",
      },
      {
        uuid: "treasure-front",
        name: "  Trésor  ",
        order: 10,
        isUserUpload: true,
        type_line: "Token Artifact — Treasure",
        imageId: "treasure-img",
        hasBuiltInBleed: true,
        projectId: "project-1",
      },
      {
        uuid: "soldier-front",
        name: "Soldier",
        order: 20,
        isUserUpload: false,
        isToken: true,
        imageId: "soldier-img",
        projectId: "project-1",
      },
    ];
    const randomUuid = vi
      .spyOn(crypto, "randomUUID")
      .mockReturnValueOnce(
        "new-back-1" as `${string}-${string}-${string}-${string}-${string}`
      )
      .mockReturnValueOnce(
        "new-back-2" as `${string}-${string}-${string}-${string}-${string}`
      );
    hoisted.cardsToArray
      .mockResolvedValueOnce(beforeCards)
      .mockResolvedValueOnce(afterCards)
      .mockResolvedValueOnce(afterCards);
    hoisted.cardsBulkGet.mockResolvedValue([
      afterCards.find((card) => card.uuid === "treasure-front"),
      afterCards.find((card) => card.uuid === "soldier-front"),
    ]);
    hoisted.imagesBulkGet.mockResolvedValue([
      { id: "soldier-img", refCount: 1 },
      { id: "treasure-img", refCount: 1 },
    ]);
    hoisted.importMissingTokens.mockResolvedValue([
      { name: "Tresor", quantity: 1, isToken: true },
      { name: "Soldier", quantity: 1, isToken: true },
    ]);

    const result = await handleManualTwoSidedTokenImport();

    expect(result).toEqual({
      importedTokenCount: 2,
      pairedTokenCount: 2,
      unpairedTokenCount: 0,
    });
    expect(hoisted.cardsBulkAdd).toHaveBeenCalledWith([
      expect.objectContaining({
        uuid: "new-back-1",
        linkedFrontId: "treasure-front",
        imageId: "soldier-img",
      }),
      expect.objectContaining({
        uuid: "new-back-2",
        linkedFrontId: "soldier-front",
        imageId: "treasure-img",
      }),
    ]);
    expect(hoisted.cardsBulkUpdate).toHaveBeenCalledWith([
      { key: "treasure-front", changes: { linkedBackId: "new-back-1" } },
      { key: "soldier-front", changes: { linkedBackId: "new-back-2" } },
    ]);
    randomUuid.mockRestore();
  });

  it("ignores aborted two-sided imports and handles silent failures", async () => {
    const abortError = new Error("stopped");
    abortError.name = "AbortError";
    hoisted.cardsToArray.mockResolvedValue([]);
    hoisted.importMissingTokens.mockRejectedValueOnce(abortError);

    await expect(handleManualTwoSidedTokenImport()).resolves.toEqual({
      importedTokenCount: 0,
      pairedTokenCount: 0,
      unpairedTokenCount: 0,
    });

    const failure = new Error("network down");
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    hoisted.importMissingTokens.mockRejectedValueOnce(failure);

    await expect(
      handleManualTwoSidedTokenImport({ silent: true })
    ).resolves.toEqual({
      importedTokenCount: 0,
      pairedTokenCount: 0,
      unpairedTokenCount: 0,
    });
    expect(consoleError).toHaveBeenCalledWith(
      "Failed to import two-sided tokens:",
      failure
    );
    consoleError.mockRestore();
  });

  it("rethrows non-abort two-sided import failures when not silent", async () => {
    const failure = new Error("network down");
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    hoisted.cardsToArray.mockResolvedValue([]);
    hoisted.importMissingTokens.mockRejectedValueOnce(failure);

    await expect(handleManualTwoSidedTokenImport()).rejects.toThrow(failure);

    expect(consoleError).toHaveBeenCalledWith(
      "Failed to import two-sided tokens:",
      failure
    );
    consoleError.mockRestore();
  });

  it("reports no tokens when no import callback fires but no token intents are returned", async () => {
    const projectCards = [
      {
        uuid: "source",
        name: "Plain Card",
        order: 1,
        isUserUpload: false,
        projectId: "project-1",
      },
    ];
    hoisted.cardsToArray.mockResolvedValue(projectCards);
    hoisted.importMissingTokens.mockResolvedValue([]);
    const onNoTokens = vi.fn();

    const result = await handleManualTwoSidedTokenImport({ onNoTokens });

    expect(result).toEqual({
      importedTokenCount: 0,
      pairedTokenCount: 0,
      unpairedTokenCount: 0,
    });
    expect(onNoTokens).toHaveBeenCalledTimes(1);
  });

  it("returns empty without reporting no tokens when unmatched intents were found", async () => {
    const projectCards = [
      {
        uuid: "source",
        name: "Plain Card",
        order: 1,
        isUserUpload: false,
        projectId: "project-1",
      },
    ];
    hoisted.cardsToArray.mockResolvedValue(projectCards);
    hoisted.importMissingTokens.mockResolvedValue([
      { name: "Treasure", quantity: 1, isToken: true },
    ]);
    const onNoTokens = vi.fn();

    const result = await handleManualTwoSidedTokenImport({ onNoTokens });

    expect(result).toEqual({
      importedTokenCount: 0,
      pairedTokenCount: 0,
      unpairedTokenCount: 0,
    });
    expect(onNoTokens).not.toHaveBeenCalled();
  });

  it("returns unpaired imported tokens when valid back pairings cannot be made", async () => {
    const beforeCards = [
      {
        uuid: "source",
        name: "Token Maker",
        order: 1,
        isUserUpload: false,
        projectId: "project-1",
      },
    ];
    const afterCards = [
      ...beforeCards,
      {
        uuid: "treasure-front-1",
        name: "Treasure",
        order: 10,
        isUserUpload: false,
        isToken: true,
        imageId: "treasure-img-1",
        projectId: "project-1",
      },
      {
        uuid: "treasure-front-2",
        name: "Treasure",
        order: 20,
        isUserUpload: false,
        isToken: true,
        imageId: "treasure-img-2",
        projectId: "project-1",
      },
    ];
    hoisted.cardsToArray
      .mockResolvedValueOnce(beforeCards)
      .mockResolvedValueOnce(afterCards);
    hoisted.importMissingTokens.mockResolvedValue([
      { name: "Treasure", quantity: 1, isToken: true },
      { name: "Treasure", quantity: 1, isToken: true },
    ]);
    const onComplete = vi.fn();

    const result = await handleManualTwoSidedTokenImport({ onComplete });

    expect(result).toEqual({
      importedTokenCount: 2,
      pairedTokenCount: 0,
      unpairedTokenCount: 2,
    });
    expect(hoisted.transaction).not.toHaveBeenCalled();
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("skips stale fronts that are missing by the time backs are applied", async () => {
    const beforeCards = [
      {
        uuid: "source",
        name: "Token Maker",
        order: 1,
        isUserUpload: false,
        projectId: "project-1",
      },
    ];
    const afterCards = [
      ...beforeCards,
      {
        uuid: "treasure-front",
        name: "Treasure",
        order: 10,
        isUserUpload: false,
        isToken: true,
        imageId: "treasure-img",
        projectId: "project-1",
      },
      {
        uuid: "soldier-front",
        name: "Soldier",
        order: 20,
        isUserUpload: false,
        isToken: true,
        imageId: "soldier-img",
        projectId: "project-1",
      },
    ];
    hoisted.cardsToArray
      .mockResolvedValueOnce(beforeCards)
      .mockResolvedValueOnce(afterCards)
      .mockResolvedValueOnce(afterCards);
    hoisted.cardsBulkGet.mockResolvedValue([undefined, undefined]);
    hoisted.importMissingTokens.mockResolvedValue([
      { name: "Treasure", quantity: 1, isToken: true },
      { name: "Soldier", quantity: 1, isToken: true },
    ]);

    const result = await handleManualTwoSidedTokenImport();

    expect(result).toEqual({
      importedTokenCount: 2,
      pairedTokenCount: 2,
      unpairedTokenCount: 0,
    });
    expect(hoisted.cardsBulkAdd).not.toHaveBeenCalled();
    expect(hoisted.cardsBulkUpdate).not.toHaveBeenCalled();
    expect(hoisted.imagesBulkGet).not.toHaveBeenCalled();
  });

  it("keeps existing backs when art already matches and has no image ref deltas", async () => {
    const random = vi.spyOn(Math, "random").mockReturnValue(0);
    const projectCards = [
      {
        uuid: "source",
        name: "Token Maker",
        order: 1,
        isUserUpload: false,
        projectId: "project-1",
        token_parts: [{ name: "Treasure" }, { name: "Soldier" }],
      },
      {
        uuid: "treasure-front",
        name: "Treasure",
        order: 10,
        isUserUpload: false,
        isToken: true,
        imageId: "treasure-img",
        projectId: "project-1",
      },
      {
        uuid: "treasure-back",
        name: "Soldier",
        order: 10,
        isUserUpload: false,
        imageId: "soldier-img",
        linkedFrontId: "treasure-front",
        projectId: "project-1",
      },
      {
        uuid: "soldier-front",
        name: "Soldier",
        order: 20,
        isUserUpload: false,
        isToken: true,
        imageId: "soldier-img",
        projectId: "project-1",
      },
      {
        uuid: "soldier-back",
        name: "Treasure",
        order: 20,
        isUserUpload: false,
        imageId: "treasure-img",
        linkedFrontId: "soldier-front",
        projectId: "project-1",
      },
    ];
    hoisted.cardsToArray.mockResolvedValue(projectCards);
    hoisted.cardsBulkGet.mockResolvedValue([
      projectCards.find((card) => card.uuid === "treasure-front"),
      projectCards.find((card) => card.uuid === "soldier-front"),
    ]);
    hoisted.importMissingTokens.mockResolvedValue([]);

    const result = await handleManualTwoSidedTokenImport();

    expect(result.pairedTokenCount).toBe(2);
    expect(hoisted.cardsBulkUpdate).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ key: "treasure-back" }),
        expect.objectContaining({ key: "soldier-back" }),
      ])
    );
    expect(hoisted.imagesBulkGet).not.toHaveBeenCalled();
    random.mockRestore();
  });

  it("uses linkedBackId repairs and deletes images whose refCount reaches zero", async () => {
    const random = vi.spyOn(Math, "random").mockReturnValue(0);
    const projectCards = [
      {
        uuid: "source",
        name: "Token Maker",
        order: 1,
        isUserUpload: false,
        projectId: "project-1",
        token_parts: [{ name: "Treasure" }, { name: "Soldier" }],
      },
      {
        uuid: "treasure-front",
        name: "Treasure",
        order: 10,
        isUserUpload: false,
        isToken: true,
        imageId: "treasure-img",
        linkedBackId: "orphan-linked-back",
        projectId: "project-1",
      },
      {
        uuid: "orphan-linked-back",
        name: "Old",
        order: 10,
        isUserUpload: false,
        imageId: "old-img",
        projectId: "project-1",
      },
      {
        uuid: "soldier-front",
        name: "Soldier",
        order: 20,
        isUserUpload: false,
        isToken: true,
        imageId: "cardback_token_soldier",
        projectId: "project-1",
      },
    ];
    hoisted.cardsToArray.mockResolvedValue(projectCards);
    hoisted.cardsBulkGet.mockResolvedValue([
      projectCards.find((card) => card.uuid === "treasure-front"),
      projectCards.find((card) => card.uuid === "soldier-front"),
    ]);
    hoisted.imagesBulkGet.mockResolvedValue([
      { id: "old-img", refCount: 1 },
      undefined,
    ]);
    hoisted.importMissingTokens.mockResolvedValue([]);

    const result = await handleManualTwoSidedTokenImport();

    expect(result.pairedTokenCount).toBe(2);
    expect(hoisted.cardsBulkUpdate).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          key: "orphan-linked-back",
          changes: expect.objectContaining({
            imageId: "cardback_token_soldier",
          }),
        }),
      ])
    );
    expect(hoisted.imagesBulkDelete).toHaveBeenCalledWith(["old-img"]);
    random.mockRestore();
  });
});
