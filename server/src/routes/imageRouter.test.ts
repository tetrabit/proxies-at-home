import { vi, describe, beforeEach, afterEach, it, expect, type Mock } from 'vitest';
import request from "supertest";
import express, { type Express, type Response } from "express";
import fs from "fs";
import axios from "axios";
import { Writable } from "stream";

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
        writeFile: vi.fn().mockResolvedValue(undefined),
    };

    const mocked = {
        existsSync: vi.fn(),
        createWriteStream: vi.fn(),
        mkdirSync: vi.fn(),
        writeFileSync: vi.fn(),
        readdir: vi.fn(),
        unlink: vi.fn(),
        readdirSync: vi.fn(),
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
    };
    return { ...mocked, default: mocked };
});

// Access the mocked instance's get method
const mockedAxiosInstance = axios.create() as unknown as { get: Mock };
const mockedAxios = {
    get: mockedAxiosInstance.get,
    create: axios.create as Mock,
};

describe("getWithRetry logic", () => {
    let app: Express;
    let writeStream: Writable;

    const imageUrl = "http://example.com/image.jpg";

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
        (fs.promises.unlink as unknown as Mock).mockReset();
        (fs.promises.utimes as unknown as Mock).mockResolvedValue(undefined);
        (fs.promises.writeFile as unknown as Mock).mockResolvedValue(undefined);
        __imageRouterTestInternals.writeInProgress.clear();
        __imageRouterTestInternals.resetCacheCleanupForTests();


        app = express();
        app.use(express.json());
        app.set("etag", false);
        app.use("/images", imageRouter);

        writeStream = new Writable({
            write(_chunk, _encoding, callback) {
                callback();
            },
        });
        (fs.createWriteStream as unknown as Mock).mockReturnValue(writeStream);
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
            data: Buffer.from("image data"),
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

    it("should retry on 429 and then succeed", async () => {
        mockedAxios.get
            .mockResolvedValueOnce({ status: 429, headers: { "retry-after": "0" } }) // Use 0 to speed up test
            .mockResolvedValueOnce({
                status: 200,
                data: Buffer.from("image data"),
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

    it("should retry on generic error and then succeed", async () => {
        mockedAxios.get
            .mockRejectedValueOnce(new Error("Network Error"))
            .mockResolvedValueOnce({
                status: 200,
                data: Buffer.from("image data"),
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
            data: Buffer.from(""),
            headers: { "content-type": "image/jpeg" },
        });

        const res = await request(app).get(`/images/proxy?url=${encodeURIComponent(imageUrl)}`);
        expect(res.status).toBe(502);
        expect(res.body.error).toBe("Upstream is a 0-byte image");
        expect(fs.writeFileSync).not.toHaveBeenCalled();
    });



    it("serves subsequent proxy requests from the in-memory path cache", async () => {
        (fs.existsSync as unknown as Mock).mockReturnValue(true);
        const sendFileSpy = vi.spyOn(express.response, "sendFile").mockImplementation(function (this: Response) {
            this.type("image/jpeg").send("cached image data");
        });

        await request(app).get(`/images/proxy?url=${encodeURIComponent("http://example.com/memory-cache.jpg")}`);
        const res = await request(app).get(`/images/proxy?url=${encodeURIComponent("http://example.com/memory-cache.jpg")}`);

        expect(res.status).toBe(200);
        expect(sendFileSpy).toHaveBeenCalledTimes(2);
        sendFileSpy.mockRestore();
    });

    it("uses thumbnail MPC CDN candidates and full-size large fallback cache path", async () => {
        mockedAxios.get.mockResolvedValue({ status: 200, headers: { "content-type": "image/png" }, data: Buffer.from("png") });
        const sendFileSpy = vi.spyOn(express.response, "sendFile").mockImplementation(function (this: Response) {
            this.type("image/png").send("cached image data");
        });

        const thumb = await request(app).get("/images/mpc?id=thumb-id&size=small");
        expect(thumb.status).toBe(200);
        expect(mockedAxios.get).toHaveBeenCalledWith("https://img.mpcautofill.com/thumb-id-small-google_drive", expect.any(Object));

        mockedAxios.get
            .mockResolvedValueOnce({ headers: { "content-type": "text/html" }, data: Buffer.from("html") })
            .mockResolvedValueOnce({ headers: { "content-type": "text/html" }, data: Buffer.from("html") })
            .mockResolvedValueOnce({ headers: { "content-type": "text/html" }, data: Buffer.from("html") })
            .mockResolvedValueOnce({ headers: { "content-type": "image/jpeg" }, data: Buffer.from("jpg") });
        const full = await request(app).get("/images/mpc?id=fallback-id&size=full");
        expect(full.status).toBe(200);
        expect(fs.promises.writeFile).toHaveBeenLastCalledWith(expect.stringContaining("gdrive_fallback-id_large"), expect.any(Buffer));
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

        it("should proxy image from Google Drive", async () => {
            mockedAxios.get.mockResolvedValue({
                status: 200,
                headers: { "content-type": "image/jpeg" },
                data: Buffer.from("fake image data"),
            });

            const sendFileSpy = vi.spyOn(express.response, "sendFile").mockImplementation(function (this: Response) {
                this.type("image/jpeg").send("cached image data");
            });

            const res = await request(app).get("/images/mpc?id=123");
            expect(res.status).toBe(200);
            expect(res.header["content-type"]).toContain("image/jpeg");
            sendFileSpy.mockRestore();
        });

        it("should return 502 if GDrive fails", async () => {
            mockedAxios.get.mockRejectedValue(new Error("Failed"));
            const res = await request(app).get("/images/mpc?id=123");
            expect(res.status).toBe(502);
        });

        it("should skip non-image responses from GDrive", async () => {
            mockedAxios.get
                .mockResolvedValueOnce({ headers: { "content-type": "text/html" } }) // First candidate
                .mockResolvedValueOnce({ headers: { "content-type": "text/html" } }) // Second candidate
                .mockResolvedValueOnce({ headers: { "content-type": "text/html" } }); // Third candidate

            const res = await request(app).get("/images/mpc?id=123");
            expect(res.status).toBe(502);
        });
    });


    // Note: Cache cleanup test removed - async cleanup + 5-min throttle makes it unreliable

    describe("Proxy Error Handling", () => {
        it("should return 502 if upstream returns 404", async () => {
            const url = "http://example.com/404.png";
            (fs.existsSync as unknown as Mock).mockReturnValue(false);
            mockedAxios.get.mockResolvedValue({ status: 404, data: "Not Found" });

            const res = await request(app).get(`/images/proxy?url=${encodeURIComponent(url)}`);
            expect(res.status).toBe(502);
            expect(res.body.error).toBe("Failed to download image");
        });

        it("should return 502 if upstream returns non-image", async () => {
            const url = "http://example.com/text.txt";
            (fs.existsSync as unknown as Mock).mockReturnValue(false);
            mockedAxios.get.mockResolvedValue({
                status: 200,
                data: Buffer.from("text data"),
                headers: { "content-type": "text/plain" },
            });

            const res = await request(app).get(`/images/proxy?url=${encodeURIComponent(url)}`);
            expect(res.status).toBe(502);
            expect(res.body.error).toBe("Upstream not image");
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
            const url = "http://example.com/error.png";
            (fs.existsSync as unknown as Mock).mockReturnValue(false);
            mockedAxios.get.mockResolvedValue({
                status: 400,
                data: Buffer.from("error data"),
                headers: { "content-type": "image/png" }
            });

            const res = await request(app).get(`/images/proxy?url=${encodeURIComponent(url)}`);
            expect(res.status).toBe(502);
            // When upstream returns 4xx, getWithRetry throws "HTTP 400" error
            // which is caught and returns "Failed to download image"
            expect(res.body.error).toBe("Failed to download image");
        });
    });

    describe("enrichment, token, and cardback routes", () => {
        it("returns [] for empty enrich and tokens requests and rejects overlarge batches", async () => {
            expect((await request(app).post("/images/enrich").send({ cards: [] })).body).toEqual([]);
            expect((await request(app).post("/images/tokens").send({ cards: [] })).body).toEqual([]);
            expect((await request(app).post("/images/enrich").send({ cards: Array.from({ length: 101 }, (_, i) => ({ name: `C${i}` })) })).status).toBe(400);
            expect((await request(app).post("/images/tokens").send({ cards: Array.from({ length: 101 }, (_, i) => ({ name: `C${i}` })) })).status).toBe(400);
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
