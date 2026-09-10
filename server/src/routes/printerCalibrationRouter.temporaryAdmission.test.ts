import { once } from "node:events";
import http from "node:http";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

const filesystemState = vi.hoisted(() => ({
  tmpdir: "",
}));

vi.mock("os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("os")>();
  const tmpdir = () => filesystemState.tmpdir;
  return {
    ...actual,
    tmpdir,
    default: { ...actual, tmpdir },
  };
});

import {
  CALIBRATION_AGGREGATE_TEMP_LIMIT_BYTES,
  CALIBRATION_OUTPUT_LIMIT_BYTES,
  createPrinterCalibrationRouter,
} from "./printerCalibrationRouter.js";
import {
  createCalibrationTemporaryFileCleanupReconciler,
  createCalibrationTemporaryFileAdmission,
} from "./calibrationTemporaryFileAdmission.js";

async function fixtureDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "proxxied-calibration-admission-"));
  filesystemState.tmpdir = directory;
  return directory;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitFor(condition: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for calibration admission to settle");
}

type RouterOptions = NonNullable<Parameters<typeof createPrinterCalibrationRouter>[0]>;

function createApp(
  directory: string,
  admission: ReturnType<typeof createCalibrationTemporaryFileAdmission>,
  runCli: RouterOptions["runCli"],
  temporaryFileCleanup?: RouterOptions["temporaryFileCleanup"]
): express.Express {
  const app = express();
  app.use((req, _res, next) => {
    req.privateIdentity = {
      ownerId: "admission-test-owner",
      capabilities: new Set(["calibration:write"]),
      transport: "server",
    };
    next();
  });
  app.use(
    "/api/printer-calibration",
    createPrinterCalibrationRouter({
      dataDirectory: path.join(directory, "data"),
      runCli,
      temporaryFileAdmission: admission,
      temporaryFileCleanup,
      privateRouteAuth: { private: () => (_req, _res, next) => next() },
    })
  );
  return app;
}

function streamedPdf(): Readable {
  return Readable.from([Buffer.from("%PDF-1.4\nstreamed input\n")]);
}

async function writeCalibrationOutput(args: string[]): Promise<void> {
  const outputPath = args[args.indexOf("--output") + 1];
  await fs.writeFile(outputPath, "%PDF-1.4\ncalibrated\n");
}

