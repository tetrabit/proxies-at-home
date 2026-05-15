import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  serializeCards,
  serializeSettings,
  getShareWarnings,
  deserializeForImport,
  createShare,
  loadShare,
  calculateStateHash,
  type ShareData,
} from "./shareHelper";
import type { CardOption } from "@/types";

// Mock dependencies
vi.mock("./mpcAutofillApi", () => ({
  extractMpcIdentifierFromImageId: vi.fn((id: string | undefined) => {
    if (!id) return null;
    if (id.startsWith("mpc_")) return id.replace("mpc_", "");
    if (id.includes("/api/cards/images/mpc?id=")) {
      const match = id.match(/id=([^&]+)/);
      return match ? match[1] : null;
    }
    return null;
  }),
}));

vi.mock("./dbUtils", () => ({
  sortCards: vi.fn((cards) => [...cards].sort((a, b) => a.order - b.order)),
}));

vi.mock("./imageSourceUtils", () => ({
  inferImageSource: vi.fn((id: string | undefined) => {
    if (!id) return "unknown";
    if (id.startsWith("mpc_")) return "mpc";
    if (id.includes("scryfall")) return "scryfall";
    if (id.startsWith("local_")) return "custom";
    return "unknown";
  }),
}));

describe("shareHelper", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("serializeCards", () => {
    it("should serialize Scryfall cards correctly", () => {
      const cards: CardOption[] = [
        {
          uuid: "card-1",
          name: "Lightning Bolt",
          order: 0,
          set: "lea",
          number: "161",
          imageId: "scryfall/lea/161",
          isUserUpload: false,
        },
      ];

      const result = serializeCards(cards);

      expect(result.shareCards).toHaveLength(1);
      expect(result.shareCards[0][0]).toBe("s"); // type
      expect(result.shareCards[0][1]).toBe("lea/161"); // set/number
      expect(result.shareCards[0][2]).toBe(0); // order
      expect(result.skipped).toBe(0);
    });

    it("should serialize MPC cards correctly", () => {
      const cards: CardOption[] = [
        {
          uuid: "card-1",
          name: "Lightning Bolt",
          order: 0,
          imageId: "mpc_abc123xyz",
          isUserUpload: false,
        },
      ];

      const result = serializeCards(cards);

      expect(result.shareCards).toHaveLength(1);
      expect(result.shareCards[0][0]).toBe("m"); // type
      expect(result.shareCards[0][1]).toBe("abc123xyz"); // MPC ID
      expect(result.shareCards[0][2]).toBe(0); // order
    });

    it("should skip custom upload cards", () => {
      const cards: CardOption[] = [
        {
          uuid: "card-1",
          name: "Custom Card",
          order: 0,
          imageId: "local_custom123",
          isUserUpload: true,
        },
      ];

      const result = serializeCards(cards);

      expect(result.shareCards).toHaveLength(0);
      expect(result.skipped).toBe(1);
    });

    it("should include category when present", () => {
      const cards: CardOption[] = [
        {
          uuid: "card-1",
          name: "Sol Ring",
          order: 0,
          set: "cmd",
          number: "235",
          imageId: "scryfall/cmd/235",
          isUserUpload: false,
          category: "Commander",
        },
      ];

      const result = serializeCards(cards);

      expect(result.shareCards[0][3]).toBe("Commander");
    });

    it("should compress overrides with short keys", () => {
      const cards: CardOption[] = [
        {
          uuid: "card-1",
          name: "Sol Ring",
          order: 0,
          set: "cmd",
          number: "235",
          imageId: "scryfall/cmd/235",
          isUserUpload: false,
          overrides: {
            brightness: 10,
            contrast: 1.2,
            saturation: 0.9,
          },
        },
      ];

      const result = serializeCards(cards);

      const overrides = result.shareCards[0][4] as Record<string, unknown>;
      expect(overrides).not.toBeNull();
      expect(overrides.br).toBe(10); // brightness -> br
      expect(overrides.ct).toBe(1.2); // contrast -> ct
      expect(overrides.sa).toBe(0.9); // saturation -> sa
    });

    it("should skip linked back cards (DFC backs)", () => {
      const cards: CardOption[] = [
        {
          uuid: "front",
          name: "Delver of Secrets",
          order: 0,
          set: "isd",
          number: "51",
          imageId: "scryfall/isd/51",
          isUserUpload: false,
          linkedBackId: "back",
        },
        {
          uuid: "back",
          name: "Insectile Aberration",
          order: 1,
          set: "isd",
          number: "51b",
          imageId: "scryfall/isd/51b",
          isUserUpload: false,
          linkedFrontId: "front",
        },
      ];

      const result = serializeCards(cards);

      // Should serialize front and back with DFC link
      // The back card should be added to the array for the DFC link
      expect(result.dfc).toHaveLength(1);
    });
  });

  describe("serializeSettings", () => {
    it("should use short keys for settings", () => {
      const settings = {
        pageSizePreset: "Letter",
        columns: 3,
        rows: 3,
        bleedEdge: true,
        bleedEdgeWidth: 3.175,
        darkenMode: "contrast-edges",
        perCardGuideStyle: "corners",
        guideColor: "#39FF14",
        dpi: 600,
      };

      const result = serializeSettings(settings);

      expect(result.pr).toBe("Letter");
      expect(result.c).toBe(3);
      expect(result.r).toBe(3);
      expect(result.bl).toBe(true);
      expect(result.blMm).toBe(3.175);
      expect(result.dk).toBe("contrast-edges");
      expect(result.gs).toBe("corners");
      expect(result.gc).toBe("#39FF14");
      expect(result.dpi).toBe(600);
    });

    it("should serialize user preference settings", () => {
      const settings = {
        autoImportTokens: true,
        preferredArtSource: "mpc",
        globalLanguage: "fr",
        mpcFuzzySearch: false,
      };

      const result = serializeSettings(settings);

      expect(result.ait).toBe(true);
      expect(result.pas).toBe("mpc");
      expect(result.gl).toBe("fr");
      expect(result.mfs).toBe(false);
    });
  });

  it("should serialize all remaining settings groups", () => {
    const result = serializeSettings({
      withBleedSourceAmount: 1,
      withBleedTargetMode: "crop",
      withBleedTargetAmount: 2,
      noBleedTargetMode: "scale",
      noBleedTargetAmount: 3,
      darkenContrast: 4,
      darkenEdgeWidth: 5,
      darkenAmount: 6,
      darkenBrightness: 7,
      darkenAutoDetect: true,
      guideWidth: 8,
      guidePlacement: "inside",
      cutGuideLengthMm: 9,
      cutLineStyle: "solid",
      cardSpacingMm: 10,
      cardPositionX: 11,
      cardPositionY: 12,
      useCustomBackOffset: true,
      cardBackPositionX: 13,
      cardBackPositionY: 14,
      showProcessingToasts: false,
      sortBy: "name",
      sortOrder: "desc",
      filterManaCost: [1],
      filterColors: ["R"],
      filterTypes: ["Instant"],
      filterCategories: ["Main"],
      filterFeatures: ["Token"],
      filterMatchType: "all",
      exportMode: "pdf",
      decklistSortAlpha: true,
    });
    expect(result).toMatchObject({
      wbSrc: 1,
      wbTm: "crop",
      wbTa: 2,
      nbTm: "scale",
      nbTa: 3,
      dkC: 4,
      dkE: 5,
      dkA: 6,
      dkB: 7,
      dkAd: true,
      gw: 8,
      gp: "inside",
      cgL: 9,
      cls: "solid",
      spc: 10,
      pX: 11,
      pY: 12,
      ucbo: true,
      bpX: 13,
      bpY: 14,
      spt: false,
      sb: "name",
      so: "desc",
      fmc: [1],
      fcol: ["R"],
      ftyp: ["Instant"],
      fcat: ["Main"],
      ffeat: ["Token"],
      fmt: "all",
      em: "pdf",
      dsa: true,
    });
  });

  it("should omit empty optional filter arrays", () => {
    expect(
      serializeSettings({
        filterManaCost: [],
        filterColors: [],
        filterTypes: [],
        filterCategories: [],
        filterFeatures: [],
      })
    ).toEqual({});
  });

  describe("getShareWarnings", () => {
    it("should return empty array when no custom uploads", () => {
      const cards: CardOption[] = [
        {
          uuid: "card-1",
          name: "Sol Ring",
          order: 0,
          set: "cmd",
          number: "235",
          imageId: "scryfall/cmd/235",
          isUserUpload: false,
        },
      ];

      const warnings = getShareWarnings(cards);

      expect(warnings).toHaveLength(0);
    });

    it("should warn about custom uploads", () => {
      const cards: CardOption[] = [
        {
          uuid: "card-1",
          name: "Custom Card",
          order: 0,
          imageId: "local_custom123",
          isUserUpload: true,
        },
        {
          uuid: "card-2",
          name: "Another Custom",
          order: 1,
          imageId: "local_custom456",
          isUserUpload: true,
        },
      ];

      const warnings = getShareWarnings(cards);

      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("2 custom uploads");
    });

    it("should use singular form for one custom upload", () => {
      const cards: CardOption[] = [
        {
          uuid: "card-1",
          name: "Custom Card",
          order: 0,
          imageId: "local_custom123",
          isUserUpload: true,
        },
      ];

      const warnings = getShareWarnings(cards);

      expect(warnings[0]).toContain("1 custom upload will");
    });
  });

  describe("deserializeForImport", () => {
    it("should deserialize Scryfall cards with set/number", () => {
      const data: ShareData = {
        v: 1,
        c: [
          ["s", "lea/161", 0, null, null],
          ["s", "cmd/235", 1, "Commander", null],
        ],
      };

      const result = deserializeForImport(data);

      expect(result.cards).toHaveLength(2);
      expect(result.cards[0].set).toBe("lea");
      expect(result.cards[0].number).toBe("161");
      expect(result.cards[1].category).toBe("Commander");
    });

    it("should deserialize MPC cards with mpcIdentifier", () => {
      const data: ShareData = {
        v: 1,
        c: [["m", "abc123xyz", 0, null, null]],
      };

      const result = deserializeForImport(data);

      expect(result.cards).toHaveLength(1);
      expect(result.cards[0].mpcIdentifier).toBe("abc123xyz");
    });

    it("should expand override short keys", () => {
      const data: ShareData = {
        v: 1,
        c: [["s", "lea/161", 0, null, { br: 10, ct: 1.2 }]],
      };

      const result = deserializeForImport(data);

      expect(result.cards[0].overrides?.brightness).toBe(10);
      expect(result.cards[0].overrides?.contrast).toBe(1.2);
    });

    it("should include DFC links", () => {
      const data: ShareData = {
        v: 1,
        c: [
          ["s", "isd/51", 0, null, null],
          ["s", "isd/51b", 1, null, null],
        ],
        dfc: [[0, 1]],
      };

      const result = deserializeForImport(data);

      expect(result.dfcLinks).toEqual([[0, 1]]);
    });

    it("should deserialize imageId and order", () => {
      const data: ShareData = {
        v: 1,
        c: [
          [
            "s",
            "sol/1",
            54321,
            null,
            null,
            "Sol Ring",
            "https://example.com/image.jpg",
          ],
        ],
      };

      const result = deserializeForImport(data);
      expect(result.cards[0].order).toBe(54321);
      expect(result.cards[0].imageId).toBe("https://example.com/image.jpg");
    });
    it("should include settings", () => {
      const data: ShareData = {
        v: 1,
        c: [],
        st: { pr: "A4", c: 3, r: 3 },
      };

      const result = deserializeForImport(data);

      expect(result.settings?.pr).toBe("A4");
      expect(result.settings?.c).toBe(3);
    });
  });

  describe("share API helpers and hashing", () => {
    beforeEach(() => {
      vi.stubGlobal("fetch", vi.fn());
      Object.defineProperty(window, "location", {
        configurable: true,
        value: { origin: "http://app.test", pathname: "/builder" },
      });
    });

    it("creates shares with sorted cards, dfc/skipped fields, and stable URL", async () => {
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: "share-1", expiresAt: 123 }),
      } as Response);
      const cards = [
        {
          uuid: "custom",
          name: "Custom",
          order: 3,
          imageId: "local_custom",
          isUserUpload: true,
        },
        {
          uuid: "card",
          name: "Card",
          order: 2,
          set: "abc",
          number: "1",
          imageId: "scryfall/abc/1",
          isUserUpload: false,
        },
      ] as CardOption[];

      await expect(
        createShare(cards, { columns: 2 }, "project-1")
      ).resolves.toEqual({
        url: "http://app.test/builder?share=share-1",
        id: "share-1",
        skipped: 1,
      });
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining("/api/share"),
        expect.objectContaining({
          method: "POST",
          body: expect.stringContaining("project-1"),
        })
      );
    });

    it("rejects empty shares and propagates create-share server errors", async () => {
      await expect(
        createShare(
          [
            {
              uuid: "custom",
              name: "Custom",
              order: 0,
              imageId: "local_custom",
              isUserUpload: true,
            } as CardOption,
          ],
          {}
        )
      ).rejects.toThrow("No shareable cards");
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: false,
        json: async () => ({ error: "bad share" }),
      } as Response);
      await expect(
        createShare(
          [
            {
              uuid: "card",
              name: "Card",
              order: 0,
              set: "abc",
              number: "1",
              imageId: "scryfall/abc/1",
              isUserUpload: false,
            } as CardOption,
          ],
          {}
        )
      ).rejects.toThrow("bad share");
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: false,
        json: async () => {
          throw new Error("no json");
        },
      } as Response);
      await expect(
        createShare(
          [
            {
              uuid: "card",
              name: "Card",
              order: 0,
              set: "abc",
              number: "1",
              imageId: "scryfall/abc/1",
              isUserUpload: false,
            } as CardOption,
          ],
          {}
        )
      ).rejects.toThrow("Failed to create share");
    });

    it("loads shares and handles load-share errors", async () => {
      vi.setSystemTime(new Date("2026-05-14T12:00:00Z"));
      vi.mocked(fetch)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ data: { v: 1, c: [] }, expiresAt: 123 }),
        } as Response)
        .mockResolvedValueOnce({ ok: false, status: 404 } as Response)
        .mockResolvedValueOnce({
          ok: false,
          status: 500,
          json: async () => ({ error: "load failed" }),
        } as Response)
        .mockResolvedValueOnce({
          ok: false,
          status: 500,
          json: async () => {
            throw new Error("no json");
          },
        } as Response);

      await expect(loadShare("share-1")).resolves.toEqual({ v: 1, c: [] });
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining("/api/share/share-1?t=")
      );
      await expect(loadShare("missing")).rejects.toThrow(
        "Share not found or expired"
      );
      await expect(loadShare("bad")).rejects.toThrow("load failed");
      await expect(loadShare("bad-json")).rejects.toThrow(
        "Failed to load share"
      );
    });

    it("calculates deterministic state hashes from sorted serialized state", async () => {
      const digest = new Uint8Array([0, 1, 2, 255]).buffer;
      vi.spyOn(crypto.subtle, "digest").mockResolvedValue(digest);
      const hash = await calculateStateHash(
        [
          {
            uuid: "b",
            name: "B",
            order: 2,
            set: "bbb",
            number: "2",
            imageId: "scryfall/bbb/2",
            isUserUpload: false,
          },
          {
            uuid: "a",
            name: "A",
            order: 1,
            imageId: "mpc_id",
            isUserUpload: false,
          },
        ] as CardOption[],
        { rows: 3 }
      );

      expect(hash).toBe("000102ff");
      expect(crypto.subtle.digest).toHaveBeenCalledWith(
        "SHA-256",
        expect.anything()
      );
    });
  });

  describe("additional built-in cardback and DFC paths", () => {
    it("serializes built-in cardbacks and suppresses custom-upload warnings for them", () => {
      const cards = [
        {
          uuid: "back",
          name: "Card Back",
          order: 0,
          imageId: "cardback_default",
          isUserUpload: true,
        },
      ] as CardOption[];
      const result = serializeCards(cards);
      expect(result.shareCards[0][0]).toBe("b");
      expect(result.shareCards[0][1]).toBe("cardback_default");
      expect(getShareWarnings(cards)).toEqual([]);
    });

    it("deserializes built-in cardbacks", () => {
      const result = deserializeForImport({
        v: 1,
        c: [
          [
            "b",
            "cardback_default",
            2,
            "Backs",
            null,
            "Default Back",
            "cardback_default",
          ],
        ],
      });
      expect(result.cards[0]).toMatchObject({
        builtInCardbackId: "cardback_default",
        category: "Backs",
        name: "Default Back",
        imageId: "cardback_default",
        order: 2,
      });
    });

    it("includes DFC links in created share payloads", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({ id: "dfc-share", expiresAt: 123 }),
        })
      );
      Object.defineProperty(window, "location", {
        configurable: true,
        value: { origin: "http://app.test", pathname: "/builder" },
      });
      await createShare(
        [
          {
            uuid: "front",
            name: "Front",
            order: 0,
            set: "abc",
            number: "1",
            imageId: "scryfall/abc/1",
            isUserUpload: false,
            linkedBackId: "back",
          },
          {
            uuid: "back",
            name: "Back",
            order: 1,
            imageId: "cardback_default",
            isUserUpload: true,
            linkedFrontId: "front",
          },
        ] as CardOption[],
        {},
        "project-dfc"
      );
      const body = JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body));
      expect(body.data.dfc).toEqual([[0, 1]]);
    });
  });

  describe("branch completion cases", () => {
    it("returns null overrides for empty override objects and preserves unknown override keys", () => {
      const serialized = serializeCards([
        {
          uuid: "empty",
          name: "Empty",
          order: 0,
          set: "abc",
          number: "1",
          imageId: "scryfall/abc/1",
          isUserUpload: false,
          overrides: {},
        },
        {
          uuid: "unknown",
          name: "Unknown",
          order: 1,
          set: "abc",
          number: "2",
          imageId: "scryfall/abc/2",
          isUserUpload: false,
          overrides: { customKey: 42 } as unknown as CardOption["overrides"],
        },
      ] as CardOption[]);
      expect(serialized.shareCards[0][4]).toBeNull();
      expect(serialized.shareCards[1][4]).toEqual({ customKey: 42 });

      const imported = deserializeForImport({
        v: 1,
        c: [["s", "abc/2", 0, null, { customKey: 42 }]],
      });
      expect(
        (imported.cards[0].overrides as Record<string, unknown>).customKey
      ).toBe(42);
    });

    it("does not skip placeholders or unidentifiable non-custom cards", () => {
      const result = serializeCards([
        {
          uuid: "placeholder",
          name: "Placeholder",
          order: 0,
          isUserUpload: false,
        },
        {
          uuid: "mpc-no-id",
          name: "Bad MPC",
          order: 1,
          imageId: "mpc_",
          isUserUpload: false,
        },
        {
          uuid: "scryfall-missing-number",
          name: "Bad Scryfall",
          order: 2,
          set: "abc",
          imageId: "scryfall/abc",
          isUserUpload: false,
        },
      ] as CardOption[]);
      expect(result).toEqual({ shareCards: [], dfc: [], skipped: 0 });
    });

    it("handles DFC fronts without usable backs", () => {
      const noBack = serializeCards([
        {
          uuid: "front",
          name: "Front",
          order: 0,
          set: "abc",
          number: "1",
          imageId: "scryfall/abc/1",
          isUserUpload: false,
          linkedBackId: "missing",
        },
      ] as CardOption[]);
      expect(noBack.dfc).toEqual([]);

      const unshareableBack = serializeCards([
        {
          uuid: "front",
          name: "Front",
          order: 0,
          set: "abc",
          number: "1",
          imageId: "scryfall/abc/1",
          isUserUpload: false,
          linkedBackId: "back",
        },
        {
          uuid: "back",
          name: "Back",
          order: 1,
          imageId: "local_custom",
          isUserUpload: true,
          linkedFrontId: "front",
        },
      ] as CardOption[]);
      expect(unshareableBack.dfc).toEqual([]);
    });

    it("uses fallback API errors when responses omit an error message", async () => {
      vi.stubGlobal("fetch", vi.fn());
      Object.defineProperty(window, "location", {
        configurable: true,
        value: { origin: "http://app.test", pathname: "/builder" },
      });
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: false,
        json: async () => ({}),
      } as Response);
      await expect(
        createShare(
          [
            {
              uuid: "card",
              name: "Card",
              order: 0,
              set: "abc",
              number: "1",
              imageId: "scryfall/abc/1",
              isUserUpload: false,
            } as CardOption,
          ],
          {}
        )
      ).rejects.toThrow("Failed to create share");

      vi.mocked(fetch).mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: async () => ({}),
      } as Response);
      await expect(loadShare("bad-empty")).rejects.toThrow(
        "Failed to load share"
      );
    });

    it("skips linked backs when calculating warnings", () => {
      expect(
        getShareWarnings([
          {
            uuid: "back",
            name: "Back",
            order: 1,
            imageId: "local_custom",
            isUserUpload: true,
            linkedFrontId: "front",
          } as CardOption,
        ])
      ).toEqual([]);
    });

    it("deserializes built-in cardbacks without optional category or overrides", () => {
      const result = deserializeForImport({
        v: 1,
        c: [["b", "cardback_default", 0, null, null]],
      });
      expect(result.cards[0]).toMatchObject({
        builtInCardbackId: "cardback_default",
        category: undefined,
        overrides: undefined,
      });
    });
  });

  describe("remaining override branch cases", () => {
    it("compresses overrides on DFC back cards", () => {
      const result = serializeCards([
        {
          uuid: "front",
          name: "Front",
          order: 0,
          set: "abc",
          number: "1",
          imageId: "scryfall/abc/1",
          isUserUpload: false,
          linkedBackId: "back",
        },
        {
          uuid: "back",
          name: "Back",
          order: 1,
          imageId: "cardback_default",
          isUserUpload: true,
          linkedFrontId: "front",
          overrides: { brightness: 3 },
        },
      ] as CardOption[]);
      expect(result.shareCards[1][4]).toEqual({ br: 3 });
    });

    it("expands overrides for MPC and built-in cardback imports", () => {
      const result = deserializeForImport({
        v: 1,
        c: [
          ["m", "mpc-id", 0, null, { br: 4 }],
          ["b", "cardback_default", 1, null, { ct: 1.5 }],
        ],
      });
      expect(result.cards[0].overrides?.brightness).toBe(4);
      expect(result.cards[1].overrides?.contrast).toBe(1.5);
    });
  });
});
