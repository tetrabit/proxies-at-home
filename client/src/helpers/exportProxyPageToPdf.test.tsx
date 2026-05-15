import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CardOption } from "@/types";

const mocks = vi.hoisted(() => ({
  save: vi.fn(async () => new Uint8Array([1, 2, 3])),
  load: vi.fn(async () => ({ getPageIndices: () => [0] })),
  copyPages: vi.fn(async () => ["page"]),
  addPage: vi.fn(() => ({
    getWidth: () => 72,
    getHeight: () => 72,
    drawImage: vi.fn(),
  })),
  embedJpg: vi.fn(async () => "image"),
  getEffectCacheEntry: vi.fn(),
  hasActiveAdjustments: vi.fn(),
}));

vi.mock("pdf-lib", () => ({
  PDFDocument: {
    create: vi.fn(async () => ({
      save: mocks.save,
      copyPages: mocks.copyPages,
      addPage: mocks.addPage,
      embedJpg: mocks.embedJpg,
    })),
    load: mocks.load,
  },
}));
vi.mock("./effectCache", () => ({
  getEffectCacheEntry: mocks.getEffectCacheEntry,
}));
vi.mock("./adjustmentUtils", () => ({
  hasActiveAdjustments: mocks.hasActiveAdjustments,
}));
vi.mock("@/constants", () => ({ API_BASE: "http://api.test" }));

const baseSettings = {
  bleedEdge: false,
  bleedEdgeWidthMm: 0,
  sourceSettings: {},
  withBleedSourceAmount: 0,
  darkenMode: "none",
  dpi: 300,
  pageWidth: 1,
  pageHeight: 1,
  pageSizeUnit: "in" as const,
  columns: 1,
  rows: 1,
  cardSpacingMm: 0,
  cardPositionX: 0,
  cardPositionY: 0,
  guideColor: "#000",
  guideWidthCssPx: 1,
  cutLineStyle: "none",
  perCardGuideStyle: "none",
  guidePlacement: "none",
  cutGuideLengthMm: 0,
  registrationMarks: false,
  registrationMarksPortrait: false,
  rightAlignRows: false,
  darkenThreshold: 0,
  darkenContrast: 0,
  darkenEdgeWidth: 0,
  darkenAmount: 0,
  darkenBrightness: 0,
  darkenAutoDetect: false,
  useCustomBackOffset: false,
  cardBackPositionX: 0,
  cardBackPositionY: 0,
};

const testCard = (overrides: Partial<CardOption> = {}): CardOption => ({
  uuid: "card-1",
  name: "Card",
  order: 0,
  isUserUpload: false,
  ...overrides,
});

class MockWorker {
  static instances: MockWorker[] = [];
  onmessage: ((event: MessageEvent) => void | Promise<void>) | null = null;
  onerror: ((event: ErrorEvent) => void | Promise<void>) | null = null;
  terminate = vi.fn();
  postMessage = vi.fn((message) => {
    queueMicrotask(async () => {
      await this.onmessage?.({
        data: {
          type: "progress",
          pageIndex: message.pageIndex,
          imagesProcessed: message.pageCards.length,
        },
      } as MessageEvent);
      await this.onmessage?.({
        data: {
          type: "result",
          pageIndex: message.pageIndex,
          url: `blob:page-${message.pageIndex}`,
        },
      } as MessageEvent);
    });
  });
  constructor() {
    MockWorker.instances.push(this);
  }
}

