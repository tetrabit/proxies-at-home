import { beforeEach, describe, expect, it } from "vitest";
import type { ScryfallCard } from "../../../shared/types";
import { db } from "@/db";
import { addCards, createLinkedBackCardsBulk } from "./dbUtils";
import { convertScryfallToCardOptions } from "./cardConverter";

const doubleFacedCard = (): ScryfallCard =>
  ({
    name: "Invasion of Zendikar",
    set: "mom",
    number: "194",
    scryfall_id: "scryfall-invasion",
    oracle_id: "oracle-invasion",
    lang: "en",
    imageUrls: ["https://img.example/front.jpg"],
    prints: [
      {
        imageUrl: "https://img.example/front.jpg",
        set: "mom",
        number: "194",
      },
    ],
    colors: ["G"],
    cmc: 4,
    type_line: "Battle — Siege",
    rarity: "rare",
    mana_cost: "{3}{G}",
    card_faces: [
      { name: "Invasion of Zendikar", imageUrl: "https://img.example/front-face.jpg" },
      { name: "Awakened Skyclave", imageUrl: "https://img.example/back-face.jpg" },
    ],
  }) as ScryfallCard;

describe("Scryfall converter linked-back image ownership", () => {
  beforeEach(async () => {
    await db.cards.clear();
    await db.images.clear();
  });

  it.each([1, 4])(
    "stores one back-image reference for each linked back at quantity %i",
    async (quantity) => {
      const resolved = await convertScryfallToCardOptions(doubleFacedCard(), quantity, {
        projectId: "project-dfc",
      });
      const addedFronts = await addCards(resolved.cardsToAdd);

      await createLinkedBackCardsBulk(
        resolved.backCardTasks.map((task) => ({
          frontUuid: addedFronts[task.frontIndex].uuid,
          backImageId: task.backImageId,
          backName: task.backName,
        }))
      );

      const backImageId = resolved.backCardTasks[0].backImageId;
      const linkedBacks = (await db.cards.where("imageId").equals(backImageId).toArray()).filter(
        (card) => card.linkedFrontId !== undefined
      );
      const storedImage = await db.images.get(backImageId);
      const storedFronts = await db.cards.bulkGet(addedFronts.map((card) => card.uuid));

      expect(resolved.cardsToAdd).toHaveLength(quantity);
      expect(resolved.backCardTasks).toEqual(
        Array.from({ length: quantity }, (_, frontIndex) => ({
          frontIndex,
          backImageId,
          backName: "Awakened Skyclave",
        }))
      );
      expect(linkedBacks).toHaveLength(quantity);
      expect(linkedBacks.every((back) => back.name === "Awakened Skyclave")).toBe(true);
      expect(storedFronts.every((front) => front?.linkedBackId !== undefined)).toBe(true);
      expect(storedImage?.refCount).toBe(linkedBacks.length);
    }
  );
});
