import { describe, it, expect, vi } from "vitest";

vi.mock("./imageProcessing", () => ({
  loadImage: vi.fn(),
}));

vi.mock("./imageHelper", () => ({
  toProxied: (url: string) => url,
  toArtCrop: (url: string) =>
    url.includes("cards.scryfall.io")
      ? url.replace("/normal/", "/art_crop/")
      : null,
}));

import {
  bucketBySetOnly,
  computeBlockScore,
  computeSsimBlock,
  computeSsimForValues,
  normalizeBitmap,
  prioritizePreferredCandidate,
  selectBestCandidate,
  rankCandidates,
  createSsimCompare,
  filterByExactName,
  sortByDpiThenId,
  normalizeName,
  computeSobelMagnitude,
  computeEdgeScore,
  type RankedCandidate,
  type SsimCompareFn,
} from "./mpcBulkUpgradeMatcher";
import type { MpcAutofillCard } from "./mpcAutofillApi";
import { loadImage } from "./imageProcessing";

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
const scryfallSourceUrl =
  "https://cards.scryfall.io/normal/front/c/8/c83ed3e0-82d0-4410-a6ca-b0f923eadf83.jpg?1581479572";
const loadImageMock = vi.mocked(loadImage);

type MockBitmap = ImageBitmap & {
  luma?: number;
  outputWidth?: number;
  outputHeight?: number;
};

function makeBitmap(overrides: Partial<MockBitmap> = {}): MockBitmap {
  return {
    width: 4,
    height: 4,
    close: vi.fn(),
    ...overrides,
  } as MockBitmap;
}

function restoreOffscreenCanvas(original: typeof globalThis.OffscreenCanvas) {
  if (original) {
    Object.defineProperty(globalThis, "OffscreenCanvas", {
      configurable: true,
      writable: true,
      value: original,
    });
    return;
  }

  delete (globalThis as typeof globalThis & { OffscreenCanvas?: unknown })
    .OffscreenCanvas;
}

function installMockOffscreenCanvas(options: { contextAvailable?: boolean } = {}) {
  const original = globalThis.OffscreenCanvas;
  const { contextAvailable = true } = options;

  class MockOffscreenCanvas {
    width: number;
    height: number;
    private bitmap?: MockBitmap;

    constructor(width: number, height: number) {
      this.width = width;
      this.height = height;
    }

    getContext() {
      if (!contextAvailable) {
        return null;
      }

      return {
        drawImage: (bitmap: MockBitmap) => {
          this.bitmap = bitmap;
        },
        getImageData: (
          _x: number,
          _y: number,
          width: number,
          height: number
        ) => {
          const outputWidth = this.bitmap?.outputWidth ?? width;
          const outputHeight = this.bitmap?.outputHeight ?? height;
          const luma = this.bitmap?.luma ?? 0.5;
          const data = new Uint8ClampedArray(outputWidth * outputHeight * 4);
          for (let i = 0; i < data.length; i += 4) {
            const value = Math.round(luma * 255);
            data[i] = value;
            data[i + 1] = value;
            data[i + 2] = value;
            data[i + 3] = 255;
          }

          return { data, width: outputWidth, height: outputHeight };
        },
      };
    }
  }

  Object.defineProperty(globalThis, "OffscreenCanvas", {
    configurable: true,
    writable: true,
    value: MockOffscreenCanvas,
  });

  return () => restoreOffscreenCanvas(original);
}

