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
  undoableChangeCardback,
} from "./undoableActions";
import { db } from "@/db";
import { useSettingsStore } from "@/store/settings";
import {
  addCards,
  addRemoteImage,
  changeCardArtwork,
  createLinkedBackCard,
  createLinkedBackCardsBulk,
  deleteCard,
  duplicateCard,
  rebalanceCardOrders,
} from "./dbUtils";
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
      vi.mocked(db.cards.update).mockClear();
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

    it("returns without action when a single reorder card is missing", async () => {
      vi.mocked(db.cards.get).mockResolvedValueOnce(undefined as unknown as CardOption);

      await undoableReorderCards("missing", 0, 1);

      expect(mockPushAction).not.toHaveBeenCalled();
    });

    it("undoes and redoes a single-card reorder with a linked back partner", async () => {
      vi.mocked(db.cards.get).mockResolvedValueOnce({
        uuid: "front-card",
        linkedBackId: "back-card",
      } as CardOption);

      await undoableReorderCards("front-card", 4, 8);
      const pushedAction = mockPushAction.mock.calls[0][0];
      await pushedAction.undo();
      await pushedAction.redo();

      expect(db.cards.update).toHaveBeenCalledWith("back-card", { order: 8 });
    });

    it("undoes and redoes a single-card reorder with a linked front partner", async () => {
      vi.mocked(db.cards.get).mockResolvedValueOnce({
        uuid: "back-card",
        linkedFrontId: "front-card",
      } as CardOption);

      await undoableReorderCards("back-card", 4, 8);
      const pushedAction = mockPushAction.mock.calls[0][0];
      await pushedAction.undo();
      await pushedAction.redo();

      expect(db.cards.update).toHaveBeenCalledWith("front-card", { order: 8 });
    });

    it("undoes and redoes multiple-card reorders", async () => {
      const adjustments = [{ uuid: "card-1", oldOrder: 0, newOrder: 2 }];

      await undoableReorderMultipleCards(adjustments);

      const pushedAction = mockPushAction.mock.calls[0][0];
      vi.mocked(db.cards.update).mockClear();
      await pushedAction.undo();
      await pushedAction.redo();

      expect(db.cards.update).toHaveBeenNthCalledWith(1, "card-1", {
        order: 0,
      });
      expect(db.cards.update).toHaveBeenNthCalledWith(2, "card-1", {
        order: 2,
      });
    });


    it("skips missing linked partners for multiple-card reorders", async () => {
      const front = {
        uuid: "front-with-missing-back",
        order: 10,
        linkedBackId: "missing-back",
      } as CardOption;
      vi.mocked(db.cards.bulkGet)
        .mockResolvedValueOnce([front] as unknown as CardOption[])
        .mockResolvedValueOnce([undefined] as unknown as CardOption[]);

      await undoableReorderMultipleCards([
        { uuid: "front-with-missing-back", oldOrder: 10, newOrder: 30 },
      ]);

      expect(db.cards.update).toHaveBeenCalledWith("front-with-missing-back", { order: 30 });
    });

    it("adds missing linked front partners for multiple-card reorders", async () => {
      const back = {
        uuid: "back-linked-front",
        order: 10,
        linkedFrontId: "front-linked-front",
      } as CardOption;
      const front = {
        uuid: "front-linked-front",
        order: 10,
        linkedBackId: "back-linked-front",
      } as CardOption;
      vi.mocked(db.cards.bulkGet)
        .mockResolvedValueOnce([back] as unknown as CardOption[])
        .mockResolvedValueOnce([front] as unknown as CardOption[]);

      await undoableReorderMultipleCards([
        { uuid: "back-linked-front", oldOrder: 10, newOrder: 30 },
      ]);

      expect(db.cards.update).toHaveBeenCalledWith("front-linked-front", { order: 30 });
    });

    it("adds missing linked partners for multiple-card reorders", async () => {
      const front = {
        uuid: "front-linked",
        order: 10,
        linkedBackId: "back-linked",
      } as CardOption;
      const back = {
        uuid: "back-linked",
        order: 10,
        linkedFrontId: "front-linked",
      } as CardOption;
      vi.mocked(db.cards.bulkGet)
        .mockResolvedValueOnce([undefined, front] as unknown as CardOption[])
        .mockResolvedValueOnce([back] as unknown as CardOption[]);

      await undoableReorderMultipleCards([
        { uuid: "missing", oldOrder: 1, newOrder: 20 },
        { uuid: "front-linked", oldOrder: 10, newOrder: 30 },
      ]);

      expect(db.cards.update).toHaveBeenCalledWith("back-linked", { order: 30 });
      const pushedAction = mockPushAction.mock.calls[0][0];
      vi.mocked(db.cards.update).mockClear();
      await pushedAction.undo();
      await pushedAction.redo();

      expect(db.cards.update).toHaveBeenCalledWith("back-linked", { order: 10 });
      expect(db.cards.update).toHaveBeenCalledWith("back-linked", { order: 30 });
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


    it("undoes a single-card delete and restores captured image data", async () => {
      const card = { uuid: "card-1", name: "Delete Me", imageId: "img-1" } as CardOption;
      const image = { id: "img-1", refCount: 1 };
      vi.mocked(db.cards.get).mockResolvedValueOnce(card);
      vi.mocked(db.images.get).mockResolvedValueOnce(image as never);

      await undoableDeleteCard("card-1");
      const pushedAction = mockPushAction.mock.calls[0][0];
      await pushedAction.undo();
      await pushedAction.redo();

      expect(db.cards.add).toHaveBeenCalledWith(card);
      expect(deleteCard).toHaveBeenCalledWith("card-1");
    });

    it("undoes a single-card delete without image data", async () => {
      const card = { uuid: "card-no-image-data", name: "No Image Data", imageId: "missing-img" } as CardOption;
      vi.mocked(db.cards.get).mockResolvedValueOnce(card);
      vi.mocked(db.images.get).mockResolvedValueOnce(undefined as never);

      await undoableDeleteCard("card-no-image-data");
      const pushedAction = mockPushAction.mock.calls[0][0];
      await pushedAction.undo();

      expect(db.cards.add).toHaveBeenCalledWith(card);
    });

    it("deletes and restores a card without an image id", async () => {
      const card = { uuid: "card-no-image", name: "No Image" } as CardOption;
      vi.mocked(db.cards.get).mockResolvedValueOnce(card);

      await undoableDeleteCard("card-no-image");
      const pushedAction = mockPushAction.mock.calls[0][0];
      await pushedAction.undo();

      expect(db.images.get).not.toHaveBeenCalled();
      expect(db.cards.add).toHaveBeenCalledWith(card);
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

    it("clears surviving front links and restores existing images during batch delete undo/redo", async () => {
      const back = {
        uuid: "back-only",
        name: "Back Only",
        imageId: "img-shared",
        linkedFrontId: "front-survives",
      } as CardOption;
      vi.mocked(db.cards.bulkGet).mockResolvedValueOnce([back]);
      vi.mocked(db.images.get).mockResolvedValueOnce({ id: "img-shared", refCount: 3 } as never);
      vi.mocked(db.images.bulkGet).mockResolvedValueOnce([
        { id: "img-shared", refCount: 3 },
      ] as never);

      await undoableDeleteCardsBatch(["back-only"]);

      expect(db.cards.update).toHaveBeenCalledWith("front-survives", { linkedBackId: undefined });
      expect(db.images.bulkUpdate).toHaveBeenCalledWith([
        { key: "img-shared", changes: { refCount: 2 } },
      ]);

      const pushedAction = mockPushAction.mock.calls[0][0];
      vi.mocked(db.images.bulkGet)
        .mockResolvedValueOnce([{ id: "img-shared", refCount: 2 }] as never)
        .mockResolvedValueOnce([{ id: "img-shared", refCount: 3 }] as never);

      await pushedAction.undo();
      await pushedAction.redo();

      expect(db.images.bulkUpdate).toHaveBeenCalledWith([
        { key: "img-shared", changes: { refCount: 3 } },
      ]);
      expect(db.images.bulkUpdate).toHaveBeenCalledWith([
        { key: "img-shared", changes: { refCount: 2 } },
      ]);

      vi.mocked(db.images.bulkGet).mockResolvedValueOnce([
        { id: "img-shared", refCount: 1 },
      ] as never);
      await pushedAction.redo();

      expect(db.images.bulkDelete).toHaveBeenCalledWith(["img-shared"]);
    });

    it("handles a batch delete with a missing linked back and no image refs", async () => {
      const front = {
        uuid: "front-missing-back",
        name: "Front Missing Back",
        linkedBackId: "missing-back",
      } as CardOption;
      vi.mocked(db.cards.bulkGet).mockResolvedValueOnce([front]);
      vi.mocked(db.cards.get).mockResolvedValueOnce(undefined as unknown as CardOption);

      await undoableDeleteCardsBatch(["front-missing-back"]);
      const pushedAction = mockPushAction.mock.calls[0][0];
      await pushedAction.undo();
      await pushedAction.redo();

      expect(db.images.bulkGet).toHaveBeenCalledWith([]);
      expect(pushedAction.description).toBe('Delete "Front Missing Back"');
    });

    it("describes batch deletes with multiple valid cards", async () => {
      vi.mocked(db.cards.bulkGet).mockResolvedValueOnce([
        { uuid: "card-a", name: "A" },
        { uuid: "card-b", name: "B" },
      ] as CardOption[]);

      await undoableDeleteCardsBatch(["card-a", "card-b"]);

      expect(mockPushAction.mock.calls[0][0].description).toBe("Delete 2 cards");
    });

    it("skips missing images during batch delete ref updates", async () => {
      const card = { uuid: "card-missing-image", name: "Missing Image", imageId: "img-missing" } as CardOption;
      vi.mocked(db.cards.bulkGet).mockResolvedValueOnce([card]);
      vi.mocked(db.images.get).mockResolvedValueOnce({ id: "img-missing", refCount: 1 } as never);
      vi.mocked(db.images.bulkGet).mockResolvedValueOnce([undefined] as never);

      await undoableDeleteCardsBatch(["card-missing-image"]);

      expect(db.images.bulkUpdate).not.toHaveBeenCalled();
      expect(db.images.bulkDelete).not.toHaveBeenCalled();
    });

    it("skips restoring batch-delete images when captured image data is unavailable", async () => {
      const card = { uuid: "card-no-captured-image", name: "No Capture", imageId: "img-no-capture" } as CardOption;
      vi.mocked(db.cards.bulkGet).mockResolvedValueOnce([card]);
      vi.mocked(db.images.get).mockResolvedValueOnce(undefined as never);
      vi.mocked(db.images.bulkGet).mockResolvedValueOnce([{ id: "img-no-capture", refCount: 1 }] as never);

      await undoableDeleteCardsBatch(["card-no-captured-image"]);
      const pushedAction = mockPushAction.mock.calls[0][0];
      vi.mocked(db.images.bulkGet).mockResolvedValueOnce([undefined] as never);
      await pushedAction.undo();

      expect(db.images.bulkAdd).not.toHaveBeenCalled();
    });

    it("skips surviving-front relink when a batch redo cannot find that front", async () => {
      const back = { uuid: "back-redo", name: "Back Redo", linkedFrontId: "front-gone", imageId: "cardback_builtin" } as CardOption;
      vi.mocked(db.cards.bulkGet).mockResolvedValueOnce([back]);
      await undoableDeleteCardsBatch(["back-redo"]);
      const pushedAction = mockPushAction.mock.calls[0][0];
      vi.mocked(db.cards.get).mockResolvedValueOnce(undefined as unknown as CardOption);
      await pushedAction.redo();

      expect(db.cards.bulkDelete).toHaveBeenCalledWith(["back-redo"]);
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


    it("uses fallback default cardback metadata and undoes cards without image refs", async () => {
      vi.mocked(useSettingsStore.getState).mockReturnValueOnce({
        defaultCardbackId: "missing-default",
      } as never);
      const added = [
        { uuid: "added-no-image", name: "No Image" },
      ] as CardOption[];
      vi.mocked(addCards).mockResolvedValueOnce(added);

      await undoableAddCards([{ name: "No Image", lang: "en", isUserUpload: false }]);
      expect(createLinkedBackCardsBulk).toHaveBeenCalledWith([
        {
          frontUuid: "added-no-image",
          backImageId: "missing-default",
          backName: "Default",
          options: { hasBuiltInBleed: false, usesDefaultCardback: true },
        },
      ]);

      const pushedAction = mockPushAction.mock.calls[0][0];
      vi.mocked(db.cards.bulkGet).mockResolvedValueOnce([undefined, { uuid: "added-no-image" }] as CardOption[]);
      await pushedAction.undo();

      expect(db.cards.bulkDelete).toHaveBeenCalledWith(["back-uuid", "added-no-image"]);
    });

    it("skips missing images while undoing added cards", async () => {
      const added = [
        { uuid: "added-missing-image", name: "Missing Image", imageId: "img-missing" },
      ] as CardOption[];
      vi.mocked(addCards).mockResolvedValueOnce(added);
      vi.mocked(db.images.bulkGet).mockResolvedValueOnce([{ id: "img-missing" }] as never);

      await undoableAddCards([{ name: "Missing Image", lang: "en", isUserUpload: false, imageId: "img-missing" }]);
      const pushedAction = mockPushAction.mock.calls[0][0];
      vi.mocked(db.cards.bulkGet).mockResolvedValueOnce([
        { uuid: "added-missing-image", imageId: "img-missing" },
      ] as CardOption[]);
      vi.mocked(db.images.bulkGet).mockResolvedValueOnce([undefined] as never);
      await pushedAction.undo();

      expect(db.images.bulkUpdate).not.toHaveBeenCalled();
      expect(db.images.bulkDelete).not.toHaveBeenCalled();
    });

    it("undoes and redoes added cards while restoring source urls and image refs", async () => {
      const cardsToAdd = [
        { name: "Card A", lang: "en", isUserUpload: false, imageId: "img-source" },
        { name: "Card B", lang: "en", isUserUpload: false, imageId: "img-url-array" },
      ];
      const added = [
        { uuid: "added-1", name: "Card A", imageId: "img-source" },
        { uuid: "added-2", name: "Card B", imageId: "img-url-array" },
      ] as CardOption[];
      vi.mocked(addCards)
        .mockResolvedValueOnce(added)
        .mockResolvedValueOnce(added);
      vi.mocked(db.images.bulkGet)
        .mockResolvedValueOnce([
          { id: "img-source", sourceUrl: "https://example.test/source.png" },
          { id: "img-url-array", imageUrls: ["https://example.test/array.png"] },
        ] as never)
        .mockResolvedValueOnce([
          { id: "img-source", refCount: 3 },
          { id: "img-url-array", refCount: 1 },
        ] as never)
        .mockResolvedValueOnce([
          { id: "img-source", refCount: 2 },
          undefined,
        ] as never);

      await undoableAddCards(cardsToAdd);

      const pushedAction = mockPushAction.mock.calls[0][0];
      vi.mocked(db.cards.bulkGet).mockResolvedValueOnce([
        { uuid: "back-uuid", imageId: "cardback_builtin" },
        ...added,
      ] as CardOption[]);

      await pushedAction.undo();
      expect(db.images.bulkUpdate).toHaveBeenCalledWith([
        { key: "img-source", changes: { refCount: 2 } },
      ]);
      expect(db.images.bulkDelete).toHaveBeenCalledWith(["img-url-array"]);

      await pushedAction.redo();
      expect(addRemoteImage).toHaveBeenCalledWith(
        ["https://example.test/array.png"],
        1
      );
      expect(createLinkedBackCardsBulk).toHaveBeenCalledWith([
        {
          frontUuid: "added-1",
          backImageId: "__builtin_mtg__",
          backName: "MTG",
          options: { hasBuiltInBleed: true, usesDefaultCardback: true },
        },
        {
          frontUuid: "added-2",
          backImageId: "__builtin_mtg__",
          backName: "MTG",
          options: { hasBuiltInBleed: true, usesDefaultCardback: true },
        },
      ]);
    });


    it("continues redo after missing image refetch retries fail", async () => {
      vi.useFakeTimers();
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const cardsToAdd = [
        { name: "Retry Card", lang: "en", isUserUpload: false, imageId: "missing-image" },
      ];
      const added = [
        { uuid: "added-retry", name: "Retry Card", imageId: "missing-image" },
      ] as CardOption[];
      vi.mocked(addCards)
        .mockResolvedValueOnce(added)
        .mockResolvedValueOnce(added);
      vi.mocked(db.images.bulkGet)
        .mockResolvedValueOnce([undefined] as never)
        .mockResolvedValueOnce([undefined] as never)
        .mockResolvedValueOnce([undefined] as never);
      vi.mocked(addRemoteImage).mockRejectedValue(new Error("network down"));

      await undoableAddCards(cardsToAdd);
      const pushedAction = mockPushAction.mock.calls[0][0];
      const redoPromise = pushedAction.redo();

      await vi.advanceTimersByTimeAsync(500);
      await vi.advanceTimersByTimeAsync(1000);
      await redoPromise;

      expect(addRemoteImage).toHaveBeenCalledTimes(3);
      expect(addRemoteImage).toHaveBeenCalledWith(["missing-image"], 1);
      expect(errorSpy).toHaveBeenCalledWith(
        "[Redo] Failed to re-fetch image after 3 attempts: missing-image",
        expect.any(Error)
      );
      expect(addCards).toHaveBeenCalledTimes(2);
      vi.useRealTimers();
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


    it("undoes a batch duplicate by deleting images whose refcount is exhausted", async () => {
      const front = { uuid: "front-solo", name: "Front", order: 10, imageId: "img-front" } as CardOption;
      vi.spyOn(crypto, "randomUUID").mockReturnValueOnce("new-front-solo" as never);
      vi.mocked(db.cards.orderBy).mockReturnValueOnce({
        toArray: vi.fn().mockResolvedValue([front]),
      } as never);
      vi.mocked(db.images.bulkGet).mockResolvedValueOnce([
        { id: "img-front", refCount: 1 },
      ] as never);

      await expect(undoableDuplicateCardsBatch(["front-solo"])).resolves.toEqual([
        "new-front-solo",
      ]);

      const pushedAction = mockPushAction.mock.calls[0][0];
      vi.mocked(db.cards.bulkGet).mockResolvedValueOnce([
        { uuid: "new-front-solo", imageId: "img-front" },
      ] as CardOption[]);
      vi.mocked(db.images.bulkGet).mockResolvedValueOnce([
        { id: "img-front", refCount: 1 },
      ] as never);

      await pushedAction.undo();

      expect(db.images.bulkDelete).toHaveBeenCalledWith(["img-front"]);
    });

    it("duplicates cards without image refs or available linked backs", async () => {
      const front = { uuid: "front-missing-back", name: "Front", order: 10, linkedBackId: "missing-back" } as CardOption;
      vi.spyOn(crypto, "randomUUID").mockReturnValueOnce("new-front-missing-back" as never);
      vi.mocked(db.cards.orderBy).mockReturnValueOnce({
        toArray: vi.fn().mockResolvedValue([front]),
      } as never);
      vi.mocked(db.cards.get).mockResolvedValueOnce(undefined as unknown as CardOption);

      await expect(undoableDuplicateCardsBatch(["front-missing-back"])).resolves.toEqual([
        "new-front-missing-back",
      ]);
      const pushedAction = mockPushAction.mock.calls[0][0];
      await pushedAction.undo();

      expect(db.images.bulkGet).not.toHaveBeenCalled();
      expect(pushedAction.description).toBe("Duplicate 1 card");
    });

    it("duplicates linked backs without refcounting cardback images", async () => {
      const front = { uuid: "front-cardback", name: "Front", order: 10, linkedBackId: "back-cardback" } as CardOption;
      const back = { uuid: "back-cardback", name: "Back", order: 10, linkedFrontId: "front-cardback", imageId: "cardback_builtin" } as CardOption;
      vi.spyOn(crypto, "randomUUID")
        .mockReturnValueOnce("new-front-cardback" as never)
        .mockReturnValueOnce("new-back-cardback" as never);
      vi.mocked(db.cards.orderBy).mockReturnValueOnce({
        toArray: vi.fn().mockResolvedValue([front, back]),
      } as never);
      vi.mocked(db.cards.get).mockResolvedValueOnce(back);

      await undoableDuplicateCardsBatch(["front-cardback"]);

      expect(db.images.bulkGet).not.toHaveBeenCalled();
    });

    it("duplicates multiple cardback-only cards without image ref updates", async () => {
      const cards = [
        { uuid: "a", name: "A", order: 10, imageId: "cardback_a" },
        { uuid: "b", name: "B", order: 20, imageId: "cardback_b" },
      ] as CardOption[];
      vi.spyOn(crypto, "randomUUID")
        .mockReturnValueOnce("new-a" as never)
        .mockReturnValueOnce("new-b" as never);
      vi.mocked(db.cards.orderBy).mockReturnValueOnce({
        toArray: vi.fn().mockResolvedValue(cards),
      } as never);

      await expect(undoableDuplicateCardsBatch(["a", "b"])).resolves.toEqual([
        "new-a",
        "new-b",
      ]);

      expect(mockPushAction.mock.calls[0][0].description).toBe("Duplicate 2 cards");
    });

    it("skips missing images during duplicate ref increments and undo decrements", async () => {
      const front = { uuid: "front-image", name: "Front", order: 10, imageId: "img-front" } as CardOption;
      vi.spyOn(crypto, "randomUUID").mockReturnValueOnce("new-front-image" as never);
      vi.mocked(db.cards.orderBy).mockReturnValueOnce({
        toArray: vi.fn().mockResolvedValue([front]),
      } as never);
      vi.mocked(db.images.bulkGet).mockResolvedValueOnce([undefined] as never);

      await undoableDuplicateCardsBatch(["front-image"]);
      const pushedAction = mockPushAction.mock.calls[0][0];
      vi.mocked(db.cards.bulkGet).mockResolvedValueOnce([
        { uuid: "new-front-image", imageId: "img-front" },
      ] as CardOption[]);
      vi.mocked(db.images.bulkGet).mockResolvedValueOnce([undefined] as never);
      await pushedAction.undo();

      expect(db.images.bulkUpdate).not.toHaveBeenCalled();
    });

    it("undoes and redoes a batch duplicate with linked backs and image refs", async () => {
      const front = {
        uuid: "front-1",
        name: "Front",
        order: 10,
        imageId: "img-front",
        linkedBackId: "back-1",
      } as CardOption;
      const back = {
        uuid: "back-1",
        name: "Back",
        order: 10,
        imageId: "img-back",
        linkedFrontId: "front-1",
      } as CardOption;
      vi.spyOn(crypto, "randomUUID")
        .mockReturnValueOnce("new-front" as never)
        .mockReturnValueOnce("new-back" as never);
      vi.mocked(db.cards.orderBy).mockReturnValueOnce({
        toArray: vi.fn().mockResolvedValue([front, back]),
      } as never);
      vi.mocked(db.cards.get).mockResolvedValueOnce(back);
      vi.mocked(db.images.bulkGet)
        .mockResolvedValueOnce([
          { id: "img-back", refCount: 1 },
          { id: "img-front", refCount: 2 },
        ] as never)
        .mockResolvedValueOnce([
          { id: "img-front", refCount: 3 },
          { id: "img-back", refCount: 2 },
        ] as never);

      await expect(undoableDuplicateCardsBatch(["front-1"])).resolves.toEqual([
        "new-front",
        "new-back",
      ]);

      expect(db.cards.bulkPut).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ uuid: "front-1", order: 10 }),
          expect.objectContaining({ uuid: "new-front", linkedBackId: "new-back", order: 20 }),
          expect.objectContaining({ uuid: "new-back", linkedFrontId: "new-front", order: 20 }),
        ])
      );
      expect(db.images.bulkUpdate).toHaveBeenCalledWith([
        { key: "img-back", changes: { refCount: 2 } },
        { key: "img-front", changes: { refCount: 3 } },
      ]);

      const pushedAction = mockPushAction.mock.calls[0][0];
      vi.mocked(db.cards.bulkGet).mockResolvedValueOnce([
        { uuid: "new-front", imageId: "img-front" },
        { uuid: "new-back", imageId: "img-back" },
      ] as CardOption[]);
      await pushedAction.undo();

      expect(db.cards.bulkDelete).toHaveBeenCalledWith(["new-front", "new-back"]);
      expect(rebalanceCardOrders).toHaveBeenCalled();

      vi.mocked(db.cards.orderBy).mockReturnValueOnce({
        toArray: vi.fn().mockResolvedValue([front, back]),
      } as never);
      vi.mocked(db.cards.get).mockResolvedValueOnce(back);
      await pushedAction.redo();
      expect(db.cards.bulkPut).toHaveBeenCalledTimes(2);
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

    it("returns without action for empty or missing bleed setting targets", async () => {
      await undoableUpdateCardBleedSettings([], { bleedMode: "none" });
      expect(mockPushAction).not.toHaveBeenCalled();

      vi.mocked(db.cards.where).mockReturnValueOnce({
        anyOf: vi.fn(() => ({ toArray: vi.fn().mockResolvedValue([]) })),
      } as never);
      await undoableUpdateCardBleedSettings(["missing"], { bleedMode: "none" });
      expect(mockPushAction).not.toHaveBeenCalled();
    });

    it("describes unnamed bleed setting targets with the fallback card label", async () => {
      const unnamed = { uuid: "unnamed", imageId: "img-unnamed" } as CardOption;
      vi.mocked(db.cards.where).mockImplementation(
        (field: string) =>
          ({
            anyOf: vi.fn(() => ({
              toArray: vi.fn().mockResolvedValue(field === "uuid" ? [unnamed] : []),
            })),
            equals: vi.fn(() => ({
              first: vi.fn(),
              toArray: vi.fn().mockResolvedValue(field === "imageId" ? [unnamed] : []),
            })),
          }) as ReturnType<typeof db.cards.where>
      );

      await undoableUpdateCardBleedSettings(["unnamed"], { bleedMode: "none" });

      expect(mockPushAction.mock.calls[0][0].description).toBe('Change bleed settings for "card"');
    });

    it("describes multiple bleed setting targets by count", async () => {
      const first = { uuid: "bleed-a", name: "A", imageId: "img-a" } as CardOption;
      const second = { uuid: "bleed-b", name: "B", imageId: "img-b" } as CardOption;
      vi.mocked(db.cards.where).mockImplementation(
        (field: string) =>
          ({
            anyOf: vi.fn(() => ({
              toArray: vi.fn().mockResolvedValue(field === "uuid" ? [first, second] : []),
            })),
            equals: vi.fn((imageId: string) => ({
              first: vi.fn(),
              toArray: vi.fn().mockResolvedValue(
                field === "imageId" ? [imageId === "img-a" ? first : second] : []
              ),
            })),
          }) as ReturnType<typeof db.cards.where>
      );

      await undoableUpdateCardBleedSettings(["bleed-a", "bleed-b"], { bleedMode: "none" });

      expect(mockPushAction.mock.calls[0][0].description).toBe('Change bleed settings for "2 cards"');
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


    it("undoes and redoes bleed settings while invalidating image and cardback caches", async () => {
      await undoableUpdateCardBleedSettings(["back-1"], { bleedMode: "none" });

      const pushedAction = mockPushAction.mock.calls[0][0];
      vi.mocked(db.cards.update).mockClear();
      vi.mocked(db.cardbacks.update).mockClear();
      await pushedAction.undo();
      await pushedAction.redo();

      expect(db.cards.update).toHaveBeenCalledWith(
        "back-1",
        expect.objectContaining({ bleedMode: undefined })
      );
      expect(db.cards.update).toHaveBeenCalledWith(
        "back-2",
        expect.objectContaining({ bleedMode: undefined })
      );
      expect(db.cards.bulkUpdate).toHaveBeenLastCalledWith([
        { key: "back-1", changes: expect.objectContaining({ bleedMode: "none" }) },
        { key: "back-2", changes: expect.objectContaining({ bleedMode: "none" }) },
      ]);
      expect(db.cardbacks.update).toHaveBeenCalledWith(
        "cardback_uploaded_1",
        expect.objectContaining({ generatedBleedMode: undefined })
      );
    });


    it("invalidates regular image caches for bleed undo and redo", async () => {
      const imageCard = {
        uuid: "image-card",
        name: "Image Card",
        order: 0,
        imageId: "img-regular",
        isUserUpload: true,
      } as CardOption;
      vi.mocked(db.cards.where).mockImplementation(
        (field: string) =>
          ({
            anyOf: vi.fn(() => ({
              toArray: vi.fn().mockResolvedValue(field === "uuid" ? [imageCard] : []),
            })),
            equals: vi.fn(() => ({
              first: vi.fn(),
              toArray: vi.fn().mockResolvedValue(field === "imageId" ? [imageCard] : []),
            })),
          }) as ReturnType<typeof db.cards.where>
      );

      await undoableUpdateCardBleedSettings(["image-card"], { bleedMode: "none" });
      const pushedAction = mockPushAction.mock.calls[0][0];
      await pushedAction.undo();
      await pushedAction.redo();

      expect(db.images.update).toHaveBeenCalledWith(
        "img-regular",
        expect.objectContaining({ generatedBleedMode: undefined })
      );
    });
  });

  describe("undoableChangeCardback", () => {
    const frontWithBack = {
      uuid: "front-existing",
      name: "Same",
      order: 10,
      linkedBackId: "back-existing",
    } as CardOption;
    const backExisting = {
      uuid: "back-existing",
      name: "Old Back",
      order: 10,
      imageId: "old-cardback",
      linkedFrontId: "front-existing",
      usesDefaultCardback: true,
    } as CardOption;
    const frontWithoutBack = {
      uuid: "front-new",
      name: "Other",
      order: 20,
    } as CardOption;

    beforeEach(() => {
      vi.mocked(db.cards.where).mockReturnValue({
        anyOf: vi.fn(() => ({
          toArray: vi.fn().mockResolvedValue([frontWithBack, frontWithoutBack]),
        })),
      } as never);
      vi.mocked(db.cards.bulkGet).mockResolvedValue([backExisting] as CardOption[]);
    });

    it("returns without action for empty or missing cardback targets", async () => {
      await undoableChangeCardback([], "new", "New");
      expect(mockPushAction).not.toHaveBeenCalled();

      vi.mocked(db.cards.where).mockReturnValueOnce({
        anyOf: vi.fn(() => ({ toArray: vi.fn().mockResolvedValue([]) })),
      } as never);
      await undoableChangeCardback(["missing"], "new", "New");
      expect(mockPushAction).not.toHaveBeenCalled();
    });

    it("handles fronts whose linked back is missing", async () => {
      vi.mocked(db.cards.where).mockReturnValue({
        anyOf: vi.fn(() => ({
          toArray: vi.fn().mockResolvedValue([frontWithBack]),
        })),
      } as never);
      vi.mocked(db.cards.bulkGet).mockResolvedValueOnce([undefined] as unknown as CardOption[]);

      await undoableChangeCardback(["front-existing"], "cardback_new", "New Back", false);

      expect(changeCardArtwork).not.toHaveBeenCalled();
      expect(createLinkedBackCardsBulk).not.toHaveBeenCalled();
    });

    it("describes same-name multi-card cardback changes", async () => {
      vi.mocked(db.cards.where).mockReturnValue({
        anyOf: vi.fn(() => ({
          toArray: vi.fn().mockResolvedValue([
            { uuid: "front-a", name: "Same" },
            { uuid: "front-b", name: "Same" },
          ]),
        })),
      } as never);
      vi.mocked(db.cards.bulkGet).mockResolvedValueOnce([]);

      await undoableChangeCardback(["front-a", "front-b"], "cardback_new", "New Back", false);

      expect(mockPushAction.mock.calls[0][0].description).toBe('Change cardback for 2 "Same" cards');
    });

    it("updates only existing backs without creating new backs", async () => {
      vi.mocked(db.cards.where).mockReturnValue({
        anyOf: vi.fn(() => ({
          toArray: vi.fn().mockResolvedValue([frontWithBack]),
        })),
      } as never);
      vi.mocked(db.cards.bulkGet).mockResolvedValueOnce([backExisting] as CardOption[]);

      await undoableChangeCardback(["front-existing"], "cardback_new", "New Back", false);

      expect(db.cards.bulkUpdate).toHaveBeenCalledWith([
        { key: "back-existing", changes: { usesDefaultCardback: false } },
      ]);
      expect(createLinkedBackCardsBulk).not.toHaveBeenCalled();
    });

    it("updates existing backs, creates missing backs, and supports undo/redo", async () => {
      await undoableChangeCardback(
        ["front-existing", "front-new"],
        "cardback_new",
        "New Back",
        false
      );

      expect(changeCardArtwork).toHaveBeenCalledWith(
        "old-cardback",
        "cardback_new",
        backExisting,
        false,
        "New Back",
        undefined,
        undefined,
        false
      );
      expect(createLinkedBackCardsBulk).toHaveBeenCalledWith([
        {
          frontUuid: "front-new",
          backImageId: "cardback_new",
          backName: "New Back",
          options: { hasBuiltInBleed: false, usesDefaultCardback: false },
        },
      ]);
      expect(mockPushAction).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "CHANGE_CARDBACK",
          description: "Change cardback for 2 cards",
        })
      );

      const pushedAction = mockPushAction.mock.calls[0][0];
      vi.mocked(db.cards.get)
        .mockResolvedValueOnce(backExisting)
        .mockResolvedValueOnce({ ...frontWithoutBack, linkedBackId: "new-back" } as CardOption)
        .mockResolvedValueOnce({ uuid: "new-back", imageId: "img-new" } as CardOption);
      vi.mocked(db.images.get).mockResolvedValueOnce({ id: "img-new", refCount: 1 } as never);

      await pushedAction.undo();

      expect(changeCardArtwork).toHaveBeenCalledWith(
        "old-cardback",
        "old-cardback",
        backExisting,
        false,
        "Old Back",
        undefined,
        undefined,
        true
      );
      expect(db.images.delete).toHaveBeenCalledWith("img-new");
      expect(db.cards.delete).toHaveBeenCalledWith("new-back");
      expect(db.cards.update).toHaveBeenCalledWith("front-new", { linkedBackId: undefined });

      vi.mocked(db.cards.get)
        .mockResolvedValueOnce(frontWithBack)
        .mockResolvedValueOnce(backExisting)
        .mockResolvedValueOnce(frontWithoutBack);
      await pushedAction.redo();

      expect(db.cards.update).toHaveBeenCalledWith("back-existing", {
        usesDefaultCardback: false,
      });
      expect(createLinkedBackCard).toHaveBeenCalledWith(
        "front-new",
        "cardback_new",
        "New Back",
        { hasBuiltInBleed: false, usesDefaultCardback: false }
      );
    });


    it("skips cardback redo when a front card disappeared", async () => {
      vi.mocked(db.cards.where).mockReturnValue({
        anyOf: vi.fn(() => ({
          toArray: vi.fn().mockResolvedValue([frontWithoutBack]),
        })),
      } as never);
      vi.mocked(db.cards.bulkGet).mockResolvedValue([]);

      await undoableChangeCardback(["front-new"], "img-new", "New Back", false);
      const pushedAction = mockPushAction.mock.calls[0][0];
      vi.mocked(db.cards.get).mockResolvedValueOnce(undefined as unknown as CardOption);

      await pushedAction.redo();

      expect(createLinkedBackCard).not.toHaveBeenCalled();
    });

    it("skips missing old backs while undoing cardback changes", async () => {
      vi.mocked(db.cards.where).mockReturnValue({
        anyOf: vi.fn(() => ({
          toArray: vi.fn().mockResolvedValue([frontWithBack]),
        })),
      } as never);
      vi.mocked(db.cards.bulkGet).mockResolvedValueOnce([backExisting] as CardOption[]);

      await undoableChangeCardback(["front-existing"], "cardback_new", "New Back", false);
      const pushedAction = mockPushAction.mock.calls[0][0];
      vi.mocked(db.cards.get).mockResolvedValueOnce(undefined as unknown as CardOption);

      await pushedAction.undo();

      expect(db.cards.update).not.toHaveBeenCalledWith("back-existing", expect.anything());
    });

    it("skips deleting newly created backs when undo cannot find the linked cards", async () => {
      vi.mocked(db.cards.where).mockReturnValue({
        anyOf: vi.fn(() => ({
          toArray: vi.fn().mockResolvedValue([frontWithoutBack]),
        })),
      } as never);
      vi.mocked(db.cards.bulkGet).mockResolvedValue([]);

      await undoableChangeCardback(["front-new"], "img-new", "New Back", false);
      const pushedAction = mockPushAction.mock.calls[0][0];
      vi.mocked(db.cards.get).mockResolvedValueOnce({ ...frontWithoutBack } as CardOption);
      await pushedAction.undo();

      vi.mocked(db.cards.get)
        .mockResolvedValueOnce({ ...frontWithoutBack, linkedBackId: "new-back" } as CardOption)
        .mockResolvedValueOnce(undefined as unknown as CardOption);
      await pushedAction.undo();

      expect(db.cards.delete).not.toHaveBeenCalledWith("new-back");
    });

    it("skips non-refcount cardbacks and missing images when undoing new backs", async () => {
      vi.mocked(db.cards.where).mockReturnValue({
        anyOf: vi.fn(() => ({
          toArray: vi.fn().mockResolvedValue([frontWithoutBack]),
        })),
      } as never);
      vi.mocked(db.cards.bulkGet).mockResolvedValue([]);

      await undoableChangeCardback(["front-new"], "cardback_builtin", "New Back", false);
      const pushedAction = mockPushAction.mock.calls[0][0];
      vi.mocked(db.cards.get)
        .mockResolvedValueOnce({ ...frontWithoutBack, linkedBackId: "new-back" } as CardOption)
        .mockResolvedValueOnce({ uuid: "new-back", imageId: "cardback_builtin" } as CardOption);
      await pushedAction.undo();

      vi.mocked(db.cards.get)
        .mockResolvedValueOnce({ ...frontWithoutBack, linkedBackId: "new-back" } as CardOption)
        .mockResolvedValueOnce({ uuid: "new-back", imageId: "img-missing" } as CardOption);
      vi.mocked(db.images.get).mockResolvedValueOnce(undefined as never);
      await pushedAction.undo();

      expect(db.cards.delete).toHaveBeenCalledWith("new-back");
    });

    it("skips missing existing backs while redoing cardback changes", async () => {
      vi.mocked(db.cards.where).mockReturnValue({
        anyOf: vi.fn(() => ({
          toArray: vi.fn().mockResolvedValue([frontWithBack]),
        })),
      } as never);
      vi.mocked(db.cards.bulkGet).mockResolvedValueOnce([backExisting] as CardOption[]);

      await undoableChangeCardback(["front-existing"], "cardback_new", "New Back", false);
      const pushedAction = mockPushAction.mock.calls[0][0];
      vi.mocked(db.cards.get)
        .mockResolvedValueOnce(frontWithBack)
        .mockResolvedValueOnce(undefined as unknown as CardOption);

      await pushedAction.redo();

      expect(changeCardArtwork).toHaveBeenCalledTimes(1);
    });

    it("decrements image refs instead of deleting when undoing newly created backs with shared images", async () => {
      vi.mocked(db.cards.where).mockReturnValue({
        anyOf: vi.fn(() => ({
          toArray: vi.fn().mockResolvedValue([frontWithoutBack]),
        })),
      } as never);
      vi.mocked(db.cards.bulkGet).mockResolvedValue([]);

      await undoableChangeCardback(["front-new"], "img-new", "New Back", false);
      const pushedAction = mockPushAction.mock.calls[0][0];
      vi.mocked(db.cards.get)
        .mockResolvedValueOnce({ ...frontWithoutBack, linkedBackId: "new-back" } as CardOption)
        .mockResolvedValueOnce({ uuid: "new-back", imageId: "img-new" } as CardOption);
      vi.mocked(db.images.get).mockResolvedValueOnce({ id: "img-new", refCount: 2 } as never);

      await pushedAction.undo();

      expect(db.images.update).toHaveBeenCalledWith("img-new", { refCount: 1 });
      expect(db.cards.delete).toHaveBeenCalledWith("new-back");
    });
  });
});
