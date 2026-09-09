import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildMpcSourceVisualProfiles,
  buildMpcVisualPreferenceScoreMap,
  extractMpcImageDescriptor,
  scoreMpcVisualSourcePreference,
} from "./mpcVisualPreference";
import type { MpcHarvestedSourceExample } from "./mpcPreferenceBootstrap";

const mockLoadImage = vi.hoisted(() => vi.fn());
const mockToProxied = vi.hoisted(() => vi.fn((url: string) => `proxied:${url}`));

const PROFILE_DECODE_CAP = 2;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function installDescriptorCanvas(value = 255) {
  vi.spyOn(document, "createElement").mockReturnValue({
    width: 0,
    height: 0,
    getContext: vi.fn(() => ({
      drawImage: vi.fn(),
      getImageData: vi.fn(() => ({
        data: new Uint8ClampedArray(32 * 32 * 4).fill(value),
      })),
    })),
  } as unknown as HTMLCanvasElement);
}

function profileExample(
  cardName: string,
  sourceName: string,
  imageUrl: string
): MpcHarvestedSourceExample {
  return {
    cardName,
    sourceName,
    candidates: [
      {
        identifier: `candidate-${cardName}`,
        name: cardName,
        rawName: cardName,
        dpi: 600,
        tags: [],
        sourceName,
        imageUrl,
      },
    ],
  };
}

function profileExamples(count: number): MpcHarvestedSourceExample[] {
  return Array.from({ length: count }, (_, index) =>
    profileExample(
      `Card ${index}`,
      "example",
      `https://example.com/${index}.png`
    )
  );
}

vi.mock("./imageProcessing", () => ({
  loadImage: mockLoadImage,
}));

vi.mock("./imageHelper", () => ({
  toProxied: mockToProxied,
}));

