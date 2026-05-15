import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  undoableReorderCards,
  undoableReorderMultipleCards,
  undoableDeleteCard,
  undoableDeleteCardsBatch,
  undoableAddCards,
  undoableDuplicateCard,
  undoableDuplicateCardsBatch,
  undoableUpdateCardBleedSettings,
} from "./undoableActions";
import { db } from "@/db";
import { addCards, deleteCard, duplicateCard } from "./dbUtils";
import type { CardOption } from "@/types";

// Mock the database
vi.mock("@/db", () => ({
  db: {
    cards: {
      get: vi.fn(),
      delete: vi.fn(),
      add: vi.fn(),
      update: vi.fn(),
      bulkGet: vi.fn(),
      bulkDelete: vi.fn(),
      bulkAdd: vi.fn(),
      bulkUpdate: vi.fn(),
      bulkPut: vi.fn(),
      orderBy: vi.fn(() => ({
        toArray: vi.fn().mockResolvedValue([]),
      })),
      where: vi.fn(() => ({
        equals: vi.fn(() => ({
          first: vi.fn(),
          toArray: vi.fn().mockResolvedValue([]),
        })),
        anyOf: vi.fn(() => ({
          toArray: vi.fn().mockResolvedValue([]),
        })),
      })),
      filter: vi.fn(() => ({
        toArray: vi.fn().mockResolvedValue([]),
      })),
      toArray: vi.fn().mockResolvedValue([]),
    },
    images: {
      get: vi.fn(),
      delete: vi.fn(),
      add: vi.fn(),
      update: vi.fn(),
      bulkGet: vi.fn().mockResolvedValue([]),
      bulkDelete: vi.fn(),
      bulkUpdate: vi.fn(),
      bulkAdd: vi.fn(),
      filter: vi.fn(() => ({
        keys: vi.fn().mockResolvedValue([]),
      })),
    },
    cardbacks: {
      update: vi.fn(),
    },
    transaction: vi.fn((...args) => args[args.length - 1]()),
  },
}));

// Mock dbUtils
vi.mock("./dbUtils", () => ({
  addCardWithImage: vi.fn().mockResolvedValue({
    uuid: "new-card-uuid",
    name: "Test Card",
    order: 1,
  }),
  addCards: vi.fn().mockResolvedValue([]),
  duplicateCard: vi.fn(),
  deleteCard: vi.fn(),
  deleteCardAndImage: vi.fn(),
  changeCardArtwork: vi.fn(),
  rebalanceCardOrders: vi.fn(),
  createLinkedBackCard: vi.fn().mockResolvedValue("back-uuid"),
  createLinkedBackCardsBulk: vi.fn().mockResolvedValue(["back-uuid"]),
  addRemoteImage: vi.fn(),
  modifyImageRefCount: vi.fn(),
}));

// Mock undoRedo store
const mockPushAction = vi.fn();
vi.mock("@/store/undoRedo", () => ({
  useUndoRedoStore: {
    getState: vi.fn(() => ({
      pushAction: mockPushAction,
    })),
  },
}));

// Mock settings store
vi.mock("@/store/settings", () => ({
  useSettingsStore: {
    getState: vi.fn(() => ({
      defaultCardbackId: "__builtin_mtg__",
    })),
    subscribe: vi.fn(() => () => {}), // Returns unsubscribe function
  },
}));

// Mock cardbackLibrary
vi.mock("./cardbackLibrary", () => ({
  BUILTIN_CARDBACKS: [
    { id: "__builtin_mtg__", name: "MTG", hasBuiltInBleed: true },
  ],
  isCardbackId: (id: string) => id.startsWith("cardback_"),
}));

