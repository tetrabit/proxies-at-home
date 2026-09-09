import { afterEach, describe, expect, it, vi } from "vitest";
import { getCardsWithImagesForCardInfo } from "./getCardImagesPaged.js";
import { scryfallRequestBroker } from "./scryfallRequestBroker.js";

// This test is deliberately unreachable unless a caller explicitly enables it.
// `npm test` excludes this file, and this guard protects direct Vitest invocations.
const describeLive = process.env.SCRYFALL_LIVE_CONTRACT === "1" ? describe : describe.skip;

describeLive("live Scryfall response contract", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses the shared broker to retrieve Delver of Secrets with real rarity and color metadata", async () => {
    const enqueue = vi.spyOn(scryfallRequestBroker, "enqueue");

    const cards = await getCardsWithImagesForCardInfo({
      name: "Delver of Secrets",
      set: "isd",
      number: "51",
    });

    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(cards).not.toHaveLength(0);
    expect(cards[0]).toMatchObject({
      name: "Delver of Secrets // Insectile Aberration",
      rarity: "common",
      card_faces: [
        { name: "Delver of Secrets", colors: ["U"] },
        { name: "Insectile Aberration", colors: ["U"] },
      ],
    });
  });
});
