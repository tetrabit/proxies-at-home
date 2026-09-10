import { vi, describe, beforeEach, afterEach, it, expect, type Mock } from 'vitest';
import request from "supertest";
import express, { type Express, type Response } from "express";
import fs from "fs";
import nodeCrypto from "crypto";
import axios from "axios";
import { Readable, Writable } from "stream";

const routeMocks = vi.hoisted(() => ({
    batchFetchCards: vi.fn(),
    getCardDataForCardInfo: vi.fn(),
    fetchCardsForTokenLookup: vi.fn(),
    resolveLatestTokenParts: vi.fn(),
    extractTokenParts: vi.fn(),
}));

vi.mock("../utils/getCardImagesPaged.js", () => ({
    batchFetchCards: routeMocks.batchFetchCards,
    getCardDataForCardInfo: routeMocks.getCardDataForCardInfo,
}));

vi.mock("../utils/tokenLookup.js", () => ({
    fetchCardsForTokenLookup: routeMocks.fetchCardsForTokenLookup,
    resolveLatestTokenParts: routeMocks.resolveLatestTokenParts,
}));

vi.mock("../utils/tokenUtils.js", () => ({
    extractTokenParts: routeMocks.extractTokenParts,
}));
import { imageRouter, __imageRouterTestInternals } from "./imageRouter";

vi.mock("axios", () => {
    const mockGet = vi.fn();
    const mockInstance = { get: mockGet };
    const mockCreate = vi.fn(() => mockInstance);
    return {
        create: mockCreate,
        get: mockGet,
        default: {
            create: mockCreate,
            get: mockGet,
        },
    };
});

vi.mock("fs", () => {
    const mockedPromises = {
        readdir: vi.fn(),
        stat: vi.fn(),
        utimes: vi.fn().mockResolvedValue(undefined),
        unlink: vi.fn().mockResolvedValue(undefined),
        rename: vi.fn().mockResolvedValue(undefined),
        writeFile: vi.fn().mockResolvedValue(undefined),
    };

    const mocked = {
        // imageRouter resolves cardbacks at module initialization, before each test
        // configures this fixture. Present one PNG so that fixture setup is silent.
        existsSync: vi.fn(() => true),
        createWriteStream: vi.fn(),
        mkdirSync: vi.fn(),
        writeFileSync: vi.fn(),
        readdir: vi.fn(),
        unlink: vi.fn(),
        readdirSync: vi.fn(() => ["mtg.png"]),
        statSync: vi.fn(),
        unlinkSync: vi.fn(),
        utimesSync: vi.fn(),
        promises: mockedPromises,
    };
    return { ...mocked, default: mocked };
});


vi.mock("fs/promises", () => {
    const mocked = {
        stat: vi.fn(),
        utimes: vi.fn(),
        unlink: vi.fn(),
    };
    return { ...mocked, default: mocked };
});

vi.mock("crypto", () => {
    const mockHash = {
        update: vi.fn().mockReturnThis(),
        digest: vi.fn().mockReturnValue("fake-hash"),
    };
    const mocked = {
        createHash: vi.fn(() => mockHash),
        randomUUID: vi.fn(() => "test-request-uuid"),
    };
    return { ...mocked, default: mocked };
});

// Access the mocked instance's get method
const mockedAxiosInstance = axios.create() as unknown as { get: Mock };
const mockedAxios = {
    get: mockedAxiosInstance.get,
    create: axios.create as Mock,
};

const imageStream = (value: string | Buffer) => Readable.from([Buffer.from(value)]);

