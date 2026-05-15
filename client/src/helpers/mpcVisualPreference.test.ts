import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildMpcSourceVisualProfiles,
  buildMpcVisualPreferenceScoreMap,
  extractMpcImageDescriptor,
  scoreMpcVisualSourcePreference,
} from "./mpcVisualPreference";

const mockLoadImage = vi.hoisted(() => vi.fn());
const mockToProxied = vi.hoisted(() => vi.fn((url: string) => `proxied:${url}`));

vi.mock("./imageProcessing", () => ({
  loadImage: mockLoadImage,
}));

vi.mock("./imageHelper", () => ({
  toProxied: mockToProxied,
}));

describe("mpcVisualPreference", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("scores preference from descriptors and profiles", () => {
    const score = scoreMpcVisualSourcePreference(
      { meanLuma: 0.5, variance: 0.2, edgeDensity: 0.1 },
      {
        alpha: {
          sourceName: "alpha",
          descriptor: { meanLuma: 0.5, variance: 0.2, edgeDensity: 0.1 },
          sampleCount: 1,
        },
      },
      { alpha: 2 }
    );

    expect(score).toBe(20);
  });

  it("builds source profiles from successful image descriptors", async () => {
    mockLoadImage.mockResolvedValue({
      close: vi.fn(),
    });
    const drawImage = vi.fn();
    const getImageData = vi.fn(() => ({
      data: new Uint8ClampedArray(32 * 32 * 4).fill(255),
    }));
    vi.spyOn(document, "createElement").mockReturnValue({
      width: 0,
      height: 0,
      getContext: vi.fn(() => ({
        drawImage,
        getImageData,
      })),
    } as unknown as HTMLCanvasElement);

    const profiles = await buildMpcSourceVisualProfiles([
      {
        sourceName: "example",
        candidates: [{ imageUrl: "https://example.com/a.png" }],
      },
    ]);

    expect(mockToProxied).toHaveBeenCalledWith("https://example.com/a.png");
    expect(profiles.example.sampleCount).toBe(1);
    expect(profiles.example.sourceName).toBe("example");
    expect(profiles.example.descriptor.meanLuma).toBeGreaterThanOrEqual(0);
  });

  it("skips candidates with no image and ignores failed descriptors", async () => {
    mockLoadImage.mockRejectedValue(new Error("nope"));

    const scores = await buildMpcVisualPreferenceScoreMap(
      [
        { identifier: "a", smallThumbnailUrl: "", mediumThumbnailUrl: "" },
        { identifier: "b", smallThumbnailUrl: "https://example.com/b.png" },
      ],
      {},
      { sourceWeights: {} }
    );

    expect(scores).toEqual({});
    expect(mockToProxied).toHaveBeenCalledWith("https://example.com/b.png");
  });

  it("builds score map entries for candidates with readable thumbnails", async () => {
    mockLoadImage.mockResolvedValue({
      close: vi.fn(),
    });
    vi.spyOn(document, "createElement").mockReturnValue({
      width: 0,
      height: 0,
      getContext: vi.fn(() => ({
        drawImage: vi.fn(),
        getImageData: vi.fn(() => ({
          data: new Uint8ClampedArray(32 * 32 * 4).fill(128),
        })),
      })),
    } as unknown as HTMLCanvasElement);

    const scores = await buildMpcVisualPreferenceScoreMap(
      [
        { identifier: "small", smallThumbnailUrl: "https://example.com/small.png", mediumThumbnailUrl: "https://example.com/medium.png" },
        { identifier: "medium", smallThumbnailUrl: "", mediumThumbnailUrl: "https://example.com/medium-only.png" },
      ],
      {
        source: {
          sourceName: "source",
          descriptor: { meanLuma: 128 / 255, variance: 0, edgeDensity: 0 },
          sampleCount: 1,
        },
      },
      { sourceWeights: { source: 1 } }
    );

    expect(scores.small).toBeCloseTo(10);
    expect(scores.medium).toBeCloseTo(10);
    expect(mockToProxied).toHaveBeenCalledWith("https://example.com/small.png");
    expect(mockToProxied).toHaveBeenCalledWith("https://example.com/medium-only.png");
    expect(mockToProxied).not.toHaveBeenCalledWith("https://example.com/medium.png");
  });

  it("returns null when a canvas context cannot be created", async () => {
    const bitmap = { close: vi.fn() };
    mockLoadImage.mockResolvedValue(bitmap);
    vi.spyOn(document, "createElement").mockReturnValue({
      width: 0,
      height: 0,
      getContext: vi.fn(() => null),
    } as unknown as HTMLCanvasElement);

    await expect(extractMpcImageDescriptor("https://example.com/no-context.png")).resolves.toBeNull();
    expect(bitmap.close).toHaveBeenCalled();
  });

  it("returns null when the image cannot be loaded", async () => {
    mockLoadImage.mockRejectedValue(new Error("bad image"));
    await expect(extractMpcImageDescriptor("https://example.com/c.png")).resolves.toBeNull();
  });
});