describe("mpcBulkUpgradeMatcher", () => {
  describe("edge similarity helpers", () => {
    it("produces no edges for a flat image", () => {
      const pixels = new Float32Array(25).fill(0.5);
      const edges = computeSobelMagnitude(pixels, 5, 5);

      expect(Array.from(edges)).toEqual(Array.from(new Float32Array(25)));
    });

    it("returns an empty edge map for invalid dimensions", () => {
      const edges = computeSobelMagnitude(new Float32Array([1, 0]), 2, 2);

      expect(Array.from(edges)).toEqual([0, 0]);
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

    it("returns zero for incompatible or one-sided edge maps", () => {
      expect(computeEdgeScore(new Float32Array([1]), new Float32Array([]))).toBe(
        0
      );
      expect(
        computeEdgeScore(new Float32Array([1, 0]), new Float32Array([0, 0]))
      ).toBe(0);
    });
  });

  describe("createSsimCompare", () => {
    it("uses OffscreenCanvas, crop fragments, abort signals, and cached edge maps", async () => {
      const restoreCanvas = installMockOffscreenCanvas();
      const signal = new AbortController().signal;
      loadImageMock.mockReset();
      loadImageMock.mockResolvedValue(makeBitmap({ luma: 0.5 }));

      try {
        const compare = createSsimCompare(new Map(), 4);
        const score = await compare(
          "https://source.test/card.png#crop=0.1,0.1,0.1,0.1",
          "https://candidate.test/card.png#crop=bad",
          signal
        );
        const cachedScore = await compare(
          "https://source.test/card.png#crop=0.1,0.1,0.1,0.1",
          "https://candidate.test/card.png#crop=bad",
          signal
        );

        expect(score).toBe(1);
        expect(cachedScore).toBe(1);
        expect(loadImageMock).toHaveBeenCalledTimes(2);
        expect(loadImageMock).toHaveBeenCalledWith(
          "https://source.test/card.png",
          { signal },
          1
        );
        expect(loadImageMock).toHaveBeenCalledWith(
          "https://candidate.test/card.png",
          { signal },
          1
        );
      } finally {
        restoreCanvas();
        loadImageMock.mockReset();
      }
    });

    it("falls back to document canvas when OffscreenCanvas is unavailable", async () => {
      const originalOffscreenCanvas = globalThis.OffscreenCanvas;
      const originalCreateElement = document.createElement.bind(document);
      const createElementSpy = vi
        .spyOn(document, "createElement")
        .mockImplementation((tagName) => {
          if (tagName !== "canvas") {
            return originalCreateElement(tagName);
          }

          let bitmap: MockBitmap | undefined;
          return {
            width: 0,
            height: 0,
            getContext: () => ({
              drawImage: (drawnBitmap: MockBitmap) => {
                bitmap = drawnBitmap;
              },
              getImageData: (
                _x: number,
                _y: number,
                width: number,
                height: number
              ) => {
                const data = new Uint8ClampedArray(width * height * 4);
                const value = Math.round((bitmap?.luma ?? 0.5) * 255);
                for (let i = 0; i < data.length; i += 4) {
                  data[i] = value;
                  data[i + 1] = value;
                  data[i + 2] = value;
                  data[i + 3] = 255;
                }

                return { data, width, height };
              },
            }),
          } as HTMLCanvasElement;
        });
      delete (globalThis as typeof globalThis & { OffscreenCanvas?: unknown })
        .OffscreenCanvas;
      loadImageMock.mockReset();
      loadImageMock.mockResolvedValue(makeBitmap({ luma: 0.5 }));

      try {
        const score = await createSsimCompare(new Map(), 4)(
          "https://source.test/card.png",
          "https://candidate.test/card.png"
        );

        expect(score).toBe(1);
        expect(createElementSpy).toHaveBeenCalledWith("canvas");
      } finally {
        createElementSpy.mockRestore();
        restoreOffscreenCanvas(originalOffscreenCanvas);
        loadImageMock.mockReset();
      }
    });

    it("returns null when image loading fails", async () => {
      loadImageMock.mockReset();
      loadImageMock.mockRejectedValue(new Error("load failed"));

      try {
        const score = await createSsimCompare(new Map(), 4)(
          "https://source.test/card.png",
          "https://candidate.test/card.png"
        );

        expect(score).toBeNull();
      } finally {
        loadImageMock.mockReset();
      }
    });

    it("returns null when a 2d context is unavailable", async () => {
      const restoreCanvas = installMockOffscreenCanvas({
        contextAvailable: false,
      });
      loadImageMock.mockReset();
      loadImageMock.mockResolvedValue(makeBitmap());

      try {
        const score = await createSsimCompare(new Map(), 4)(
          "https://source.test/card.png",
          "https://candidate.test/card.png"
        );

        expect(score).toBeNull();
      } finally {
        restoreCanvas();
        loadImageMock.mockReset();
      }
    });

    it("returns null when normalized image dimensions differ", async () => {
      const restoreCanvas = installMockOffscreenCanvas();
      loadImageMock.mockReset();
      loadImageMock
        .mockResolvedValueOnce(makeBitmap({ outputWidth: 4, outputHeight: 4 }))
        .mockResolvedValueOnce(makeBitmap({ outputWidth: 5, outputHeight: 4 }));

      try {
        const score = await createSsimCompare(new Map(), 4)(
          "https://source.test/card.png",
          "https://candidate.test/card.png"
        );

        expect(score).toBeNull();
      } finally {
        restoreCanvas();
        loadImageMock.mockReset();
      }
    });

    it("returns zero for empty normalized images", async () => {
      const restoreCanvas = installMockOffscreenCanvas();
      loadImageMock.mockReset();
      loadImageMock.mockResolvedValue(
        makeBitmap({ outputWidth: 0, outputHeight: 0 })
      );

      try {
        const score = await createSsimCompare(new Map(), 4)(
          "https://source.test/card.png",
          "https://candidate.test/card.png"
        );

        expect(score).toBe(0);
      } finally {
        restoreCanvas();
        loadImageMock.mockReset();
      }
    });
  });

  describe("normalizeName", () => {
    it("trims and lowercases", () => {
      expect(normalizeName("  Sol Ring  ")).toBe("sol ring");
    });
  });

  describe("prioritizePreferredCandidate", () => {
    it("keeps the existing layer when no preferred identifier is provided", () => {
      const layer: RankedCandidate[] = [
        {
          card: makeCard({ identifier: "alpha" }),
          reason: "set_only",
          bucket: "set",
        },
      ];

      expect(prioritizePreferredCandidate(layer, [layer[0].card])).toBe(layer);
    });

    it("promotes an existing preferred card to the front and clears its score", () => {
      const preferred = makeCard({ identifier: "preferred" });
      const fallback = makeCard({ identifier: "fallback" });
      const layer: RankedCandidate[] = [
        {
          card: fallback,
          reason: "set_only",
          bucket: "set",
          score: 7,
        },
        {
          card: preferred,
          reason: "set_dpi_fallback",
          bucket: "set",
          score: 9,
        },
      ];

      const result = prioritizePreferredCandidate(
        layer,
        [fallback, preferred],
        "preferred"
      );

      expect(result).toHaveLength(2);
      expect(result[0]).toMatchObject({
        card: preferred,
        reason: "name_only",
        bucket: "set",
      });
      expect(result[0].score).toBeUndefined();
      expect(result[1].card).toBe(fallback);
    });

    it("inserts a missing preferred card before the existing layer", () => {
      const preferred = makeCard({ identifier: "preferred" });
      const fallback = makeCard({ identifier: "fallback" });
      const layer: RankedCandidate[] = [
        {
          card: fallback,
          reason: "set_only",
          bucket: "set",
        },
      ];

      const result = prioritizePreferredCandidate(
        layer,
        [preferred, fallback],
        "preferred"
      );

      expect(result).toHaveLength(2);
      expect(result[0]).toMatchObject({
        card: preferred,
        reason: "name_only",
        bucket: "name",
      });
      expect(result[1]).toBe(layer[0]);
    });

    it("returns the layer unchanged when the preferred card cannot be found", () => {
      const layer: RankedCandidate[] = [
        {
          card: makeCard({ identifier: "fallback" }),
          reason: "set_only",
          bucket: "set",
        },
      ];

      expect(
        prioritizePreferredCandidate(layer, [layer[0].card], "missing")
      ).toBe(layer);
    });
  });

  describe("bucketBySetOnly", () => {
    it("returns an empty array when no set is provided and filters same-set cards", () => {
      const setCard = makeCard({
        identifier: "set-card",
        rawName: "Sol Ring [C21] {267}",
      });
      const otherSet = makeCard({
        identifier: "other-set",
        rawName: "Sol Ring [CMR] {395}",
      });
      const nameOnly = makeCard({
        identifier: "name-only",
        rawName: "Sol Ring",
      });

      expect(bucketBySetOnly([setCard, otherSet, nameOnly])).toEqual([]);
      expect(bucketBySetOnly([setCard, otherSet, nameOnly], "c21")).toEqual([
        setCard,
      ]);
    });
  });

  describe("normalizeBitmap", () => {
    it("normalizes full-frame and cropped bitmaps and rejects missing contexts", () => {
      const restoreCanvas = installMockOffscreenCanvas();
      const expectedLuma = 64 / 255;
      const bitmap = makeBitmap({
        luma: expectedLuma,
        outputWidth: 4,
        outputHeight: 4,
      });

      try {
        const fullFrame = normalizeBitmap(bitmap, undefined, 4);
        const cropped = normalizeBitmap(
          bitmap,
          { top: 0.25, right: 0.25, bottom: 0.25, left: 0.25 },
          4
        );

        expect(fullFrame.width).toBe(4);
        expect(fullFrame.height).toBe(4);
        expect(Array.from(fullFrame.pixels)).toHaveLength(16);
        expect(fullFrame.pixels[0]).toBeCloseTo(expectedLuma);
        expect(fullFrame.pixels.at(-1)).toBeCloseTo(expectedLuma);
        expect(cropped.width).toBe(4);
        expect(cropped.height).toBe(4);
        expect(Array.from(cropped.pixels)).toHaveLength(16);
      } finally {
        restoreCanvas();
      }

      const restoreNoContext = installMockOffscreenCanvas({
        contextAvailable: false,
      });
      try {
        expect(() => normalizeBitmap(bitmap, undefined, 4)).toThrow(
          "Failed to get 2D context"
        );
      } finally {
        restoreNoContext();
      }
    });

    it("returns an empty bitmap for zero-sized image data and zeroes truncated pixels", () => {
      const restoreCanvas = installMockOffscreenCanvas();
      const emptyBitmap = makeBitmap({
        luma: 0.75,
        outputWidth: 0,
        outputHeight: 0,
      });

      try {
        const empty = normalizeBitmap(emptyBitmap, undefined, 4);
        expect(empty.width).toBe(0);
        expect(empty.height).toBe(0);
        expect(empty.pixels).toHaveLength(0);
      } finally {
        restoreCanvas();
      }

      const originalOffscreenCanvas = globalThis.OffscreenCanvas;
      class TruncatedOffscreenCanvas {
        constructor(
          public width: number,
          public height: number
        ) {}

        getContext() {
          return {
            drawImage: vi.fn(),
            getImageData: () => ({
              data: new Uint8ClampedArray([255, 255]),
              width: 1,
              height: 1,
            }),
          };
        }
      }

      Object.defineProperty(globalThis, "OffscreenCanvas", {
        configurable: true,
        writable: true,
        value: TruncatedOffscreenCanvas,
      });

      try {
        const truncated = normalizeBitmap(makeBitmap(), undefined, 1);
        expect(truncated.width).toBe(1);
        expect(truncated.height).toBe(1);
        expect(truncated.pixels).toHaveLength(1);
        expect(truncated.pixels[0]).toBe(0);
      } finally {
        restoreOffscreenCanvas(originalOffscreenCanvas);
      }
    });

    it("falls back to the requested size when image data omits dimensions", () => {
      const originalOffscreenCanvas = globalThis.OffscreenCanvas;
      class SizeFallbackOffscreenCanvas {
        constructor(
          public width: number,
          public height: number
        ) {}

        getContext() {
          return {
            drawImage: vi.fn(),
            getImageData: () => ({
              data: new Uint8ClampedArray([255, 255, 255, 255]),
              width: undefined,
              height: undefined,
            }),
          };
        }
      }

      Object.defineProperty(globalThis, "OffscreenCanvas", {
        configurable: true,
        writable: true,
        value: SizeFallbackOffscreenCanvas,
      });

      try {
        const normalized = normalizeBitmap(makeBitmap(), undefined, 4);
        expect(normalized.width).toBe(4);
        expect(normalized.height).toBe(4);
        expect(normalized.pixels).toHaveLength(16);
      } finally {
        restoreOffscreenCanvas(originalOffscreenCanvas);
      }
    });
  });

  describe("SSIM math helpers", () => {
    it("falls back to the direct SSIM formula when no blocks fit", () => {
      const pixels = new Float32Array([0.5]);

      expect(computeBlockScore(pixels, pixels, 1, 1)).toBeCloseTo(1);
      expect(
        computeBlockScore(new Float32Array([1]), new Float32Array([]), 1, 1)
      ).toBe(0);
      expect(computeSsimForValues(new Float32Array([1]), new Float32Array([]))).toBe(0);
    });

    it("computes block SSIM over a dense window", () => {
      const pixels = new Float32Array(64).fill(0.5);

      expect(computeSsimBlock(pixels, pixels, 0, 0, 8)).toBeCloseTo(1);
    });

    it("uses the block SSIM loop when blocks fit", () => {
      const source = new Float32Array(256);
      const candidate = new Float32Array(256);
      for (let i = 0; i < source.length; i += 1) {
        source[i] = (i % 7) / 7;
        candidate[i] = source[i];
      }

      expect(computeBlockScore(source, candidate, 16, 16)).toBeCloseTo(1);
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

    it("keeps name variants that only add style or set suffixes", () => {
      const cards = [
        makeCard({
          identifier: "a",
          name: "Adarkar Wastes (DMU)",
          rawName: "Adarkar Wastes (DMU)",
        }),
        makeCard({
          identifier: "b",
          name: "Jace Beleren (Art Nouveau)",
          rawName: "Jace Beleren (Art Nouveau)",
        }),
        makeCard({
          identifier: "c",
          name: "Approach of the Second Sun (Normal, Noah Bradley) [AKH] {4}",
          rawName:
            "Approach of the Second Sun (Normal, Noah Bradley) [AKH] {4}",
        }),
      ];

      expect(
        filterByExactName(cards, "Adarkar Wastes").map((c) => c.identifier)
      ).toEqual(["a"]);
      expect(
        filterByExactName(cards, "Jace Beleren").map((c) => c.identifier)
      ).toEqual(["b"]);
      expect(
        filterByExactName(cards, "Approach of the Second Sun").map(
          (c) => c.identifier
        )
      ).toEqual(["c"]);
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
          sourceImageUrl: scryfallSourceUrl,
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
          sourceImageUrl: scryfallSourceUrl,
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
          sourceImageUrl: scryfallSourceUrl,
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
          sourceImageUrl: scryfallSourceUrl,
          ssimCompare,
          getMpcImageUrl: defaultGetUrl,
        });

        expect(result?.card.identifier).toBe("showcase");
        expect(result?.reason).toBe("name_ssim");
      });

      it("keeps a decisive winner on the metadata fallback path when SSIM stays below threshold", async () => {
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
          candidateUrl.includes("a") ? 0.78 : 0.74
        );

        const result = await selectBestCandidate({
          candidates: [cardA, cardB],
          set: "C21",
          collectorNumber: "267",
          sourceImageUrl: scryfallSourceUrl,
          ssimCompare,
          getMpcImageUrl: defaultGetUrl,
        });

        expect(result?.card.identifier).toBe("a");
        expect(result?.reason).toBe("set_collector_dpi_fallback");
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
          candidateUrl.includes("a") ? 0.8 : 0.8005
        );

        const result = await selectBestCandidate({
          candidates: [cardA, cardB],
          set: "C21",
          collectorNumber: "267",
          sourceImageUrl: scryfallSourceUrl,
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
          sourceImageUrl: scryfallSourceUrl,
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
          sourceImageUrl: scryfallSourceUrl,
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
          sourceImageUrl: scryfallSourceUrl,
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
          sourceImageUrl: scryfallSourceUrl,
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
          sourceImageUrl: scryfallSourceUrl,
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
          sourceImageUrl: scryfallSourceUrl,
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

      it("matches exact-printing collector numbers when only numeric leading zeros differ", async () => {
        const exactWithLeadingZeros = makeCard({
          identifier: "leading-zero-match",
          rawName: "Sol Ring [C21] {001}",
          dpi: 300,
        });
        const setOnly = makeCard({
          identifier: "set-only",
          rawName: "Sol Ring [C21] {268}",
          dpi: 600,
        });

        const result = await rankCandidates({
          candidates: [setOnly, exactWithLeadingZeros],
          set: "C21",
          collectorNumber: "1",
        });

        expect(result.exactPrinting).toHaveLength(2);
        expect(result.exactPrinting[0].card.identifier).toBe(
          "leading-zero-match"
        );
        expect(result.exactPrinting[0].bucket).toBe("set_collector");
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
      it("can use a separate art-match comparator from the full-card comparator", async () => {
        const cards = [
          makeCard({ identifier: "full-fav", dpi: 300 }),
          makeCard({ identifier: "art-fav", dpi: 300 }),
        ];
        const ssimCompare: SsimCompareFn = vi.fn(async (_src, candidateUrl) => {
          if (candidateUrl.includes("full-fav")) return 0.97;
          if (candidateUrl.includes("art-fav")) return 0.93;
          return null;
        });
        const artMatchCompare: SsimCompareFn = vi.fn(
          async (_src, candidateUrl) => {
            if (candidateUrl.includes("art-fav")) return 0.98;
            if (candidateUrl.includes("full-fav")) return 0.91;
            return null;
          }
        );

        const result = await rankCandidates({
          candidates: cards,
          sourceImageUrl: scryfallSourceUrl,
          ssimCompare,
          artMatchCompare,
          getMpcImageUrl: defaultGetUrl,
        });

        expect(result.fullCard[0].card.identifier).toBe("full-fav");
        expect(result.artMatch[0].card.identifier).toBe("art-fav");
      });

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
          sourceImageUrl: scryfallSourceUrl,
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
          sourceImageUrl: scryfallSourceUrl,
          ssimCompare,
          getMpcImageUrl: defaultGetUrl,
        });

        expect(result.artMatch).toHaveLength(2);
        expect(result.artMatch[0].card.identifier).toBe("b");
        expect(result.artMatch[0].score).toBe(0.95);
        expect(result.artMatch[1].card.identifier).toBe("a");
        expect(result.artMatch[1].score).toBe(0.85);
        expect(ssimCompare).toHaveBeenCalledWith(
          expect.stringContaining("/art_crop/"),
          expect.stringContaining("#crop="),
          undefined
        );
      });

      it("ranks same-art different-border candidates above clearly different art", async () => {
        const borderless = makeCard({
          identifier: "borderless",
          rawName: "Thassa, Deep-Dwelling (Borderless)",
          dpi: 1200,
        });
        const matching = makeCard({
          identifier: "matching",
          rawName: "Thassa, Deep-Dwelling",
          dpi: 800,
        });
        const unrelated = makeCard({
          identifier: "unrelated",
          rawName: "Thassa, Deep-Dwelling (Poseidon)",
          dpi: 1200,
        });

        const ssimCompare: SsimCompareFn = vi.fn(async (_src, candidateUrl) => {
          if (candidateUrl.includes("matching")) return 0.94;
          if (candidateUrl.includes("borderless")) return 0.78;
          if (candidateUrl.includes("unrelated")) return 0.22;
          return null;
        });

        const result = await rankCandidates({
          candidates: [unrelated, borderless, matching],
          sourceImageUrl:
            "https://cards.scryfall.io/normal/front/c/8/c83ed3e0-82d0-4410-a6ca-b0f923eadf83.jpg?1581479572",
          ssimCompare,
          getMpcImageUrl: defaultGetUrl,
        });

        expect(
          result.artMatch.map((candidate) => candidate.card.identifier)
        ).toEqual(["matching", "borderless", "unrelated"]);
      });

      it("is empty when SSIM infrastructure is not provided", async () => {
        const card = makeCard({ identifier: "a", dpi: 300 });

        const result = await rankCandidates({ candidates: [card] });

        expect(result.artMatch).toEqual([]);
      });

      it("falls back to full-card comparison when source art crop is unavailable", async () => {
        const cardA = makeCard({ identifier: "a", dpi: 300 });
        const cardB = makeCard({ identifier: "b", dpi: 300 });

        const ssimCompare: SsimCompareFn = vi.fn(async (_src, candidateUrl) => {
          if (candidateUrl.includes("b")) return 0.95;
          if (candidateUrl.includes("a")) return 0.85;
          return null;
        });

        const result = await rankCandidates({
          candidates: [cardA, cardB],
          sourceImageUrl: "https://proxy.example.invalid/source-image.png",
          ssimCompare,
          getMpcImageUrl: defaultGetUrl,
        });

        expect(result.artMatch).toHaveLength(2);
        expect(result.artMatch[0].card.identifier).toBe("b");
        expect(result.artMatch[1].card.identifier).toBe("a");
        expect(ssimCompare).toHaveBeenCalledWith(
          "https://proxy.example.invalid/source-image.png",
          expect.stringContaining("/b"),
          undefined
        );
      });

      it("lets fallback art-match scoring drive fullProcess shortlisting when art crop is unavailable", async () => {
        const exactPrint = makeCard({
          identifier: "exact",
          rawName: "Sol Ring [C21] {267}",
          dpi: 300,
        });
        const artFavorite = makeCard({
          identifier: "art-fav",
          rawName: "Sol Ring (Alt Art)",
          dpi: 600,
        });

        const ssimCompare: SsimCompareFn = vi.fn(async (_src, candidateUrl) => {
          if (candidateUrl.includes("exact")) return 0.97;
          if (candidateUrl.includes("art-fav")) return 0.6;
          return null;
        });
        const artMatchCompare: SsimCompareFn = vi.fn(
          async (_src, candidateUrl) => {
            if (candidateUrl.includes("art-fav")) return 0.98;
            if (candidateUrl.includes("exact")) return 0.8;
            return null;
          }
        );

        const result = await rankCandidates({
          candidates: [exactPrint, artFavorite],
          set: "C21",
          collectorNumber: "267",
          sourceImageUrl: "https://proxy.example.invalid/source-image.png",
          ssimCompare,
          artMatchCompare,
          getMpcImageUrl: defaultGetUrl,
        });

        expect(result.artMatch[0].card.identifier).toBe("art-fav");
        expect(result.fullProcess[0].card.identifier).toBe("art-fav");
        expect(result.fullProcess[0].bucket).toBe("name");
      });

      it("is empty when SSIM comparison throws", async () => {
        const card = makeCard({ identifier: "a", dpi: 300 });
        const ssimCompare: SsimCompareFn = vi.fn(async () => {
          throw new Error("Canvas unavailable");
        });

        const result = await rankCandidates({
          candidates: [card],
          sourceImageUrl: scryfallSourceUrl,
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
          sourceImageUrl: scryfallSourceUrl,
          ssimCompare,
          getMpcImageUrl: defaultGetUrl,
        });

        expect(result.fullProcess[0].card.identifier).toBe("b");
        expect(result.fullProcess[0].reason).toBe("set_collector_ssim");
        expect(result.fullProcess[0].score).toBe(0.97);
      });

      it("promotes the best profile-matching candidate to the top of fullProcess", async () => {
        const exactPrint = makeCard({
          identifier: "exact",
          rawName: "Aven Mindcensor [CLB] {34}",
          dpi: 1200,
          tags: ["Borderless", "Frame"],
          sourceName: "BeardedBeowolf",
        });
        const preferred = makeCard({
          identifier: "preferred",
          rawName: "Aven Mindcensor (Rebecca Guay)",
          dpi: 1200,
          sourceName: "MrTeferi",
        });

        const result = await rankCandidates({
          candidates: [exactPrint, preferred],
          set: "CLB",
          collectorNumber: "34",
          preferenceProfile: {
            sourceName: "MrTeferi",
            tags: [],
            rawName: "Aven Mindcensor (Rebecca Guay)",
            hasBracketSet: false,
            parenText: "rebecca guay",
          },
        });

        expect(result.fullProcess[0].card.identifier).toBe("preferred");
        expect(result.fullProcess[0].bucket).toBe("name");
      });

      it("uses the stored preferred identifier before profile fallback", async () => {
        const exact = makeCard({
          identifier: "exact",
          rawName: "Aven Mindcensor [AKH] {5}",
          dpi: 1200,
          tags: ["Borderless"],
          sourceName: "Default Artist",
        });
        const preferred = makeCard({
          identifier: "preferred",
          rawName: "Aven Mindcensor (Rebecca Guay)",
          dpi: 600,
          sourceName: "MrTeferi",
        });

        const result = await rankCandidates({
          candidates: [exact, preferred],
          preferredIdentifier: "preferred",
          preferenceProfile: {
            sourceName: "Default Artist",
            tags: ["Borderless"],
            rawName: "Aven Mindcensor [AKH] {5}",
            hasBracketSet: true,
          },
        });

        expect(result.fullProcess[0].card.identifier).toBe("preferred");
      });

      it("uses unseen preference scores when no replay/profile is available", async () => {
        const fallback = makeCard({
          identifier: "fallback",
          rawName: "Windborn Muse",
          dpi: 1200,
        });
        const predicted = makeCard({
          identifier: "predicted",
          rawName: "Windborn Muse (Preferred)",
          dpi: 800,
        });

        const result = await rankCandidates({
          candidates: [fallback, predicted],
          unseenPreferenceScores: {
            fallback: 0.1,
            predicted: 2.5,
          },
        });

        expect(result.fullProcess[0].card.identifier).toBe("predicted");
      });
    });

    describe("allMatches layer", () => {
      it("returns ranked candidates instead of raw API order", async () => {
        const fallback = makeCard({ identifier: "fallback", dpi: 600 });
        const exact = makeCard({
          identifier: "exact",
          rawName: "Sol Ring [C21] {267}",
          dpi: 200,
        });
        const artFav = makeCard({ identifier: "art-fav", dpi: 300 });

        const ssimCompare: SsimCompareFn = vi.fn(async (_src, candidateUrl) => {
          if (candidateUrl.includes("art-fav")) return 0.99;
          if (candidateUrl.includes("exact")) return 0.8;
          return null;
        });

        const result = await rankCandidates({
          candidates: [fallback, exact, artFav],
          set: "C21",
          collectorNumber: "267",
          sourceImageUrl: scryfallSourceUrl,
          ssimCompare,
          getMpcImageUrl: defaultGetUrl,
        });

        expect(result.allMatches).toHaveLength(3);
        expect(
          result.allMatches.map((candidate) => candidate.card.identifier)
        ).toEqual(["art-fav", "exact", "fallback"]);
        expect(result.allMatches[0].reason).toBe("name_ssim");
      });

      it("dedupes cards already surfaced by higher-priority layers", async () => {
        const exact = makeCard({
          identifier: "exact",
          rawName: "Sol Ring [C21] {267}",
          dpi: 300,
        });
        const sameSet = makeCard({
          identifier: "same-set",
          rawName: "Sol Ring [C21] {268}",
          dpi: 400,
        });
        const nameOnly = makeCard({ identifier: "name-only", dpi: 800 });

        const ssimCompare: SsimCompareFn = vi.fn(async (_src, candidateUrl) => {
          if (candidateUrl.includes("name-only")) return 0.97;
          if (candidateUrl.includes("exact")) return 0.9;
          return null;
        });

        const result = await rankCandidates({
          candidates: [nameOnly, exact, sameSet],
          set: "C21",
          collectorNumber: "267",
          sourceImageUrl: scryfallSourceUrl,
          ssimCompare,
          getMpcImageUrl: defaultGetUrl,
        });

        expect(
          result.allMatches.map((candidate) => candidate.card.identifier)
        ).toEqual(["name-only", "exact", "same-set"]);
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
          sourceImageUrl: scryfallSourceUrl,
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
          makeCard({ identifier: `card-${i}`, dpi: 100 + i * 50 })
        );

        const result = await rankCandidates({ candidates: cards });

        expect(result.allMatches).toHaveLength(6);
        expect(result.allMatches[0].card.identifier).toBe("card-9");
        expect(result.allMatches[5].card.identifier).toBe("card-4");
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
          sourceImageUrl: scryfallSourceUrl,
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
          sourceImageUrl: scryfallSourceUrl,
        });

        expect(result.artMatch).toEqual([]);
        expect(result.fullCard[0].card.identifier).toBe("dpi-fav");
      });

      it("fullProcess narrows to a decisive art shortlist before metadata buckets", async () => {
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
          sourceImageUrl: scryfallSourceUrl,
          ssimCompare,
          getMpcImageUrl: defaultGetUrl,
        });

        expect(result.artMatch[0].card.identifier).toBe("art-fav");
        expect(result.fullProcess[0].card.identifier).toBe("art-fav");
        expect(result.fullProcess[0].bucket).toBe("name");
        expect(result.exactPrinting[0].card.identifier).toBe("exact");
        expect(result.fullCard[0].card.identifier).toBe("exact");
      });

      it("fullProcess falls back to the original pool when art scores are inconclusive", async () => {
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
          if (candidateUrl.includes("sc-a")) return 0.985;
          if (candidateUrl.includes("sc-b")) return 0.93;
          if (candidateUrl.includes("name-only")) return 0.99;
          return null;
        });

        const result = await rankCandidates({
          candidates: [scA, scB, nameOnly],
          set: "C21",
          collectorNumber: "267",
          sourceImageUrl: scryfallSourceUrl,
          ssimCompare,
          getMpcImageUrl: defaultGetUrl,
        });

        expect(result.fullProcess[0].card.identifier).toBe("sc-a");
        expect(result.fullProcess[0].bucket).toBe("set_collector");
        expect(result.artMatch[0].card.identifier).toBe("name-only");
      });

      it("keeps near-tied top art candidates so metadata can still decide within the shortlist", async () => {
        const exactPrint = makeCard({
          identifier: "exact",
          rawName: "Sol Ring [C21] {267}",
          dpi: 300,
        });
        const sameArtAlt = makeCard({
          identifier: "same-art-alt",
          rawName: "Sol Ring (Alt Art)",
          dpi: 600,
        });
        const unrelated = makeCard({
          identifier: "unrelated",
          rawName: "Sol Ring (Different Art)",
          dpi: 900,
        });

        const ssimCompare: SsimCompareFn = vi.fn(async (_src, candidateUrl) => {
          if (candidateUrl.includes("exact")) return 0.97;
          if (candidateUrl.includes("same-art-alt")) return 0.965;
          if (candidateUrl.includes("unrelated")) return 0.5;
          return null;
        });

        const result = await rankCandidates({
          candidates: [unrelated, sameArtAlt, exactPrint],
          set: "C21",
          collectorNumber: "267",
          sourceImageUrl: scryfallSourceUrl,
          ssimCompare,
          getMpcImageUrl: defaultGetUrl,
        });

        expect(result.artMatch[0].card.identifier).toBe("exact");
        expect(result.fullProcess[0].card.identifier).toBe("exact");
        expect(result.fullProcess[0].bucket).toBe("set_collector");
      });

      it("preserves the corrected Thassa, Deep-Dwelling ordering across layers", async () => {
        const exactPrinting = makeCard({
          identifier: "exact-printing",
          rawName: "Thassa, Deep-Dwelling [THB] {71}",
          dpi: 1200,
        });
        const sameArt = makeCard({
          identifier: "same-art",
          rawName: "Thassa, Deep-Dwelling",
          dpi: 800,
        });
        const borderVariant = makeCard({
          identifier: "border-variant",
          rawName: "Thassa, Deep-Dwelling (Borderless Zack Stella)",
          dpi: 1200,
        });
        const unrelatedArt = makeCard({
          identifier: "unrelated-art",
          rawName: "Thassa, Deep-Dwelling (Poseidon, God of the Sea)",
          dpi: 1210,
        });

        const ssimCompare: SsimCompareFn = vi.fn(async (_src, candidateUrl) => {
          if (candidateUrl.includes("same-art")) return 0.94;
          if (candidateUrl.includes("border-variant")) return 0.78;
          if (candidateUrl.includes("exact-printing")) return 0.52;
          if (candidateUrl.includes("unrelated-art")) return 0.22;
          return null;
        });

        const result = await rankCandidates({
          candidates: [unrelatedArt, borderVariant, sameArt, exactPrinting],
          set: "THB",
          collectorNumber: "71",
          sourceImageUrl: scryfallSourceUrl,
          ssimCompare,
          getMpcImageUrl: defaultGetUrl,
        });

        expect(result.fullProcess[0].card.identifier).toBe("same-art");
        expect(result.exactPrinting[0].card.identifier).toBe("exact-printing");
        expect(
          result.artMatch.map((candidate) => candidate.card.identifier)
        ).toEqual([
          "same-art",
          "border-variant",
          "exact-printing",
          "unrelated-art",
        ]);
        expect(result.fullCard[0].card.identifier).toBe("exact-printing");
        expect(
          result.allMatches.map((candidate) => candidate.card.identifier)
        ).toEqual([
          "same-art",
          "border-variant",
          "exact-printing",
          "unrelated-art",
        ]);
      });
    });

    describe("coverage-critical fallback branches", () => {
      const zeroScoreProfile = {
        sourceName: "Different Source",
        tags: ["Never Matched"],
        rawName: "Different Card [ZZZ] {999}",
        hasBracketSet: true,
        parenText: "missing artist",
      };

      it("promotes a preferred identifier even when a decisive art shortlist excluded it", async () => {
        const artFavorite = makeCard({
          identifier: "art-fav",
          rawName: "Sol Ring (Alt Art)",
          dpi: 600,
        });
        const preferred = makeCard({
          identifier: "preferred",
          rawName: "Sol Ring [C21] {267}",
          dpi: 300,
        });
        const ssimCompare: SsimCompareFn = vi.fn(async (_src, candidateUrl) =>
          candidateUrl.includes("art-fav") ? 0.99 : 0.5
        );

        const result = await rankCandidates({
          candidates: [artFavorite, preferred],
          preferredIdentifier: "preferred",
          sourceImageUrl: scryfallSourceUrl,
          ssimCompare,
          getMpcImageUrl: defaultGetUrl,
        });

        expect(result.fullProcess[0].card.identifier).toBe("preferred");
        expect(result.fullProcess[1].card.identifier).toBe("art-fav");
      });

      it("leaves ranked layers unchanged when the preferred identifier is absent", async () => {
        const card = makeCard({ identifier: "fallback", dpi: 300 });

        const result = await rankCandidates({
          candidates: [card],
          preferredIdentifier: "missing",
        });

        expect(result.fullProcess.map((candidate) => candidate.card.identifier))
          .toEqual(["fallback"]);
      });

      it("leaves preference profile ranking unchanged when replay scores are zero", async () => {
        const card = makeCard({
          identifier: "zero-score",
          name: "Sol Ring",
          rawName: undefined,
          dpi: 0,
        });

        const result = await rankCandidates({
          candidates: [card],
          preferenceProfile: zeroScoreProfile,
        });

        expect(result.fullProcess[0].card.identifier).toBe("zero-score");
      });

      it("uses deterministic identifier fallback when profile scores tie", async () => {
        const beta = makeCard({
          identifier: "beta",
          rawName: "Windborn Muse",
          sourceName: "Preferred Source",
          dpi: 400,
        });
        const alpha = makeCard({
          identifier: "alpha",
          rawName: "Windborn Muse",
          sourceName: "Preferred Source",
          dpi: 400,
        });

        const result = await rankCandidates({
          candidates: [beta, alpha],
          preferenceProfile: {
            sourceName: "Preferred Source",
            tags: [],
            rawName: "Different Name",
            hasBracketSet: false,
          },
        });

        expect(result.fullProcess[0].card.identifier).toBe("alpha");
      });

      it("leaves unseen preference ranking unchanged when no scores match", async () => {
        const card = makeCard({ identifier: "fallback", dpi: 300 });

        const result = await rankCandidates({
          candidates: [card],
          unseenPreferenceScores: {},
        });

        expect(result.fullProcess[0].card.identifier).toBe("fallback");
      });

      it("uses deterministic identifier fallback when unseen scores tie", async () => {
        const beta = makeCard({ identifier: "beta", dpi: 300 });
        const alpha = makeCard({ identifier: "alpha", dpi: 300 });

        const result = await rankCandidates({
          candidates: [beta, alpha],
          unseenPreferenceScores: { alpha: 1, beta: 1 },
        });

        expect(result.fullProcess[0].card.identifier).toBe("alpha");
      });

      it("can promote unseen scores from outside a decisive art shortlist", async () => {
        const artFavorite = makeCard({
          identifier: "art-fav",
          rawName: "Sol Ring (Alt Art)",
          dpi: 600,
        });
        const predicted = makeCard({
          identifier: "predicted",
          rawName: "Sol Ring [C21] {267}",
          dpi: 300,
        });
        const ssimCompare: SsimCompareFn = vi.fn(async (_src, candidateUrl) =>
          candidateUrl.includes("art-fav") ? 0.99 : 0.5
        );

        const result = await rankCandidates({
          candidates: [artFavorite, predicted],
          sourceImageUrl: scryfallSourceUrl,
          ssimCompare,
          getMpcImageUrl: defaultGetUrl,
          unseenPreferenceScores: { predicted: 200 },
        });

        expect(result.fullProcess[0].card.identifier).toBe("predicted");
        expect(result.fullProcess[1].card.identifier).toBe("art-fav");
      });

      it("uses set-only buckets when no collector number is provided", async () => {
        const setCard = makeCard({
          identifier: "set-card",
          rawName: "Sol Ring [C21] {267}",
          dpi: 300,
        });
        const other = makeCard({
          identifier: "other-set",
          rawName: "Sol Ring [CMR] {395}",
          dpi: 600,
        });

        const result = await rankCandidates({
          candidates: [other, setCard],
          set: "C21",
        });

        expect(result.fullProcess[0].card.identifier).toBe("set-card");
        expect(result.fullProcess[0].bucket).toBe("set");
      });

      it("does not treat collector-number-only metadata as exact-printing evidence", async () => {
        const card = makeCard({
          identifier: "collector-only",
          rawName: "Sol Ring [C21] {267}",
          dpi: 300,
        });

        const result = await rankCandidates({
          candidates: [card],
          collectorNumber: "267",
        });

        expect(result.exactPrinting).toEqual([]);
        expect(result.fullProcess[0].bucket).toBe("name");
      });

      it("matches name-only set data and all-zero collector numbers", async () => {
        const card = makeCard({
          identifier: "name-fallback",
          name: "Sol Ring [C21] {000}",
          rawName: undefined,
          dpi: 300,
        });

        const result = await rankCandidates({
          candidates: [card],
          set: "C21",
          collectorNumber: "000",
        });

        expect(result.fullProcess[0].card.identifier).toBe("name-fallback");
        expect(result.exactPrinting[0].bucket).toBe("set_collector");
      });

      it("uses name and zero-DPI fallbacks in ensemble scoring", async () => {
        const noRawName = makeCard({
          identifier: "no-raw-name",
          name: "Sol Ring",
          rawName: undefined,
          dpi: undefined,
        });

        const result = await selectBestCandidate({
          candidates: [noRawName],
        });

        expect(result?.card.identifier).toBe("no-raw-name");
        expect(result?.reason).toBe("name_only");
      });

      it("continues after a missing preferred id and zero replay score", async () => {
        const card = makeCard({
          identifier: "fallback",
          rawName: "Sol Ring",
          dpi: 0,
        });

        const result = await selectBestCandidate({
          candidates: [card],
          preferredIdentifier: "missing",
          preferenceProfile: zeroScoreProfile,
        });

        expect(result?.card.identifier).toBe("fallback");
      });

      it("returns an existing preferred id before ensemble scoring", async () => {
        const preferred = makeCard({ identifier: "preferred", dpi: 300 });
        const fallback = makeCard({ identifier: "fallback", dpi: 600 });

        const result = await selectBestCandidate({
          candidates: [fallback, preferred],
          preferredIdentifier: "preferred",
        });

        expect(result?.card.identifier).toBe("preferred");
        expect(result?.reason).toBe("name_only");
      });

      it("scores set-only ensemble metadata when collector number is absent", async () => {
        const setCard = makeCard({
          identifier: "set-card",
          rawName: "Sol Ring [C21] {267}",
          dpi: 300,
        });
        const nameOnly = makeCard({
          identifier: "name-only",
          rawName: "Sol Ring",
          dpi: 600,
        });

        const result = await selectBestCandidate({
          candidates: [nameOnly, setCard],
          set: "C21",
        });

        expect(result?.card.identifier).toBe("set-card");
        expect(result?.reason).toBe("set_only");
      });

      it("keeps parsed metadata at name score when the set differs", async () => {
        const card = makeCard({
          identifier: "parsed-other-set",
          rawName: "Sol Ring [C21] {267}",
          dpi: 300,
        });

        const result = await selectBestCandidate({
          candidates: [card],
          set: "CMR",
        });

        expect(result?.card.identifier).toBe("parsed-other-set");
        expect(result?.reason).toBe("name_only");
      });

      it("lets positive unseen ensemble scores override metadata fallbacks", async () => {
        const fallback = makeCard({
          identifier: "fallback",
          rawName: "Sol Ring [C21] {267}",
          dpi: 600,
        });
        const predicted = makeCard({
          identifier: "predicted",
          rawName: "Sol Ring (Preferred)",
          dpi: 300,
        });

        const result = await selectBestCandidate({
          candidates: [fallback, predicted],
          set: "C21",
          collectorNumber: "267",
          unseenPreferenceScores: { predicted: 5 },
        });

        expect(result?.card.identifier).toBe("predicted");
      });

      it("lets positive replay ensemble scores override metadata fallbacks", async () => {
        const fallback = makeCard({
          identifier: "fallback",
          rawName: "Sol Ring [C21] {267}",
          sourceName: "Default",
          dpi: 600,
        });
        const replayed = makeCard({
          identifier: "replayed",
          rawName: "Sol Ring (Preferred Artist)",
          sourceName: "Preferred Source",
          dpi: 300,
        });

        const result = await selectBestCandidate({
          candidates: [fallback, replayed],
          set: "C21",
          collectorNumber: "267",
          preferenceProfile: {
            sourceName: "Preferred Source",
            tags: [],
            rawName: "Sol Ring (Preferred Artist)",
            hasBracketSet: false,
            parenText: "preferred artist",
          },
        });

        expect(result?.card.identifier).toBe("replayed");
      });

      it("treats missing unseen ensemble entries as zero scores", async () => {
        const card = makeCard({ identifier: "fallback", dpi: 300 });

        const result = await selectBestCandidate({
          candidates: [card],
          unseenPreferenceScores: { other: 1 },
        });

        expect(result?.card.identifier).toBe("fallback");
      });

      it("falls back to the original pool when only one art score is available", async () => {
        const scored = makeCard({
          identifier: "scored",
          rawName: "Sol Ring (Alt Art)",
          dpi: 300,
        });
        const unscoredHighDpi = makeCard({
          identifier: "missing-score-high-dpi",
          rawName: "Sol Ring",
          dpi: 600,
        });
        const ssimCompare: SsimCompareFn = vi.fn(async (_src, candidateUrl) =>
          candidateUrl.includes("scored") ? 0.99 : null
        );

        const result = await rankCandidates({
          candidates: [scored, unscoredHighDpi],
          sourceImageUrl: scryfallSourceUrl,
          ssimCompare,
          getMpcImageUrl: defaultGetUrl,
        });

        expect(result.artMatch).toHaveLength(1);
        expect(result.fullProcess[0].card.identifier).toBe("scored");
      });

      it("uses zero-DPI sort fallback when every candidate omits DPI", async () => {
        const beta = makeCard({
          identifier: "beta",
          dpi: undefined,
        });
        const alpha = makeCard({
          identifier: "alpha",
          dpi: undefined,
        });

        const result = await rankCandidates({ candidates: [beta, alpha] });

        expect(result.fullProcess.map((candidate) => candidate.card.identifier))
          .toEqual(["alpha", "beta"]);
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
