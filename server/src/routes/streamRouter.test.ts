import { vi, describe, beforeEach, afterEach, it, expect } from 'vitest';
import { createServer, request as httpRequest } from "node:http";
import request from "supertest";
import express, { type Express, json } from "express";
import { __streamRouterTestInternals, streamRouter } from "./streamRouter";
import * as getCardImagesPaged from "../utils/getCardImagesPaged";
import type { CardInfo } from "../../../shared/types";

// Partial mock - only mock batchFetchCards, keep lookupCardFromBatch real
vi.mock("../utils/getCardImagesPaged", async (importOriginal) => {
    const actual = await importOriginal<typeof getCardImagesPaged>();
    return {
        ...actual,
        batchFetchCards: vi.fn(),
        getCardsWithImagesForCardInfo: vi.fn(),

    };
});

describe("Stream Router", () => {
    let app: Express;

    beforeEach(() => {
        vi.mocked(getCardImagesPaged.batchFetchCards).mockClear();
        vi.mocked(getCardImagesPaged.getCardsWithImagesForCardInfo).mockClear();
        vi.mocked(getCardImagesPaged.getCardsWithImagesForCardInfo).mockResolvedValue([]);
        app = express();
        app.use(json());
        app.use("/stream", streamRouter);
    });

    afterEach(() => {
        vi.useRealTimers();
        __streamRouterTestInternals.resetOperationTimeoutForTests();
    });

    it("accepts only finite positive integer SSE operation timeout configuration", () => {
        expect(__streamRouterTestInternals.configuredOperationTimeout({})).toBe(120_000);
        expect(__streamRouterTestInternals.configuredOperationTimeout({ STREAM_OPERATION_TIMEOUT_MS: "2500" })).toBe(2500);

        expect(__streamRouterTestInternals.configuredOperationTimeout({ STREAM_OPERATION_TIMEOUT_MS: "" })).toBe(120_000);

        for (const value of ["0", "-1", "1.5", "Infinity", "not-a-number"]) {
            expect(() => __streamRouterTestInternals.configuredOperationTimeout({ STREAM_OPERATION_TIMEOUT_MS: value }))
                .toThrow("STREAM_OPERATION_TIMEOUT_MS must be a finite positive integer.");
        }
    });

    it("aborts only the disconnected SSE request and releases the next queued resolver", async () => {
        const server = createServer(app);
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("Expected a TCP test server");

        const active: Array<{ name: string; resolve: (value: Map<string, never>) => void; signal: AbortSignal }> = [];
        const queued: Array<{ name: string; resolve: (value: Map<string, never>) => void; signal: AbortSignal }> = [];
        const aborts: string[] = [];

        const startNext = () => {
            const next = queued.shift();
            if (next) active.push(next);
        };
        const release = (entry: { name: string }) => {
            const index = active.indexOf(entry as typeof active[number]);
            if (index >= 0) active.splice(index, 1);
            startNext();
        };

        vi.mocked(getCardImagesPaged.batchFetchCards).mockImplementation((queries, _language, signal) => {
            const name = queries[0]!.name;
            return new Promise<Map<string, never>>((resolve, reject) => {
                expect(signal).toBeInstanceOf(AbortSignal);
                const entry = { name, resolve, signal: signal!, };
                const abort = () => {
                    aborts.push(name);
                    const queuedIndex = queued.indexOf(entry);
                    if (queuedIndex >= 0) queued.splice(queuedIndex, 1);
                    release(entry);
                    reject(Object.assign(new Error("cancelled"), { name: "AbortError" }));
                };
                signal!.addEventListener("abort", abort, { once: true });
                if (active.length === 0) active.push(entry);
                else queued.push(entry);
            }) as ReturnType<typeof getCardImagesPaged.batchFetchCards>;
        });

        const openStream = (name: string) => new Promise<{ request: ReturnType<typeof httpRequest>; response: import("node:http").IncomingMessage }>((resolve, reject) => {
            const client = httpRequest({
                host: "127.0.0.1",
                port: address.port,
                path: "/stream/cards",
                method: "POST",
                headers: { "content-type": "application/json" },
            });
            client.once("error", reject);
            client.once("response", (response) => resolve({ request: client, response }));
            client.end(JSON.stringify({ cardQueries: [{ name }] }));
        });

        try {
            const first = await openStream("First");
            await vi.waitFor(() => expect(active.map((entry) => entry.name)).toEqual(["First"]));
            const second = await openStream("Second");
            await vi.waitFor(() => expect(queued.map((entry) => entry.name)).toEqual(["Second"]));

            first.response.destroy();
            await vi.waitFor(() => {
                expect(aborts).toEqual(["First"]);
                expect(active.map((entry) => entry.name)).toEqual(["Second"]);
            });

            second.response.destroy();
            await vi.waitFor(() => expect(aborts).toEqual(["First", "Second"]));
        } finally {
            await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        }
    });

    it("should stream card data correctly on happy path", async () => {
        // Mock batch returns a Map with the card data
        const mockBatchResults = new Map();
        mockBatchResults.set("sol ring", {
            name: "Sol Ring",
            image_uris: { png: "some_url" },
            colors: [],
            cmc: 1,
            type_line: "Artifact",
            rarity: "uncommon",
            set: "cmd",
            collector_number: "123"
        });
        const resolverSignals: AbortSignal[] = [];
        vi.mocked(getCardImagesPaged.batchFetchCards).mockImplementation((_queries, _language, signal) => {
            resolverSignals.push(signal!);
            return Promise.resolve(mockBatchResults);
        });

        const cardQueries: CardInfo[] = [{ name: "Sol Ring" }];

        const res = await request(app)
            .post("/stream/cards")
            .send({ cardQueries })
            .expect(200);

        const events = res.text.split("\n\n");

        // handshake
        expect(events[0]).toBe('event: handshake\ndata: {"total":1,"cardArt":"art"}');

        // card-found
        const cardFoundData = JSON.parse(events[1].match(/data: (.*)/)![1]);
        expect(events[1].startsWith("event: card-found")).toBe(true);
        expect(cardFoundData.name).toBe("Sol Ring");
        expect(cardFoundData.imageUrls).toEqual(["some_url"]);

        // progress
        expect(events[2]).toBe("event: progress\ndata: {\"processed\":1,\"total\":1}");

        // done
        expect(events[3]).toBe("event: done\ndata: {}");
        expect(resolverSignals).toHaveLength(1);
        expect(resolverSignals[0]!.aborted).toBe(false);
    });

    it("should handle card-error events gracefully", async () => {
        const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => { });
        // Return empty map = card not found
        vi.mocked(getCardImagesPaged.batchFetchCards).mockResolvedValue(new Map());

        const cardQueries: CardInfo[] = [{ name: "Unknown Card" }];

        const res = await request(app)
            .post("/stream/cards")
            .send({ cardQueries })
            .expect(200);

        const events = res.text.split("\n\n");

        // handshake
        expect(events[0]).toBe('event: handshake\ndata: {"total":1,"cardArt":"art"}');

        // card-error
        const cardErrorData = JSON.parse(events[1].match(/data: (.*)/)![1]);
        expect(events[1].startsWith("event: card-error")).toBe(true);
        expect(cardErrorData.query.name).toBe("Unknown Card");
        expect(cardErrorData.error).toBe("Card not found on Scryfall.");

        // progress
        expect(events[2]).toBe("event: progress\ndata: {\"processed\":1,\"total\":1}");

        // done
        expect(events[3]).toBe("event: done\ndata: {}");

        consoleErrorSpy.mockRestore();
    });

    it("should handle empty cardQueries array", async () => {
        const cardQueries: CardInfo[] = [];
        const res = await request(app)
            .post("/stream/cards")
            .send({ cardQueries })
            .expect(200);

        const events = res.text.split("\n\n");
        expect(events[0]).toBe('event: handshake\ndata: {"total":0,"cardArt":"art"}');
        expect(events[1]).toBe("event: done\ndata: {}");
    });

    it("should correctly stream cards with multiple faces", async () => {
        const mockBatchResults = new Map();
        mockBatchResults.set("valki, god of lies // tibalt, cosmic impostor", {
            name: "Valki, God of Lies // Tibalt, Cosmic Impostor",
            card_faces: [
                { image_uris: { png: "valki_url" } },
                { image_uris: { png: "tibalt_url" } }
            ],
            colors: ["B", "R"],
            cmc: 7,
            type_line: "Creature // Planeswalker",
            rarity: "mythic",
            set: "khm",
            collector_number: "114"
        });
        vi.mocked(getCardImagesPaged.batchFetchCards).mockResolvedValue(mockBatchResults);

        const cardQueries: CardInfo[] = [{ name: "Valki, God of Lies // Tibalt, Cosmic Impostor" }];

        const res = await request(app)
            .post("/stream/cards")
            .send({ cardQueries })
            .expect(200);

        const events = res.text.split("\n\n").filter((e: string) => e);
        const cardFoundEvent = events.find((e: string) => e.startsWith("event: card-found"));
        const cardFoundData = JSON.parse(cardFoundEvent!.match(/data: (.*)/s)![1]);

        expect(cardFoundData.name).toBe("Valki, God of Lies // Tibalt, Cosmic Impostor");
        expect(cardFoundData.imageUrls).toEqual(["valki_url", "tibalt_url"]);
    });

    it("streams cards when Scryfall omits optional set, number, and name fields", async () => {
        const mockBatchResults = new Map();
        mockBatchResults.set("nameless", {
            image_uris: { png: "nameless_url" },
            colors: [],
            cmc: 0,
            type_line: "Token",
            rarity: "common",
        });
        mockBatchResults.set("two faces", {
            name: "Two Faces",
            card_faces: [
                { name: "Two", image_uris: { png: "two_url" } },
                { name: "Faces", image_uris: { png: "faces_url" } },
            ],
        });
        vi.mocked(getCardImagesPaged.batchFetchCards).mockResolvedValue(mockBatchResults);

        const res = await request(app)
            .post("/stream/cards")
            .send({ cardQueries: [{ name: "Nameless" }, { name: "Two Faces" }] })
            .expect(200);

        const events = res.text.split("\n\n").filter(Boolean);
        const foundEvents = events.filter((event: string) => event.startsWith("event: card-found"));
        const nameless = JSON.parse(foundEvents[0].match(/data: (.*)/s)![1]);
        const twoFaces = JSON.parse(foundEvents[1].match(/data: (.*)/s)![1]);

        expect(nameless).toMatchObject({ name: "Nameless", imageUrls: ["nameless_url"] });
        expect(nameless).not.toHaveProperty("set");
        expect(nameless).not.toHaveProperty("number");
        expect(twoFaces.prints[0]).toMatchObject({ set: "", number: "", imageUrl: "two_url" });
    });

    it("defaults to the front face when the requested face does not match", async () => {
        const mockBatchResults = new Map();
        mockBatchResults.set("bala ged recovery // bala ged sanctuary", {
            name: "Bala Ged Recovery // Bala Ged Sanctuary",
            card_faces: [
                { name: "Bala Ged Recovery", image_uris: { png: "front_url" } },
                { name: "Bala Ged Sanctuary", image_uris: { png: "back_url" } }
            ],
            colors: ["G"],
            cmc: 2,
            type_line: "Sorcery // Land",
            rarity: "rare",
            set: "znr",
            collector_number: "180"
        });
        vi.mocked(getCardImagesPaged.batchFetchCards).mockResolvedValue(mockBatchResults);

        const res = await request(app)
            .post("/stream/cards")
            .send({ cardQueries: [{ name: "Bala Ged Recovery // Bala Ged Sanctuary" }] })
            .expect(200);

        const events = res.text.split("\n\n").filter((e: string) => e);
        const cardFoundEvent = events.find((e: string) => e.startsWith("event: card-found"));
        const cardFoundData = JSON.parse(cardFoundEvent!.match(/data: (.*)/s)![1]);
        expect(cardFoundData.name).toBe("Bala Ged Recovery");
        expect(cardFoundData.imageUrls[0]).toBe("front_url");
    });

    it("should handle a mix of found and not-found cards", async () => {
        const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => { });

        // Only "Sol Ring" is in the batch results
        const mockBatchResults = new Map();
        mockBatchResults.set("sol ring", {
            name: "Sol Ring",
            image_uris: { png: "sol_ring_url" },
            colors: [],
            cmc: 1,
            type_line: "Artifact",
            rarity: "uncommon",
            set: "cmd",
            collector_number: "123"
        });
        vi.mocked(getCardImagesPaged.batchFetchCards).mockResolvedValue(mockBatchResults);

        const cardQueries: CardInfo[] = [{ name: "Sol Ring" }, { name: "Unknown" }];

        const res = await request(app)
            .post("/stream/cards")
            .send({ cardQueries })
            .expect(200);

        const events = res.text.split("\n\n").filter(Boolean);

        // Correctly find all events of a certain type
        const handshake = events.find((e: string) => e.startsWith("event: handshake"));
        const cardFound = events.find((e: string) => e.startsWith("event: card-found"));
        const cardError = events.find((e: string) => e.startsWith("event: card-error"));
        const progressEvents = events.filter((e: string) => e.startsWith("event: progress"));
        const doneEvent = events.find((e: string) => e.startsWith("event: done"));

        expect(handshake).toBe('event: handshake\ndata: {"total":2,"cardArt":"art"}');

        const cardFoundData = JSON.parse(cardFound!.match(/data: (.*)/s)![1]);
        expect(cardFoundData.name).toBe("Sol Ring");

        const cardErrorData = JSON.parse(cardError!.match(/data: (.*)/s)![1]);
        expect(cardErrorData.query.name).toBe("Unknown");

        expect(progressEvents).toHaveLength(2);
        expect(progressEvents[0]).toBe("event: progress\ndata: {\"processed\":1,\"total\":2}");
        expect(progressEvents[1]).toBe("event: progress\ndata: {\"processed\":2,\"total\":2}");

        expect(doneEvent).toBe("event: done\ndata: {}");

        consoleErrorSpy.mockRestore();
    });

    it("rejects a missing cardQueries list before opening an SSE stream", async () => {
        const res = await request(app)
            .post("/stream/cards")
            .send({})
            .expect(400);

        expect(res.body).toEqual({ error: "Invalid import request" });
        expect(res.headers["content-type"]).not.toContain("text/event-stream");
    });

    it("rejects a malformed top-level language before opening an SSE stream", async () => {
        const res = await request(app)
            .post("/stream/cards")
            .send({ cardQueries: [{ name: "Test" }], language: { invalid: true } })
            .expect(400);

        expect(res.body).toEqual({ error: "Invalid import request" });
        expect(res.headers["content-type"]).not.toContain("text/event-stream");
    });

    it("should handle empty image array as card not found", async () => {
        // Card exists but has no images
        const mockBatchResults = new Map();
        mockBatchResults.set("empty card", {
            name: "Empty Card",
            // No image_uris or card_faces
            colors: [],
            cmc: 0,
            type_line: "Unknown",
            rarity: "common"
        });
        vi.mocked(getCardImagesPaged.batchFetchCards).mockResolvedValue(mockBatchResults);

        const cardQueries: CardInfo[] = [{ name: "Empty Card" }];

        const res = await request(app)
            .post("/stream/cards")
            .send({ cardQueries })
            .expect(200);

        const events = res.text.split("\n\n").filter(Boolean);
        const cardError = events.find((e: string) => e.startsWith("event: card-error"));
        const cardErrorData = JSON.parse(cardError!.match(/data: (.*)/)![1]);

        expect(cardErrorData.query.name).toBe("Empty Card");
        expect(cardErrorData.error).toBe("No images found for card on Scryfall.");
    });


    it("streams prints mode responses and per-card errors", async () => {
        vi.mocked(getCardImagesPaged.getCardsWithImagesForCardInfo)
            .mockResolvedValueOnce([
                {
                    name: "Face A // Face B",
                    set: "abc",
                    collector_number: "7",
                    rarity: "rare",
                    card_faces: [
                        { name: "Face A", image_uris: { png: "a.png" }, colors: ["G"], mana_cost: "{G}" },
                        { name: "Face B", image_uris: { png: "b.png" } },
                    ],
                    all_parts: [{ component: "token", name: "Token" }],
                } as never,
            ])
            .mockRejectedValueOnce(new Error("prints failed"));

        const res = await request(app)
            .post("/stream/cards")
            .send({ cardArt: "prints", language: "EN", cardQueries: [{ name: "Face B" }, { name: "Bad" }] })
            .expect(200);

        const events = res.text.split("\n\n").filter(Boolean);
        expect(events[0]).toBe('event: handshake\ndata: {"total":2,"cardArt":"prints"}');
        const printData = JSON.parse(events.find((event: string) => event.startsWith("event: print-found"))!.match(/data: (.*)/s)![1]);
        expect(printData.name).toBe("Face B");
        expect(printData.imageUrls).toEqual(["b.png", "a.png"]);
        expect(events.some((event: string) => event.includes('"printsFound":1'))).toBe(true);
        expect(events.some((event: string) => event.startsWith("event: card-error") && event.includes("prints failed"))).toBe(true);
        expect(events.at(-1)).toBe("event: done\ndata: {}");
    });

    it("stringifies non-Error failures in prints and art streams", async () => {
        const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => { });
        vi.mocked(getCardImagesPaged.getCardsWithImagesForCardInfo)
            .mockRejectedValueOnce("plain prints failure")
            .mockRejectedValueOnce("plain art failure");

        const prints = await request(app)
            .post("/stream/cards")
            .send({ cardArt: "prints", cardQueries: [{ name: "Bad Prints" }] })
            .expect(200);
        expect(prints.text).toContain('"error":"plain prints failure"');

        vi.mocked(getCardImagesPaged.batchFetchCards).mockResolvedValue(new Map());
        const art = await request(app)
            .post("/stream/cards")
            .send({ cardQueries: [{ name: "Bad Art" }] })
            .expect(200);
        expect(art.text).toContain('"error":"plain art failure"');

        consoleErrorSpy.mockRestore();
    });

    it("sends keep-alive comments while card streaming is still pending", async () => {
        vi.useFakeTimers();
        let resolveBatch!: (value: Awaited<ReturnType<typeof getCardImagesPaged.batchFetchCards>>) => void;
        vi.mocked(getCardImagesPaged.batchFetchCards).mockReturnValueOnce(
            new Promise((resolve) => {
                resolveBatch = resolve;
            }) as ReturnType<typeof getCardImagesPaged.batchFetchCards>
        );

        const responsePromise = request(app)
            .post("/stream/cards")
            .send({ cardQueries: [{ name: "Slow Card" }] })
            .then((response) => response);

        await vi.waitFor(() => expect(getCardImagesPaged.batchFetchCards).toHaveBeenCalled());
        await vi.advanceTimersByTimeAsync(10_000);
        resolveBatch(new Map());
        const response = await responsePromise;

        expect(response.status).toBe(200);
        expect(response.text).toContain(":keep-alive\n\n");
    });

    it("closes a timed-out hung SSE operation without affecting a normal stream", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(0));
        __streamRouterTestInternals.setOperationTimeoutForTests(20_000);

        let settleHungResolver!: (value: Awaited<ReturnType<typeof getCardImagesPaged.getCardsWithImagesForCardInfo>>) => void;
        const aborts: string[] = [];
        const resolverStarts: Array<{ name: string; at: number }> = [];
        vi.mocked(getCardImagesPaged.batchFetchCards).mockImplementation(() => {
            return Promise.resolve(new Map([["normal", {
                name: "Normal",
                image_uris: { png: "normal.png" },
            }]])) as ReturnType<typeof getCardImagesPaged.batchFetchCards>;
        });
        vi.mocked(getCardImagesPaged.getCardsWithImagesForCardInfo).mockImplementation((query, _mode, _language, _fallback, signal) => {
            resolverStarts.push({ name: query.name, at: Date.now() });
            if (query.name === "First") {
                return new Promise((resolve) => setTimeout(() => resolve([]), 15_000));
            }
            return new Promise<Awaited<ReturnType<typeof getCardImagesPaged.getCardsWithImagesForCardInfo>>>((resolve) => {
                settleHungResolver = resolve;
                signal!.addEventListener("abort", () => aborts.push(query.name), { once: true });
            }) as ReturnType<typeof getCardImagesPaged.getCardsWithImagesForCardInfo>;
        });

        const server = createServer(app);
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("Expected a TCP test server");

        const openStream = (body: unknown) => new Promise<{
            ended: Promise<void>;
            response: import("node:http").IncomingMessage;
            text: () => string;
        }>((resolve, reject) => {
            const client = httpRequest({
                host: "127.0.0.1",
                port: address.port,
                path: "/stream/cards",
                method: "POST",
                headers: { "content-type": "application/json" },
            });
            client.once("error", reject);
            client.once("response", (response) => {
                let text = "";
                response.setEncoding("utf8");
                response.on("data", (chunk: string) => { text += chunk; });
                resolve({
                    response,
                    ended: new Promise<void>((resolveEnd) => response.once("end", resolveEnd)),
                    text: () => text,
                });
            });
            client.end(JSON.stringify(body));
        });

        try {
            const hung = await openStream({
                cardArt: "prints",
                cardQueries: [{ name: "First" }, { name: "Second" }],
            });
            await vi.waitFor(() => expect(getCardImagesPaged.getCardsWithImagesForCardInfo).toHaveBeenCalledTimes(1));
            const normal = await openStream({ cardQueries: [{ name: "Normal" }] });
            await normal.ended;

            expect(normal.response.headers["content-type"]).toContain("text/event-stream");
            expect(normal.response.headers["content-encoding"]).toBeUndefined();
            expect(normal.text().split("\n\n").filter(Boolean).map((event) => event.split("\n", 1)[0])).toEqual([
                "event: handshake",
                "event: card-found",
                "event: progress",
                "event: done",
            ]);

            await vi.advanceTimersByTimeAsync(10_000);
            await vi.waitFor(() => expect(hung.text()).toContain(":keep-alive\n\n"));
            await vi.advanceTimersByTimeAsync(5_000);
            await vi.waitFor(() => expect(getCardImagesPaged.getCardsWithImagesForCardInfo).toHaveBeenCalledTimes(2));
            expect(resolverStarts).toEqual([{ name: "First", at: 0 }, { name: "Second", at: 15_000 }]);
            await vi.advanceTimersByTimeAsync(5_000);
            await hung.ended;

            const timedOutResponse = hung.text();
            expect(timedOutResponse).toContain("event: fatal-error");
            expect(timedOutResponse).toContain('"timeoutMs":20000');
            expect(timedOutResponse).not.toContain("event: done");
            expect(aborts).toEqual(["Second"]);
            expect(vi.getTimerCount()).toBe(0);

            settleHungResolver([]);
            await Promise.resolve();
            await vi.advanceTimersByTimeAsync(20_000);
            expect(hung.text()).toBe(timedOutResponse);
        } finally {
            await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        }
    });

    it("returns metadata for batch hits, fallback hits, misses, per-card errors, empty input, and fatal failures", async () => {
        const batchResults = new Map();
        batchResults.set("sol ring", {
            name: "Sol Ring",
            image_uris: { png: "sol.png" },
            colors: [],
            cmc: 1,
            type_line: "Artifact",
            rarity: "uncommon",
            set: "cmd",
            collector_number: "123",
        });
        vi.mocked(getCardImagesPaged.batchFetchCards).mockResolvedValueOnce(batchResults);
        vi.mocked(getCardImagesPaged.getCardsWithImagesForCardInfo)
            .mockResolvedValueOnce([{ name: "Fallback", image_uris: { png: "fallback.png" }, set: "abc", collector_number: "1" } as never])
            .mockRejectedValueOnce(new Error("one bad card"))
            .mockResolvedValueOnce([]);

        const response = await request(app)
            .post("/stream/metadata")
            .send({ cardQueries: [{ name: "Sol Ring" }, { name: "Fallback" }, { name: "Throws" }, { name: "Missing" }] })
            .expect(200);

        expect(response.body.results[0].card.name).toBe("Sol Ring");
        expect(response.body.results[1].card.name).toBe("Fallback");
        expect(response.body.results[2]).toMatchObject({ card: null, error: "one bad card" });
        expect(response.body.results[3]).toMatchObject({ card: null, error: "Card not found" });

        const empty = await request(app).post("/stream/metadata").send({ cardQueries: [] }).expect(200);
        expect(empty.body).toEqual({ results: [] });

        const invalidBody = await request(app).post("/stream/metadata").send({ cardQueries: "not-array" }).expect(400);
        expect(invalidBody.body).toEqual({ error: "Invalid import request" });

        vi.mocked(getCardImagesPaged.batchFetchCards).mockRejectedValueOnce(new Error("batch fatal"));
        const failed = await request(app).post("/stream/metadata").send({ cardQueries: [{ name: "Boom" }] });
        expect(failed.status).toBe(500);
        expect(failed.body.error).toBe("An unexpected server error occurred.");
    });

    it("stringifies non-Error metadata fallback failures", async () => {
        vi.mocked(getCardImagesPaged.batchFetchCards).mockResolvedValueOnce(new Map());
        vi.mocked(getCardImagesPaged.getCardsWithImagesForCardInfo).mockRejectedValueOnce("metadata string failure");

        const response = await request(app)
            .post("/stream/metadata")
            .send({ cardQueries: [{ name: "String Failure" }] })
            .expect(200);

        expect(response.body.results[0]).toMatchObject({ card: null, error: "metadata string failure" });
    });



    it("rejects malformed and oversized stream requests before resolver work", async () => {
        const oversized = Array.from({ length: 101 }, (_, index) => ({ name: `Card ${index}` }));

        for (const [path, body] of [
            ["/stream/cards", { cardQueries: oversized }],
            ["/stream/cards", { cardQueries: [{ name: "Card", language: { code: "en" } }] }],
            ["/stream/metadata", { cardQueries: "not-an-array" }],
            ["/stream/metadata", { cardQueries: [{ name: "Card", quantity: Number.MAX_SAFE_INTEGER + 1 }] }],
        ] as const) {
            const response = await request(app).post(path).send(body).expect(400);
            expect(response.body).toEqual({ error: "Invalid import request" });
            expect(response.headers["content-type"]).not.toContain("text/event-stream");
        }

        expect(getCardImagesPaged.batchFetchCards).not.toHaveBeenCalled();
        expect(getCardImagesPaged.getCardsWithImagesForCardInfo).not.toHaveBeenCalled();
    });

    it("accepts the existing 100-card import boundary", async () => {
        vi.mocked(getCardImagesPaged.batchFetchCards).mockResolvedValue(new Map());
        vi.mocked(getCardImagesPaged.getCardsWithImagesForCardInfo).mockResolvedValue([]);
        const cardQueries = Array.from({ length: 100 }, (_, index) => ({ name: `Card ${index}` }));

        const metadata = await request(app)
            .post("/stream/metadata")
            .send({ cardQueries })
            .expect(200);

        expect(metadata.body.results).toHaveLength(100);
        expect(getCardImagesPaged.batchFetchCards).toHaveBeenCalledTimes(1);
        expect(vi.mocked(getCardImagesPaged.batchFetchCards).mock.calls[0]?.[0]).toHaveLength(100);
        expect(vi.mocked(getCardImagesPaged.batchFetchCards).mock.calls[0]?.[1]).toBe("en");
    });

    it("falls back to individual art search when batch lookup misses", async () => {
        vi.mocked(getCardImagesPaged.batchFetchCards).mockResolvedValue(new Map());
        vi.mocked(getCardImagesPaged.getCardsWithImagesForCardInfo).mockResolvedValueOnce([
            { name: "Fallback Card", image_uris: { png: "fallback_url" }, set: "abc", collector_number: "1" } as never,
        ]);

        const res = await request(app)
            .post("/stream/cards")
            .send({ cardQueries: [{ name: "Fallback Card" }] })
            .expect(200);

        const events = res.text.split("\n\n").filter(Boolean);
        const found = events.find((event: string) => event.startsWith("event: card-found"));
        expect(JSON.parse(found!.match(/data: (.*)/s)![1]).imageUrls).toEqual(["fallback_url"]);
    });

});