describe("undoableActions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("undoableReorderCards", () => {
    it("should push an undo action for reordering", async () => {
      const mockCard = { uuid: "card-123", order: 0 };
      vi.mocked(db.cards.get).mockResolvedValue(
        mockCard as unknown as CardOption
      );

      await undoableReorderCards("card-123", 0, 2);

      expect(mockPushAction).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "REORDER_CARDS",
          description: "Reorder cards",
        })
      );
    });

    it("undoes and redoes a single-card reorder", async () => {
      const mockCard = { uuid: "card-123", order: 0 };
      vi.mocked(db.cards.get).mockResolvedValue(
        mockCard as unknown as CardOption
      );

      await undoableReorderCards("card-123", 0, 2);

      const pushedAction = mockPushAction.mock.calls[0][0];
      await pushedAction.undo();
      await pushedAction.redo();

      expect(db.cards.update).toHaveBeenNthCalledWith(1, "card-123", {
        order: 0,
      });
      expect(db.cards.update).toHaveBeenNthCalledWith(2, "card-123", {
        order: 2,
      });
    });
  });

  describe("undoableReorderMultipleCards", () => {
    it("should push an undo action for reordering multiple cards", async () => {
      const adjustments = [
        { uuid: "card-1", oldOrder: 0, newOrder: 2 },
        { uuid: "card-2", oldOrder: 1, newOrder: 0 },
      ];
      const mockCards = [
        { uuid: "card-1", order: 0 },
        { uuid: "card-2", order: 1 },
      ];
      vi.mocked(db.cards.bulkGet).mockResolvedValue(
        mockCards as unknown as CardOption[]
      );

      await undoableReorderMultipleCards(adjustments);

      expect(mockPushAction).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "REORDER_MULTIPLE_CARDS",
          description: "Reorder 2 cards",
        })
      );
    });

    it("should not push action for empty adjustments array", async () => {
      await undoableReorderMultipleCards([]);

      expect(mockPushAction).not.toHaveBeenCalled();
    });

    it("undoes and redoes multiple-card reorders", async () => {
      const adjustments = [{ uuid: "card-1", oldOrder: 0, newOrder: 2 }];

      await undoableReorderMultipleCards(adjustments);

      const pushedAction = mockPushAction.mock.calls[0][0];
      await pushedAction.undo();
      await pushedAction.redo();

      expect(db.cards.bulkUpdate).toHaveBeenNthCalledWith(1, [
        { key: "card-1", changes: { order: 0 } },
      ]);
      expect(db.cards.bulkUpdate).toHaveBeenNthCalledWith(2, [
        { key: "card-1", changes: { order: 2 } },
      ]);
    });
  });
  describe("undoableDeleteCard", () => {
    it("does not push an action when the card no longer exists", async () => {
      vi.mocked(db.cards.get).mockResolvedValueOnce(
        undefined as unknown as CardOption
      );

      await undoableDeleteCard("missing-card");

      expect(mockPushAction).not.toHaveBeenCalled();
    });
    it("should push an undo action for deleting a card", async () => {
      vi.mocked(db.cards.get).mockResolvedValueOnce({
        uuid: "card-1",
        name: "Delete Me",
        imageId: "img-1",
      } as unknown as CardOption);

      await undoableDeleteCard("card-1");
      expect(mockPushAction).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "DELETE_CARD",
          description: expect.stringContaining('Delete "'),
        })
      );
    });
  });

  describe("undoableDeleteCardsBatch", () => {
    it("does not push when there are no card ids or no matching cards", async () => {
      await undoableDeleteCardsBatch([]);
      expect(mockPushAction).not.toHaveBeenCalled();

      vi.mocked(db.cards.bulkGet).mockResolvedValueOnce([
        undefined,
      ] as unknown as CardOption[]);
      await undoableDeleteCardsBatch(["missing"]);
      expect(mockPushAction).not.toHaveBeenCalled();
    });

    it("captures linked backs and image ref updates for batch deletes", async () => {
      const front = {
        uuid: "front",
        name: "Front",
        imageId: "img-front",
        linkedBackId: "back",
      } as CardOption;
      const back = {
        uuid: "back",
        name: "Back",
        imageId: "cardback_builtin",
        linkedFrontId: "front",
      } as CardOption;
      vi.mocked(db.cards.bulkGet).mockResolvedValueOnce([front]);
      vi.mocked(db.cards.get).mockResolvedValueOnce(back);
      vi.mocked(db.images.get).mockResolvedValue({
        id: "img-front",
        refCount: 1,
      } as never);
      vi.mocked(db.images.bulkGet).mockResolvedValueOnce([
        { id: "img-front", refCount: 1 },
      ] as never);

      await undoableDeleteCardsBatch(["front"]);

      expect(db.cards.bulkDelete).toHaveBeenCalledWith(["front", "back"]);
      expect(db.images.bulkDelete).toHaveBeenCalledWith(["img-front"]);
      expect(mockPushAction).toHaveBeenCalledWith(
        expect.objectContaining({ type: "DELETE_CARDS_BATCH" })
      );

      const pushedAction = mockPushAction.mock.calls[0][0];
      vi.mocked(db.images.bulkGet).mockResolvedValueOnce([undefined] as never);
      await pushedAction.undo();
      await pushedAction.redo();

      expect(db.cards.bulkAdd).toHaveBeenCalledWith([front, back]);
      expect(db.images.bulkAdd).toHaveBeenCalledWith([
        { id: "img-front", refCount: 1 },
      ]);
    });
  });
  describe("undoableAddCards", () => {
    it("returns early when no cards are provided or created", async () => {
      await expect(undoableAddCards([])).resolves.toEqual([]);
      expect(mockPushAction).not.toHaveBeenCalled();

      vi.mocked(addCards).mockResolvedValueOnce([]);
      await expect(
        undoableAddCards([{ name: "None", lang: "en", isUserUpload: false }])
      ).resolves.toEqual([]);
      expect(mockPushAction).not.toHaveBeenCalled();
    });

    it("should push an undo action for adding cards", async () => {
      const cardsToAdd = [
        { name: "New Card", lang: "en", isUserUpload: false },
      ];
      vi.mocked(addCards).mockResolvedValue([
        {
          uuid: "new-uuid",
          name: "New Card",
          imageId: "img-1",
        } as unknown as CardOption,
      ]);

      await undoableAddCards(cardsToAdd);

      expect(mockPushAction).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "ADD_CARDS",
          description: expect.stringContaining('Add "'),
        })
      );
    });
  });

  describe("undoableDuplicateCard", () => {
    it("returns undefined when the source card is missing or no new card appears", async () => {
      vi.mocked(db.cards.get).mockResolvedValueOnce(
        undefined as unknown as CardOption
      );
      await expect(undoableDuplicateCard("missing")).resolves.toBeUndefined();

      vi.mocked(db.cards.get).mockResolvedValueOnce({
        uuid: "old",
        name: "Old",
      } as CardOption);
      vi.mocked(db.cards.toArray)
        .mockResolvedValueOnce([{ uuid: "old", name: "Old" }] as CardOption[])
        .mockResolvedValueOnce([{ uuid: "old", name: "Old" }] as CardOption[]);
      await expect(undoableDuplicateCard("old")).resolves.toBeUndefined();
    });

    it("should push an undo action for duplicating a card", async () => {
      // Mock finding the new card
      const original = { uuid: "old-uuid", name: "Old Card" };
      const newCard = { uuid: "new-uuid", name: "Old Card" };

      // First call returns original
      // Second call returns original + new
      vi.mocked(db.cards.get).mockResolvedValueOnce(
        original as unknown as CardOption
      );
      vi.mocked(db.cards.toArray)
        .mockResolvedValueOnce([original] as unknown as CardOption[])
        .mockResolvedValueOnce([original, newCard] as unknown as CardOption[]);

      await undoableDuplicateCard("old-uuid");

      expect(mockPushAction).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "DUPLICATE_CARD",
          description: expect.stringContaining('Duplicate "'),
        })
      );

      const pushedAction = mockPushAction.mock.calls[0][0];
      await pushedAction.undo();
      await pushedAction.redo();

      expect(deleteCard).toHaveBeenCalledWith("new-uuid");
      expect(duplicateCard).toHaveBeenCalledWith("old-uuid");
    });
  });

  describe("undoableDuplicateCardsBatch", () => {
    it("returns an empty list without pushing when no cards can be duplicated", async () => {
      await expect(undoableDuplicateCardsBatch([])).resolves.toEqual([]);
      expect(mockPushAction).not.toHaveBeenCalled();

      vi.mocked(db.cards.orderBy).mockReturnValueOnce({
        toArray: vi.fn().mockResolvedValue([]),
      } as never);
      await expect(undoableDuplicateCardsBatch(["missing"])).resolves.toEqual(
        []
      );
      expect(mockPushAction).not.toHaveBeenCalled();
    });
  });
  describe("undoableUpdateCardBleedSettings", () => {
    const selectedCard = {
      uuid: "back-1",
      name: "Shared Back",
      order: 0,
      imageId: "cardback_uploaded_1",
      isUserUpload: true,
    } as CardOption;
    const otherSharedCard = {
      uuid: "back-2",
      name: "Other Shared Back",
      order: 1,
      imageId: "cardback_uploaded_1",
      isUserUpload: true,
    } as CardOption;

    beforeEach(() => {
      vi.mocked(db.cards.where).mockImplementation(
        (field: string) =>
          ({
            anyOf: vi.fn(() => ({
              toArray: vi
                .fn()
                .mockResolvedValue(field === "uuid" ? [selectedCard] : []),
            })),
            equals: vi.fn(() => ({
              first: vi.fn(),
              toArray: vi
                .fn()
                .mockResolvedValue(
                  field === "imageId" ? [selectedCard, otherSharedCard] : []
                ),
            })),
          }) as ReturnType<typeof db.cards.where>
      );
    });

    it("updates only selected cards when selected scope is requested", async () => {
      await undoableUpdateCardBleedSettings(
        ["back-1"],
        { bleedMode: "none" },
        { scope: "selected" }
      );

      expect(db.cards.bulkUpdate).toHaveBeenCalledWith([
        {
          key: "back-1",
          changes: expect.objectContaining({ bleedMode: "none" }),
        },
      ]);
    });

    it("keeps shared-image updates as the default behavior", async () => {
      await undoableUpdateCardBleedSettings(["back-1"], { bleedMode: "none" });

      expect(db.cards.bulkUpdate).toHaveBeenCalledWith([
        {
          key: "back-1",
          changes: expect.objectContaining({ bleedMode: "none" }),
        },
        {
          key: "back-2",
          changes: expect.objectContaining({ bleedMode: "none" }),
        },
      ]);
    });
  });
});
