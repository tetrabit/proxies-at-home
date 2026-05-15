import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useScryfallPrints } from "./useScryfallPrints";
import { db } from "@/db";

vi.mock("@/helpers/debug", () => ({
  debugLog: vi.fn(),
}));

describe("useScryfallPrints", () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    await db.cardMetadataCache.clear();
  });

  it("prefers oracle_id lookup when available", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        total: 1,
        prints: [
          {
            imageUrl: "https://example.com/print.png",
            set: "mul",
            number: "76",
            oracle_id: "oracle-123",
            scryfall_id: "print-1",
          },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() =>
      useScryfallPrints({
        name: "Sheoldred",
        oracleId: "oracle-123",
      })
    );

    await vi.waitFor(() => {
      expect(result.current.hasSearched).toBe(true);
    });

    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain("oracle_id=oracle-123");
    expect(url).not.toContain("name=Sheoldred");
    expect(result.current.prints[0]?.oracle_id).toBe("oracle-123");
  });

  it("performs secondary oracle lookup after set+number fetch", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          total: 1,
          oracle_id: "oracle-xyz",
          prints: [
            {
              imageUrl: "https://example.com/single-print.png",
              set: "mh2",
              number: "200",
              oracle_id: "oracle-xyz",
              scryfall_id: "print-single",
            },
          ],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          total: 2,
          prints: [
            {
              imageUrl: "https://example.com/front-alt.png",
              set: "mh2",
              number: "200",
              oracle_id: "oracle-xyz",
              scryfall_id: "print-a",
            },
            {
              imageUrl: "https://example.com/front-alt-2.png",
              set: "sld",
              number: "12",
              oracle_id: "oracle-xyz",
              scryfall_id: "print-b",
            },
          ],
        }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() =>
      useScryfallPrints({
        name: "Sheoldred",
        set: "mh2",
        number: "200",
      })
    );

    await vi.waitFor(() => {
      expect(result.current.hasSearched).toBe(true);
      expect(result.current.prints.length).toBe(2);
    });

    expect(String(fetchMock.mock.calls[0][0])).toContain("set=mh2");
    expect(String(fetchMock.mock.calls[1][0])).toContain("oracle_id=oracle-xyz");
  });

  it("keeps the initial set+number results when the secondary oracle lookup fails", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          total: 1,
          oracle_id: "oracle-xyz",
          prints: [
            {
              imageUrl: "https://example.com/single-print.png",
              set: "mh2",
              number: "200",
              oracle_id: "oracle-xyz",
              scryfall_id: "print-single",
            },
          ],
        }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: async () => ({}),
      });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() =>
      useScryfallPrints({
        name: "Sheoldred",
        set: "mh2",
        number: "200",
      })
    );

    await vi.waitFor(() => {
      expect(result.current.hasSearched).toBe(true);
      expect(result.current.prints.length).toBe(1);
    });

    expect(String(fetchMock.mock.calls[1][0])).toContain("oracle_id=oracle-xyz");
  });

  it("uses a full local cache hit without calling the network", async () => {
    await db.cardMetadataCache.add({
      id: "cached-oracle",
      name: "Cached Card",
      set: "abc",
      number: "12",
      oracle_id: "oracle-cache",
      data: { prints: [{ imageUrl: "https://example.com/cached.png" }] },
      cachedAt: Date.now(),
      size: 1,
      hasFullPrints: true,
    } as never);

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() =>
      useScryfallPrints({
        name: "Cached Card",
        oracleId: "oracle-cache",
      })
    );

    await vi.waitFor(() => {
      expect(result.current.hasSearched).toBe(true);
      expect(result.current.prints).toHaveLength(1);
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not fetch when disabled or missing lookup identity", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    renderHook(() =>
      useScryfallPrints({
        name: "",
        enabled: false,
      })
    );

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("aborts an in-flight request when the query changes", async () => {
    vi.useFakeTimers();
    const abortSpy = vi.spyOn(AbortController.prototype, "abort");
    const fetchMock = vi.fn().mockImplementation(
      () =>
        new Promise(() => {
          // Intentionally left pending so the second query can abort it.
        })
    );
    vi.stubGlobal("fetch", fetchMock);

    const { rerender } = renderHook(
      ({ name }) => useScryfallPrints({ name }),
      { initialProps: { name: "First Card" } }
    );

    await vi.advanceTimersByTimeAsync(100);
    rerender({ name: "Second Card" });
    await vi.advanceTimersByTimeAsync(100);

    expect(abortSpy).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("updates an existing cached metadata object after a successful fetch", async () => {
    await db.cardMetadataCache.add({
      id: "cached-update-object",
      name: "Update Card",
      set: "upd",
      number: "1",
      oracle_id: "oracle-update-object",
      data: { existing: true },
      cachedAt: Date.now(),
      size: 1,
      hasFullPrints: false,
    } as never);

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        total: 1,
        prints: [{ imageUrl: "https://example.com/update-object.png" }],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() =>
      useScryfallPrints({
        name: "Update Card",
        oracleId: "oracle-update-object",
      })
    );

    await vi.waitFor(() => {
      expect(result.current.hasSearched).toBe(true);
    });

    const stored = await db.cardMetadataCache.get("cached-update-object");
    expect((stored?.data as { prints?: unknown[] } | undefined)?.prints).toHaveLength(1);
  });

  it("updates a null metadata payload after a successful fetch", async () => {
    await db.cardMetadataCache.add({
      id: "cached-update-null",
      name: "Null Card",
      set: "nul",
      number: "2",
      data: null,
      cachedAt: Date.now(),
      size: 1,
      hasFullPrints: false,
    } as never);

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        total: 1,
        prints: [{ imageUrl: "https://example.com/update-null.png" }],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() =>
      useScryfallPrints({
        name: "Null Card",
        set: "nul",
        number: "2",
      })
    );

    await vi.waitFor(() => {
      expect(result.current.hasSearched).toBe(true);
    });

    const stored = await db.cardMetadataCache.get("cached-update-null");
    expect((stored?.data as { prints?: unknown[] } | undefined)?.prints).toHaveLength(1);
  });

  it("updates a name-based cache entry after a successful fetch", async () => {
    await db.cardMetadataCache.add({
      id: "cached-update-name",
      name: "Name Card",
      set: "",
      number: "",
      data: {},
      cachedAt: Date.now(),
      size: 1,
      hasFullPrints: false,
    } as never);

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        total: 1,
        prints: [{ imageUrl: "https://example.com/update-name.png" }],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() =>
      useScryfallPrints({
        name: "Name Card",
      })
    );

    await vi.waitFor(() => {
      expect(result.current.hasSearched).toBe(true);
    });

    const stored = await db.cardMetadataCache.get("cached-update-name");
    expect((stored?.data as { prints?: unknown[] } | undefined)?.prints).toHaveLength(1);
  });

  it("handles a non-ok response by clearing results", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: vi.fn(),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() =>
      useScryfallPrints({
        name: "Broken Card",
      })
    );

    await vi.waitFor(() => {
      expect(result.current.hasSearched).toBe(true);
    });

    expect(result.current.prints).toEqual([]);
  });

  it("handles a fetch rejection by clearing results", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("offline"));
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() =>
      useScryfallPrints({
        name: "Broken Card",
      })
    );

    await vi.waitFor(() => {
      expect(result.current.hasSearched).toBe(true);
    });

    expect(result.current.prints).toEqual([]);
  });
});
