import { beforeEach, describe, expect, it, vi } from "vitest";

const transport = vi.hoisted(() => {
  const get = vi.fn();
  const create = vi.fn(() => ({ get }));
  return { create, get };
});

// This test file must never instantiate Axios's real HTTP adapter.
vi.mock("axios", () => ({
  create: transport.create,
  default: { create: transport.create },
}));

import { getCardsWithImagesForCardInfo } from "./getCardImagesPaged.js";

describe("Basic Land Rarity", () => {
  beforeEach(() => {
    transport.get.mockReset();
  });

  it("returns the mocked basic-land rarity without a live Scryfall request", async () => {
    transport.get.mockResolvedValue({
      data: {
        data: [{ name: "Plains", rarity: "common", colors: [] }],
        has_more: false,
        next_page: null,
      },
    });

    const results = await getCardsWithImagesForCardInfo({ name: "Plains", quantity: 1 });

    expect(results).toEqual([{ name: "Plains", rarity: "common", colors: [] }]);
    expect(transport.get).toHaveBeenCalledTimes(1);
    expect(transport.get.mock.calls[0]?.[0]).toContain("https://api.scryfall.com/cards/search?q=");
  });
});