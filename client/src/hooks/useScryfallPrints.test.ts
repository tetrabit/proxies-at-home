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
});
