import { describe, it, expect, vi } from "vitest";

vi.mock("./imageProcessing", () => ({
  loadImage: vi.fn(),
}));

vi.mock("./imageHelper", () => ({
  toProxied: (url: string) => url,
}));

import {
  selectBestCandidate,
  rankCandidates,
  filterByExactName,
  normalizeName,
  computeSobelMagnitude,
  computeEdgeScore,
  type SsimCompareFn,
} from "./mpcBulkUpgradeMatcher";
import type { MpcAutofillCard } from "./mpcAutofillApi";

function makeCard(
  overrides: Partial<MpcAutofillCard> & Pick<MpcAutofillCard, "identifier">
): MpcAutofillCard {
  return {
    name: "Sol Ring",
    rawName: "Sol Ring",
    dpi: 300,
    tags: [],
    sourceName: "test",
    source: "test",
    extension: "png",
    size: 1000,
    smallThumbnailUrl: "",
    mediumThumbnailUrl: "",
    ...overrides,
  };
}

const defaultGetUrl = (id: string) => `https://mpc.test/${id}`;

describe("mpcBulkUpgradeMatcher", () => {
  describe("edge similarity helpers", () => {
    it("produces no edges for a flat image", () => {
      const pixels = new Float32Array(25).fill(0.5);
      const edges = computeSobelMagnitude(pixels, 5, 5);

      expect(Array.from(edges)).toEqual(Array.from(new Float32Array(25)));
    });

    it("scores matching edge layouts higher than different layouts", () => {
      const vertical = new Float32Array([
        0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0,
        0,
      ]);
      const horizontal = new Float32Array([
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        0,
      ]);

      const sourceEdges = computeSobelMagnitude(vertical, 5, 5);
      const matchingEdges = computeSobelMagnitude(vertical, 5, 5);
      const differentEdges = computeSobelMagnitude(horizontal, 5, 5);

      const matchingScore = computeEdgeScore(sourceEdges, matchingEdges);
      const differentScore = computeEdgeScore(sourceEdges, differentEdges);

      expect(matchingScore).toBeGreaterThan(0.99);
      expect(differentScore).toBeLessThan(matchingScore);
    });

    it("treats two edge-free images as a perfect edge match", () => {
      const flatA = new Float32Array(25);
      const flatB = new Float32Array(25);

      expect(computeEdgeScore(flatA, flatB)).toBe(1);
    });
  });

  describe("normalizeName", () => {
    it("trims and lowercases", () => {
      expect(normalizeName("  Sol Ring  ")).toBe("sol ring");
    });
  });

  describe("filterByExactName", () => {
    it("returns cards whose parsed name matches", () => {
      const cards = [
        makeCard({
          identifier: "a",
          name: "Sol Ring",
          rawName: "Sol Ring [C21] {267}",
        }),
        makeCard({
          identifier: "b",
          name: "Lightning Bolt",
          rawName: "Lightning Bolt [M21]",
        }),
        makeCard({
          identifier: "c",
          name: "Sol Ring",
          rawName: "Sol Ring [CMR] {395}",
        }),
      ];
      const result = filterByExactName(cards, "sol ring");
      expect(result).toHaveLength(2);
      expect(result.map((c) => c.identifier).sort()).toEqual(["a", "c"]);
    });

    it("returns empty array when no match", () => {
      const cards = [makeCard({ identifier: "a", name: "Lightning Bolt" })];
      expect(filterByExactName(cards, "Sol Ring")).toEqual([]);
    });
  });

  describe("selectBestCandidate", () => {
    it("returns null for empty candidates", async () => {
      const result = await selectBestCandidate({ candidates: [] });
      expect(result).toBeNull();
    });

    describe("metadata precedence", () => {
      const setCollectorCard = makeCard({
        identifier: "sc",
        rawName: "Sol Ring [C21] {267}",
        dpi: 200,
      });
      const setOnlyCard = makeCard({
        identifier: "so",
        rawName: "Sol Ring [CMR]",
        dpi: 400,
      });
      const nameOnlyCard = makeCard({
        identifier: "no",
        rawName: "Sol Ring (Artist Name)",
        dpi: 600,
      });

      it("prefers set+collector over set-only despite lower DPI", async () => {
        const result = await selectBestCandidate({
          candidates: [nameOnlyCard, setOnlyCard, setCollectorCard],
          set: "C21",
          collectorNumber: "267",
        });
        expect(result?.card.identifier).toBe("sc");
        expect(result?.reason).toBe("set_collector_only");
      });

      it("prefers set-only over name-only when no collector match", async () => {
        const result = await selectBestCandidate({
          candidates: [nameOnlyCard, setOnlyCard],
          set: "CMR",
          collectorNumber: "999",
        });
        expect(result?.card.identifier).toBe("so");
        expect(result?.reason).toBe("set_only");
      });

      it("falls back to name-only when no set data provided", async () => {
        const result = await selectBestCandidate({
          candidates: [nameOnlyCard],
        });
        expect(result?.card.identifier).toBe("no");
        expect(result?.reason).toBe("name_only");
      });
    });

    describe("single candidate returns *_only reason", () => {
      it("set_collector_only for single set+collector match", async () => {
        const card = makeCard({
          identifier: "a",
          rawName: "Sol Ring [C21] {267}",
        });
        const result = await selectBestCandidate({
          candidates: [card],
          set: "C21",
          collectorNumber: "267",
        });
        expect(result?.reason).toBe("set_collector_only");
      });

      it("set_only for single set match", async () => {
        const card = makeCard({
          identifier: "a",
          rawName: "Sol Ring [CMR] {395}",
        });
        const result = await selectBestCandidate({
          candidates: [card],
          set: "CMR",
          collectorNumber: "999",
        });
        expect(result?.reason).toBe("set_only");
      });

      it("name_only for single name match", async () => {
        const card = makeCard({ identifier: "a", rawName: "Sol Ring" });
        const result = await selectBestCandidate({ candidates: [card] });
        expect(result?.reason).toBe("name_only");
      });
    });

    describe("SSIM decisive winner", () => {
      it("picks candidate with highest SSIM when margin is sufficient", async () => {
        const cardA = makeCard({
          identifier: "a",
          rawName: "Sol Ring [C21] {267}",
          dpi: 600,
        });
        const cardB = makeCard({
          identifier: "b",
          rawName: "Sol Ring [C21] {267}",
          dpi: 300,
        });

        const ssimCompare: SsimCompareFn = vi.fn(async (_src, candidateUrl) => {
          if (candidateUrl.includes("a")) return 0.93;
          if (candidateUrl.includes("b")) return 0.97;
          return null;
        });

        const result = await selectBestCandidate({
          candidates: [cardA, cardB],
          set: "C21",
          collectorNumber: "267",
          sourceImageUrl: "https://scryfall.test/sol-ring.png",
          ssimCompare,
          getMpcImageUrl: defaultGetUrl,
        });

        expect(result?.card.identifier).toBe("b");
        expect(result?.reason).toBe("set_collector_ssim");
      });

      it("uses SSIM within set-only bucket", async () => {
        const cardA = makeCard({
          identifier: "a",
          rawName: "Sol Ring [CMR] {395}",
          dpi: 300,
        });
        const cardB = makeCard({
          identifier: "b",
          rawName: "Sol Ring [CMR] {396}",
          dpi: 300,
        });

        const ssimCompare: SsimCompareFn = vi.fn(async (_src, candidateUrl) =>
          candidateUrl.includes("a") ? 0.96 : 0.93
        );

        const result = await selectBestCandidate({
          candidates: [cardA, cardB],
          set: "CMR",
          collectorNumber: "999",
          sourceImageUrl: "https://scryfall.test/sol-ring.png",
          ssimCompare,
          getMpcImageUrl: defaultGetUrl,
        });

        expect(result?.card.identifier).toBe("a");
        expect(result?.reason).toBe("set_ssim");
      });

      it("uses SSIM within name-only bucket", async () => {
        const cardA = makeCard({
          identifier: "a",
          rawName: "Sol Ring",
          dpi: 300,
        });
        const cardB = makeCard({
          identifier: "b",
          rawName: "Sol Ring",
          dpi: 300,
        });

        const ssimCompare: SsimCompareFn = vi.fn(async (_src, candidateUrl) =>
          candidateUrl.includes("b") ? 0.95 : 0.93
        );

        const result = await selectBestCandidate({
          candidates: [cardA, cardB],
          sourceImageUrl: "https://scryfall.test/sol-ring.png",
          ssimCompare,
          getMpcImageUrl: defaultGetUrl,
        });

        expect(result?.card.identifier).toBe("b");
        expect(result?.reason).toBe("name_ssim");
      });

      it("can pick a lower-DPI same-name different-art candidate when SSIM is decisive", async () => {
        const showcase = makeCard({
          identifier: "showcase",
          rawName: "Sol Ring (Showcase)",
          dpi: 300,
        });
        const regular = makeCard({
          identifier: "regular",
          rawName: "Sol Ring",
          dpi: 600,
        });

        const ssimCompare: SsimCompareFn = vi.fn(async (_src, candidateUrl) =>
          candidateUrl.includes("showcase") ? 0.98 : 0.82
        );

        const result = await selectBestCandidate({
          candidates: [regular, showcase],
          sourceImageUrl: "https://scryfall.test/sol-ring-showcase.png",
          ssimCompare,
          getMpcImageUrl: defaultGetUrl,
        });

        expect(result?.card.identifier).toBe("showcase");
        expect(result?.reason).toBe("name_ssim");
      });
    });

    describe("SSIM inconclusive fallback", () => {
      it("falls back to DPI when scores are too close", async () => {
        const cardA = makeCard({
          identifier: "a",
          rawName: "Sol Ring [C21] {267}",
          dpi: 300,
        });
        const cardB = makeCard({
          identifier: "b",
          rawName: "Sol Ring [C21] {267}",
          dpi: 600,
        });

        const ssimCompare: SsimCompareFn = vi.fn(async (_src, candidateUrl) =>
          candidateUrl.includes("a") ? 0.8 : 0.81
        );

        const result = await selectBestCandidate({
          candidates: [cardA, cardB],
          set: "C21",
          collectorNumber: "267",
          sourceImageUrl: "https://scryfall.test/sol-ring.png",
          ssimCompare,
          getMpcImageUrl: defaultGetUrl,
        });

        expect(result?.card.identifier).toBe("b");
        expect(result?.reason).toBe("set_collector_dpi_fallback");
      });

      it("falls back to DPI within a set-only bucket when scores are too close", async () => {
        const lowDpi = makeCard({
          identifier: "low",
          rawName: "Sol Ring [CMR] {395}",
          dpi: 300,
        });
        const highDpi = makeCard({
          identifier: "high",
          rawName: "Sol Ring [CMR] {396}",
          dpi: 600,
        });

        const ssimCompare: SsimCompareFn = vi.fn(async (_src, candidateUrl) =>
          candidateUrl.includes("low") ? 0.81 : 0.8
        );

        const result = await selectBestCandidate({
          candidates: [lowDpi, highDpi],
          set: "CMR",
          collectorNumber: "999",
          sourceImageUrl: "https://scryfall.test/sol-ring-cmr.png",
          ssimCompare,
          getMpcImageUrl: defaultGetUrl,
        });

        expect(result?.card.identifier).toBe("high");
        expect(result?.reason).toBe("set_dpi_fallback");
      });

      it("falls back to DPI when all scores are below minimum", async () => {
        const cardA = makeCard({
          identifier: "a",
          rawName: "Sol Ring [C21] {267}",
          dpi: 300,
        });
        const cardB = makeCard({
          identifier: "b",
          rawName: "Sol Ring [C21] {267}",
          dpi: 600,
        });

        const ssimCompare: SsimCompareFn = vi.fn(async () => 0.1);

        const result = await selectBestCandidate({
          candidates: [cardA, cardB],
          set: "C21",
          collectorNumber: "267",
          sourceImageUrl: "https://scryfall.test/sol-ring.png",
          ssimCompare,
          getMpcImageUrl: defaultGetUrl,
        });

        expect(result?.card.identifier).toBe("b");
        expect(result?.reason).toBe("set_collector_dpi_fallback");
      });

      it("falls back to higher DPI within a set-only bucket when visual scores are too low", async () => {
        const lowDpi = makeCard({
          identifier: "low",
          rawName: "Sol Ring [CMR] {395}",
          dpi: 300,
        });
        const highDpi = makeCard({
          identifier: "high",
          rawName: "Sol Ring [CMR] {396}",
          dpi: 600,
        });

        const ssimCompare: SsimCompareFn = vi.fn(async () => 0.1);

        const result = await selectBestCandidate({
          candidates: [lowDpi, highDpi],
          set: "CMR",
          collectorNumber: "999",
          sourceImageUrl: "https://scryfall.test/sol-ring-cmr.png",
          ssimCompare,
          getMpcImageUrl: defaultGetUrl,
        });

        expect(result?.card.identifier).toBe("high");
        expect(result?.reason).toBe("set_dpi_fallback");
      });
    });

    describe("SSIM unavailable fallback", () => {
      it("falls back to DPI when all SSIM scores return null", async () => {
        const cardA = makeCard({
          identifier: "a",
          rawName: "Sol Ring [C21] {267}",
          dpi: 300,
        });
        const cardB = makeCard({
          identifier: "b",
          rawName: "Sol Ring [C21] {267}",
          dpi: 600,
        });

        const ssimCompare: SsimCompareFn = vi.fn(async () => null);

        const result = await selectBestCandidate({
          candidates: [cardA, cardB],
          set: "C21",
          collectorNumber: "267",
          sourceImageUrl: "https://scryfall.test/sol-ring.png",
          ssimCompare,
          getMpcImageUrl: defaultGetUrl,
        });

        expect(result?.card.identifier).toBe("b");
        expect(result?.reason).toBe("set_collector_dpi_fallback");
      });

      it("falls back to DPI within a set-only bucket when comparison is unavailable", async () => {
        const lowDpi = makeCard({
          identifier: "low",
          rawName: "Sol Ring [CMR] {395}",
          dpi: 300,
        });
        const highDpi = makeCard({
          identifier: "high",
          rawName: "Sol Ring [CMR] {396}",
          dpi: 600,
        });

        const ssimCompare: SsimCompareFn = vi.fn(async () => null);

        const result = await selectBestCandidate({
          candidates: [lowDpi, highDpi],
          set: "CMR",
          collectorNumber: "999",
          sourceImageUrl: "https://scryfall.test/sol-ring-cmr.png",
          ssimCompare,
          getMpcImageUrl: defaultGetUrl,
        });

        expect(result?.card.identifier).toBe("high");
        expect(result?.reason).toBe("set_dpi_fallback");
      });

      it("falls back to DPI when SSIM throws", async () => {
        const cardA = makeCard({
          identifier: "a",
          rawName: "Sol Ring [C21] {267}",
          dpi: 300,
        });
        const cardB = makeCard({
          identifier: "b",
          rawName: "Sol Ring [C21] {267}",
          dpi: 600,
        });

        const ssimCompare: SsimCompareFn = vi.fn(async () => {
          throw new Error("Canvas unavailable");
        });

        const result = await selectBestCandidate({
          candidates: [cardA, cardB],
          set: "C21",
          collectorNumber: "267",
          sourceImageUrl: "https://scryfall.test/sol-ring.png",
          ssimCompare,
          getMpcImageUrl: defaultGetUrl,
        });

        expect(result?.card.identifier).toBe("b");
        expect(result?.reason).toBe("set_collector_dpi_fallback");
      });

      it("falls back to DPI when ssimCompare is not provided", async () => {
        const cardA = makeCard({
          identifier: "a",
          rawName: "Sol Ring",
          dpi: 300,
        });
        const cardB = makeCard({
          identifier: "b",
          rawName: "Sol Ring",
          dpi: 600,
        });

        const result = await selectBestCandidate({
          candidates: [cardA, cardB],
        });

        expect(result?.card.identifier).toBe("b");
        expect(result?.reason).toBe("name_dpi_fallback");
      });
    });

    describe("deterministic highest-DPI fallback", () => {
      it("picks highest DPI", async () => {
        const cards = [
          makeCard({ identifier: "low", dpi: 200 }),
          makeCard({ identifier: "high", dpi: 600 }),
          makeCard({ identifier: "mid", dpi: 400 }),
        ];
        const result = await selectBestCandidate({ candidates: cards });
        expect(result?.card.identifier).toBe("high");
      });

      it("breaks DPI ties by identifier ascending", async () => {
        const cards = [
          makeCard({ identifier: "charlie", dpi: 300 }),
          makeCard({ identifier: "alpha", dpi: 300 }),
          makeCard({ identifier: "bravo", dpi: 300 }),
        ];
        const result = await selectBestCandidate({ candidates: cards });
        expect(result?.card.identifier).toBe("alpha");
        expect(result?.reason).toBe("name_dpi_fallback");
      });

      it("combines DPI desc + identifier asc", async () => {
        const cards = [
          makeCard({ identifier: "z_low", dpi: 200 }),
          makeCard({ identifier: "b_high", dpi: 600 }),
          makeCard({ identifier: "a_high", dpi: 600 }),
        ];
        const result = await selectBestCandidate({ candidates: cards });
        expect(result?.card.identifier).toBe("a_high");
      });
    });
  });

  describe("rankCandidates", () => {
    describe("layer structure", () => {
      it("returns all five layers for a basic input", async () => {
        const card = makeCard({
          identifier: "a",
          rawName: "Sol Ring [C21] {267}",
          dpi: 300,
        });
        const result = await rankCandidates({
          candidates: [card],
          set: "C21",
          collectorNumber: "267",
        });

        expect(result).toHaveProperty("fullProcess");
        expect(result).toHaveProperty("exactPrinting");
        expect(result).toHaveProperty("artMatch");
        expect(result).toHaveProperty("fullCard");
        expect(result).toHaveProperty("allMatches");
      });

      it("returns empty layers when candidates is empty", async () => {
        const result = await rankCandidates({ candidates: [] });

        expect(result.fullProcess).toEqual([]);
        expect(result.exactPrinting).toEqual([]);
        expect(result.artMatch).toEqual([]);
        expect(result.fullCard).toEqual([]);
        expect(result.allMatches).toEqual([]);
      });
    });

    describe("exactPrinting layer", () => {
      it("includes set+collector matches before same-set fallbacks", async () => {
        const matching = makeCard({
          identifier: "sc",
          rawName: "Sol Ring [C21] {267}",
          dpi: 300,
        });
        const setOnly = makeCard({
          identifier: "set-only",
          rawName: "Sol Ring [C21] {268}",
          dpi: 600,
        });
        const nonMatching = makeCard({
          identifier: "other-set",
          rawName: "Sol Ring [CMR] {395}",
          dpi: 700,
        });

        const result = await rankCandidates({
          candidates: [matching, setOnly, nonMatching],
          set: "C21",
          collectorNumber: "267",
        });

        expect(result.exactPrinting).toHaveLength(2);
        expect(
          result.exactPrinting.map((candidate) => candidate.card.identifier)
        ).toEqual(["sc", "set-only"]);
        expect(
          result.exactPrinting.map((candidate) => candidate.bucket)
        ).toEqual(["set_collector", "set"]);
      });

      it("falls back to same-set matches when no exact collector match exists", async () => {
        const setOnly = makeCard({
          identifier: "set-only",
          rawName: "Sol Ring [C21] {268}",
          dpi: 300,
        });
        const other = makeCard({
          identifier: "other",
          rawName: "Sol Ring (Artist Name)",
          dpi: 600,
        });

        const result = await rankCandidates({
          candidates: [setOnly, other],
          set: "C21",
          collectorNumber: "267",
        });

        expect(result.exactPrinting).toHaveLength(1);
        expect(result.exactPrinting[0].card.identifier).toBe("set-only");
        expect(result.exactPrinting[0].bucket).toBe("set");
      });

      it("sorts by DPI descending within exact printing", async () => {
        const low = makeCard({
          identifier: "low",
          rawName: "Sol Ring [C21] {268}",
          dpi: 200,
        });
        const high = makeCard({
          identifier: "high",
          rawName: "Sol Ring [C21] {269}",
          dpi: 600,
        });

        const result = await rankCandidates({
          candidates: [low, high],
          set: "C21",
          collectorNumber: "267",
        });

        expect(result.exactPrinting[0].card.identifier).toBe("high");
        expect(result.exactPrinting[1].card.identifier).toBe("low");
        expect(
          result.exactPrinting.every((candidate) => candidate.bucket === "set")
        ).toBe(true);
      });
    });

    describe("fullCard layer", () => {
      it("uses the preserved full-card comparison path when comparison is available", async () => {
        const cards = [
          makeCard({ identifier: "low", dpi: 200 }),
          makeCard({ identifier: "high", dpi: 600 }),
        ];
        const ssimCompare: SsimCompareFn = vi.fn(async (_src, candidateUrl) => {
          if (candidateUrl.includes("low")) return 0.97;
          if (candidateUrl.includes("high")) return 0.93;
          return null;
        });

        const result = await rankCandidates({
          candidates: cards,
          sourceImageUrl: "https://scryfall.test/sol-ring.png",
          ssimCompare,
          getMpcImageUrl: defaultGetUrl,
        });

        expect(result.fullCard.map((r) => r.card.identifier)).toEqual([
          "low",
          "high",
        ]);
        expect(result.fullCard[0].reason).toBe("name_ssim");
        expect(result.fullCard.every((r) => r.bucket === "name")).toBe(true);
      });

      it("falls back to DPI ordering when full-card comparison is unavailable", async () => {
        const cards = [
          makeCard({ identifier: "charlie", dpi: 300 }),
          makeCard({ identifier: "alpha", dpi: 300 }),
          makeCard({ identifier: "bravo", dpi: 300 }),
        ];

        const result = await rankCandidates({ candidates: cards });

        expect(result.fullCard.map((r) => r.card.identifier)).toEqual([
          "alpha",
          "bravo",
          "charlie",
        ]);
        expect(
          result.fullCard.every(
            (candidate) => candidate.reason === "name_dpi_fallback"
          )
        ).toBe(true);
      });
    });

    describe("artMatch layer", () => {
      it("returns SSIM-scored candidates when comparison is available", async () => {
        const cardA = makeCard({ identifier: "a", dpi: 300 });
        const cardB = makeCard({ identifier: "b", dpi: 300 });

        const ssimCompare: SsimCompareFn = vi.fn(async (_src, candidateUrl) => {
          if (candidateUrl.includes("a")) return 0.85;
          if (candidateUrl.includes("b")) return 0.95;
          return null;
        });

        const result = await rankCandidates({
          candidates: [cardA, cardB],
          sourceImageUrl: "https://scryfall.test/sol-ring.png",
          ssimCompare,
          getMpcImageUrl: defaultGetUrl,
        });

        expect(result.artMatch).toHaveLength(2);
        expect(result.artMatch[0].card.identifier).toBe("b");
        expect(result.artMatch[0].score).toBe(0.95);
        expect(result.artMatch[1].card.identifier).toBe("a");
        expect(result.artMatch[1].score).toBe(0.85);
      });

      it("is empty when SSIM infrastructure is not provided", async () => {
        const card = makeCard({ identifier: "a", dpi: 300 });

        const result = await rankCandidates({ candidates: [card] });

        expect(result.artMatch).toEqual([]);
      });

      it("is empty when SSIM comparison throws", async () => {
        const card = makeCard({ identifier: "a", dpi: 300 });
        const ssimCompare: SsimCompareFn = vi.fn(async () => {
          throw new Error("Canvas unavailable");
        });

        const result = await rankCandidates({
          candidates: [card],
          sourceImageUrl: "https://scryfall.test/sol-ring.png",
          ssimCompare,
          getMpcImageUrl: defaultGetUrl,
        });

        expect(result.artMatch).toEqual([]);
      });
    });

    describe("fullProcess layer", () => {
      it("uses set+collector bucket when available", async () => {
        const scCard = makeCard({
          identifier: "sc",
          rawName: "Sol Ring [C21] {267}",
          dpi: 200,
        });
        const nameCard = makeCard({
          identifier: "name",
          rawName: "Sol Ring (Artist Name)",
          dpi: 600,
        });

        const result = await rankCandidates({
          candidates: [scCard, nameCard],
          set: "C21",
          collectorNumber: "267",
        });

        expect(result.fullProcess[0].card.identifier).toBe("sc");
        expect(result.fullProcess[0].bucket).toBe("set_collector");
      });

      it("falls back to set-only bucket when no collector match", async () => {
        const setCard = makeCard({
          identifier: "set",
          rawName: "Sol Ring [CMR] {395}",
          dpi: 300,
        });
        const nameCard = makeCard({
          identifier: "name",
          rawName: "Sol Ring (Artist Name)",
          dpi: 600,
        });

        const result = await rankCandidates({
          candidates: [setCard, nameCard],
          set: "CMR",
          collectorNumber: "999",
        });

        expect(result.fullProcess[0].card.identifier).toBe("set");
        expect(result.fullProcess[0].bucket).toBe("set");
      });

      it("falls back to name bucket when no set data provided", async () => {
        const cards = [
          makeCard({ identifier: "low", dpi: 200 }),
          makeCard({ identifier: "high", dpi: 600 }),
        ];

        const result = await rankCandidates({ candidates: cards });

        expect(result.fullProcess[0].card.identifier).toBe("high");
        expect(result.fullProcess[0].bucket).toBe("name");
      });

      it("uses SSIM within fullProcess when scores meet threshold", async () => {
        const cardA = makeCard({
          identifier: "a",
          rawName: "Sol Ring [C21] {267}",
          dpi: 600,
        });
        const cardB = makeCard({
          identifier: "b",
          rawName: "Sol Ring [C21] {267}",
          dpi: 300,
        });

        const ssimCompare: SsimCompareFn = vi.fn(async (_src, candidateUrl) => {
          if (candidateUrl.includes("b")) return 0.97;
          if (candidateUrl.includes("a")) return 0.93;
          return null;
        });

        const result = await rankCandidates({
          candidates: [cardA, cardB],
          set: "C21",
          collectorNumber: "267",
          sourceImageUrl: "https://scryfall.test/sol-ring.png",
          ssimCompare,
          getMpcImageUrl: defaultGetUrl,
        });

        expect(result.fullProcess[0].card.identifier).toBe("b");
        expect(result.fullProcess[0].reason).toBe("set_collector_ssim");
        expect(result.fullProcess[0].score).toBe(0.97);
      });
    });

    describe("allMatches layer", () => {
      it("returns raw candidates without ranking metadata", async () => {
        const cards = [
          makeCard({ identifier: "a", dpi: 200 }),
          makeCard({ identifier: "b", dpi: 600 }),
        ];

        const result = await rankCandidates({ candidates: cards });

        expect(result.allMatches).toHaveLength(2);
        // allMatches returns MpcAutofillCard[] (no RankedCandidate wrapper)
        expect(result.allMatches[0].identifier).toBe("a");
        expect(result.allMatches[1].identifier).toBe("b");
      });
    });

    describe("top-6 cap", () => {
      it("caps fullProcess to 6 ranked candidates", async () => {
        const cards = Array.from({ length: 10 }, (_, i) =>
          makeCard({
            identifier: `card-${String(i).padStart(2, "0")}`,
            dpi: 100 + i * 50,
          })
        );

        const result = await rankCandidates({ candidates: cards });

        expect(result.fullProcess).toHaveLength(6);
        expect(result.fullProcess.map((r) => r.card.identifier)).toEqual([
          "card-09",
          "card-08",
          "card-07",
          "card-06",
          "card-05",
          "card-04",
        ]);
      });

      it("caps each layer to 6 entries", async () => {
        const cards = Array.from({ length: 10 }, (_, i) =>
          makeCard({
            identifier: `card-${String(i).padStart(2, "0")}`,
            rawName: `Sol Ring [C21] {${267 + i}}`,
            dpi: 300 + i * 10,
          })
        );

        const result = await rankCandidates({
          candidates: cards,
          set: "C21",
          collectorNumber: "267",
        });

        // exactPrinting only has the one matching collector number
        expect(result.exactPrinting.length).toBeLessThanOrEqual(6);
        expect(result.fullProcess.length).toBeLessThanOrEqual(6);
        expect(result.fullCard.length).toBeLessThanOrEqual(6);
        expect(result.allMatches.length).toBeLessThanOrEqual(6);
      });

      it("caps fullCard to 6 from many candidates", async () => {
        const cards = Array.from({ length: 10 }, (_, i) =>
          makeCard({
            identifier: `card-${String(i).padStart(2, "0")}`,
            dpi: 100 + i * 50,
          })
        );

        const result = await rankCandidates({ candidates: cards });

        expect(result.fullCard).toHaveLength(6);
        // Should be the top 6 by DPI
        expect(result.fullCard[0].card.dpi).toBe(550);
        expect(result.fullCard[5].card.dpi).toBe(300);
      });

      it("caps artMatch to 6 from many candidates", async () => {
        const cards = Array.from({ length: 10 }, (_, i) =>
          makeCard({
            identifier: `card-${String(i).padStart(2, "0")}`,
            dpi: 300,
          })
        );

        const ssimCompare: SsimCompareFn = vi.fn(async (_src, candidateUrl) => {
          const match = candidateUrl.match(/card-(\d+)/);
          return match ? 0.8 + parseInt(match[1]) * 0.01 : null;
        });

        const result = await rankCandidates({
          candidates: cards,
          sourceImageUrl: "https://scryfall.test/sol-ring.png",
          ssimCompare,
          getMpcImageUrl: defaultGetUrl,
        });

        expect(result.artMatch).toHaveLength(6);
        // Top 6 by SSIM score descending
        expect(result.artMatch[0].card.identifier).toBe("card-09");
        expect(result.artMatch[5].card.identifier).toBe("card-04");
      });

      it("caps allMatches to 6", async () => {
        const cards = Array.from({ length: 10 }, (_, i) =>
          makeCard({ identifier: `card-${i}`, dpi: 300 })
        );

        const result = await rankCandidates({ candidates: cards });

        expect(result.allMatches).toHaveLength(6);
      });
    });

    describe("metadata for modal consumption", () => {
      it("includes reason, bucket, and optional score in ranked candidates", async () => {
        const card = makeCard({
          identifier: "a",
          rawName: "Sol Ring [C21] {267}",
          dpi: 300,
        });

        const result = await rankCandidates({
          candidates: [card],
          set: "C21",
          collectorNumber: "267",
        });

        const fp = result.fullProcess[0];
        expect(fp).toHaveProperty("card");
        expect(fp).toHaveProperty("reason");
        expect(fp).toHaveProperty("bucket");
        expect(fp.card.identifier).toBe("a");
        expect(fp.bucket).toBe("set_collector");
      });

      it("includes score when SSIM is used", async () => {
        const card = makeCard({ identifier: "a", dpi: 300 });
        const ssimCompare: SsimCompareFn = vi.fn(async () => 0.95);

        const result = await rankCandidates({
          candidates: [card],
          sourceImageUrl: "https://scryfall.test/sol-ring.png",
          ssimCompare,
          getMpcImageUrl: defaultGetUrl,
        });

        const artCandidate = result.artMatch[0];
        expect(artCandidate.score).toBe(0.95);
      });
    });

    describe("layer disagreement", () => {
      it("artMatch can be empty while fullCard falls back to DPI ordering", async () => {
        const lowDpiHighSsim = makeCard({ identifier: "art-fav", dpi: 200 });
        const highDpiLowSsim = makeCard({ identifier: "dpi-fav", dpi: 600 });

        const result = await rankCandidates({
          candidates: [lowDpiHighSsim, highDpiLowSsim],
          sourceImageUrl: "https://scryfall.test/sol-ring.png",
        });

        expect(result.artMatch).toEqual([]);
        expect(result.fullCard[0].card.identifier).toBe("dpi-fav");
      });

      it("fullProcess preserves exact-printing priority even when art-match disagrees", async () => {
        const exactPrint = makeCard({
          identifier: "exact",
          rawName: "Sol Ring [C21] {267}",
          dpi: 200,
        });
        const artFavorite = makeCard({
          identifier: "art-fav",
          rawName: "Sol Ring (Alt Art)",
          dpi: 600,
        });

        const ssimCompare: SsimCompareFn = vi.fn(async (_src, candidateUrl) => {
          if (candidateUrl.includes("art-fav")) return 0.99;
          if (candidateUrl.includes("exact")) return 0.8;
          return null;
        });

        const result = await rankCandidates({
          candidates: [exactPrint, artFavorite],
          set: "C21",
          collectorNumber: "267",
          sourceImageUrl: "https://scryfall.test/sol-ring.png",
          ssimCompare,
          getMpcImageUrl: defaultGetUrl,
        });

        expect(result.artMatch[0].card.identifier).toBe("art-fav");
        expect(result.fullProcess[0].card.identifier).toBe("exact");
        expect(result.fullProcess[0].bucket).toBe("set_collector");
        expect(result.exactPrinting[0].card.identifier).toBe("exact");
        expect(result.fullCard[0].card.identifier).toBe("art-fav");
      });

      it("fullProcess uses SSIM within its bucket, not across layers", async () => {
        const scA = makeCard({
          identifier: "sc-a",
          rawName: "Sol Ring [C21] {267}",
          dpi: 300,
        });
        const scB = makeCard({
          identifier: "sc-b",
          rawName: "Sol Ring [C21] {267}",
          dpi: 600,
        });
        const nameOnly = makeCard({
          identifier: "name-only",
          rawName: "Sol Ring (Best Art)",
          dpi: 800,
        });

        const ssimCompare: SsimCompareFn = vi.fn(async (_src, candidateUrl) => {
          if (candidateUrl.includes("sc-a")) return 0.96;
          if (candidateUrl.includes("sc-b")) return 0.93;
          if (candidateUrl.includes("name-only")) return 0.99;
          return null;
        });

        const result = await rankCandidates({
          candidates: [scA, scB, nameOnly],
          set: "C21",
          collectorNumber: "267",
          sourceImageUrl: "https://scryfall.test/sol-ring.png",
          ssimCompare,
          getMpcImageUrl: defaultGetUrl,
        });

        expect(result.fullProcess[0].card.identifier).toBe("sc-a");
        expect(result.fullProcess[0].bucket).toBe("set_collector");
        expect(result.artMatch[0].card.identifier).toBe("name-only");
      });
    });

    describe("selectBestCandidate preserves behavior as wrapper", () => {
      it("returns same winner as fullProcess[0] for decisive SSIM", async () => {
        const cardA = makeCard({
          identifier: "a",
          rawName: "Sol Ring [C21] {267}",
          dpi: 600,
        });
        const cardB = makeCard({
          identifier: "b",
          rawName: "Sol Ring [C21] {267}",
          dpi: 300,
        });

        const ssimCompare: SsimCompareFn = vi.fn(async (_src, candidateUrl) => {
          if (candidateUrl.includes("b")) return 0.97;
          if (candidateUrl.includes("a")) return 0.93;
          return null;
        });

        const input = {
          candidates: [cardA, cardB],
          set: "C21",
          collectorNumber: "267",
          sourceImageUrl: "https://scryfall.test/sol-ring.png",
          ssimCompare,
          getMpcImageUrl: defaultGetUrl,
        };

        const ranked = await rankCandidates(input);
        const best = await selectBestCandidate(input);

        expect(best?.card.identifier).toBe(
          ranked.fullProcess[0].card.identifier
        );
        expect(best?.reason).toBe(ranked.fullProcess[0].reason);
      });

      it("falls back to DPI when SSIM margin is inconclusive", async () => {
        const cardA = makeCard({
          identifier: "a",
          rawName: "Sol Ring [C21] {267}",
          dpi: 600,
        });
        const cardB = makeCard({
          identifier: "b",
          rawName: "Sol Ring [C21] {267}",
          dpi: 300,
        });

        // Scores are too close (< 0.01 margin)
        const ssimCompare: SsimCompareFn = vi.fn(async (_src, candidateUrl) => {
          if (candidateUrl.includes("a")) return 0.95;
          if (candidateUrl.includes("b")) return 0.955;
          return null;
        });

        const input = {
          candidates: [cardA, cardB],
          set: "C21",
          collectorNumber: "267",
          sourceImageUrl: "https://scryfall.test/sol-ring.png",
          ssimCompare,
          getMpcImageUrl: defaultGetUrl,
        };

        const best = await selectBestCandidate(input);
        // Falls back to DPI: cardA has 600 DPI
        expect(best?.card.identifier).toBe("a");
        expect(best?.reason).toBe("set_collector_dpi_fallback");
      });
    });
  });
});
