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

  it("skips searching when the tag syntax is incomplete", async () => {
    mockHasIncompleteTagSyntax.mockReturnValue(true);

    renderHook(() => useScryfallPreview("Forest ["));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(mockSearchCards).not.toHaveBeenCalled();
    expect(mockFetchCardBySetAndNumber).not.toHaveBeenCalled();
  });

  it("skips searching for queries that are too short", async () => {
    renderHook(() => useScryfallPreview("A"));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(mockSearchCards).not.toHaveBeenCalled();
    expect(mockFetchCardBySetAndNumber).not.toHaveBeenCalled();
  });

  it("reuses cached specific-card results on repeated queries", async () => {
    mockExtractCardInfo.mockReturnValue({ name: "Dark", set: "abc", number: "12" });
    mockFetchCardBySetAndNumber.mockResolvedValue({ name: "Darksteel Citadel" });

    const { rerender } = renderHook(({ query }) => useScryfallPreview(query), {
      initialProps: { query: "Dark [abc] 12" },
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    rerender({ query: "Dark [abc] 12" });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(mockFetchCardBySetAndNumber).toHaveBeenCalledTimes(1);
  });

  it("drops a specific card result when the fetched name does not match the cleaned query", async () => {
    mockExtractCardInfo.mockReturnValue({ name: "Dark", set: "abc", number: "12" });
    mockFetchCardBySetAndNumber.mockResolvedValue({ name: "Lightning Bolt" });

    const { result } = renderHook(() => useScryfallPreview("Dark [abc] 12"));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(result.current.setVariations).toEqual([]);
    expect(result.current.validatedPreviewUrl).toBeNull();
  });

  it("clears results when the search API rejects", async () => {
    mockSearchCards.mockRejectedValue(new Error("Network down"));

    const { result } = renderHook(() => useScryfallPreview("Forest"));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(mockSearchCards).toHaveBeenCalledWith("Forest", expect.any(AbortSignal));
    expect(result.current.setVariations).toEqual([]);
    expect(result.current.isLoading).toBe(false);
  });

  it("sorts by word boundary and alphabetical fallback for less relevant results", async () => {
    mockExtractCardInfo.mockReturnValue({ name: "art", set: null, number: null });
    mockSearchCards.mockResolvedValue([
      { name: "Quartermaster" },
      { name: "The Artful Dodger" },
      { name: "Alpha Art" },
    ]);

    const { result } = renderHook(() => useScryfallPreview("art"));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(result.current.setVariations.map((card) => card.name)).toEqual([
      "Alpha Art",
      "The Artful Dodger",
      "Quartermaster",
    ]);
  });

  it("clears results when the search API returns no cards", async () => {
    mockSearchCards.mockResolvedValue(null);

    const { result } = renderHook(() => useScryfallPreview("Forest"));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(result.current.setVariations).toEqual([]);
    expect(result.current.hasSearched).toBe(true);
  });

  it("aborts the in-flight search when the query changes", async () => {
    const abortSpy = vi.spyOn(AbortController.prototype, "abort");
    mockSearchCards.mockImplementation(
      () =>
        new Promise(() => {
          // Keep the first request pending so the rerender can abort it.
        }) as Promise<never>
    );

    const { rerender } = renderHook(({ query }) => useScryfallPreview(query), {
      initialProps: { query: "Forest" },
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    rerender({ query: "Forest Bear" });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(abortSpy).toHaveBeenCalled();
  });
});
