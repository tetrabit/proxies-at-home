import { describe, expect, it, vi } from "vitest";

import {
  type ArtCropCompareFn,
  filterByExactName,
  normalizeName,
  selectBestCandidate,
  type HashDistanceFn,
  type VisualCompareFn,
} from "./mpcBulkUpgradeMatcher";
import type { MpcAutofillCard } from "./mpcAutofillApi";

function makeCard(
  overrides: Partial<MpcAutofillCard> & Pick<MpcAutofillCard, "identifier">
): MpcAutofillCard {
  return {
    name: "Sol Ring",
    rawName: "Sol Ring",
    smallThumbnailUrl: "",
    mediumThumbnailUrl: "",
    dpi: 300,
    tags: [],
    sourceName: "test",
    source: "test",
    extension: "png",
    size: 1000,
    ...overrides,
    identifier: overrides.identifier,
  };
}

describe("mpcBulkUpgradeMatcher", () => {
  describe("normalizeName", () => {
    it("trims and lowercases values", () => {
      expect(normalizeName("  Sol Ring  ")).toBe("sol ring");
    });
  });

  describe("filterByExactName", () => {
    it("matches parsed MPC names", () => {
      const cards = [
        makeCard({ identifier: "a", rawName: "Sol Ring [C21] {267}" }),
        makeCard({
          identifier: "b",
          name: "Arcane Signet",
          rawName: "Arcane Signet [C21] {237}",
        }),
        makeCard({ identifier: "c", rawName: "Sol Ring [CMR] {395}" }),
      ];

      expect(
        filterByExactName(cards, "sol ring").map((card) => card.identifier)
      ).toEqual(["a", "c"]);
    });
  });

  describe("selectBestCandidate", () => {
    it("returns null for empty candidate lists", async () => {
      expect(await selectBestCandidate({ candidates: [] })).toBeNull();
    });

    it("returns a metadata-only match when the bucket has one candidate", async () => {
      const result = await selectBestCandidate({
        candidates: [
          makeCard({ identifier: "a", rawName: "Sol Ring [C21] {267}" }),
        ],
        set: "C21",
        collectorNumber: "267",
      });

      expect(result).toEqual(
        expect.objectContaining({
          status: "matched",
          reason: "set_collector_only",
        })
      );
    });

    it("marks multiple metadata matches as ambiguous when no visual comparator is available", async () => {
      const result = await selectBestCandidate({
        candidates: [
          makeCard({ identifier: "a", rawName: "Sol Ring [C21] {267}" }),
          makeCard({ identifier: "b", rawName: "Sol Ring [C21] {267}" }),
        ],
        set: "C21",
        collectorNumber: "267",
      });

      expect(result).toEqual(
        expect.objectContaining({
          status: "ambiguous",
          reason: "set_collector_ambiguous",
        })
      );
    });

    it("returns an ambiguous result when visual scores are too close", async () => {
      const visualCompare: VisualCompareFn = vi.fn(
        async (_source: string, candidate: MpcAutofillCard) =>
          candidate.identifier === "a" ? 0.91 : 0.89
      );

      const result = await selectBestCandidate({
        candidates: [
          makeCard({ identifier: "a", rawName: "Sol Ring [C21] {267}" }),
          makeCard({ identifier: "b", rawName: "Sol Ring [C21] {267}" }),
        ],
        set: "C21",
        collectorNumber: "267",
        sourceImageUrl: "https://scryfall.test/card.png",
        visualCompare,
      });

      expect(result).toEqual(
        expect.objectContaining({
          status: "ambiguous",
          reason: "set_collector_visual_tie",
          bestConfidence: 0.91,
          runnerUpConfidence: 0.89,
        })
      );
    });

    it("returns an ambiguous result when visual confidence is too low", async () => {
      const visualCompare: VisualCompareFn = vi.fn(
        async (_source: string, candidate: MpcAutofillCard) =>
          candidate.identifier === "a" ? 0.69 : 0.55
      );

      const result = await selectBestCandidate({
        candidates: [
          makeCard({ identifier: "a" }),
          makeCard({ identifier: "b" }),
        ],
        sourceImageUrl: "https://scryfall.test/card.png",
        visualCompare,
      });

      expect(result).toEqual(
        expect.objectContaining({
          status: "ambiguous",
          reason: "name_visual_low_confidence",
          bestConfidence: 0.69,
          runnerUpConfidence: 0.55,
        })
      );
    });

    it("returns an ambiguous result when visual comparison is unavailable", async () => {
      const visualCompare: VisualCompareFn = vi.fn(async () => null);

      const result = await selectBestCandidate({
        candidates: [
          makeCard({ identifier: "a", rawName: "Sol Ring [C21] {267}" }),
          makeCard({ identifier: "b", rawName: "Sol Ring [C21] {267}" }),
        ],
        set: "C21",
        collectorNumber: "267",
        sourceImageUrl: "https://scryfall.test/card.png",
        visualCompare,
      });

      expect(result).toEqual(
        expect.objectContaining({
          status: "ambiguous",
          reason: "set_collector_visual_unavailable",
        })
      );
    });

    it("returns an art-crop match before the full-card visual layer", async () => {
      const artCropCompare: ArtCropCompareFn = vi.fn(
        async (_source: string, candidate: MpcAutofillCard) =>
          candidate.identifier === "b" ? 0.9 : 0.6
      );
      const visualCompare: VisualCompareFn = vi.fn(async () => 0.99);

      const result = await selectBestCandidate({
        candidates: [
          makeCard({ identifier: "a", rawName: "Sol Ring [C21] {267}" }),
          makeCard({ identifier: "b", rawName: "Sol Ring [C21] {267}" }),
        ],
        set: "C21",
        collectorNumber: "267",
        sourceImageUrl: "https://cards.scryfall.io/png/front/1/2/123.png",
        artCropCompare,
        visualCompare,
      });

      expect(result).toEqual(
        expect.objectContaining({
          status: "matched",
          reason: "set_collector_art_crop",
          confidence: 0.9,
        })
      );
      expect(visualCompare).not.toHaveBeenCalled();
    });

    it("falls through to the full-card layer when art-crop scoring is inconclusive", async () => {
      const artCropCompare: ArtCropCompareFn = vi.fn(
        async (_source: string, candidate: MpcAutofillCard) =>
          candidate.identifier === "b" ? 0.78 : 0.75
      );
      const visualCompare: VisualCompareFn = vi.fn(
        async (_source: string, candidate: MpcAutofillCard) =>
          candidate.identifier === "a" ? 0.97 : 0.8
      );

      const result = await selectBestCandidate({
        candidates: [
          makeCard({ identifier: "a", rawName: "Sol Ring [C21] {267}" }),
          makeCard({ identifier: "b", rawName: "Sol Ring [C21] {267}" }),
        ],
        set: "C21",
        collectorNumber: "267",
        sourceImageUrl: "https://cards.scryfall.io/png/front/1/2/123.png",
        artCropCompare,
        visualCompare,
      });

      expect(result).toEqual(
        expect.objectContaining({
          status: "matched",
          reason: "set_collector_visual",
          confidence: 0.97,
        })
      );
      expect(visualCompare).toHaveBeenCalled();
    });

    it("returns a matched result when visual scoring is decisive", async () => {
      const visualCompare: VisualCompareFn = vi.fn(
        async (_source: string, candidate: MpcAutofillCard) =>
          candidate.identifier === "b" ? 0.96 : 0.81
      );

      const result = await selectBestCandidate({
        candidates: [
          makeCard({ identifier: "a", rawName: "Sol Ring [CMR] {395}" }),
          makeCard({ identifier: "b", rawName: "Sol Ring [CMR] {396}" }),
        ],
        set: "CMR",
        collectorNumber: "999",
        sourceImageUrl: "https://scryfall.test/card.png",
        visualCompare,
      });

      expect(result).toEqual(
        expect.objectContaining({
          status: "matched",
          reason: "set_visual",
          confidence: 0.96,
        })
      );
      if (result?.status === "matched") {
        expect(result.card.identifier).toBe("b");
      }
    });

    it("prefilters candidates with perceptual hash distance before visual scoring", async () => {
      const hashDistance: HashDistanceFn = vi.fn(
        async (_source: string, candidate: MpcAutofillCard) =>
          candidate.identifier === "a" ? 3 : 14
      );
      const visualCompare: VisualCompareFn = vi.fn(async () => 0.96);

      const result = await selectBestCandidate({
        candidates: [
          makeCard({ identifier: "a", rawName: "Sol Ring [C21] {267}" }),
          makeCard({ identifier: "b", rawName: "Sol Ring [C21] {267}" }),
        ],
        set: "C21",
        collectorNumber: "267",
        sourceImageUrl: "https://scryfall.test/card.png",
        hashDistance,
        visualCompare,
      });

      expect(result).toEqual(
        expect.objectContaining({
          status: "matched",
          reason: "set_collector_visual",
          confidence: 0.96,
        })
      );
      expect(hashDistance).toHaveBeenCalledTimes(2);
      expect(visualCompare).toHaveBeenCalledTimes(1);
    });

    it("falls back to the full bucket when hash distances are unavailable", async () => {
      const hashDistance: HashDistanceFn = vi.fn(async () => null);
      const visualCompare: VisualCompareFn = vi.fn(
        async (_source: string, candidate: MpcAutofillCard) =>
          candidate.identifier === "b" ? 0.95 : 0.8
      );

      const result = await selectBestCandidate({
        candidates: [
          makeCard({ identifier: "a", rawName: "Sol Ring [C21] {267}" }),
          makeCard({ identifier: "b", rawName: "Sol Ring [C21] {267}" }),
        ],
        set: "C21",
        collectorNumber: "267",
        sourceImageUrl: "https://scryfall.test/card.png",
        hashDistance,
        visualCompare,
      });

      expect(result).toEqual(
        expect.objectContaining({
          status: "matched",
          reason: "set_collector_visual",
          confidence: 0.95,
        })
      );
      expect(visualCompare).toHaveBeenCalledTimes(2);
    });

    it("returns a name-only ambiguity when there are multiple matches without source imagery", async () => {
      const result = await selectBestCandidate({
        candidates: [
          makeCard({ identifier: "a" }),
          makeCard({ identifier: "b" }),
        ],
      });

      expect(result).toEqual(
        expect.objectContaining({
          status: "ambiguous",
          reason: "name_ambiguous",
        })
      );
    });
  });
});
