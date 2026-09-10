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
  let dbModule: typeof import("../db/db.js");

  beforeEach(async () => {
    vi.resetModules();
    axiosMock.get.mockReset();
    fs.mkdirSync(fixtureRoot, { recursive: true });
    fixtureDirectory = fs.mkdtempSync(path.join(fixtureRoot, "fixture-"));
    process.env.SERVER_DATA_DIR = path.join(fixtureDirectory, "data");
    dbModule = await import("../db/db.js");
    dbModule.initDatabase();
    const imageModule = await import("./imageRouter.js");
    internals = imageModule.__imageRouterTestInternals;
    app = express();
    app.set("etag", false);
    app.use("/images", imageModule.imageRouter);
    cacheDirectory = path.join(process.env.SERVER_DATA_DIR, "cached-images");
  });

  afterEach(async () => {
    dbModule.closeDatabase();
    if (originalServerDataDir === undefined) delete process.env.SERVER_DATA_DIR;
    else process.env.SERVER_DATA_DIR = originalServerDataDir;
    vi.resetModules();
    expect(path.relative(fixtureRoot, fixtureDirectory)).not.toMatch(/^\.\.(?:[\\/]|$)/);
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
    expect(dbModule.getDatabase().prepare(
      'SELECT basename, size, last_access FROM image_cache_metadata',
    ).all()).toEqual([{
      basename: entries[0],
      size: Buffer.concat(chunks).byteLength,
      last_access: expect.any(Number),
    }]);
  });

  it("touches only the access timestamp for memory and disk proxy cache hits", async () => {
    const localPath = internals.cachePathFromUrl(imageUrl);
    await fs.promises.writeFile(localPath, "cached");
    dbModule.getDatabase().prepare(
      'INSERT INTO image_cache_metadata (basename, size, last_access) VALUES (?, ?, ?)',
    ).run(path.basename(localPath), 6, 1);
    const sendFileSpy = vi.spyOn(express.response, "sendFile").mockImplementation(function (this: { type: (contentType: string) => { send: (body: Buffer) => void } }, filePath: string) {
      this.type("image/png").send(fs.readFileSync(filePath));
    });
    const now = vi.spyOn(Date, "now").mockReturnValue(2_000);

    expect((await request(app).get("/images/proxy").query({ url: imageUrl })).status).toBe(200);
    now.mockReturnValue(3_000);
    expect((await request(app).get("/images/proxy").query({ url: imageUrl })).status).toBe(200);
    sendFileSpy.mockRestore();
    now.mockRestore();

    expect(dbModule.getDatabase().prepare(
      'SELECT size, last_access FROM image_cache_metadata WHERE basename = ?',
    ).get(path.basename(localPath))).toEqual({ size: 6, last_access: 3_000 });
  });

  it("touches only the access timestamp for MPC cache hits", async () => {
    const basename = "gdrive_cached-mpc_small";
    await fs.promises.writeFile(path.join(cacheDirectory, basename), "mpc");
    dbModule.getDatabase().prepare(
      'INSERT INTO image_cache_metadata (basename, size, last_access) VALUES (?, ?, ?)',
    ).run(basename, 3, 1);
    const sendFileSpy = vi.spyOn(express.response, "sendFile").mockImplementation(function (this: { type: (contentType: string) => { send: (body: Buffer) => void } }, filePath: string) {
      this.type("image/png").send(fs.readFileSync(filePath));
    });
    const now = vi.spyOn(Date, "now").mockReturnValue(4_000);

    expect((await request(app).get("/images/mpc").query({ id: "cached-mpc", size: "small" })).status).toBe(200);
    sendFileSpy.mockRestore();
    now.mockRestore();

    expect(dbModule.getDatabase().prepare(
      'SELECT size, last_access FROM image_cache_metadata WHERE basename = ?',
    ).get(basename)).toEqual({ size: 3, last_access: 4_000 });
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

  it("retains a failed owned-temp cleanup lease until the router reconciler confirms removal", async () => {
    const finalPath = path.join(cacheDirectory, "cleanup-retry.png");
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
    const reservation = internals.proxyDownloadAdmission.reserve(internals.MAX_PROXY_RESPONSE_BYTES);
    const unlink = vi.spyOn(fs.promises, "unlink").mockRejectedValueOnce(new Error("EBUSY"));

    await expect(internals.streamImageResponseToFile(
      { status: 200, headers: { "content-type": "image/png" }, data: source } as never,
      finalPath,
      new AbortController().signal,
      reservation,
    )).rejects.toThrow("upstream broke");

    expect(internals.proxyDownloadAdmission.stats().reservedBytes).toBe(internals.MAX_PROXY_RESPONSE_BYTES);
    expect(() => internals.proxyDownloadAdmission.reserve(internals.MAX_PROXY_DOWNLOAD_RESERVED_BYTES)).toThrow();
    const tempName = (await fs.promises.readdir(cacheDirectory)).find(entry => entry.endsWith(".tmp"));
    expect(tempName).toBeDefined();
    const tempPath = path.join(cacheDirectory, tempName!);
    expect(internals.writeInProgress.has(tempPath)).toBe(true);
    await expect(fs.promises.readFile(sentinel, "utf8")).resolves.toBe("retain");
    unlink.mockRestore();

    await vi.waitFor(() => expect(internals.proxyDownloadAdmission.stats().reservedBytes).toBe(0));
    expect(internals.writeInProgress.has(tempPath)).toBe(false);
    expect((await fs.promises.readdir(cacheDirectory)).sort()).toEqual(["pre-existing-sentinel"]);
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

  it("keeps an atomically published image when metadata recording fails", async () => {
    const finalPath = path.join(cacheDirectory, "metadata-failure.png");
    const database = dbModule.getDatabase();
    const prepare = database.prepare.bind(database);
    const metadataFailure = vi.spyOn(database, "prepare").mockImplementation((sql: string) => {
      if (sql.includes('INSERT INTO image_cache_metadata')) throw new Error('metadata unavailable');
      return prepare(sql);
    });

    await expect(internals.streamImageResponseToFile(
      { status: 200, headers: { "content-type": "image/png" }, data: lazyChunks([Buffer.from("published")]) } as never,
      finalPath,
      new AbortController().signal,
    )).resolves.toEqual({ contentType: "image/png" });
    metadataFailure.mockRestore();

    await expect(fs.promises.readFile(finalPath)).resolves.toEqual(Buffer.from("published"));
    expect(database.prepare(
      'SELECT * FROM image_cache_metadata WHERE basename = ?',
    ).get(path.basename(finalPath))).toBeUndefined();
  });

  it("gives concurrent readers complete old and new snapshots around a paused replacement publication", async () => {
    const finalPath = path.join(cacheDirectory, "paused-replacement.png");
    await fs.promises.writeFile(finalPath, "old-complete");

    let firstChunkSent = false;
    const source = new Readable({
      read() {
        if (firstChunkSent) return;
        firstChunkSent = true;
        queueMicrotask(() => this.push(Buffer.from("new-")));
      },
    });
    const releaseSource = () => {
      source.push(Buffer.from("complete"));
      source.push(null);
    };

    const publication = internals.streamImageResponseToFile(
      { status: 200, headers: { "content-type": "image/png" }, data: source } as never,
      finalPath,
      new AbortController().signal,
    );
    await vi.waitFor(async () => expect((await fs.promises.readdir(cacheDirectory)).some(entry => entry.endsWith(".tmp"))).toBe(true));

    const oldReaders = await Promise.all([fs.promises.readFile(finalPath), fs.promises.readFile(finalPath)]);
    expect(oldReaders).toEqual([Buffer.from("old-complete"), Buffer.from("old-complete")]);

    releaseSource();
    await publication;

    const newReaders = await Promise.all([fs.promises.readFile(finalPath), fs.promises.readFile(finalPath)]);
    expect(newReaders).toEqual([Buffer.from("new-complete"), Buffer.from("new-complete")]);
    expect(await fs.promises.readdir(cacheDirectory)).toEqual([path.basename(finalPath)]);
  });

  it("preserves an old final and a foreign temp when atomic publication rename fails", async () => {
    const finalPath = path.join(cacheDirectory, "rename-preserves-old.png");
    const foreignTempPath = path.join(cacheDirectory, "foreign-publisher.tmp");
    await fs.promises.writeFile(finalPath, "old-complete");
    await fs.promises.writeFile(foreignTempPath, "foreign-sentinel");
    const rename = vi.spyOn(fs.promises, "rename").mockRejectedValueOnce(new Error("rename denied"));

    try {
      await expect(internals.streamImageResponseToFile(
        { status: 200, headers: { "content-type": "image/png" }, data: lazyChunks([Buffer.from("new-complete")]) } as never,
        finalPath,
        new AbortController().signal,
      )).rejects.toThrow("rename denied");
    } finally {
      rename.mockRestore();
    }

    await expect(fs.promises.readFile(finalPath)).resolves.toEqual(Buffer.from("old-complete"));
    await expect(fs.promises.readFile(foreignTempPath)).resolves.toEqual(Buffer.from("foreign-sentinel"));
    expect((await fs.promises.readdir(cacheDirectory)).sort()).toEqual([path.basename(finalPath), path.basename(foreignTempPath)].sort());
  });

  it("deduplicates concurrent same-key proxy misses until one complete file is published", async () => {
    const body = Buffer.from("deduplicated-png");
    let resolveUpstream: (response: { status: number; headers: { "content-type": string }; data: Readable }) => void;
    const upstream = new Promise<{ status: number; headers: { "content-type": string }; data: Readable }>(resolve => {
      resolveUpstream = resolve;
    });
    let sharedSignal: AbortSignal | undefined;
    axiosMock.get.mockImplementation((_url: string, config: { signal: AbortSignal }) => {
      sharedSignal = config.signal;
      return upstream;
    });
    const sendFileSpy = vi.spyOn(express.response, "sendFile").mockImplementation(function (this: { type: (contentType: string) => { send: (body: Buffer) => void } }, filePath: string) {
      this.type("image/png").send(fs.readFileSync(filePath));
    });

    const first = request(app).get("/images/proxy").query({ url: imageUrl }).then(response => response);
    await vi.waitFor(() => expect(axiosMock.get).toHaveBeenCalledTimes(1));
    const second = request(app).get("/images/proxy").query({ url: imageUrl }).then(response => response);

    await new Promise<void>(resolve => setTimeout(resolve, 125));
    const upstreamCalls = axiosMock.get.mock.calls.length;
    expect(internals.proxyDownloadAdmission.stats().reservedBytes).toBe(internals.MAX_PROXY_RESPONSE_BYTES);
    resolveUpstream!({
      status: 200,
      headers: { "content-type": "image/png" },
      data: lazyChunks([body]),
    });
    const [firstResponse, secondResponse] = await Promise.all([first, second]);

    expect(upstreamCalls).toBe(1);
    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(200);
    expect(firstResponse.body).toEqual(body);
    expect(secondResponse.body).toEqual(body);
    expect(sharedSignal?.aborted).toBe(false);
    expect(internals.proxyDownloadAdmission.stats().reservedBytes).toBe(0);
    await expect(fs.promises.readFile(internals.cachePathFromUrl(imageUrl))).resolves.toEqual(body);
    sendFileSpy.mockRestore();
  });

  it("shares one terminally rejected owner between concurrent subscribers before permitting a fresh owner", async () => {
    let rejectFirstOwner: (reason: unknown) => void;
    const firstOwner = new Promise<never>((_resolve, reject) => {
      rejectFirstOwner = reject;
    });
    const ownerSignals: AbortSignal[] = [];
    axiosMock.get.mockImplementation((_url: string, config: { signal: AbortSignal }) => {
      ownerSignals.push(config.signal);
      return firstOwner;
    });

    const first = request(app).get("/images/proxy").query({ url: imageUrl }).then(response => response);
    await vi.waitFor(() => expect(axiosMock.get).toHaveBeenCalledTimes(1));
    const second = request(app).get("/images/proxy").query({ url: imageUrl }).then(response => response);

    // Leave the physical owner pending long enough for the second request to
    // subscribe. A duplicate owner would call axios a second time here.
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(axiosMock.get).toHaveBeenCalledTimes(1);
    rejectFirstOwner!(new Error("shared upstream failure"));

    const [firstResponse, secondResponse] = await Promise.all([first, second]);
    expect(firstResponse.status).toBe(502);
    expect(secondResponse.status).toBe(502);
    expect(firstResponse.body).toEqual(secondResponse.body);
    expect(axiosMock.get).toHaveBeenCalledTimes(2); // getWithRetry permits two physical attempts per owner.
    expect(ownerSignals).toHaveLength(2);
    expect(ownerSignals[0]).toBe(ownerSignals[1]);

    const body = Buffer.from("fresh-owner-png");
    axiosMock.get.mockReset().mockImplementation((_url: string, config: { signal: AbortSignal }) => {
      ownerSignals.push(config.signal);
      return Promise.resolve({
        status: 200,
        headers: { "content-type": "image/png" },
        data: lazyChunks([body]),
      });
    });
    const sendFileSpy = vi.spyOn(express.response, "sendFile").mockImplementation(function (this: { type: (contentType: string) => { send: (body: Buffer) => void } }, filePath: string) {
      this.type("image/png").send(fs.readFileSync(filePath));
    });
    const freshResponse = await request(app).get("/images/proxy").query({ url: imageUrl });
    sendFileSpy.mockRestore();

    expect(freshResponse.status).toBe(200);
    expect(freshResponse.body).toEqual(body);
    expect(axiosMock.get).toHaveBeenCalledTimes(1);
    expect(ownerSignals).toHaveLength(3);
    expect(ownerSignals[2]).not.toBe(ownerSignals[0]);
  });

  it("keeps a shared download alive when its first subscriber disconnects", async () => {
    const body = Buffer.from("surviving-subscriber-png");
    let resolveUpstream: (response: { status: number; headers: { "content-type": string }; data: Readable }) => void;
    const upstream = new Promise<{ status: number; headers: { "content-type": string }; data: Readable }>(resolve => {
      resolveUpstream = resolve;
    });
    let sharedSignal: AbortSignal | undefined;
    axiosMock.get.mockImplementation((_url: string, config: { signal: AbortSignal }) => {
      sharedSignal = config.signal;
      return upstream;
    });
    const sendFileSpy = vi.spyOn(express.response, "sendFile").mockImplementation(function (this: { type: (contentType: string) => { send: (body: Buffer) => void } }, filePath: string) {
      this.type("image/png").send(fs.readFileSync(filePath));
    });

    const first = request(app).get("/images/proxy").query({ url: imageUrl });
    first.end(() => undefined);
    await vi.waitFor(() => expect(axiosMock.get).toHaveBeenCalledTimes(1));
    const survivor = request(app).get("/images/proxy").query({ url: imageUrl }).then(response => response);
    await new Promise(resolve => setTimeout(resolve, 25));
    first.abort();
    expect(sharedSignal?.aborted).toBe(false);

    resolveUpstream!({
      status: 200,
      headers: { "content-type": "image/png" },
      data: lazyChunks([body]),
    });
    const response = await survivor;
    sendFileSpy.mockRestore();

    expect(response.status).toBe(200);
    expect(response.body).toEqual(body);
    expect(axiosMock.get).toHaveBeenCalledTimes(1);
  });

  it("starts a new owner after a shared download failure", async () => {
    axiosMock.get.mockRejectedValue(new Error("first owner failed"));
    const failed = await request(app).get("/images/proxy").query({ url: imageUrl });
    expect(failed.status).toBe(502);

    const body = Buffer.from("replacement-owner-png");
    axiosMock.get.mockReset().mockResolvedValue({
      status: 200,
      headers: { "content-type": "image/png" },
      data: lazyChunks([body]),
    });
    const sendFileSpy = vi.spyOn(express.response, "sendFile").mockImplementation(function (this: { type: (contentType: string) => { send: (body: Buffer) => void } }, filePath: string) {
      this.type("image/png").send(fs.readFileSync(filePath));
    });
    const retry = await request(app).get("/images/proxy").query({ url: imageUrl });
    sendFileSpy.mockRestore();

    expect(retry.status).toBe(200);
    expect(retry.body).toEqual(body);
    expect(axiosMock.get).toHaveBeenCalledTimes(1);
  });

  it("does not evict an active owned temp path during a cache sweep", async () => {
    const gib = 1024 * 1024 * 1024;
    const activeTemp = path.join(cacheDirectory, "active-owner.tmp");
    const evictable = path.join(cacheDirectory, "evictable.png");
    internals.writeInProgress.add(activeTemp);
    const readdir = vi.spyOn(fs.promises, "readdir").mockResolvedValue(["active-owner.tmp", "evictable.png"] as never);
    const stat = vi.spyOn(fs.promises, "stat").mockImplementation(async filePath => ({
      isFile: () => true,
      atimeMs: String(filePath).endsWith("active-owner.tmp") ? 1 : 2,
      size: 7 * gib,
    }) as never);
    const unlink = vi.spyOn(fs.promises, "unlink").mockResolvedValue(undefined);
    dbModule.getDatabase().prepare(
      'INSERT INTO image_cache_metadata (basename, size, last_access) VALUES (?, ?, ?)',
    ).run('evictable.png', 7 * gib, 1);

    await internals.checkAndCleanCache();

    expect(unlink).toHaveBeenCalledTimes(1);
    expect(unlink).toHaveBeenCalledWith(evictable);
    expect(dbModule.getDatabase().prepare(
      'SELECT * FROM image_cache_metadata WHERE basename = ?',
    ).get('evictable.png')).toBeUndefined();
    internals.writeInProgress.delete(activeTemp);
    readdir.mockRestore();
    stat.mockRestore();
    unlink.mockRestore();
  });

  it("retains metadata when cache eviction unlink fails", async () => {
    const gib = 1024 * 1024 * 1024;
    const retained = path.join(cacheDirectory, "retained.png");
    const readdir = vi.spyOn(fs.promises, "readdir").mockResolvedValue(["retained.png"] as never);
    const stat = vi.spyOn(fs.promises, "stat").mockResolvedValue({
      isFile: () => true,
      atimeMs: 1,
      size: 13 * gib,
    } as never);
    const unlink = vi.spyOn(fs.promises, "unlink").mockRejectedValueOnce(new Error("EBUSY"));
    dbModule.getDatabase().prepare(
      'INSERT INTO image_cache_metadata (basename, size, last_access) VALUES (?, ?, ?)',
    ).run('retained.png', 13 * gib, 1);

    await internals.checkAndCleanCache();

    expect(unlink).toHaveBeenCalledWith(retained);
    expect(dbModule.getDatabase().prepare(
      'SELECT basename, size, last_access FROM image_cache_metadata WHERE basename = ?',
    ).get('retained.png')).toEqual({ basename: 'retained.png', size: 13 * gib, last_access: 1 });
    readdir.mockRestore();
    stat.mockRestore();
    unlink.mockRestore();
  });

  it("aborts a shared download only when its last subscriber disconnects, then permits a retry", async () => {
    let emitted = false;
    const source = new Readable({
      read() {
        if (emitted) return;
        emitted = true;
        this.push(Buffer.from("partial"));
      },
    });
    axiosMock.get.mockResolvedValueOnce({
      status: 200,
      headers: { "content-type": "image/png" },
      data: source,
    });

    const first = request(app).get("/images/proxy").query({ url: imageUrl });
    first.end(() => undefined);
    await vi.waitFor(() => expect(axiosMock.get).toHaveBeenCalledTimes(1));

    const second = request(app).get("/images/proxy").query({ url: imageUrl });
    second.end(() => undefined);
    await vi.waitFor(async () => expect((await fs.promises.readdir(cacheDirectory)).some(entry => entry.endsWith(".tmp"))).toBe(true));

    first.abort();
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(source.destroyed).toBe(false);

    second.abort();
    await vi.waitFor(() => expect(source.destroyed).toBe(true));
    await vi.waitFor(async () => expect(await fs.promises.readdir(cacheDirectory)).toEqual([]));

    const retryBody = Buffer.from("retry-png");
    axiosMock.get.mockResolvedValueOnce({
      status: 200,
      headers: { "content-type": "image/png" },
      data: lazyChunks([retryBody]),
    });
    const sendFileSpy = vi.spyOn(express.response, "sendFile").mockImplementation(function (this: { type: (contentType: string) => { send: (body: Buffer) => void } }, filePath: string) {
      this.type("image/png").send(fs.readFileSync(filePath));
    });
    const retry = await request(app).get("/images/proxy").query({ url: imageUrl });
    sendFileSpy.mockRestore();

    expect(retry.status).toBe(200);
    expect(retry.body).toEqual(retryBody);
    expect(axiosMock.get).toHaveBeenCalledTimes(2);
    await expect(fs.promises.readFile(internals.cachePathFromUrl(imageUrl))).resolves.toEqual(retryBody);
  });

  it("reserves one temporary-byte lease when a physical proxy owner starts", async () => {
    let resolveUpstream: (response: { status: number; headers: { "content-type": string }; data: Readable }) => void;
    axiosMock.get.mockImplementation(() => new Promise(resolve => {
      resolveUpstream = resolve;
    }));
    const sendFileSpy = vi.spyOn(express.response, "sendFile").mockImplementation(function (this: { type: (contentType: string) => { send: (body: Buffer) => void } }, filePath: string) {
      this.type("image/png").send(fs.readFileSync(filePath));
    });

    const pending = request(app).get("/images/proxy").query({ url: imageUrl }).then(response => response);
    await vi.waitFor(() => expect(axiosMock.get).toHaveBeenCalledTimes(1));
    expect(internals.proxyDownloadAdmission.stats()).toEqual({
      reservedBytes: internals.MAX_PROXY_RESPONSE_BYTES,
      maxBytes: internals.MAX_PROXY_DOWNLOAD_RESERVED_BYTES,
    });

    resolveUpstream!({
      status: 200,
      headers: { "content-type": "image/png" },
      data: lazyChunks([Buffer.from("settled")]),
    });
    await pending;
    sendFileSpy.mockRestore();
    expect(internals.proxyDownloadAdmission.stats().reservedBytes).toBe(0);
  });

  it("holds ten distinct physical owners at the 250 MiB envelope and starts the queued eleventh only after settlement", async () => {
    const urls = Array.from({ length: internals.MAX_PROXY_CONCURRENT_DOWNLOADS + 1 }, (_value, index) =>
      imageUrl.replace("ab123456-1234-1234-1234-123456789abc.png", `ab123456-1234-1234-1234-123456789ab${index.toString(16)}.png`)
    );
    const held = new Map<string, (response: { status: number; headers: { "content-type": string }; data: Readable }) => void>();
    axiosMock.get.mockImplementation((url: string) => new Promise(resolve => {
      held.set(url, resolve as (response: { status: number; headers: { "content-type": string }; data: Readable }) => void);
    }));
    const sendFileSpy = vi.spyOn(express.response, "sendFile").mockImplementation(function (this: { type: (contentType: string) => { send: (body: Buffer) => void } }, filePath: string) {
      this.type("image/png").send(fs.readFileSync(filePath));
    });

    const owners = urls.slice(0, 10).map(url => request(app).get("/images/proxy").query({ url }).then(response => response));
    await vi.waitFor(() => expect(axiosMock.get).toHaveBeenCalledTimes(10));
    expect(internals.proxyDownloadAdmission.stats()).toEqual({
      reservedBytes: 10 * internals.MAX_PROXY_RESPONSE_BYTES,
      maxBytes: internals.MAX_PROXY_DOWNLOAD_RESERVED_BYTES,
    });

    const queued = request(app).get("/images/proxy").query({ url: urls[10] }).then(response => response);
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(axiosMock.get).toHaveBeenCalledTimes(10);
    expect(internals.proxyDownloadAdmission.stats().reservedBytes).toBe(internals.MAX_PROXY_DOWNLOAD_RESERVED_BYTES);

    held.get(urls[0])!({ status: 200, headers: { "content-type": "image/png" }, data: lazyChunks([Buffer.from("first")]) });
    await vi.waitFor(() => expect(axiosMock.get).toHaveBeenCalledTimes(11));
    expect(internals.proxyDownloadAdmission.stats().reservedBytes).toBe(internals.MAX_PROXY_DOWNLOAD_RESERVED_BYTES);

    for (const url of urls.slice(1)) {
      held.get(url)!({ status: 200, headers: { "content-type": "image/png" }, data: lazyChunks([Buffer.from("settled")]) });
    }
    await Promise.all([...owners, queued]);
    sendFileSpy.mockRestore();
    expect(internals.proxyDownloadAdmission.stats().reservedBytes).toBe(0);
  });

  it("charges independent MPC physical owners through the shared admission", async () => {
    const held = new Map<string, (response: { status: number; headers: { "content-type": string }; data: Readable }) => void>();
    axiosMock.get.mockImplementation((url: string) => new Promise(resolve => {
      held.set(url, resolve as (response: { status: number; headers: { "content-type": string }; data: Readable }) => void);
    }));
    const sendFileSpy = vi.spyOn(express.response, "sendFile").mockImplementation(function (this: { type: (contentType: string) => { send: (body: Buffer) => void } }, filePath: string) {
      this.type("image/png").send(fs.readFileSync(filePath));
    });

    const first = request(app).get("/images/mpc").query({ id: "first-owner", size: "small" }).then(response => response);
    const second = request(app).get("/images/mpc").query({ id: "second-owner", size: "small" }).then(response => response);
    await vi.waitFor(() => expect(axiosMock.get).toHaveBeenCalledTimes(2));
    expect(internals.proxyDownloadAdmission.stats().reservedBytes).toBe(2 * internals.MAX_PROXY_RESPONSE_BYTES);

    for (const resolve of held.values()) {
      resolve({ status: 200, headers: { "content-type": "image/png" }, data: lazyChunks([Buffer.from("mpc")]) });
    }
    await Promise.all([first, second]);
    sendFileSpy.mockRestore();
    expect(internals.proxyDownloadAdmission.stats().reservedBytes).toBe(0);
  });

  it("re-admits an MPC fallback stream after its settled predecessor fails", async () => {
    let emitted = false;
    const failedStream = new Readable({
      read() {
        if (emitted) return;
        emitted = true;
        this.push(Buffer.from("partial"));
        queueMicrotask(() => this.destroy(new Error("candidate failed")));
      },
    });
    let resolveFallback: (response: { status: number; headers: { "content-type": string }; data: Readable }) => void;
    axiosMock.get
      .mockResolvedValueOnce({ status: 200, headers: { "content-type": "image/png" }, data: failedStream })
      .mockImplementationOnce(() => new Promise(resolve => {
        resolveFallback = resolve;
      }));
    const sendFileSpy = vi.spyOn(express.response, "sendFile").mockImplementation(function (this: { type: (contentType: string) => { send: (body: Buffer) => void } }, filePath: string) {
      this.type("image/png").send(fs.readFileSync(filePath));
    });

    const pending = request(app).get("/images/mpc").query({ id: "fallback-owner", size: "full" }).then(response => response);
    await vi.waitFor(() => expect(axiosMock.get).toHaveBeenCalledTimes(2));
    expect(internals.proxyDownloadAdmission.stats().reservedBytes).toBe(internals.MAX_PROXY_RESPONSE_BYTES);

    resolveFallback!({ status: 200, headers: { "content-type": "image/png" }, data: lazyChunks([Buffer.from("fallback")]) });
    await pending;
    sendFileSpy.mockRestore();
    expect(internals.proxyDownloadAdmission.stats().reservedBytes).toBe(0);
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
