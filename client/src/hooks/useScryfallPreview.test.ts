import { renderHook, act } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useScryfallPreview } from "./useScryfallPreview";

const mockExtractCardInfo = vi.hoisted(() => vi.fn());
const mockHasIncompleteTagSyntax = vi.hoisted(() => vi.fn());
const mockSearchCards = vi.hoisted(() => vi.fn());
const mockFetchCardBySetAndNumber = vi.hoisted(() => vi.fn());

vi.mock("@/helpers/cardInfoHelper", () => ({
  extractCardInfo: mockExtractCardInfo,
  hasIncompleteTagSyntax: mockHasIncompleteTagSyntax,
}));

vi.mock("@/helpers/scryfallApi", () => ({
  searchCards: mockSearchCards,
  fetchCardBySetAndNumber: mockFetchCardBySetAndNumber,
}));

vi.mock("@/helpers/debug", () => ({
  debugLog: vi.fn(),
}));

describe("useScryfallPreview", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mockHasIncompleteTagSyntax.mockReturnValue(false);
    mockExtractCardInfo.mockReturnValue({ name: "Forest", set: null, number: null });
  });

  it("searches by simple name and exposes sorted results", async () => {
    mockSearchCards.mockResolvedValue([
      { name: "Forest" },
      { name: "Forest Bear" },
    ]);

    const { result } = renderHook(() => useScryfallPreview("Forest"));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(mockSearchCards).toHaveBeenCalledWith("Forest", expect.any(AbortSignal));
    expect(result.current.setVariations.map((card) => card.name)).toEqual(["Forest", "Forest Bear"]);
  });

  it("fetches a specific set/number card and validates the name", async () => {
    mockExtractCardInfo.mockReturnValue({ name: "Dark", set: "abc", number: "12" });
    mockFetchCardBySetAndNumber.mockResolvedValue({ name: "Darksteel Citadel" });

    const { result } = renderHook(() => useScryfallPreview("Dark [abc] 12"));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(mockFetchCardBySetAndNumber).toHaveBeenCalledWith("abc", "12", expect.any(AbortSignal));
    expect(result.current.setVariations).toHaveLength(1);
    expect(result.current.isLoading).toBe(false);
  });
});
