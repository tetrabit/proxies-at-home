import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const { effectCacheRecords } = vi.hoisted(() => ({
    effectCacheRecords: new Map<string, { key: string; blob: Blob; size: number; cachedAt: number }>(),
}));

vi.mock("../db", () => ({
    db: {
        effectCache: {
            put: vi.fn(async (entry: { key: string; blob: Blob; size: number; cachedAt: number }) => {
                effectCacheRecords.set(entry.key, entry);
            }),
            orderBy: vi.fn(() => ({
                reverse: () => ({
                    each: async (callback: (entry: { key: string; blob: Blob; size: number; cachedAt: number }) => void) => {
                        [...effectCacheRecords.values()]
                            .sort((left, right) => right.cachedAt - left.cachedAt)
                            .forEach(callback);
                    },
                }),
            })),
            bulkDelete: vi.fn(async (keys: string[]) => {
                keys.forEach(key => effectCacheRecords.delete(key));
            }),
        },
    },
}));

vi.mock("./cardCanvasWorker", () => ({
    hasAdvancedOverrides: vi.fn(() => false),
    overridesToRenderParams: () => ({}),
    renderCardWithOverridesWorker: vi.fn(),
}));

vi.mock("./debug", () => ({ debugLog: vi.fn() }));

import { db } from "../db";
import { hasAdvancedOverrides, renderCardWithOverridesWorker } from "./cardCanvasWorker";

class FakeCanvasContext {
    fillStyle = "";
    strokeStyle = "";
    lineWidth = 0;
    font = "";
    textAlign = "";
    imageSmoothingEnabled = false;
    imageSmoothingQuality: ImageSmoothingQuality = "low";

    private readonly owner: FakeOffscreenCanvas;

    constructor(owner: FakeOffscreenCanvas) {
        this.owner = owner;
    }

    save(): void {}
    restore(): void {}
    fillRect(): void {}
    strokeRect(): void {}
    fillText(): void {}
    beginPath(): void {}
    roundRect(): void {}
    stroke(): void {}
    moveTo(): void {}
    lineTo(): void {}
    setLineDash(): void {}
    arc(): void {}
    translate(): void {}
    rotate(): void {}

    drawImage(source: CanvasImageSource): void {
        if (this.owner.isPageCanvas && FakeOffscreenCanvas.failPageDraw) {
            throw new Error("drawing failed");
        }
        this.owner.drawnSources.push(source);
    }
}

class FakeOffscreenCanvas {
    static instances: FakeOffscreenCanvas[] = [];
    static failContextAt: number | undefined;
    static failPageDraw = false;

    readonly context = new FakeCanvasContext(this);
    readonly drawnSources: CanvasImageSource[] = [];
    readonly isPageCanvas: boolean;
    disposed = 0;
    private _width: number;
    private _height: number;

    constructor(width: number, height: number) {
        this._width = width;
        this._height = height;
        this.isPageCanvas = width === 10 && height === 10;
        FakeOffscreenCanvas.instances.push(this);
    }

    get width(): number {
        return this._width;
    }

    set width(value: number) {
        if (this._width > 0 && value === 0) this.disposed += 1;
        this._width = value;
    }

    get height(): number {
        return this._height;
    }

    set height(value: number) {
        this._height = value;
    }

    getContext(): FakeCanvasContext | null {
        if (FakeOffscreenCanvas.instances.indexOf(this) + 1 === FakeOffscreenCanvas.failContextAt) {
            return null;
        }
        return this.context;
    }

    async convertToBlob(): Promise<Blob> {
        return new Blob(["page"]);
    }
}

class FakeImageBitmap {
    closeCalls = 0;
    readonly width: number;
    readonly height: number;

    constructor(width: number, height: number) {
        this.width = width;
        this.height = height;
    }

    close(): void {
        this.closeCalls += 1;
    }
}

type WorkerHarness = {
    posts: unknown[];
    deliver(data: unknown): Promise<void>;
};

const sourceSettings = {
    withBleedTargetMode: "none" as const,
    withBleedTargetAmount: 0,
    noBleedTargetMode: "none" as const,
    noBleedTargetAmount: 0,
};

