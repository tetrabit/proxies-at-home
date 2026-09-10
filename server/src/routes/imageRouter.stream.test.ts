import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express, { type Express } from "express";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

const axiosMock = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock("axios", () => {
  const create = vi.fn(() => ({ get: axiosMock.get }));
  return {
    create,
    default: { create, get: axiosMock.get },
  };
});

const fixtureRoot = fileURLToPath(new URL("../../.review-artifacts/image-router-stream-fixtures/", import.meta.url));
const originalServerDataDir = process.env.SERVER_DATA_DIR;
const imageUrl = "https://cards.scryfall.io/png/front/a/b/ab123456-1234-1234-1234-123456789abc.png";

function lazyChunks(chunks: readonly Buffer[]): Readable {
  let next = 0;
  return new Readable({
    read() {
      if (next === chunks.length) {
        this.push(null);
        return;
      }
      const chunk = chunks[next++];
      queueMicrotask(() => this.push(chunk));
    },
  });
}

describe("image proxy stream cache publication", () => {
  let fixtureDirectory: string;
  let cacheDirectory: string;
  let app: Express;
  let internals: typeof import("./imageRouter.js").__imageRouterTestInternals;

  beforeEach(async () => {
    vi.resetModules();
    axiosMock.get.mockReset();
    fs.mkdirSync(fixtureRoot, { recursive: true });
    fixtureDirectory = fs.mkdtempSync(path.join(fixtureRoot, "fixture-"));
    process.env.SERVER_DATA_DIR = path.join(fixtureDirectory, "data");
    const imageModule = await import("./imageRouter.js");
    internals = imageModule.__imageRouterTestInternals;
    app = express();
    app.set("etag", false);
    app.use("/images", imageModule.imageRouter);
    cacheDirectory = path.join(process.env.SERVER_DATA_DIR, "cached-images");
  });

  afterEach(async () => {
    if (originalServerDataDir === undefined) delete process.env.SERVER_DATA_DIR;
    else process.env.SERVER_DATA_DIR = originalServerDataDir;
    vi.resetModules();
    expect(path.relative(fixtureRoot, fixtureDirectory)).not.toMatch(/^\.\.(?:[\\/]|$)/);
    await fs.promises.rm(fixtureDirectory, { recursive: true, force: true });
  });

  it("streams a chunked image under the fixed cap to one atomically published final file", async () => {
    const chunks = [Buffer.from("first-"), Buffer.from("second-"), Buffer.from("third")];
    axiosMock.get.mockResolvedValue({
      status: 200,
      headers: { "content-type": "image/png" },
      data: lazyChunks(chunks),
    });

    const sendFileSpy = vi.spyOn(express.response, "sendFile").mockImplementation(function (this: { type: (contentType: string) => { send: (body: Buffer) => void } }) {
      this.type("image/png").send(Buffer.concat(chunks));
    });
    const response = await request(app).get("/images/proxy").query({ url: imageUrl });
    sendFileSpy.mockRestore();

    expect(response.status).toBe(200);
    expect(response.body).toEqual(Buffer.concat(chunks));
    expect(axiosMock.get).toHaveBeenCalledWith(imageUrl, expect.objectContaining({
      responseType: "stream",
      maxRedirects: 0,
      proxy: false,
      signal: expect.any(AbortSignal),
    }));
    const entries = await fs.promises.readdir(cacheDirectory);
    expect(entries).toHaveLength(1);
    expect(entries.some(entry => entry.endsWith(".tmp"))).toBe(false);
    await expect(fs.promises.readFile(path.join(cacheDirectory, entries[0]))).resolves.toEqual(Buffer.concat(chunks));
    await expect(fs.promises.stat(path.join(cacheDirectory, entries[0]))).resolves.toMatchObject({ mode: expect.any(Number) });
    expect((await fs.promises.stat(path.join(cacheDirectory, entries[0]))).mode & 0o777).toBe(0o600);
  });

  it("destroys a cap-plus-one stream before a trailing sentinel and removes only its temp", async () => {
    const cap = internals.MAX_PROXY_RESPONSE_BYTES;
    let sent = 0;
    let overflowQueued = false;
    let trailingSentinelAttempted = false;
    const source = new Readable({
      read() {
        if (this.destroyed) return;
        if (sent < cap) {
          sent += 64 * 1024;
          queueMicrotask(() => this.push(Buffer.alloc(64 * 1024, 0x61)));
          return;
        }
        if (sent === cap && !overflowQueued) {
          sent++;
          overflowQueued = true;
          queueMicrotask(() => this.push(Buffer.from([0x62])));
          setTimeout(() => {
            if (this.destroyed) return;
            trailingSentinelAttempted = true;
            this.push(Buffer.from("must-not-be-read"));
          }, 100);
        }
      },
    });
    axiosMock.get.mockResolvedValue({ status: 200, headers: { "content-type": "image/png" }, data: source });
    const sentinel = path.join(cacheDirectory, "pre-existing-sentinel");
    await fs.promises.writeFile(sentinel, "retain");

    const response = await request(app).get("/images/proxy").query({ url: imageUrl });

    expect(response.status).toBe(502);
    await new Promise(resolve => setTimeout(resolve, 120));
    expect(source.destroyed).toBe(true);
    expect(trailingSentinelAttempted).toBe(false);
    expect(await fs.promises.readdir(cacheDirectory)).toEqual(["pre-existing-sentinel"]);
    await expect(fs.promises.readFile(sentinel, "utf8")).resolves.toBe("retain");
  });

  it("publishes a lazy exact-cap stream at exactly 25 MiB", async () => {
    const cap = internals.MAX_PROXY_RESPONSE_BYTES;
    const chunk = Buffer.alloc(64 * 1024, 0x63);
    let remaining = cap / chunk.length;
    const source = new Readable({
      read() {
        if (remaining-- === 0) this.push(null);
        else queueMicrotask(() => this.push(chunk));
      },
    });
    const finalPath = path.join(cacheDirectory, "exact-cap.png");

    await internals.streamImageResponseToFile(
      { status: 200, headers: { "content-type": "image/png" }, data: source } as never,
      finalPath,
      new AbortController().signal,
    );

    expect(cap).toBe(25 * 1024 * 1024);
    await expect(fs.promises.stat(finalPath)).resolves.toMatchObject({ size: cap });
    expect((await fs.promises.readdir(cacheDirectory)).some(entry => entry.endsWith(".tmp"))).toBe(false);
  });

  it("removes its partial temp after an upstream stream error without touching a sentinel", async () => {
    const sentinel = path.join(cacheDirectory, "pre-existing-sentinel");
    await fs.promises.writeFile(sentinel, "retain");
    let emitted = false;
    const source = new Readable({
      read() {
        if (emitted) return;
        emitted = true;
        this.push(Buffer.from("partial"));
        queueMicrotask(() => this.destroy(new Error("upstream broke")));
      },
    });

    await expect(internals.streamImageResponseToFile(
      { status: 200, headers: { "content-type": "image/png" }, data: source } as never,
      path.join(cacheDirectory, "broken.png"),
      new AbortController().signal,
    )).rejects.toThrow("upstream broke");

    expect(await fs.promises.readdir(cacheDirectory)).toEqual(["pre-existing-sentinel"]);
  });

  it("disposes a non-image stream before allocating a cache file", async () => {
    const source = lazyChunks([Buffer.from("html")]);
    await expect(internals.streamImageResponseToFile(
      { status: 200, headers: { "content-type": "text/html" }, data: source } as never,
      path.join(cacheDirectory, "not-image.png"),
      new AbortController().signal,
    )).rejects.toThrow("Upstream not image");

    expect(source.destroyed).toBe(true);
    expect(await fs.promises.readdir(cacheDirectory)).toEqual([]);
  });

  it("removes only its partial temp when the active request aborts", async () => {
    const controller = new AbortController();
    const source = new Readable({
      read() {
        this.push(Buffer.from("partial"));
      },
    });
    setTimeout(() => controller.abort(new Error("client disconnected")), 10);

    await expect(internals.streamImageResponseToFile(
      { status: 200, headers: { "content-type": "image/png" }, data: source } as never,
      path.join(cacheDirectory, "aborted.png"),
      controller.signal,
    )).rejects.toBeDefined();

    expect(source.destroyed).toBe(true);
    expect(await fs.promises.readdir(cacheDirectory)).toEqual([]);
  });

  it("removes its exact temp if atomic publication fails", async () => {
    const finalPath = path.join(cacheDirectory, "rename-failure.png");
    const rename = vi.spyOn(fs.promises, "rename").mockRejectedValueOnce(new Error("rename denied"));
    await expect(internals.streamImageResponseToFile(
      { status: 200, headers: { "content-type": "image/png" }, data: lazyChunks([Buffer.from("png")]) } as never,
      finalPath,
      new AbortController().signal,
    )).rejects.toThrow("rename denied");
    rename.mockRestore();

    expect(await fs.promises.readdir(cacheDirectory)).toEqual([]);
  });

  it("disposes an invalid MPC candidate before streaming a later candidate to its cache key", async () => {
    const discarded = lazyChunks([Buffer.from("interstitial")]);
    const valid = lazyChunks([Buffer.from("mpc-png")]);
    axiosMock.get
      .mockResolvedValueOnce({ status: 200, headers: { "content-type": "text/html" }, data: discarded })
      .mockResolvedValueOnce({ status: 200, headers: { "content-type": "image/png" }, data: valid });
    const sendFileSpy = vi.spyOn(express.response, "sendFile").mockImplementation(function (this: { type: (contentType: string) => { send: (body: Buffer) => void } }) {
      this.type("image/png").send(Buffer.from("mpc-png"));
    });

    const response = await request(app).get("/images/mpc").query({ id: "candidate-id", size: "full" });
    sendFileSpy.mockRestore();

    expect(response.status).toBe(200);
    expect(discarded.destroyed).toBe(true);
    expect(axiosMock.get).toHaveBeenCalledTimes(2);
    await expect(fs.promises.readFile(path.join(cacheDirectory, "gdrive_candidate-id_full"))).resolves.toEqual(Buffer.from("mpc-png"));
  });
});