describe("printer calibration temporary-file admission", () => {
  it("rejects a second concurrent upload because each apply reserves its input and output ceilings", async () => {
    const directory = await fixtureDirectory();
    const admission = createCalibrationTemporaryFileAdmission({
      maxBytes: CALIBRATION_AGGREGATE_TEMP_LIMIT_BYTES,
    });
    const firstRunnerStarted = deferred<void>();
    const finishRunner = deferred<void>();
    let runnerCalls = 0;
    const app = createApp(directory, admission, async (args) => {
      runnerCalls += 1;
      firstRunnerStarted.resolve();
      await finishRunner.promise;
      await writeCalibrationOutput(args);
      return { stdout: "", stderr: "" };
    });

    const first = request(app)
      .post("/api/printer-calibration/apply")
      .field("profileName", "office")
      .attach("file", streamedPdf() as unknown as import("node:fs").ReadStream, { filename: "unknown-size.pdf", contentType: "application/pdf" });
    const firstResult = new Promise<request.Response>((resolve, reject) => {
      first.end((error, response) => {
        if (error) reject(error);
        else resolve(response);
      });
    });
    await firstRunnerStarted.promise;

    const rejected = await request(app)
      .post("/api/printer-calibration/apply")
      .field("profileName", "office")
      .attach("file", Buffer.from("%PDF-1.4\nknown-size input\n"), "known-size.pdf");

    expect(rejected.status).toBe(503);
    expect(runnerCalls).toBe(1);
    expect(admission.stats()).toEqual({
      reservedBytes: CALIBRATION_AGGREGATE_TEMP_LIMIT_BYTES,
      maxBytes: CALIBRATION_AGGREGATE_TEMP_LIMIT_BYTES,
    });

    finishRunner.resolve();
    await expect(firstResult).resolves.toEqual(expect.objectContaining({ status: 200 }));
    await waitFor(() => admission.stats().reservedBytes === 0);
  });

  it("releases the reservation after a runner error and removes only its test-owned temp file", async () => {
    const directory = await fixtureDirectory();
    const admission = createCalibrationTemporaryFileAdmission({
      maxBytes: CALIBRATION_AGGREGATE_TEMP_LIMIT_BYTES,
    });
    const app = createApp(directory, admission, async () => {
      throw new Error("runner failed");
    });

    const response = await request(app)
      .post("/api/printer-calibration/apply")
      .field("profileName", "office")
      .attach("file", streamedPdf() as unknown as import("node:fs").ReadStream, { filename: "runner-error.pdf", contentType: "application/pdf" });

    expect(response.status).toBe(500);
    await waitFor(() => admission.stats().reservedBytes === 0);
    expect(await fs.readdir(directory)).toEqual([]);
  });

  it("keeps exact owned input and output files reserved until an aborted calibration writer settles", async () => {
    const directory = await fixtureDirectory();
    const sentinelPath = path.join(directory, "unrelated-sentinel.pdf");
    await fs.writeFile(sentinelPath, "must survive another request cleanup");
    const admission = createCalibrationTemporaryFileAdmission({
      maxBytes: CALIBRATION_AGGREGATE_TEMP_LIMIT_BYTES,
    });
    const runnerStarted = deferred<void>();
    const runnerCancelled = deferred<void>();
    const settleWriter = deferred<void>();
    let outputPath = "";
    const app = createApp(directory, admission, async (args, options) => {
      outputPath = args[args.indexOf("--output") + 1]!;
      await fs.writeFile(outputPath, "%PDF-1.4\nwriter-open\n");
      runnerStarted.resolve();
      return new Promise((_resolve, reject) => {
        options?.signal?.addEventListener(
          "abort",
          () => {
            runnerCancelled.resolve();
            void settleWriter.promise.then(async () => {
              await fs.appendFile(outputPath, "writer-settled\n");
              reject(new Error("request cancelled"));
            });
          },
          { once: true }
        );
      });
    });
    const server = app.listen(0);
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected TCP test listener");
    const boundary = "calibration-admission-boundary";
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="profileName"\r\n\r\noffice\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="cancel.pdf"\r\nContent-Type: application/pdf\r\n\r\n%PDF-1.4\ncancel\n\r\n--${boundary}--\r\n`),
    ]);

    try {
      const client = http.request({
        host: "127.0.0.1",
        port: address.port,
        method: "POST",
        path: "/api/printer-calibration/apply",
        headers: {
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          "Content-Length": String(body.length),
        },
      });
      client.on("error", () => undefined);
      client.end(body);
      await runnerStarted.promise;
      client.destroy();

      await runnerCancelled.promise;
      expect(admission.stats().reservedBytes).toBe(CALIBRATION_AGGREGATE_TEMP_LIMIT_BYTES);
      expect(await fs.readFile(outputPath, "utf8")).toContain("writer-open");
      expect(await fs.readdir(directory)).toEqual(
        expect.arrayContaining([
          path.basename(sentinelPath),
          path.basename(outputPath),
          expect.stringContaining("-upload-"),
        ])
      );

      settleWriter.resolve();
      await waitFor(() => admission.stats().reservedBytes === 0);
      expect(await fs.readdir(directory)).toEqual([path.basename(sentinelPath)]);
    } finally {
      server.close();
      await once(server, "close");
    }
  });

  it("removes only the owned partial multipart upload after the client disconnects before Multer completes", async () => {
    const directory = await fixtureDirectory();
    const sentinelPath = path.join(directory, "unrelated-sentinel.pdf");
    await fs.writeFile(sentinelPath, "must survive another request cleanup");
    const admission = createCalibrationTemporaryFileAdmission({
      maxBytes: CALIBRATION_AGGREGATE_TEMP_LIMIT_BYTES,
    });
    const runCli = vi.fn(async () => ({ stdout: "", stderr: "" }));
    const app = createApp(directory, admission, runCli);
    const server = app.listen(0);
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected TCP test listener");
    const boundary = "partial-calibration-admission-boundary";

    try {
      const client = http.request({
        host: "127.0.0.1",
        port: address.port,
        method: "POST",
        path: "/api/printer-calibration/apply",
        headers: {
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
        },
      });
      client.on("error", () => undefined);
      client.write(
        `--${boundary}\r\nContent-Disposition: form-data; name="profileName"\r\n\r\noffice\r\n` +
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="partial.pdf"\r\n` +
          "Content-Type: application/pdf\r\n\r\n%PDF-1.4\npartial upload"
      );

      await waitFor(async () =>
        (await fs.readdir(directory)).some((name) => name.includes("-upload-"))
      );
      expect(admission.stats().reservedBytes).toBe(CALIBRATION_AGGREGATE_TEMP_LIMIT_BYTES);
      client.destroy();

      await waitFor(() => admission.stats().reservedBytes === 0);
      expect(runCli).not.toHaveBeenCalled();
      expect(await fs.readdir(directory)).toEqual([path.basename(sentinelPath)]);
    } finally {
      server.close();
      await once(server, "close");
    }
  });

  it("keeps owned calibration files until a disconnected download has read output bytes", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const directory = await fixtureDirectory();
    const sentinelPath = path.join(directory, "unrelated-sentinel.pdf");
    await fs.writeFile(sentinelPath, "must survive another request cleanup");
    const admission = createCalibrationTemporaryFileAdmission({
      maxBytes: CALIBRATION_AGGREGATE_TEMP_LIMIT_BYTES,
    });
    const outputWritten = deferred<void>();
    let outputPath = "";
    const app = createApp(directory, admission, async (args) => {
      outputPath = args[args.indexOf("--output") + 1]!;
      await fs.writeFile(outputPath, Buffer.alloc(512 * 1024, 0x61));
      outputWritten.resolve();
      return { stdout: "", stderr: "" };
    });
    const server = app.listen(0);
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected TCP test listener");
    const boundary = "download-calibration-admission-boundary";
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="profileName"\r\n\r\noffice\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="download.pdf"\r\nContent-Type: application/pdf\r\n\r\n%PDF-1.4\ndownload\n\r\n--${boundary}--\r\n`),
    ]);
    const firstOutputByte = deferred<void>();

    try {
      const client = http.request({
        host: "127.0.0.1",
        port: address.port,
        method: "POST",
        path: "/api/printer-calibration/apply",
        headers: {
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          "Content-Length": String(body.length),
        },
      });
      client.on("error", () => undefined);
      client.once("response", (response) => {
        response.once("data", () => {
          void fs.access(outputPath).then(
            () => {
              client.destroy();
              firstOutputByte.resolve();
            },
            firstOutputByte.reject
          );
        });
      });
      client.end(body);

      await outputWritten.promise;
      await firstOutputByte.promise;
      await waitFor(() => admission.stats().reservedBytes === 0);
      expect(await fs.readdir(directory)).toEqual([path.basename(sentinelPath)]);
    } finally {
      consoleError.mockRestore();
      server.close();
      await once(server, "close");
    }
  });

  it("reserves the sheet output and passes its writer limit through the CLI", async () => {
    const directory = await fixtureDirectory();
    const admission = createCalibrationTemporaryFileAdmission({
      maxBytes: CALIBRATION_OUTPUT_LIMIT_BYTES,
    });
    let receivedArgs: string[] = [];
    const app = createApp(directory, admission, async (args) => {
      receivedArgs = args;
      await writeCalibrationOutput(args);
      return { stdout: "", stderr: "" };
    });

    const response = await request(app).get("/api/printer-calibration/sheet");

    expect(response.status).toBe(200);
    expect(receivedArgs).toContain("--max-output-bytes");
    expect(receivedArgs[receivedArgs.indexOf("--max-output-bytes") + 1]).toBe(
      String(CALIBRATION_OUTPUT_LIMIT_BYTES)
    );
    await waitFor(() => admission.stats().reservedBytes === 0);
  });

  it("serves a valid calibration output and releases its final reservation", async () => {
    const directory = await fixtureDirectory();
    const admission = createCalibrationTemporaryFileAdmission({
      maxBytes: CALIBRATION_AGGREGATE_TEMP_LIMIT_BYTES,
    });
    let receivedArgs: string[] = [];
    const app = createApp(directory, admission, async (args) => {
      receivedArgs = args;
      await writeCalibrationOutput(args);
      return { stdout: "", stderr: "" };
    });

    const response = await request(app)
      .post("/api/printer-calibration/apply")
      .field("profileName", "office")
      .attach("file", Buffer.from("%PDF-1.4\nvalid\n"), "valid.pdf");

    expect(response.status).toBe(200);
    expect(response.header["content-type"]).toContain("application/pdf");
    expect(receivedArgs[receivedArgs.indexOf("--max-output-bytes") + 1]).toBe(
      String(CALIBRATION_OUTPUT_LIMIT_BYTES)
    );
    await waitFor(() => admission.stats().reservedBytes === 0);
  });

  it("reconciles a transient upload unlink failure and admits a later full apply", async () => {
    const directory = await fixtureDirectory();
    const admission = createCalibrationTemporaryFileAdmission({
      maxBytes: CALIBRATION_AGGREGATE_TEMP_LIMIT_BYTES,
    });
    const retryCallbacks: Array<() => void> = [];
    let failedUploadUnlink = false;
    const unlink = vi.fn(async (filePath: string) => {
      if (!failedUploadUnlink && filePath.includes("-upload-")) {
        failedUploadUnlink = true;
        throw new Error("temporary EBUSY");
      }
      await fs.unlink(filePath);
    });
    const cleanup = createCalibrationTemporaryFileCleanupReconciler({
      unlink,
      scheduleRetry: (callback) => retryCallbacks.push(callback),
      log: () => undefined,
    });
    const app = createApp(directory, admission, async (args) => {
      await writeCalibrationOutput(args);
      return { stdout: "", stderr: "" };
    }, cleanup);

    const first = await request(app)
      .post("/api/printer-calibration/apply")
      .field("profileName", "office")
      .attach("file", Buffer.from("%PDF-1.4\nfirst\n"), "first.pdf");

    expect(first.status).toBe(200);
    await waitFor(() => admission.stats().reservedBytes === CALIBRATION_OUTPUT_LIMIT_BYTES);
    expect(retryCallbacks).toHaveLength(1);

    retryCallbacks.shift()?.();
    await waitFor(() => admission.stats().reservedBytes === 0);

    const second = await request(app)
      .post("/api/printer-calibration/apply")
      .field("profileName", "office")
      .attach("file", Buffer.from("%PDF-1.4\nsecond\n"), "second.pdf");

    expect(second.status).toBe(200);
    await waitFor(() => admission.stats().reservedBytes === 0);
    expect(unlink.mock.calls.some(([filePath]) => String(filePath).includes("-upload-"))).toBe(true);
    expect(unlink.mock.calls.some(([filePath]) => String(filePath).includes("-output-"))).toBe(true);
  });

  it("reconciles the owned sheet output after a transient unlink failure", async () => {
    const directory = await fixtureDirectory();
    const admission = createCalibrationTemporaryFileAdmission({
      maxBytes: CALIBRATION_OUTPUT_LIMIT_BYTES,
    });
    const retryCallbacks: Array<() => void> = [];
    const unlink = vi
      .fn<(filePath: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error("temporary EBUSY"))
      .mockImplementation(async (filePath) => fs.unlink(filePath));
    const cleanup = createCalibrationTemporaryFileCleanupReconciler({
      unlink,
      scheduleRetry: (callback) => retryCallbacks.push(callback),
      log: () => undefined,
    });
    const app = createApp(directory, admission, async (args) => {
      await writeCalibrationOutput(args);
      return { stdout: "", stderr: "" };
    }, cleanup);

    const response = await request(app).get("/api/printer-calibration/sheet");

    expect(response.status).toBe(200);
    await waitFor(() => admission.stats().reservedBytes === CALIBRATION_OUTPUT_LIMIT_BYTES);
    expect(retryCallbacks).toHaveLength(1);
    expect(unlink).toHaveBeenCalledWith(expect.stringContaining("-sheet-"));

    retryCallbacks.shift()?.();
    await waitFor(() => admission.stats().reservedBytes === 0);
    expect(unlink).toHaveBeenCalledTimes(2);
  });
});