function settings(imagesById = new Map()): Record<string, unknown> {
    return {
        pageWidth: 10,
        pageHeight: 10,
        pageSizeUnit: "in",
        columns: 3,
        rows: 1,
        bleedEdge: false,
        bleedEdgeWidthMm: 0,
        cardSpacingMm: 0,
        cardPositionX: 0,
        cardPositionY: 0,
        guideColor: "black",
        guideWidthCssPx: 0,
        DPI: 1,
        imagesById,
        API_BASE: "",
        darkenMode: "none",
        cutLineStyle: "none",
        perCardGuideStyle: "none",
        guidePlacement: "outside",
        showGuideLinesOnBackCards: true,
        sourceSettings,
        withBleedSourceAmount: 0,
        rightAlignRows: false,
    };
}

function card(uuid: string, imageId: string): Record<string, unknown> {
    return { uuid, imageId, bleedMode: "none" };
}

async function loadWorker(): Promise<WorkerHarness> {
    const posts: unknown[] = [];
    const worker = {
        onmessage: undefined as ((event: MessageEvent) => Promise<void>) | undefined,
        postMessage: (message: unknown) => posts.push(message),
    };
    vi.stubGlobal("self", worker);
    await import("./pdf.worker");
    if (!worker.onmessage) throw new Error("worker message handler was not registered");

    return {
        posts,
        deliver: (data: unknown) => worker.onmessage!({ data } as MessageEvent),
    };
}

beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    effectCacheRecords.clear();
    vi.mocked(hasAdvancedOverrides).mockReset().mockReturnValue(false);
    vi.mocked(renderCardWithOverridesWorker).mockReset();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    FakeOffscreenCanvas.instances = [];
    FakeOffscreenCanvas.failContextAt = undefined;
    FakeOffscreenCanvas.failPageDraw = false;
    vi.stubGlobal("OffscreenCanvas", FakeOffscreenCanvas);
    vi.stubGlobal("ImageBitmap", FakeImageBitmap);
    vi.stubGlobal("URL", Object.assign(class extends URL {}, {
        createObjectURL: vi.fn(() => "blob:pdf-page"),
    }));
    vi.stubGlobal("createImageBitmap", vi.fn());
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe("PDF worker canvas lifecycle", () => {
    test("writes advanced PDF renders through the shared bounded effect-cache policy", async () => {
        const worker = await loadWorker();
        const threeGiB = 3 * 1024 * 1024 * 1024;
        const olderRendered = new Blob(["older rendered"], { type: "image/png" });
        const newerRendered = new Blob(["newer rendered"], { type: "image/png" });
        Object.defineProperty(olderRendered, "size", { value: threeGiB });
        Object.defineProperty(newerRendered, "size", { value: threeGiB });
        vi.mocked(hasAdvancedOverrides).mockReturnValue(true);
        vi.mocked(renderCardWithOverridesWorker)
            .mockResolvedValueOnce(olderRendered)
            .mockResolvedValueOnce(newerRendered);
        vi.stubGlobal("createImageBitmap", vi.fn(async () => new FakeImageBitmap(2, 3)));
        vi.spyOn(Date, "now")
            .mockReturnValueOnce(1)
            .mockReturnValueOnce(2);
        const imagesById = new Map([
            ["older", {
                exportBlob: new Blob(["source"], { type: "image/png" }),
                exportBleedWidth: 0,
                exportDpi: 1,
                generatedBleedMode: "none",
                generatedExistingBleedMm: 0,
                generatedHasBuiltInBleed: false,
                generatedRenderVersion: 1,
            }],
            ["newer", {
                exportBlob: new Blob(["source"], { type: "image/png" }),
                exportBleedWidth: 0,
                exportDpi: 1,
                generatedBleedMode: "none",
                generatedExistingBleedMm: 0,
                generatedHasBuiltInBleed: false,
                generatedRenderVersion: 1,
            }],
        ]);

        await worker.deliver({
            pageCards: [{ ...card("older-card", "older"), overrides: { brightness: 1 }}],
            pageIndex: 5,
            settings: settings(imagesById),
        });
        await vi.waitFor(() => expect(db.effectCache.put).toHaveBeenCalledTimes(1));
        await worker.deliver({
            pageCards: [{ ...card("newer-card", "newer"), overrides: { brightness: 1 }}],
            pageIndex: 6,
            settings: settings(imagesById),
        });

        await vi.waitFor(() => expect(db.effectCache.bulkDelete).toHaveBeenCalledWith([
            expect.stringMatching(/^older:1:/),
        ]));
        expect([...effectCacheRecords.values()]).toEqual([
            expect.objectContaining({ key: expect.stringMatching(/^newer:1:/), size: threeGiB }),
        ]);
    });

    test("reuses a cached placeholder canvas across worker messages without disposing it before drawing", async () => {
        const worker = await loadWorker();
        const payload = { pageCards: [card("first", "shared")], pageIndex: 0, settings: settings() };

        await worker.deliver(payload);
        const cachedSurface = FakeOffscreenCanvas.instances[1];
        expect(cachedSurface).toMatchObject({ width: 2, height: 3, disposed: 0 });

        await worker.deliver({ ...payload, pageIndex: 1, pageCards: [card("second", "shared")] });

        expect(cachedSurface).toMatchObject({ width: 2, height: 3, disposed: 0 });
        expect(FakeOffscreenCanvas.instances[2].drawnSources).toContain(cachedSurface);
        expect(worker.posts).toContainEqual({ type: "result", url: "blob:pdf-page", pageIndex: 1 });
    });

    test("waits for pending preparation before reporting a sibling preparation failure and closes its transient bitmap", async () => {
        const slowBlob = new Blob(["slow"]);
        let resolveSlowBitmap: ((bitmap: FakeImageBitmap) => void) | undefined;
        const slowBitmap = new FakeImageBitmap(2, 3);
        vi.stubGlobal("createImageBitmap", vi.fn(() => new Promise<FakeImageBitmap>((resolve) => {
            resolveSlowBitmap = resolve;
        })));
        FakeOffscreenCanvas.failContextAt = 3;
        const worker = await loadWorker();
        const imagesById = new Map([
            ["slow", {
                exportBlob: slowBlob,
                exportBleedWidth: 0,
                exportDpi: 1,
                generatedBleedMode: "none",
                generatedExistingBleedMm: 0,
                generatedHasBuiltInBleed: false,
                generatedRenderVersion: 1,
            }],
        ]);

        const run = worker.deliver({
            pageCards: [card("cached", "cached"), card("slow", "slow"), card("broken", "broken")],
            pageIndex: 2,
            settings: settings(imagesById),
        });
        await vi.waitFor(() => expect(resolveSlowBitmap).toBeTypeOf("function"));

        let completed = false;
        void run.then(() => { completed = true; });
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        expect(completed).toBe(false);

        resolveSlowBitmap!(slowBitmap);
        await run;

        expect(slowBitmap.closeCalls).toBe(1);
        expect(FakeOffscreenCanvas.instances[1]).toMatchObject({ width: 2, height: 3, disposed: 0 });
        expect(worker.posts).toContainEqual(expect.objectContaining({
            error: expect.stringContaining("Failed to get 2d context for placeholder canvas"),
            pageIndex: 2,
        }));
    });

    test("releases a cached surface after a page drawing failure without zeroing it before the failed draw", async () => {
        const worker = await loadWorker();
        const payload = { pageCards: [card("first", "draw-shared")], pageIndex: 3, settings: settings() };
        await worker.deliver(payload);
        const cachedSurface = FakeOffscreenCanvas.instances[1];

        FakeOffscreenCanvas.failPageDraw = true;
        await worker.deliver({ ...payload, pageIndex: 4, pageCards: [card("second", "draw-shared")] });

        expect(cachedSurface).toMatchObject({ width: 2, height: 3, disposed: 0 });
        expect(worker.posts).toContainEqual(expect.objectContaining({
            error: "drawing failed",
            pageIndex: 4,
        }));
    });
});
