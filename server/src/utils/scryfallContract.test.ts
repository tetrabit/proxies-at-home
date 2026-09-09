import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const transport = vi.hoisted(() => {
  const get = vi.fn();
  const create = vi.fn(() => ({ get }));
  return { create, get };
});

// This is deterministic unit coverage for getCardImagesPaged's use of the
// shared broker. The separate .optin test exercises Axios's real adapter.
vi.mock("axios", () => ({
  create: transport.create,
  default: { create: transport.create },
}));

import { getCardsWithImagesForCardInfo } from "./getCardImagesPaged.js";

describe("Scryfall transport broker unit contract", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    transport.get.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("submits concurrent lookups to the shared FIFO transport one at a time at least 100ms apart", async () => {
    const dispatches: Array<{ url: string; at: number }> = [];
    let active = 0;
    let maximumActive = 0;

    transport.get.mockImplementation((url: string) => new Promise((resolve) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      dispatches.push({ url, at: Date.now() });
      queueMicrotask(() => {
        active -= 1;
        resolve({
          data: {
            data: [{ name: url, rarity: "common", colors: ["U"] }],
            has_more: false,
            next_page: null,
          },
        });
      });
    }));

    const results = [
      getCardsWithImagesForCardInfo({ name: "Contract Plains" }),
      getCardsWithImagesForCardInfo({ name: "Contract Island" }),
      getCardsWithImagesForCardInfo({ name: "Contract Swamp" }),
    ];

    await vi.runAllTimersAsync();
    await expect(Promise.all(results)).resolves.toHaveLength(3);

    expect(maximumActive).toBe(1);
    expect(dispatches.map(({ at }) => at)).toEqual([0, 100, 200]);
    expect(dispatches.every(({ url }) => url.startsWith("https://api.scryfall.com/cards/search?q="))).toBe(true);
  });
});
