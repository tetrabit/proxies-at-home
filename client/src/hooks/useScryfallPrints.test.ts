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

  const deferred = <T,>() => {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };

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

  it("starts from empty initialPrints without marking searched", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() =>
      useScryfallPrints({
        name: "Initial Empty",
        initialPrints: [],
      })
    );

    expect(result.current.hasSearched).toBe(false);
    expect(result.current.prints).toEqual([]);
  });

  it("falls back to an empty trimmed name when the name option is missing", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        total: 1,
        prints: [{ imageUrl: "https://example.com/undefined-name.png" }],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() =>
      useScryfallPrints({
        name: undefined as unknown as string,
        oracleId: "oracle-undefined-name",
      })
    );

    await vi.waitFor(() => {
      expect(result.current.hasSearched).toBe(true);
    });

    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain("oracle_id=oracle-undefined-name");
    expect(url).not.toContain("name=");
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

  it("uses oracle_id from the returned print list when the response omits it", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          total: 1,
          prints: [
            {
              imageUrl: "https://example.com/single-print.png",
              set: "mh2",
              number: "200",
              oracle_id: "oracle-fallback",
              scryfall_id: "print-single",
            },
          ],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          total: 1,
          prints: [
            {
              imageUrl: "https://example.com/oracle-print.png",
              set: "mh2",
              number: "200",
              oracle_id: "oracle-fallback",
              scryfall_id: "print-oracle",
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
      expect(result.current.prints[0]?.scryfall_id).toBe("print-oracle");
    });
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

  it("keeps the initial set+number results when the secondary oracle lookup returns no prints array", async () => {
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
          total: 0,
          oracle_id: "oracle-xyz",
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
      expect(result.current.prints.length).toBe(1);
    });

    expect(String(fetchMock.mock.calls[1][0])).toContain("oracle_id=oracle-xyz");
  });

  it("keeps the initial set+number results when the secondary oracle lookup is empty", async () => {
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
          total: 0,
          prints: [],
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

  it("reuses a cached set+number result on repeated queries", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        total: 1,
        oracle_id: "oracle-cache-repeat",
        prints: [
          {
            imageUrl: "https://example.com/repeat.png",
            set: "mh2",
            number: "200",
            oracle_id: "oracle-cache-repeat",
            scryfall_id: "print-repeat",
          },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { rerender } = renderHook(({ name }) => useScryfallPrints({ name, set: "mh2", number: "200" }), {
      initialProps: { name: "Sheoldred" },
    });

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());

    rerender({ name: "Sheoldred" });

    await vi.waitFor(() => {
      expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(1);
    });
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

  it("cleans up before a debounced fetch starts without aborting a request", async () => {
    vi.useFakeTimers();
    const abortSpy = vi.spyOn(AbortController.prototype, "abort");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { unmount } = renderHook(() =>
      useScryfallPrints({
        name: "Early Unmount",
      })
    );

    unmount();
    await vi.advanceTimersByTimeAsync(100);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(abortSpy).not.toHaveBeenCalled();
    vi.useRealTimers();
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

  it("drops a stale request response after a newer query has started", async () => {
    vi.useFakeTimers();
    const firstResponse = deferred<{
      ok: boolean;
      json: () => Promise<{ total: number; prints: Array<{ imageUrl: string }> }>;
    }>();
    const secondResponse = Promise.resolve({
      ok: true,
      json: async () => ({
        total: 1,
        prints: [{ imageUrl: "https://example.com/newer-request.png" }],
      }),
    });
    const fetchMock = vi.fn().mockImplementationOnce(() => firstResponse.promise).mockImplementationOnce(() => secondResponse);
    vi.stubGlobal("fetch", fetchMock);

    const { rerender } = renderHook(
      ({ name }) => useScryfallPrints({ name }),
      { initialProps: { name: "First Card" } }
    );

    await vi.advanceTimersByTimeAsync(100);
    rerender({ name: "Second Card" });
    await vi.advanceTimersByTimeAsync(100);

    firstResponse.resolve({
      ok: true,
      json: async () => ({
        total: 1,
        prints: [{ imageUrl: "https://example.com/stale-request.png" }],
      }),
    });

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    vi.useRealTimers();
  });

  it("drops a stale oracle lookup after a newer query has started", async () => {
    vi.useFakeTimers();
    const oracleResponse = deferred<{
      ok: boolean;
      json: () => Promise<{ total: number; prints: Array<{ imageUrl: string }> }>;
    }>();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          total: 1,
          oracle_id: "oracle-stale",
          prints: [
            {
              imageUrl: "https://example.com/stale-front.png",
              set: "mh2",
              number: "200",
              oracle_id: "oracle-stale",
              scryfall_id: "stale-front",
            },
          ],
        }),
      })
      .mockImplementationOnce(() => oracleResponse.promise)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          total: 1,
          prints: [{ imageUrl: "https://example.com/newer-oracle.png" }],
        }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const { rerender, result } = renderHook(
      ({ name }) =>
        useScryfallPrints({
          name,
          set: "mh2",
          number: "200",
        }),
      { initialProps: { name: "First Card" } }
    );

    await vi.advanceTimersByTimeAsync(100);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    rerender({ name: "Second Card" });
    await vi.advanceTimersByTimeAsync(100);

    oracleResponse.resolve({
      ok: true,
      json: async () => ({
        total: 2,
        prints: [{ imageUrl: "https://example.com/stale-oracle.png" }],
      }),
    });

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(result.current.hasSearched).toBe(true);
    });

    vi.useRealTimers();
  });

  it("handles a successful response that omits the prints array", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        total: 1,
        oracle_id: "oracle-missing-prints",
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() =>
      useScryfallPrints({
        name: "Missing Prints",
      })
    );

    await vi.waitFor(() => {
      expect(result.current.hasSearched).toBe(true);
    });

    expect(result.current.prints).toEqual([]);
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

  it("uses a set-only lookup without setting the name query parameter", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        total: 1,
        prints: [{ imageUrl: "https://example.com/set-only.png" }],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    renderHook(() =>
      useScryfallPrints({
        name: "",
        set: "m21",
        number: "200",
      })
    );

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain("set=m21");
    expect(url).toContain("number=200");
    expect(url).not.toContain("name=");
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

  it("ignores an AbortError rejection without clearing results", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new DOMException("aborted", "AbortError"));
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() =>
      useScryfallPrints({
        name: "Abort Card",
      })
    );

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });

    expect(result.current.hasSearched).toBe(false);
    expect(result.current.prints).toEqual([]);
  });
});
