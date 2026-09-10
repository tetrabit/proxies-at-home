import { once } from "node:events";
import http from "node:http";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
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

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (condition()) return;
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

  it("releases a known-size upload reservation after the client cancels an active calibration", async () => {
    const directory = await fixtureDirectory();
    const admission = createCalibrationTemporaryFileAdmission({
      maxBytes: CALIBRATION_AGGREGATE_TEMP_LIMIT_BYTES,
    });
    const runnerStarted = deferred<void>();
    const runnerCancelled = deferred<void>();
    const app = createApp(directory, admission, async (_args, options) => {
      runnerStarted.resolve();
      return new Promise((_resolve, reject) => {
        options?.signal?.addEventListener(
          "abort",
          () => {
            runnerCancelled.resolve();
            reject(new Error("request cancelled"));
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
      await waitFor(() => admission.stats().reservedBytes === 0);
      expect(await fs.readdir(directory)).toEqual([]);
    } finally {
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