describe("getWithRetry logic", () => {
    let app: Express;

    const imageUrl = "https://cards.scryfall.io/normal/front/a/b/ab123456-1234-1234-1234-123456789abc.jpg";

    beforeEach(() => {
        vi.clearAllMocks();
        routeMocks.batchFetchCards.mockResolvedValue(new Map());
        routeMocks.getCardDataForCardInfo.mockResolvedValue(null);
        routeMocks.fetchCardsForTokenLookup.mockResolvedValue({ cards: new Map() });
        routeMocks.resolveLatestTokenParts.mockResolvedValue([]);
        routeMocks.extractTokenParts.mockReturnValue([]);
        mockedAxios.create.mockClear();
        mockedAxios.get.mockReset();
        // Default mock implementation for fs.existsSync to avoid "not found" errors in general flow
        (fs.existsSync as unknown as Mock).mockReturnValue(false);
        (fs.readdir as unknown as Mock).mockImplementation((_path, cb) => cb(null, ["file1.png", "file2.png"]));
        (fs.unlink as unknown as Mock).mockImplementation((_path, cb) => cb(null));
        (fs.readdirSync as unknown as Mock).mockReturnValue([]);
        (fs.promises.readdir as unknown as Mock).mockResolvedValue([]);
        (fs.promises.stat as unknown as Mock).mockReset();
        (fs.promises.unlink as unknown as Mock).mockReset().mockResolvedValue(undefined);
        (fs.promises.utimes as unknown as Mock).mockResolvedValue(undefined);
        (fs.promises.writeFile as unknown as Mock).mockResolvedValue(undefined);
        __imageRouterTestInternals.writeInProgress.clear();
        __imageRouterTestInternals.resetCacheCleanupForTests();


        app = express();
        app.use(express.json());
        app.set("etag", false);
        app.use("/images", imageRouter);

        (fs.createWriteStream as unknown as Mock).mockImplementation(() => new Writable({
            write(_chunk, _encoding, callback) {
                callback();
            },
        }));
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it("should serve from cache if file exists", async () => {
        (fs.existsSync as unknown as Mock).mockReturnValue(true);
        const sendFileSpy = vi.spyOn(express.response, "sendFile").mockImplementation(function (this: Response) {
            this.type("image/jpeg").send("cached image data");
        });

        const res = await request(app).get(`/images/proxy?url=${encodeURIComponent(imageUrl)}`);
        expect(res.status).toBe(200);
        expect(res.body.toString()).toBe("cached image data");
        expect(fs.promises.utimes).toHaveBeenCalled();
        sendFileSpy.mockRestore();
    });

    it("should succeed on the first try", async () => {
        mockedAxios.get.mockResolvedValue({
            status: 200,
            data: imageStream("image data"),
            headers: { "content-type": "image/jpeg" },
        });

        const sendFileSpy = vi.spyOn(express.response, "sendFile").mockImplementation(function (this: Response) {
            this.type("image/jpeg").send("image data");
        });

        const res = await request(app).get(`/images/proxy?url=${encodeURIComponent(imageUrl)}`);
        expect(res.status).toBe(200);
        expect(res.headers["content-type"]).toContain("image/jpeg");
        sendFileSpy.mockRestore();
    });

    it("covers status validation and queued proxy limiter behavior", async () => {
        expect(__imageRouterTestInternals.acceptsSurfaceableStatus(200)).toBe(true);
        expect(__imageRouterTestInternals.acceptsSurfaceableStatus(499)).toBe(true);
        expect(__imageRouterTestInternals.acceptsSurfaceableStatus(199)).toBe(false);
        expect(__imageRouterTestInternals.acceptsSurfaceableStatus(500)).toBe(false);

        const limit = __imageRouterTestInternals.pLimit(1);
        let releaseFirst!: () => void;
        const first = limit(() => new Promise<string>(resolve => {
            releaseFirst = () => resolve("first");
        }));
        const second = limit(() => Promise.resolve("second"));

        await Promise.resolve();
        releaseFirst();
        await expect(Promise.all([first, second])).resolves.toEqual(["first", "second"]);
        await expect(limit(() => Promise.reject(new Error("limited failure")))).rejects.toThrow("limited failure");
    });

    it("cleans oversized image cache directories and tolerates cleanup races", async () => {
        const gib = 1024 * 1024 * 1024;
        const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
        const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
        const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
        vi.spyOn(Date, "now").mockReturnValue(10 * 60 * 1000);

        (fs.promises.readdir as unknown as Mock).mockResolvedValueOnce(["dir", "gone.png", "old.png", "new.png"]);
        (fs.promises.stat as unknown as Mock).mockImplementation(async (filePath: string) => {
            if (String(filePath).endsWith("dir")) return { isFile: () => false, atimeMs: 0, size: 0 };
            if (String(filePath).endsWith("gone.png")) throw new Error("gone");
            if (String(filePath).endsWith("old.png")) return { isFile: () => true, atimeMs: 1, size: 7 * gib };
            return { isFile: () => true, atimeMs: 2, size: 6 * gib };
        });
        (fs.promises.unlink as unknown as Mock)
            .mockRejectedValueOnce(new Error("unlink failed"))
            .mockResolvedValueOnce(undefined);

        await __imageRouterTestInternals.checkAndCleanCache();

        expect(fs.promises.unlink).toHaveBeenCalledTimes(2);
        expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining("[CACHE] Failed to delete"), "unlink failed");

        await __imageRouterTestInternals.checkAndCleanCache();
        expect(fs.promises.readdir).toHaveBeenCalledTimes(1);

        __imageRouterTestInternals.resetCacheCleanupForTests();
        (fs.promises.readdir as unknown as Mock).mockResolvedValueOnce(["small.png"]);
        (fs.promises.stat as unknown as Mock).mockResolvedValueOnce({ isFile: () => true, atimeMs: 3, size: 1 });
        await __imageRouterTestInternals.checkAndCleanCache();
        expect(fs.promises.readdir).toHaveBeenCalledTimes(2);

        __imageRouterTestInternals.resetCacheCleanupForTests();
        (fs.promises.readdir as unknown as Mock).mockResolvedValueOnce(["old.png", "new.png"]);
        (fs.promises.stat as unknown as Mock)
            .mockResolvedValueOnce({ isFile: () => true, atimeMs: 1, size: 4 * gib })
            .mockResolvedValueOnce({ isFile: () => true, atimeMs: 2, size: 9 * gib });
        (fs.promises.unlink as unknown as Mock).mockResolvedValueOnce(undefined);
        await __imageRouterTestInternals.checkAndCleanCache();
        expect(fs.promises.unlink).toHaveBeenCalledTimes(3);

        __imageRouterTestInternals.resetCacheCleanupForTests();
        (fs.promises.readdir as unknown as Mock).mockResolvedValueOnce(["plain-error.png"]);
        (fs.promises.stat as unknown as Mock).mockResolvedValueOnce({ isFile: () => true, atimeMs: 1, size: 13 * gib });
        (fs.promises.unlink as unknown as Mock).mockRejectedValueOnce("plain unlink failure");
        await __imageRouterTestInternals.checkAndCleanCache();
        expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining("[CACHE] Failed to delete"), "plain unlink failure");

        __imageRouterTestInternals.resetCacheCleanupForTests();
        (fs.promises.readdir as unknown as Mock).mockRejectedValueOnce(new Error("readdir failed"));
        await __imageRouterTestInternals.checkAndCleanCache();
        expect(consoleErrorSpy).toHaveBeenCalledWith("[CACHE] Cleanup error:", "readdir failed");

        __imageRouterTestInternals.resetCacheCleanupForTests();
        (fs.promises.readdir as unknown as Mock).mockRejectedValueOnce("plain readdir failure");
        await __imageRouterTestInternals.checkAndCleanCache();
        expect(consoleErrorSpy).toHaveBeenCalledWith("[CACHE] Cleanup error:", "plain readdir failure");

        consoleLogSpy.mockRestore();
        consoleWarnSpy.mockRestore();
        consoleErrorSpy.mockRestore();
    });

    it("should retry on 429 and then succeed", async () => {
        mockedAxios.get
            .mockResolvedValueOnce({ status: 429, headers: { "retry-after": "0" } }) // Use 0 to speed up test
            .mockResolvedValueOnce({
                status: 200,
                data: imageStream("image data"),
                headers: { "content-type": "image/jpeg" },
            });

        const sendFileSpy = vi.spyOn(express.response, "sendFile").mockImplementation(function (this: Response) {
            this.type("image/jpeg").send("image data");
        });

        const res = await request(app).get(`/images/proxy?url=${encodeURIComponent(imageUrl)}`);
        expect(res.status).toBe(200);
        expect(mockedAxios.get).toHaveBeenCalledTimes(2);
        sendFileSpy.mockRestore();
    }, 10000);

    it("uses the default retry-after delay when 429 omits the header", async () => {
        vi.useFakeTimers();
        mockedAxios.get
            .mockResolvedValueOnce({ status: 429, headers: {} })
            .mockResolvedValueOnce({
                status: 200,
                data: imageStream("image data"),
                headers: { "content-type": "image/png" },
            });

        const responsePromise = __imageRouterTestInternals.getWithRetry("http://example.com/rate-limited.png");
        await vi.advanceTimersByTimeAsync(5_000);
        await expect(responsePromise).resolves.toMatchObject({ status: 200 });
        expect(mockedAxios.get).toHaveBeenCalledTimes(2);
    });

    it("should retry on generic error and then succeed", async () => {
        mockedAxios.get
            .mockRejectedValueOnce(new Error("Network Error"))
            .mockResolvedValueOnce({
                status: 200,
                data: imageStream("image data"),
                headers: { "content-type": "image/jpeg" },
            });

        const sendFileSpy = vi.spyOn(express.response, "sendFile").mockImplementation(function (this: Response) {
            this.type("image/jpeg").send("image data");
        });

        const res = await request(app).get(`/images/proxy?url=${encodeURIComponent(imageUrl)}`);
        expect(res.status).toBe(200);
        expect(mockedAxios.get).toHaveBeenCalledTimes(2);
        sendFileSpy.mockRestore();
    }, 60000);

    it("should fail after all retries", async () => {
        mockedAxios.get.mockRejectedValue(new Error("Network Error"));

        const res = await request(app).get(`/images/proxy?url=${encodeURIComponent(imageUrl)}`);
        expect(res.status).toBe(502);
        expect(mockedAxios.get).toHaveBeenCalledTimes(2); // tries=2 means 2 total attempts
    }, 10000);

    it("should return an error for a 0-byte image and not cache it", async () => {
        mockedAxios.get.mockResolvedValue({
            status: 200,
            data: imageStream(""),
            headers: { "content-type": "image/jpeg" },
        });

        const res = await request(app).get(`/images/proxy?url=${encodeURIComponent(imageUrl)}`);
        expect(res.status).toBe(502);
        expect(res.body.error).toBe("Upstream is a 0-byte image");
        expect(fs.writeFileSync).not.toHaveBeenCalled();
    });

    it("returns upstream errors when the proxy response has no data", async () => {
        mockedAxios.get.mockResolvedValue({
            status: 200,
            data: undefined,
            headers: { "content-type": "image/jpeg" },
        });

        const res = await request(app).get(`/images/proxy?url=${encodeURIComponent("https://cards.scryfall.io/normal/front/c/d/cd123456-1234-1234-1234-123456789abc.jpg")}`);
        expect(res.status).toBe(502);
        expect(res.body).toEqual({ error: "Upstream error", status: 200 });
    });

    it("serves a proxy request after an in-progress write finishes", async () => {
        const url = "https://cards.scryfall.io/normal/front/e/f/ef123456-1234-1234-1234-123456789abc.jpg";
        const localPath = __imageRouterTestInternals.cachePathFromUrl(url);
        __imageRouterTestInternals.writeInProgress.add(localPath);
        let localPathChecks = 0;
        (fs.existsSync as unknown as Mock).mockImplementation((filePath: string) => {
            if (filePath === localPath) {
                localPathChecks++;
                return localPathChecks >= 2;
            }
            return false;
        });
        const sendFileSpy = vi.spyOn(express.response, "sendFile").mockImplementation(function (this: Response) {
            this.type("image/jpeg").send("in-progress cached image");
        });

        const responsePromise = request(app).get("/images/proxy").query({ url });
        await new Promise(resolve => setTimeout(resolve, 150));
        const res = await responsePromise;

        expect(res.status).toBe(200);
        expect(sendFileSpy).toHaveBeenCalledWith(localPath);
        sendFileSpy.mockRestore();
    });



    it("serves subsequent proxy requests from the in-memory path cache", async () => {
        (fs.existsSync as unknown as Mock).mockReturnValue(true);
        const sendFileSpy = vi.spyOn(express.response, "sendFile").mockImplementation(function (this: Response) {
            this.type("image/jpeg").send("cached image data");
        });

        const url = "https://cards.scryfall.io/normal/front/0/1/01234567-1234-1234-1234-123456789abc.jpg";
        await request(app).get(`/images/proxy?url=${encodeURIComponent(url)}`);
        const res = await request(app).get(`/images/proxy?url=${encodeURIComponent(url)}`);

        expect(res.status).toBe(200);
        expect(sendFileSpy).toHaveBeenCalledTimes(2);
        sendFileSpy.mockRestore();
    });

    it("rejects invalid proxy targets before cache or transport and sends admitted targets to transport", async () => {
        const invalidTargets = [
            "/relative.png",
            "https://cards.scryfall.io.evil.example/png/front/a/b/ab123456-1234-1234-1234-123456789abc.png",
            "https://user@cards.scryfall.io/png/front/a/b/ab123456-1234-1234-1234-123456789abc.png",
            "https://cards.scryfall.io:444/png/front/a/b/ab123456-1234-1234-1234-123456789abc.png",
            "https://drive.google.com/thumbnail?id=one&id=two&sz=w400-h400",
            "https%253A%252F%252Fcards.scryfall.io%252Fpng%252Ffront%252Fa%252Fb%252Fab123456-1234-1234-1234-123456789abc.png",
        ];
        for (const target of invalidTargets) {
            const response = await request(app).get("/images/proxy").query({ url: target });
            expect(response.status).toBe(400);
        }
        expect(mockedAxios.get).not.toHaveBeenCalled();
        expect(nodeCrypto.createHash).not.toHaveBeenCalled();
        expect(fs.existsSync).not.toHaveBeenCalled();

        const target = "https://cards.scryfall.io/png/front/a/b/ab123456-1234-1234-1234-123456789abc.png?1562820261";
        mockedAxios.get.mockResolvedValue({
            status: 200,
            data: imageStream("image data"),
            headers: { "content-type": "image/png" },
        });
        const sendFileSpy = vi.spyOn(express.response, "sendFile").mockImplementation(function (this: Response) {
            this.type("image/png").send("image data");
        });

        const accepted = await request(app).get("/images/proxy").query({ url: target });
        expect(accepted.status).toBe(200);
        expect(mockedAxios.get).toHaveBeenCalledWith(target, expect.any(Object));
        sendFileSpy.mockRestore();
    });

    it("binds proxy requests to a fresh pinned agent instead of an unvalidated client lookup", async () => {
        const resolveAll = vi.fn((_hostname: string, _options: { all: true; verbatim: true }, callback: (error: NodeJS.ErrnoException | null, addresses: Array<{ address: string; family: number }>) => void) => {
            callback(null, [{ address: "8.8.8.8", family: 4 }]);
        });
        __imageRouterTestInternals.setImageResolveAllForTests(resolveAll);
        mockedAxios.get.mockResolvedValue({
            status: 200,
            data: imageStream("image data"),
            headers: { "content-type": "image/png" },
        });
        const sendFileSpy = vi.spyOn(express.response, "sendFile").mockImplementation(function (this: Response) {
            this.type("image/png").send("image data");
        });

        const url = "https://cards.scryfall.io/png/front/a/b/ab123456-1234-1234-1234-123456789abc.png";
        const response = await request(app).get("/images/proxy").query({ url });
        const options = mockedAxios.get.mock.calls[0][1] as {
            httpsAgent: { options: { lookup: (hostname: string, options: unknown, callback: (error: NodeJS.ErrnoException | null, address?: string, family?: number) => void) => void } };
            maxRedirects: number;
            proxy: boolean;
        };

        await expect(new Promise<{ address: string; family: number }>((resolve, reject) => {
            options.httpsAgent.options.lookup("cards.scryfall.io", {}, (error, address, family) => {
                if (error || !address || !family) {
                    reject(error ?? new Error("agent did not pin an address"));
                    return;
                }
                resolve({ address, family });
            });
        })).resolves.toEqual({ address: "8.8.8.8", family: 4 });
        expect(response.status).toBe(200);
        expect(options).toMatchObject({ maxRedirects: 0, proxy: false });
        expect(resolveAll).toHaveBeenCalledWith("cards.scryfall.io", { all: true, verbatim: true }, expect.any(Function));
        sendFileSpy.mockRestore();
    });

    it("follows admitted same-origin proxy redirects with a fresh pinned agent and blocks an unadmitted destination", async () => {
        const resolveAll = vi.fn((_hostname: string, _options: { all: true; verbatim: true }, callback: (error: NodeJS.ErrnoException | null, addresses: Array<{ address: string; family: number }>) => void) => {
            callback(null, [{ address: "8.8.8.8", family: 4 }]);
        });
        __imageRouterTestInternals.setImageResolveAllForTests(resolveAll);
        const initial = "https://cards.scryfall.io/png/front/a/b/ab123456-1234-1234-1234-123456789abc.png";
        const redirected = "https://cards.scryfall.io/png/front/b/a/ba123456-1234-1234-1234-123456789abc.png";
        mockedAxios.get
            .mockResolvedValueOnce({ status: 302, data: Buffer.alloc(0), headers: { location: "/png/front/b/a/ba123456-1234-1234-1234-123456789abc.png" } })
            .mockResolvedValueOnce({ status: 200, data: imageStream("image data"), headers: { "content-type": "image/png" } });
        const sendFileSpy = vi.spyOn(express.response, "sendFile").mockImplementation(function (this: Response) {
            this.type("image/png").send("image data");
        });

        const accepted = await request(app).get("/images/proxy").query({ url: initial });
        expect(accepted.status).toBe(200);
        expect(mockedAxios.get).toHaveBeenNthCalledWith(1, initial, expect.objectContaining({ maxRedirects: 0, proxy: false }));
        expect(mockedAxios.get).toHaveBeenNthCalledWith(2, redirected, expect.objectContaining({ maxRedirects: 0, proxy: false }));
        const firstOptions = mockedAxios.get.mock.calls[0][1] as { httpsAgent: { options: { lookup: (hostname: string, options: unknown, callback: (error: NodeJS.ErrnoException | null, address?: string, family?: number) => void) => void } } };
        const secondOptions = mockedAxios.get.mock.calls[1][1] as typeof firstOptions;
        expect(firstOptions.httpsAgent).not.toBe(secondOptions.httpsAgent);
        await Promise.all([firstOptions, secondOptions].map(options => new Promise<void>((resolve, reject) => {
            options.httpsAgent.options.lookup("cards.scryfall.io", {}, error => error ? reject(error) : resolve());
        })));
        expect(resolveAll).toHaveBeenCalledTimes(2);
        sendFileSpy.mockRestore();

        mockedAxios.get.mockReset().mockResolvedValue({
            status: 302,
            data: Buffer.alloc(0),
            headers: { location: "https://evil.example/image.png" },
        });
        const denied = await request(app).get("/images/proxy").query({ url: initial });
        expect(denied.status).toBe(502);
        expect(mockedAxios.get).toHaveBeenCalledTimes(1);
    });

    it("uses thumbnail MPC CDN candidates and full-size large fallback cache path", async () => {
        mockedAxios.get.mockResolvedValue({ status: 200, headers: { "content-type": "image/png" }, data: imageStream("png") });
        const sendFileSpy = vi.spyOn(express.response, "sendFile").mockImplementation(function (this: Response) {
            this.type("image/png").send("cached image data");
        });

        const thumb = await request(app).get("/images/mpc?id=thumb-id&size=small");
        expect(thumb.status).toBe(200);
        expect(mockedAxios.get).toHaveBeenCalledWith("https://img.mpcautofill.com/thumb-id-small-google_drive", expect.any(Object));

        mockedAxios.get
            .mockResolvedValueOnce({ headers: { "content-type": "text/html" }, data: imageStream("html") })
            .mockResolvedValueOnce({ headers: { "content-type": "text/html" }, data: imageStream("html") })
            .mockResolvedValueOnce({ headers: { "content-type": "text/html" }, data: imageStream("html") })
            .mockResolvedValueOnce({ headers: { "content-type": "image/jpeg" }, data: imageStream("jpg") });
        const full = await request(app).get("/images/mpc?id=fallback-id&size=full");
        expect(full.status).toBe(200);
        expect(fs.promises.rename).toHaveBeenLastCalledWith(expect.stringContaining("gdrive_fallback-id_large"), expect.stringContaining("gdrive_fallback-id_large"));
        sendFileSpy.mockRestore();
    });

    it("serves cardbacks and covers cardback validation branches", async () => {
        const sendFileSpy = vi.spyOn(express.response, "sendFile").mockImplementation(function (this: Response) {
            this.type("image/png").send("cardback");
        });

        (fs.existsSync as unknown as Mock).mockReturnValue(true);

        const missing = await request(app).get("/images/cardback/");
        expect(missing.status).toBe(404);

        const unknown = await request(app).get("/images/cardback/not-a-cardback");
        expect(unknown.status).toBe(404);

        const found = await request(app).get("/images/cardback/mtg");
        expect(found.status).toBe(200);
        expect(sendFileSpy).toHaveBeenCalled();

        sendFileSpy.mockRestore();
    });

    describe("GET /mpc (MPC Google Drive Proxy)", () => {
        it("should return 400 if id is missing", async () => {
            const res = await request(app).get("/images/mpc");
            expect(res.status).toBe(400);
        });

        it("rejects invalid MPC identifiers and sizes before cache or transport", async () => {
            for (const query of [
                { id: "bad/id", size: "full" },
                { id: "Drive_ID-123", size: "unrecognized" },
            ]) {
                const response = await request(app).get("/images/mpc").query(query);
                expect(response.status).toBe(400);
            }
            const duplicateId = await request(app).get("/images/mpc?id=Drive_ID-123&id=second&size=full");
            expect(duplicateId.status).toBe(400);
            expect(mockedAxios.get).not.toHaveBeenCalled();
            expect(fs.existsSync).not.toHaveBeenCalled();
        });

        it("follows only same-origin MPC redirects with a fresh pinned agent", async () => {
            const resolveAll = vi.fn((_hostname: string, _options: { all: true; verbatim: true }, callback: (error: NodeJS.ErrnoException | null, addresses: Array<{ address: string; family: number }>) => void) => {
                callback(null, [{ address: "1.1.1.1", family: 4 }]);
            });
            __imageRouterTestInternals.setImageResolveAllForTests(resolveAll);
            mockedAxios.get
                .mockResolvedValueOnce({ status: 308, data: Buffer.alloc(0), headers: { location: "/redirect-next-small-google_drive" } })
                .mockResolvedValueOnce({ status: 200, data: imageStream("png"), headers: { "content-type": "image/png" } });
            const sendFileSpy = vi.spyOn(express.response, "sendFile").mockImplementation(function (this: Response) {
                this.type("image/png").send("png");
            });

            const accepted = await request(app).get("/images/mpc?id=redirected&size=small");
            expect(accepted.status).toBe(200);
            expect(mockedAxios.get).toHaveBeenNthCalledWith(1, "https://img.mpcautofill.com/redirected-small-google_drive", expect.objectContaining({ maxRedirects: 0, proxy: false }));
            expect(mockedAxios.get).toHaveBeenNthCalledWith(2, "https://img.mpcautofill.com/redirect-next-small-google_drive", expect.objectContaining({ maxRedirects: 0, proxy: false }));
            const firstOptions = mockedAxios.get.mock.calls[0][1] as { httpsAgent: unknown };
            const secondOptions = mockedAxios.get.mock.calls[1][1] as typeof firstOptions;
            expect(firstOptions.httpsAgent).not.toBe(secondOptions.httpsAgent);
            sendFileSpy.mockRestore();

            mockedAxios.get.mockReset().mockResolvedValue({
                status: 302,
                data: Buffer.alloc(0),
                headers: { location: "https://drive.google.com/uc?export=download&id=redirected" },
            });
            const denied = await request(app).get("/images/mpc?id=redirected&size=small");
            expect(denied.status).toBe(502);
            expect(mockedAxios.get).toHaveBeenCalledTimes(1);
        });

        it("should proxy image from Google Drive", async () => {
            mockedAxios.get.mockResolvedValue({
                status: 200,
                headers: { "content-type": "image/jpeg" },
                data: imageStream("fake image data"),
            });

            const sendFileSpy = vi.spyOn(express.response, "sendFile").mockImplementation(function (this: Response) {
                this.type("image/jpeg").send("cached image data");
            });

            const res = await request(app).get("/images/mpc?id=123");
            expect(res.status).toBe(200);
            expect(res.header["content-type"]).toContain("image/jpeg");
            sendFileSpy.mockRestore();
        });

        it("serves cached MPC images without fetching", async () => {
            (fs.existsSync as unknown as Mock).mockReturnValue(true);
            const sendFileSpy = vi.spyOn(express.response, "sendFile").mockImplementation(function (this: Response) {
                this.type("image/png").send("cached mpc image");
            });

            const res = await request(app).get("/images/mpc?id=cached-id&size=small");
            expect(res.status).toBe(200);
            expect(mockedAxios.get).not.toHaveBeenCalled();
            expect(fs.promises.utimes).toHaveBeenCalled();
            sendFileSpy.mockRestore();
        });

        it("should return 502 if GDrive fails", async () => {
            mockedAxios.get.mockRejectedValue(new Error("Failed"));
            const res = await request(app).get("/images/mpc?id=123");
            expect(res.status).toBe(502);
        });

        it("should skip non-image responses from GDrive", async () => {
            const candidates = [
                "https://drive.google.com/uc?export=download&confirm=t&id=123",
                "https://drive.google.com/uc?export=download&id=123",
                "https://drive.google.com/uc?export=view&id=123",
                "https://img.mpcautofill.com/123-large-google_drive",
            ];
            // Keep the expected final diagnostic visible while asserting its contents.
            const consoleErrorSpy = vi.spyOn(console, "error");
            mockedAxios.get
                .mockResolvedValueOnce({ headers: { "content-type": "text/html" }, data: imageStream("first interstitial") })
                .mockResolvedValueOnce({ headers: { "content-type": "text/plain" }, data: imageStream("second interstitial") })
                .mockResolvedValueOnce({ headers: { "content-type": "application/pdf" }, data: imageStream("third interstitial") })
                .mockResolvedValueOnce({ headers: { "content-type": "application/octet-stream" }, data: imageStream("cdn error page") });

            const res = await request(app).get("/images/mpc?id=123");
            expect(res.status).toBe(502);
            expect(mockedAxios.get).toHaveBeenCalledTimes(candidates.length);
            for (const [attempt, url] of candidates.entries()) {
                expect(mockedAxios.get).toHaveBeenNthCalledWith(attempt + 1, url, expect.objectContaining({
                    responseType: "stream",
                    maxRedirects: 0,
                    proxy: false,
                    httpsAgent: expect.any(Object),
                }));
            }
            expect(fs.promises.writeFile).not.toHaveBeenCalled();
            expect(consoleErrorSpy).toHaveBeenCalledWith("MPC image proxy failed:", {
                id: "123",
                size: "full",
                lastError: "Non-image response from https://img.mpcautofill.com/123-large-google_drive: application/octet-stream",
            });
        });

        it("handles missing GDrive content types and non-Error candidate failures", async () => {
            const candidates = [
                "https://drive.google.com/uc?export=download&confirm=t&id=plain-gdrive",
                "https://drive.google.com/uc?export=download&id=plain-gdrive",
                "https://drive.google.com/uc?export=view&id=plain-gdrive",
                "https://img.mpcautofill.com/plain-gdrive-large-google_drive",
            ];
            // This spy intentionally calls through so expected diagnostics remain observable.
            const consoleErrorSpy = vi.spyOn(console, "error");
            mockedAxios.get
                .mockResolvedValueOnce({ headers: {}, data: imageStream("html") })
                .mockRejectedValueOnce("plain gdrive failure")
                .mockResolvedValueOnce({ headers: { "content-type": "text/html" }, data: imageStream("view interstitial") })
                .mockRejectedValueOnce("plain CDN fallback failure");

            const res = await request(app).get("/images/mpc?id=plain-gdrive");
            expect(res.status).toBe(502);
            expect(mockedAxios.get).toHaveBeenCalledTimes(candidates.length);
            for (const [attempt, url] of candidates.entries()) {
                expect(mockedAxios.get).toHaveBeenNthCalledWith(attempt + 1, url, expect.objectContaining({
                    responseType: "stream",
                    maxRedirects: 0,
                    proxy: false,
                    httpsAgent: expect.any(Object),
                }));
            }
            expect(fs.promises.writeFile).not.toHaveBeenCalled();
            expect(consoleErrorSpy).toHaveBeenCalledWith("MPC image proxy failed:", {
                id: "plain-gdrive",
                size: "full",
                lastError: "Failed to fetch https://img.mpcautofill.com/plain-gdrive-large-google_drive: plain CDN fallback failure",
            });
        });
    });


    // Note: Cache cleanup test removed - async cleanup + 5-min throttle makes it unreliable

    describe("Proxy Error Handling", () => {
        it("should return 502 if upstream returns 404", async () => {
            const url = "https://cards.scryfall.io/png/front/2/3/23456789-1234-1234-1234-123456789abc.png";
            (fs.existsSync as unknown as Mock).mockReturnValue(false);
            mockedAxios.get.mockResolvedValue({ status: 404, data: "Not Found" });

            const res = await request(app).get(`/images/proxy?url=${encodeURIComponent(url)}`);
            expect(res.status).toBe(502);
            expect(res.body.error).toBe("Failed to download image");
        });

        it("should return 502 if upstream returns non-image", async () => {
            const url = "https://cards.scryfall.io/png/front/4/5/456789ab-1234-1234-1234-123456789abc.png";
            (fs.existsSync as unknown as Mock).mockReturnValue(false);
            mockedAxios.get.mockResolvedValue({
                status: 200,
                data: imageStream("text data"),
                headers: { "content-type": "text/plain" },
            });

            const res = await request(app).get(`/images/proxy?url=${encodeURIComponent(url)}`);
            expect(res.status).toBe(502);
            expect(res.body.error).toBe("Upstream not image");
        });

        it("rejects relative and malformed proxy URLs before transport", async () => {
            const relative = await request(app).get("/images/proxy").query({ url: "/cardbacks/mtg.png" });
            expect(relative.status).toBe(400);

            const malformed = await request(app).get("/images/proxy").query({ url: "%E0%A4%A" });
            expect(malformed.status).toBe(400);
            expect(mockedAxios.get).not.toHaveBeenCalled();
        });

        it("continues to fetch when an in-progress write does not produce a cached file", async () => {
            const url = "https://cards.scryfall.io/png/front/6/7/6789abcd-1234-1234-1234-123456789abc.png";
            const localPath = __imageRouterTestInternals.cachePathFromUrl(url);
            __imageRouterTestInternals.writeInProgress.add(localPath);
            mockedAxios.get.mockResolvedValue({
                status: 200,
                data: imageStream("image data"),
                headers: { "content-type": "image/png" },
            });
            const sendFileSpy = vi.spyOn(express.response, "sendFile").mockImplementation(function (this: Response) {
                this.type("image/png").send("fresh image");
            });

            const responsePromise = request(app).get("/images/proxy").query({ url });
            await new Promise(resolve => setTimeout(resolve, 150));
            const res = await responsePromise;

            expect(res.status).toBe(200);
            expect(mockedAxios.get).toHaveBeenCalledWith(url, expect.any(Object));
            sendFileSpy.mockRestore();
        });

        it("should return 400 if url query param is missing", async () => {
            const res = await request(app).get("/images/proxy");
            expect(res.status).toBe(400);
            expect(res.body.error).toBe("Missing or invalid ?url");
        });

        it("should return 400 if url query param is not a string", async () => {
            const res = await request(app).get("/images/proxy?url[]=invalid");
            expect(res.status).toBe(400);
            expect(res.body.error).toBe("Missing or invalid ?url");
        });

        it("should return 502 if upstream returns 400 with data", async () => {
            const url = "https://cards.scryfall.io/png/front/8/9/89abcdef-1234-1234-1234-123456789abc.png";
            (fs.existsSync as unknown as Mock).mockReturnValue(false);
            mockedAxios.get.mockResolvedValue({
                status: 400,
                data: imageStream("error data"),
                headers: { "content-type": "image/png" }
            });

            const res = await request(app).get(`/images/proxy?url=${encodeURIComponent(url)}`);
            expect(res.status).toBe(502);
            // When upstream returns 4xx, getWithRetry throws "HTTP 400" error
            // which is caught and returns "Failed to download image"
            expect(res.body.error).toBe("Failed to download image");
        });

        it("stringifies non-Error proxy failures", async () => {
            mockedAxios.get.mockRejectedValue("plain proxy failure");
            const res = await request(app).get("/images/proxy").query({ url: "https://cards.scryfall.io/png/front/a/b/abcdefab-1234-1234-1234-123456789abc.png" });
            expect(res.status).toBe(502);
            expect(res.body.error).toBe("Failed to download image");
        });
    });

    describe("enrichment, token, and cardback routes", () => {
        it("returns [] for empty enrich and tokens requests and rejects malformed or overlarge batches", async () => {
            expect((await request(app).post("/images/enrich").send({ cards: [] })).body).toEqual([]);
            expect((await request(app).post("/images/tokens").send({ cards: [] })).body).toEqual([]);
            expect((await request(app).post("/images/enrich").send({ cards: "not-array" })).status).toBe(400);
            expect((await request(app).post("/images/tokens").send({ cards: "not-array" })).status).toBe(400);
            expect((await request(app).post("/images/enrich").send({ cards: Array.from({ length: 101 }, (_, i) => ({ name: `C${i}` })) })).status).toBe(400);
            expect((await request(app).post("/images/tokens").send({ cards: Array.from({ length: 101 }, (_, i) => ({ name: `C${i}` })) })).status).toBe(400);
        });

        it("rejects malformed and oversized enrichment requests before lookup work", async () => {
            const oversized = Array.from({ length: 101 }, (_, index) => ({ name: `Card ${index}` }));

            for (const [path, body] of [
                ["/images/enrich", { cards: oversized }],
                ["/images/enrich", { cards: [{ name: 42 }] }],
                ["/images/tokens", { cards: "not-an-array" }],
                ["/images/tokens", { cards: [{ name: "Card", number: { value: "1" } }] }],
            ] as const) {
                const response = await request(app).post(path).send(body).expect(400);
                expect(response.body).toEqual({ error: "Invalid import request" });
            }

            expect(routeMocks.batchFetchCards).not.toHaveBeenCalled();
            expect(routeMocks.getCardDataForCardInfo).not.toHaveBeenCalled();
            expect(routeMocks.fetchCardsForTokenLookup).not.toHaveBeenCalled();
            expect(routeMocks.resolveLatestTokenParts).not.toHaveBeenCalled();
        });

        it("accepts the existing 100-card enrichment boundary", async () => {
            const cards = Array.from({ length: 100 }, (_, index) => ({ name: `Card ${index}` }));
            routeMocks.batchFetchCards.mockResolvedValue(new Map());
            routeMocks.getCardDataForCardInfo.mockResolvedValue(null);

            const response = await request(app).post("/images/enrich").send({ cards }).expect(200);

            expect(response.body).toHaveLength(100);
            expect(routeMocks.batchFetchCards).toHaveBeenCalledTimes(1);
            expect(routeMocks.batchFetchCards.mock.calls[0]?.[0]).toHaveLength(100);
        });

        it("enriches batch hits by set/number and name, and falls back for misses", async () => {
            const batch = new Map();
            batch.set("lea:1", { name: "Set Hit", set: "lea", collector_number: "1", colors: ["W"], mana_cost: "{W}", cmc: 1, type_line: "Creature", rarity: "common", lang: "en" });
            batch.set("face card", { name: "Front // Back", set: "abc", collector_number: "2", card_faces: [{ name: "Face Card", colors: ["U"], mana_cost: "{U}", image_uris: { png: "face.png" } }], cmc: 2, type_line: "Instant", rarity: "rare" });
            routeMocks.batchFetchCards.mockResolvedValueOnce(batch);
            routeMocks.getCardDataForCardInfo.mockResolvedValueOnce({ name: "Fallback", set: "def", collector_number: "3", image_uris: { png: "fallback.png" }, all_parts: [{ component: "token", name: "Token" }] });
            routeMocks.extractTokenParts.mockReturnValueOnce([]).mockReturnValueOnce([{ name: "Face Token" }]).mockReturnValueOnce([{ name: "Token" }]);

            const response = await request(app).post("/images/enrich").send({ cards: [
                { name: "Set Hit", set: "LEA", number: "1" },
                { name: "Face Card" },
                { name: "Fallback" },
            ] });

            expect(response.status).toBe(200);
            expect(response.body[0]).toMatchObject({ name: "Set Hit", set: "lea", number: "1", colors: ["W"] });
            expect(response.body[1]).toMatchObject({ name: "Front // Back", token_parts: [{ name: "Face Token" }] });
            expect(response.body[2]).toMatchObject({ name: "Fallback", token_parts: [{ name: "Token" }] });
        });

        it("enriches fallback metadata shapes and timeout test seams", async () => {
            const batch = new Map();
            batch.set("fallback fields", {
                card_faces: [{ image_uris: { png: "nameless-face.png" } }],
            });
            routeMocks.batchFetchCards.mockResolvedValueOnce(batch);
            routeMocks.extractTokenParts.mockReturnValueOnce([]);

            const response = await request(app).post("/images/enrich").send({
                cards: [{ name: "Fallback Fields", set: "SET", number: "42" }],
            });
            expect(response.status).toBe(200);
            expect(response.body[0]).toMatchObject({
                name: "Fallback Fields",
                set: "SET",
                number: "42",
                card_faces: [{ name: "" }],
            });

            __imageRouterTestInternals.setEnrichLookupTimeoutForTests(1);
            routeMocks.batchFetchCards.mockResolvedValueOnce(new Map());
            routeMocks.getCardDataForCardInfo.mockImplementationOnce(() => new Promise(() => undefined));
            const timedOut = await request(app).post("/images/enrich").send({ cards: [{ name: "Slow" }] });
            expect(timedOut.body).toEqual([null]);
        });

        it("returns null enrich entries for mismatches, fallback misses, timeouts, and reports batch failures", async () => {
            const batch = new Map();
            batch.set("wrong", { name: "Different", set: "abc", collector_number: "9" });
            routeMocks.batchFetchCards.mockResolvedValueOnce(batch);
            routeMocks.getCardDataForCardInfo.mockResolvedValueOnce(null);
            const mismatch = await request(app).post("/images/enrich").send({ cards: [{ name: "Wrong" }] });
            expect(mismatch.body).toEqual([null]);

            routeMocks.batchFetchCards.mockResolvedValueOnce(new Map());
            routeMocks.getCardDataForCardInfo.mockRejectedValueOnce(new Error("lookup failed"));
            const fallbackFailure = await request(app).post("/images/enrich").send({ cards: [{ name: "Timeout" }] });
            expect(fallbackFailure.body).toEqual([null]);

            routeMocks.batchFetchCards.mockRejectedValueOnce(new Error("batch down"));
            const errorFailed = await request(app).post("/images/enrich").send({ cards: [{ name: "Boom" }] });
            expect(errorFailed.status).toBe(500);

            routeMocks.batchFetchCards.mockRejectedValueOnce("plain batch down");
            const failed = await request(app).post("/images/enrich").send({ cards: [{ name: "Boom" }] });
            expect(failed.status).toBe(500);
            expect(failed.body.error).toBe("Failed to enrich cards.");
        });

        it("fetches token data while preserving request identity and handles misses/failures", async () => {
            const lookup = new Map();
            lookup.set("lea:1", { name: "Canonical", set: "lea", collector_number: "1" });
            lookup.set("sol ring", { name: "Sol Ring", set: "cmd", collector_number: "1" });
            routeMocks.fetchCardsForTokenLookup.mockResolvedValueOnce({ cards: lookup });
            routeMocks.extractTokenParts.mockReturnValue([{ name: "Goblin" }]);
            routeMocks.resolveLatestTokenParts.mockResolvedValue([{ name: "Latest Goblin" }]);

            const response = await request(app).post("/images/tokens").send({ cards: [
                { name: "Requested", set: "LEA", number: "1" },
                { name: "Sol Ring" },
                { name: "Missing" },
            ] });

            expect(response.status).toBe(200);
            expect(response.body).toEqual([
                { name: "Requested", set: "LEA", number: "1", token_parts: [{ name: "Latest Goblin" }] },
                { name: "Sol Ring", token_parts: [{ name: "Latest Goblin" }] },
                { name: "Missing" },
            ]);

            routeMocks.fetchCardsForTokenLookup.mockRejectedValueOnce(new Error("lookup down"));
            const errorFailed = await request(app).post("/images/tokens").send({ cards: [{ name: "Boom" }] });
            expect(errorFailed.status).toBe(500);

            routeMocks.fetchCardsForTokenLookup.mockRejectedValueOnce("plain lookup down");
            const failed = await request(app).post("/images/tokens").send({ cards: [{ name: "Boom" }] });
            expect(failed.status).toBe(500);
            expect(failed.body.error).toBe("Failed to fetch token data.");
        });

        it("serves and rejects cardbacks", async () => {
            const sendFileSpy = vi.spyOn(express.response, "sendFile").mockImplementation(function (this: Response) {
                this.type("image/png").send("png");
            });
            (fs.existsSync as unknown as Mock).mockImplementation((filePath: string) => String(filePath).endsWith("mtg.png"));

            const missingId = await request(app).get("/images/cardback/%20");
            expect(missingId.status).toBe(404);

            const ok = await request(app).get("/images/cardback/mtg");
            const unknown = await request(app).get("/images/cardback/unknown");
            (fs.existsSync as unknown as Mock).mockReturnValue(false);
            const missing = await request(app).get("/images/cardback/mtg");

            expect(ok.status).toBe(200);
            expect(unknown.status).toBe(404);
            expect(missing.status).toBe(404);
            sendFileSpy.mockRestore();
        });

        it("covers cardback directory resolution fallbacks via helper export", async () => {
            vi.resetModules();
            const fsMock = {
                ...fs,
                existsSync: vi.fn(() => true),
                readdirSync: vi.fn(() => []),
            };
            vi.doMock("fs", () => ({ ...fsMock, default: fsMock }));

            const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
            const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
            const { resolveCardbacksDir } = await import("./imageRouter.js");

            const resolved = resolveCardbacksDir();
            expect(resolved).toContain("cardbacks");
            expect(warnSpy).toHaveBeenCalled();
            expect(errorSpy).toHaveBeenCalled();

            warnSpy.mockRestore();
            errorSpy.mockRestore();
        });

        it("uses the first cardback directory that contains a png", async () => {
            vi.resetModules();
            const fsMock = {
                ...fs,
                existsSync: vi.fn(() => true),
                readdirSync: vi.fn(() => ["mtg.png"]),
            };
            vi.doMock("fs", () => ({ ...fsMock, default: fsMock }));

            const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
            const { resolveCardbacksDir } = await import("./imageRouter.js");

            const resolved = resolveCardbacksDir();

            expect(resolved).toContain("cardbacks");
            expect(fsMock.readdirSync).toHaveBeenCalledTimes(2);

            logSpy.mockRestore();
        });

        it("continues cardback directory resolution after a readable directory throws", async () => {
            vi.resetModules();
            const fsMock = {
                ...fs,
                existsSync: vi.fn(() => true),
                readdirSync: vi.fn()
                    .mockImplementationOnce(() => {
                        throw new Error("cannot read");
                    })
                    .mockReturnValue(["mtg.png"]),
            };
            vi.doMock("fs", () => ({ ...fsMock, default: fsMock }));

            const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
            const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
            const { resolveCardbacksDir } = await import("./imageRouter.js");

            const resolved = resolveCardbacksDir();

            expect(resolved).toContain("cardbacks");
            expect(fsMock.readdirSync).toHaveBeenCalledTimes(3);
            expect(warnSpy).toHaveBeenCalledWith(
                expect.stringContaining("[Cardbacks] Error reading directory"),
                expect.any(Error)
            );

            warnSpy.mockRestore();
            logSpy.mockRestore();
        });
    });

});