describe("mpcVisualPreference", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadImage.mockReset();
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
      profileExample("Example card", "example", "https://example.com/a.png"),
    ]);

    expect(mockToProxied).toHaveBeenCalledWith("https://example.com/a.png");
    expect(profiles.example.sampleCount).toBe(1);
    expect(profiles.example.sourceName).toBe("example");
    expect(profiles.example.descriptor.meanLuma).toBeGreaterThanOrEqual(0);
  });

  it("caps active profile decodes at two and admits queued work only after settlement", async () => {
    installDescriptorCanvas();
    const pending: Array<ReturnType<typeof deferred<ImageBitmap>>> = [];
    mockLoadImage.mockImplementation(() => {
      const next = deferred<ImageBitmap>();
      pending.push(next);
      return next.promise;
    });

    const build = buildMpcSourceVisualProfiles(profileExamples(5));
    await vi.waitFor(() =>
      expect(mockLoadImage).toHaveBeenCalledTimes(PROFILE_DECODE_CAP)
    );
    expect(pending).toHaveLength(PROFILE_DECODE_CAP);

    pending.shift()!.resolve({ close: vi.fn() } as unknown as ImageBitmap);
    await vi.waitFor(() => expect(mockLoadImage).toHaveBeenCalledTimes(3));

    while (pending.length > 0) {
      pending.shift()!.resolve({ close: vi.fn() } as unknown as ImageBitmap);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await vi.waitFor(() => expect(mockLoadImage).toHaveBeenCalledTimes(5));
    while (pending.length > 0) {
      pending.shift()!.resolve({ close: vi.fn() } as unknown as ImageBitmap);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    await expect(build).resolves.toMatchObject({
      example: { sourceName: "example", sampleCount: 5 },
    });
  });

  it("does not admit profile decodes for a pre-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      buildMpcSourceVisualProfiles(profileExamples(3), controller.signal)
    ).resolves.toEqual({});
    expect(mockLoadImage).not.toHaveBeenCalled();
  });

  it("waits for active profile decodes after abort without admitting queued work", async () => {
    installDescriptorCanvas();
    const controller = new AbortController();
    const pending: Array<ReturnType<typeof deferred<ImageBitmap>>> = [];
    mockLoadImage.mockImplementation(() => {
      const next = deferred<ImageBitmap>();
      pending.push(next);
      return next.promise;
    });

    let settled = false;
    const build = buildMpcSourceVisualProfiles(
      profileExamples(PROFILE_DECODE_CAP + 2),
      controller.signal
    ).then((profiles) => {
      settled = true;
      return profiles;
    });
    await vi.waitFor(() =>
      expect(mockLoadImage).toHaveBeenCalledTimes(PROFILE_DECODE_CAP)
    );
    expect(
      mockLoadImage.mock.calls.every(([, init]) => init?.signal === controller.signal)
    ).toBe(true);

    controller.abort();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(mockLoadImage).toHaveBeenCalledTimes(PROFILE_DECODE_CAP);

    pending.forEach((entry) =>
      entry.resolve({ close: vi.fn() } as unknown as ImageBitmap)
    );
    await expect(build).resolves.toEqual({});
    expect(mockLoadImage).toHaveBeenCalledTimes(PROFILE_DECODE_CAP);
  });

  it("releases a failed decode slot only after failure settlement", async () => {
    installDescriptorCanvas();
    const first = deferred<ImageBitmap>();
    const second = deferred<ImageBitmap>();
    const third = deferred<ImageBitmap>();
    mockLoadImage
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockReturnValueOnce(third.promise);

    const build = buildMpcSourceVisualProfiles(profileExamples(3));
    await vi.waitFor(() =>
      expect(mockLoadImage).toHaveBeenCalledTimes(PROFILE_DECODE_CAP)
    );
    first.reject(new Error("decode failed"));
    await vi.waitFor(() => expect(mockLoadImage).toHaveBeenCalledTimes(3));
    second.resolve({ close: vi.fn() } as unknown as ImageBitmap);
    third.resolve({ close: vi.fn() } as unknown as ImageBitmap);

    await expect(build).resolves.toMatchObject({
      example: { sampleCount: 2 },
    });
  });

  it("shares the two-decode cap across concurrent profile builds", async () => {
    installDescriptorCanvas();
    const pending: Array<ReturnType<typeof deferred<ImageBitmap>>> = [];
    mockLoadImage.mockImplementation(() => {
      const next = deferred<ImageBitmap>();
      pending.push(next);
      return next.promise;
    });

    const first = buildMpcSourceVisualProfiles(profileExamples(3));
    await vi.waitFor(() =>
      expect(mockLoadImage).toHaveBeenCalledTimes(PROFILE_DECODE_CAP)
    );
    const second = buildMpcSourceVisualProfiles(profileExamples(3));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mockLoadImage).toHaveBeenCalledTimes(PROFILE_DECODE_CAP);

    while (mockLoadImage.mock.calls.length < 6 || pending.length > 0) {
      const entry = pending.shift();
      if (entry) entry.resolve({ close: vi.fn() } as unknown as ImageBitmap);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ example: expect.objectContaining({ sampleCount: 3 }) }),
      expect.objectContaining({ example: expect.objectContaining({ sampleCount: 3 }) }),
    ]);
  });

  it("skips candidates with no image and ignores failed descriptors", async () => {
    mockLoadImage.mockRejectedValue(new Error("nope"));

    const scores = await buildMpcVisualPreferenceScoreMap(
      [
        { identifier: "a", smallThumbnailUrl: "", mediumThumbnailUrl: "" },
        {
          identifier: "b",
          smallThumbnailUrl: "https://example.com/b.png",
          mediumThumbnailUrl: "",
        },
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

  it("passes abort signals through descriptor image loading", async () => {
    const bitmap = { close: vi.fn() };
    mockLoadImage.mockResolvedValue(bitmap);
    vi.spyOn(document, "createElement").mockReturnValue({
      width: 0,
      height: 0,
      getContext: vi.fn(() => ({
        drawImage: vi.fn(),
        getImageData: vi.fn(() => ({
          data: new Uint8ClampedArray(32 * 32 * 4).fill(64),
        })),
      })),
    } as unknown as HTMLCanvasElement);

    const signal = new AbortController().signal;
    await expect(
      extractMpcImageDescriptor("https://example.com/signal.png", signal)
    ).resolves.toEqual(
      expect.objectContaining({
        meanLuma: expect.any(Number),
        variance: expect.any(Number),
        edgeDensity: expect.any(Number),
      })
    );

    expect(mockLoadImage).toHaveBeenCalledWith(
      "proxied:https://example.com/signal.png",
      { signal },
      1
    );
    expect(bitmap.close).toHaveBeenCalled();
  });

  it("skips empty profile images and failed profile descriptors", async () => {
    mockLoadImage.mockRejectedValue(new Error("no descriptor"));

    const profiles = await buildMpcSourceVisualProfiles([
      profileExample("Empty", "empty", ""),
      profileExample("Failed", "empty", "https://example.com/fail.png"),
    ]);

    expect(profiles).toEqual({});
    expect(mockToProxied).toHaveBeenCalledWith("https://example.com/fail.png");
  });

  it("returns zero when profile weights are missing or non-positive", () => {
    const descriptor = { meanLuma: 0.1, variance: 0.1, edgeDensity: 0.1 };

    expect(
      scoreMpcVisualSourcePreference(
        descriptor,
        {
          zero: { sourceName: "zero", descriptor, sampleCount: 1 },
          missing: { sourceName: "missing", descriptor, sampleCount: 1 },
        },
        { zero: 0 }
      )
    ).toBe(0);
  });

  it("returns null when the image cannot be loaded", async () => {
    mockLoadImage.mockRejectedValue(new Error("bad image"));
    await expect(extractMpcImageDescriptor("https://example.com/c.png")).resolves.toBeNull();
  });
});
