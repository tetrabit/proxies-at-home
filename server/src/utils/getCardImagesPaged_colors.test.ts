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

describe("DFC Color Extraction", () => {
  beforeEach(() => {
    transport.get.mockReset();
  });

  it("returns deterministic colors for a double-faced card without a live Scryfall request", async () => {
    const card = {
      name: "Delver of Secrets // Insectile Aberration",
      colors: ["U"],
      card_faces: [
        { name: "Delver of Secrets", colors: ["U"] },
        { name: "Insectile Aberration", colors: ["U"] },
      ],
    };
    transport.get.mockResolvedValue({ data: { data: [card], has_more: false, next_page: null } });

    const results = await getCardsWithImagesForCardInfo({ name: "Delver of Secrets", quantity: 1 });

    expect(results).toEqual([card]);
    expect(transport.get).toHaveBeenCalledTimes(1);
    expect(transport.get.mock.calls[0]?.[0]).toContain("https://api.scryfall.com/cards/search?q=");
  });

  it("returns deterministic colors for a modal double-faced card without a live Scryfall request", async () => {
    const card = {
      name: "Malakir Rebirth // Malakir Mire",
      colors: ["B"],
      card_faces: [
        { name: "Malakir Rebirth", colors: ["B"] },
        { name: "Malakir Mire", colors: [] },
      ],
    };
    transport.get.mockResolvedValue({ data: { data: [card], has_more: false, next_page: null } });

    const results = await getCardsWithImagesForCardInfo({ name: "Malakir Rebirth", quantity: 1 });

    expect(results).toEqual([card]);
    expect(transport.get).toHaveBeenCalledTimes(1);
    expect(transport.get.mock.calls[0]?.[0]).toContain("https://api.scryfall.com/cards/search?q=");
  });
});