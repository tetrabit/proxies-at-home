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

  it("falls back to the trimmed query when extraction does not provide a cleaned name", async () => {
    mockExtractCardInfo.mockReturnValue({ name: "", set: null, number: null });
    mockSearchCards.mockResolvedValue([{ name: "Dragon" }]);

    const { result } = renderHook(() => useScryfallPreview("  dragon  "));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(mockSearchCards).toHaveBeenCalledWith("dragon", expect.any(AbortSignal));
    expect(result.current.setVariations).toEqual([{ name: "Dragon" }]);
  });

  it("sorts an exact match ahead of a longer result when the exact card is returned second", async () => {
    mockSearchCards.mockResolvedValue([
      { name: "Forest Bear" },
      { name: "Forest" },
    ]);

    const { result } = renderHook(() => useScryfallPreview("Forest"));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(result.current.setVariations.map((card) => card.name)).toEqual(["Forest", "Forest Bear"]);
  });

  it("deduplicates repeated search results by card name", async () => {
    mockSearchCards.mockResolvedValue([
      { name: "Forest" },
      { name: "Forest" },
      { name: "Forest Bear" },
    ]);

    const { result } = renderHook(() => useScryfallPreview("Forest"));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

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

  it("keeps a matching specific-card result when the fetched name matches the cleaned query", async () => {
    mockExtractCardInfo.mockReturnValue({ name: "Darksteel Citadel", set: "abc", number: "12" });
    mockFetchCardBySetAndNumber.mockResolvedValue({ name: "Darksteel Citadel" });

    const { result } = renderHook(() => useScryfallPreview("Darksteel Citadel [abc] 12"));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(result.current.setVariations).toEqual([{ name: "Darksteel Citadel" }]);
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

  it("reuses cached specific-card results when only outer whitespace changes", async () => {
    mockExtractCardInfo.mockReturnValue({ name: "Dark", set: "abc", number: "12" });
    mockFetchCardBySetAndNumber.mockResolvedValue({ name: "Darksteel Citadel" });

    const { rerender } = renderHook(({ query }) => useScryfallPreview(query), {
      initialProps: { query: "Dark [abc] 12" },
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    rerender({ query: " Dark [abc] 12 " });

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

  it("ignores a stale specific-card response when the query changes to a too-short value", async () => {
    mockExtractCardInfo.mockImplementation((input: string) =>
      input === "A" ? { name: "A", set: null, number: null } : { name: "Dark", set: "abc", number: "12" }
    );
    const deferred = <T,>() => {
      let resolve!: (value: T | PromiseLike<T>) => void;
      const promise = new Promise<T>((res) => {
        resolve = res;
      });
      return { promise, resolve };
    };
    const pending = deferred<{ name: string }>();
    mockFetchCardBySetAndNumber.mockReturnValueOnce(pending.promise);

    const { result, rerender } = renderHook(({ query }) => useScryfallPreview(query), {
      initialProps: { query: "Dark [abc] 12" },
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    rerender({ query: "A" });
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    await act(async () => {
      setTimeout(() => pending.resolve({ name: "Darksteel Citadel" }), 0);
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();
    });

    expect(result.current.setVariations).toEqual([]);
    expect(mockFetchCardBySetAndNumber).toHaveBeenCalledTimes(1);
  });

  it("clears specific-card results when the direct lookup rejects", async () => {
    mockExtractCardInfo.mockReturnValue({ name: "Dark", set: "abc", number: "12" });
    mockFetchCardBySetAndNumber.mockRejectedValue(new Error("lookup failed"));

    const { result } = renderHook(() => useScryfallPreview("Dark [abc] 12"));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(result.current.setVariations).toEqual([]);
    expect(result.current.isLoading).toBe(false);
  });

  it("ignores a stale specific-card response after the query changes", async () => {
    mockExtractCardInfo.mockImplementation((input: string) =>
      input.includes("Lightning")
        ? { name: "Lightning", set: "def", number: "1" }
        : { name: "Dark", set: "abc", number: "12" }
    );
    const deferred = <T,>() => {
      let resolve!: (value: T | PromiseLike<T>) => void;
      const promise = new Promise<T>((res) => {
        resolve = res;
      });
      return { promise, resolve };
    };
    const firstPending = deferred<{ name: string }>();
    const secondPending = deferred<{ name: string }>();
    mockFetchCardBySetAndNumber
      .mockReturnValueOnce(firstPending.promise)
      .mockReturnValueOnce(secondPending.promise);

    const { result, rerender } = renderHook(({ query }) => useScryfallPreview(query), {
      initialProps: { query: "Dark [abc] 12" },
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    rerender({ query: "Lightning [def] 1" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
      firstPending.resolve({ name: "Darksteel Citadel" });
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(result.current.setVariations).toEqual([]);
    expect(mockFetchCardBySetAndNumber).toHaveBeenCalledTimes(2);
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

  it("prefers a word-boundary match over a contains-only match", async () => {
    mockExtractCardInfo.mockReturnValue({ name: "art", set: null, number: null });
    mockSearchCards.mockResolvedValue([
      { name: "Quartermaster" },
      { name: "The Artful Dodger" },
    ]);

    const { result } = renderHook(() => useScryfallPreview("art"));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(result.current.setVariations.map((card) => card.name)).toEqual([
      "The Artful Dodger",
      "Quartermaster",
    ]);
  });

  it("also orders word-boundary results when the comparator sees the reverse pair first", async () => {
    mockExtractCardInfo.mockReturnValue({ name: "art", set: null, number: null });
    mockSearchCards.mockResolvedValue([
      { name: "The Artful Dodger" },
      { name: "Quartermaster" },
    ]);

    const { result } = renderHook(() => useScryfallPreview("art"));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(result.current.setVariations.map((card) => card.name)).toEqual([
      "The Artful Dodger",
      "Quartermaster",
    ]);
  });

  it("prefers starts-with results over word-boundary and contains-only matches", async () => {
    mockExtractCardInfo.mockReturnValue({ name: "art", set: null, number: null });
    mockSearchCards.mockResolvedValue([
      { name: "Quartermaster" },
      { name: "Artful Mage" },
      { name: "The Artful Dodger" },
    ]);

    const { result } = renderHook(() => useScryfallPreview("art"));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(result.current.setVariations.map((card) => card.name)).toEqual([
      "Artful Mage",
      "The Artful Dodger",
      "Quartermaster",
    ]);
  });

  it("passes raw Scryfall syntax through unchanged", async () => {
    mockExtractCardInfo.mockReturnValue({ name: "", set: null, number: null });
    mockSearchCards.mockResolvedValue([{ name: "Artifact" }]);

    const { result } = renderHook(() => useScryfallPreview("type:artifact"));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(mockSearchCards).toHaveBeenCalledWith("type:artifact", expect.any(AbortSignal));
    expect(result.current.setVariations).toHaveLength(1);
  });

  it("searches name-in-set queries with the set-specific syntax", async () => {
    mockExtractCardInfo.mockReturnValue({ name: "Forest", set: "m21", number: null });
    mockSearchCards.mockResolvedValue([{ name: "Forest" }]);

    const { result } = renderHook(() => useScryfallPreview("Forest [m21]"));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(mockSearchCards).toHaveBeenCalledWith('!"Forest" set:m21 unique:prints', expect.any(AbortSignal));
    expect(result.current.setVariations).toHaveLength(1);
  });

  it("reuses cached search results when the trimmed query stays the same", async () => {
    mockSearchCards.mockResolvedValue([{ name: "Forest" }]);

    const { rerender } = renderHook(({ query }) => useScryfallPreview(query), {
      initialProps: { query: "Forest" },
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    rerender({ query: "Forest " });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(mockSearchCards).toHaveBeenCalledTimes(1);
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

  it("ignores AbortError rejections without treating them as fatal", async () => {
    mockSearchCards.mockRejectedValue(Object.assign(new Error("Aborted"), { name: "AbortError" }));

    const { result } = renderHook(() => useScryfallPreview("Forest"));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(result.current.setVariations).toEqual([]);
    expect(result.current.isLoading).toBe(false);
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