describe("exportProxyPagesToPdf", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    MockWorker.instances = [];
    mocks.hasActiveAdjustments.mockReturnValue(false);
    mocks.getEffectCacheEntry.mockResolvedValue(undefined);
    vi.stubGlobal("Worker", MockWorker);
    vi.stubGlobal("navigator", { hardwareConcurrency: 1 });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ blob: async () => new Blob(["jpg"]) }))
    );
    vi.spyOn(Blob.prototype, "arrayBuffer").mockResolvedValue(
      new ArrayBuffer(3)
    );
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:pdf");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("returns an empty buffer for empty card lists when requested", async () => {
    const { exportProxyPagesToPdf } = await import("./exportProxyPageToPdf");
    await expect(
      exportProxyPagesToPdf({
        cards: [],
        imagesById: new Map(),
        pdfSettings: baseSettings,
        pagesPerPdf: 1,
        cancellationPromise: new Promise(() => undefined),
        returnBuffer: true,
      })
    ).resolves.toEqual(new Uint8Array());
  });

  it("returns undefined for empty card lists when no buffer is requested", async () => {
    const { exportProxyPagesToPdf } = await import("./exportProxyPageToPdf");
    const result = await exportProxyPagesToPdf({
      cards: [],
      imagesById: new Map(),
      pdfSettings: baseSettings,
      pagesPerPdf: 1,
      cancellationPromise: new Promise(() => undefined),
      returnBuffer: false,
    });
    expect(result).toBeUndefined();
  });

  it("honors maxPages zero with returnBuffer", async () => {
    const { exportProxyPagesToPdf } = await import("./exportProxyPageToPdf");
    const result = await exportProxyPagesToPdf({
      cards: [testCard({ uuid: "c1" })],
      imagesById: new Map(),
      pdfSettings: baseSettings,
      pagesPerPdf: 1,
      maxPages: 0,
      cancellationPromise: new Promise(() => undefined),
      returnBuffer: true,
    });
    expect(result).toEqual(new Uint8Array());
    expect(MockWorker.instances).toHaveLength(0);
  });

  it("renders worker pages, merges chunks, reports progress, and returns a buffer", async () => {
    const { exportProxyPagesToPdf } = await import("./exportProxyPageToPdf");
    const onProgress = vi.fn();
    const result = await exportProxyPagesToPdf({
      cards: [
        testCard({ uuid: "c1", name: "One" }),
        testCard({
          uuid: "c2",
          name: "Two",
          imageId: "img",
          overrides: { brightness: 1 },
        }),
      ],
      imagesById: new Map(),
      pdfSettings: {
        ...baseSettings,
        columns: 1,
        rows: 1,
        pageSizeUnit: "mm" as const,
      },
      onProgress,
      pagesPerPdf: 2,
      cancellationPromise: new Promise(() => undefined),
      returnBuffer: true,
    });

    expect(result).toEqual(new Uint8Array([1, 2, 3]));
    expect(MockWorker.instances.length).toBeGreaterThan(0);
    expect(onProgress).toHaveBeenCalledWith(50);
    expect(onProgress).toHaveBeenCalledWith(100);
    expect(global.fetch).toHaveBeenCalledWith("blob:page-0");
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:page-0");
  });

  it("downloads merged PDFs and includes filename suffixes", async () => {
    vi.useFakeTimers();
    const link = document.createElement("a");
    const click = vi.spyOn(link, "click").mockImplementation(() => undefined);
    vi.spyOn(document, "createElement").mockReturnValue(link);
    const { exportProxyPagesToPdf } = await import("./exportProxyPageToPdf");

    await exportProxyPagesToPdf({
      cards: [testCard({ uuid: "c1", name: "One" })],
      imagesById: new Map(),
      pdfSettings: baseSettings,
      pagesPerPdf: 0,
      cancellationPromise: new Promise(() => undefined),
      filenameSuffix: "_backs",
    });

    expect(click).toHaveBeenCalled();
    expect(link.download).toMatch(/^proxxies_\d{4}-\d{2}-\d{2}_backs\.pdf$/);
    vi.advanceTimersByTime(1000);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:pdf");
    vi.useRealTimers();
  });

  it("passes active effect-cache blobs to workers", async () => {
    mocks.hasActiveAdjustments.mockReturnValue(true);
    const cached = new Blob(["cached"]);
    mocks.getEffectCacheEntry.mockResolvedValue(cached);
    const { exportProxyPagesToPdf } = await import("./exportProxyPageToPdf");

    await exportProxyPagesToPdf({
      cards: [
        testCard({
          uuid: "c1",
          name: "One",
          imageId: "img",
          overrides: { brightness: 2 },
        }),
      ],
      imagesById: new Map(),
      pdfSettings: baseSettings,
      pagesPerPdf: 1,
      cancellationPromise: new Promise(() => undefined),
      returnBuffer: true,
    });

    const posted = MockWorker.instances[0].postMessage.mock.calls[0][0];
    expect(posted.settings.effectCacheById.get("c1")).toBe(cached);
  });

  it("skips empty effect-cache lookups and falls back when hardware concurrency is unavailable", async () => {
    vi.stubGlobal("navigator", { hardwareConcurrency: 0 });
    mocks.hasActiveAdjustments.mockReturnValue(true);
    mocks.getEffectCacheEntry.mockResolvedValue(undefined);
    const { exportProxyPagesToPdf } = await import("./exportProxyPageToPdf");

    await exportProxyPagesToPdf({
      cards: [
        testCard({
          uuid: "c1",
          name: "One",
          imageId: "img",
          overrides: { brightness: 2 },
        }),
      ],
      imagesById: new Map(),
      pdfSettings: baseSettings,
      pagesPerPdf: 1,
      cancellationPromise: new Promise(() => undefined),
      returnBuffer: true,
    });

    const posted = MockWorker.instances[0].postMessage.mock.calls[0][0];
    expect(posted.settings.effectCacheById.size).toBe(0);
  });

  it("wraps non-Error image assembly failures", async () => {
    const { exportProxyPagesToPdf } = await import("./exportProxyPageToPdf");
    vi.mocked(global.fetch).mockRejectedValueOnce("string failure");
    await expect(
      exportProxyPagesToPdf({
        cards: [testCard({ uuid: "c1", name: "One" })],
        imagesById: new Map(),
        pdfSettings: baseSettings,
        pagesPerPdf: 1,
        cancellationPromise: new Promise(() => undefined),
        returnBuffer: true,
      })
    ).rejects.toThrow("string failure");
  });

  it("rejects image assembly failures after revoking the failed page URL", async () => {
    const { exportProxyPagesToPdf } = await import("./exportProxyPageToPdf");
    vi.mocked(global.fetch).mockRejectedValueOnce(
      new Error("blob fetch failed")
    );
    await expect(
      exportProxyPagesToPdf({
        cards: [testCard({ uuid: "c1", name: "One" })],
        imagesById: new Map(),
        pdfSettings: baseSettings,
        pagesPerPdf: 1,
        cancellationPromise: new Promise(() => undefined),
        returnBuffer: true,
      })
    ).rejects.toThrow("blob fetch failed");
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:page-0");
  });

  it("ignores non-result worker messages and result messages without URLs", async () => {
    class NoisyWorker extends MockWorker {
      postMessage = vi.fn((message) => {
        queueMicrotask(async () => {
          await this.onmessage?.({
            data: { type: "noop", pageIndex: message.pageIndex },
          } as MessageEvent);
          await this.onmessage?.({
            data: { type: "result", pageIndex: message.pageIndex },
          } as MessageEvent);
          await this.onmessage?.({
            data: {
              type: "result",
              pageIndex: message.pageIndex,
              url: `blob:page-${message.pageIndex}`,
            },
          } as MessageEvent);
        });
      });
    }
    vi.stubGlobal("Worker", NoisyWorker);
    const { exportProxyPagesToPdf } = await import("./exportProxyPageToPdf");

    await expect(
      exportProxyPagesToPdf({
        cards: [testCard({ uuid: "c1", name: "One" })],
        imagesById: new Map(),
        pdfSettings: baseSettings,
        pagesPerPdf: 1,
        cancellationPromise: new Promise(() => undefined),
        returnBuffer: true,
      })
    ).resolves.toEqual(new Uint8Array([1, 2, 3]));
  });

  it("rejects native worker error events", async () => {
    const { exportProxyPagesToPdf } = await import("./exportProxyPageToPdf");
    class NativeErrorWorker extends MockWorker {
      postMessage = vi.fn(() =>
        queueMicrotask(() =>
          this.onerror?.(
            new Error("native worker failed") as unknown as ErrorEvent
          )
        )
      );
    }
    vi.stubGlobal("Worker", NativeErrorWorker);
    await expect(
      exportProxyPagesToPdf({
        cards: [testCard({ uuid: "c1", name: "One" })],
        imagesById: new Map(),
        pdfSettings: baseSettings,
        pagesPerPdf: 1,
        cancellationPromise: new Promise(() => undefined),
        returnBuffer: true,
      })
    ).rejects.toThrow("native worker failed");

    class EventWorker extends MockWorker {
      postMessage = vi.fn(() =>
        queueMicrotask(() => this.onerror?.({} as ErrorEvent))
      );
    }
    vi.stubGlobal("Worker", EventWorker);
    await expect(
      exportProxyPagesToPdf({
        cards: [testCard({ uuid: "c1", name: "One" })],
        imagesById: new Map(),
        pdfSettings: baseSettings,
        pagesPerPdf: 1,
        cancellationPromise: new Promise(() => undefined),
        returnBuffer: true,
      })
    ).rejects.toThrow("Worker error");
  });

  it("rejects cancellation and worker errors while cleaning up workers", async () => {
    const { exportProxyPagesToPdf } = await import("./exportProxyPageToPdf");
    await expect(
      exportProxyPagesToPdf({
        cards: [testCard({ uuid: "c1", name: "One" })],
        imagesById: new Map(),
        pdfSettings: baseSettings,
        pagesPerPdf: 1,
        cancellationPromise: Promise.resolve(),
        returnBuffer: true,
      })
    ).rejects.toThrow("Cancelled by user");

    class ErrorWorker extends MockWorker {
      postMessage = vi.fn((message) =>
        queueMicrotask(() =>
          this.onmessage?.({
            data: { error: "bad", pageIndex: message.pageIndex },
          } as MessageEvent)
        )
      );
    }
    vi.stubGlobal("Worker", ErrorWorker);
    await expect(
      exportProxyPagesToPdf({
        cards: [testCard({ uuid: "c1", name: "One" })],
        imagesById: new Map(),
        pdfSettings: baseSettings,
        pagesPerPdf: 1,
        cancellationPromise: new Promise(() => undefined),
        returnBuffer: true,
      })
    ).rejects.toThrow("Error from worker for page 1: bad");
  });
});
