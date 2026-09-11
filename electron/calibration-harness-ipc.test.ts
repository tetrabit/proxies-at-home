import { EventEmitter } from "node:events";
import { setImmediate } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import {
  CalibrationHarnessPrivateConfig,
  type CalibrationHarnessConfigLoadResult,
} from "./calibration-harness-config.js";
import {
  createCalibrationHarnessBroker,
  type CalibrationHarnessBroker,
} from "./calibration-harness-broker.js";
import { registerCalibrationHarnessIpcHandlers } from "./calibration-harness-ipc.js";

const snapshot = { version: 1, datasets: [], cases: [], assets: [], runs: [] };
const hash = "a".repeat(64);
const configured: CalibrationHarnessConfigLoadResult = Object.freeze({
  kind: "configured" as const,
  config: CalibrationHarnessPrivateConfig.fromValues({
    backendOrigin: "https://calibration.invalid",
    credential: `calibration_pair_${"a".repeat(43)}`,
    harnessId: "synthetic-harness",
  }),
  file: Object.freeze({ byteLength: 0, mode: 0o600 }),
  platformSecurity: process.platform === "win32" ? "best-effort-acl" as const : "posix-owner-mode" as const,
});

type Handler = (event: unknown, operation: unknown) => Promise<unknown>;

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function fixture({
  execute = vi.fn(async (operation: { kind: string }) => ({ ownerId: "owner", harnessId: operation.kind })),
  loadConfig = vi.fn(async () => configured),
  current,
}: {
  execute?: CalibrationHarnessBroker["execute"];
  loadConfig?: (filename: string) => Promise<CalibrationHarnessConfigLoadResult>;
  current?: { value: ReturnType<typeof webContents> | null };
} = {}) {
  const handlers = new Map<string, Handler>();
  const ipcMain = {
    handle: vi.fn((channel: string, handler: Handler) => handlers.set(channel, handler)),
    removeHandler: vi.fn((channel: string) => handlers.delete(channel)),
  };
  const source = current?.value ?? webContents("http://localhost:5173/?serverPort=3001");
  const main = current ?? { value: source };
  const dispose = registerCalibrationHarnessIpcHandlers({
    ipcMain,
    getMainWebContents: () => main.value,
    expectedRendererUrl: () => "http://localhost:5173/?serverPort=3001",
    configPath: () => "/operator-only/calibration-harness.connection.json",
    loadConfig,
    createBroker: vi.fn(() => ({ execute })),
  });
  const event = { sender: source, senderFrame: source.mainFrame };
  const invoke = (operation: unknown = { kind: "getSession" }) =>
    handlers.get("calibration-harness:execute")?.(event, operation);
  return { handlers, ipcMain, source, main, loadConfig, execute, dispose, invoke };
}

function webContents(url: string) {
  return Object.assign(new EventEmitter(), {
    isDestroyed: vi.fn(() => false),
    mainFrame: { url },
  });
}

describe("calibration harness IPC", () => {
  it("forwards every accepted operation through the one fixed handler", async () => {
    const test = fixture();
    const operations = [
      { kind: "getSession" },
      { kind: "getSnapshot" },
      { kind: "publishSnapshot", snapshot, expectedRevision: null },
      { kind: "getBlob", sha256: hash },
      { kind: "putBlob", sha256: hash, bytes: new Uint8Array([1]) },
      { kind: "missingBlobs", hashes: [hash] },
    ];
    try {
      for (const operation of operations) {
        await expect(test.invoke(operation)).resolves.toMatchObject({ ok: true });
      }
      expect(test.ipcMain.handle).toHaveBeenCalledTimes(1);
      expect(test.execute).toHaveBeenNthCalledWith(1, operations[0]);
      expect(test.execute).toHaveBeenNthCalledWith(6, operations[5]);
      expect(test.loadConfig).toHaveBeenCalledWith("/operator-only/calibration-harness.connection.json");
    } finally {
      await test.dispose();
    }
  });

  it("denies foreign hosts, subframes, destroyed senders, and sender read errors before config loading", async () => {
    const test = fixture();
    try {
      test.source.mainFrame.url = "file://foreign.invalid/owned/app/index.html?serverPort=3001";
      await expect(test.invoke()).resolves.toEqual({ ok: false, error: { code: "invalid-operation" } });
      test.source.mainFrame.url = "http://localhost:5173/?serverPort=3001";
      await expect(test.handlers.get("calibration-harness:execute")?.({ sender: test.source, senderFrame: {} }, { kind: "getSession" }))
        .resolves.toEqual({ ok: false, error: { code: "invalid-operation" } });
      test.source.isDestroyed.mockReturnValue(true);
      await expect(test.invoke()).resolves.toEqual({ ok: false, error: { code: "invalid-operation" } });
      expect(test.loadConfig).not.toHaveBeenCalled();
      expect(test.execute).not.toHaveBeenCalled();
    } finally {
      await test.dispose();
    }
  });

  it.each([401, 403, 404, 412, 428, 503])("preserves safe typed HTTP status %i without raw broker errors", async (status) => {
    const test = fixture({
      execute: vi.fn(async () => { throw Object.assign(new Error("private credential sentinel"), { code: "http", status }); }),
    });
    try {
      await expect(test.invoke()).resolves.toEqual({ ok: false, error: { code: "http", status } });
    } finally {
      await test.dispose();
    }
  });

  it("delegates malformed operations to the real E1 admission boundary with zero transport calls", async () => {
    const fetch = vi.fn();
    const test = fixture({
      execute: createCalibrationHarnessBroker(configured, { fetch }).execute,
    });
    try {
      await expect(test.invoke({ kind: "getSession", unexpected: true })).resolves.toEqual({
        ok: false,
        error: { code: "invalid-operation" },
      });
      await expect(test.invoke({ kind: "missingBlobs", hashes: [hash, hash] })).resolves.toEqual({
        ok: false,
        error: { code: "invalid-operation" },
      });
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      await test.dispose();
    }
  });

  it("aborts the main-owned transport on a main-frame navigation and removes its listener", async () => {
    const entered = deferred<void>();
    const release = deferred<void>();
    const execute = vi.fn(async () => {
      entered.resolve();
      await release.promise;
      return { ownerId: "owner", harnessId: "harness" };
    });
    const test = fixture({
      execute,
    });
    try {
      const pending = test.invoke();
      await entered.promise;
      test.source.emit("did-start-navigation", {}, "https://foreign.invalid/", false, true, 0, 0);
      await setImmediate();
      expect(test.source.listenerCount("did-start-navigation")).toBe(1);
      release.resolve();
      await expect(pending).resolves.toEqual({ ok: false, error: { code: "aborted" } });
      expect(test.source.listenerCount("did-start-navigation")).toBe(0);
      expect(execute).toHaveBeenCalledOnce();
    } finally {
      release.resolve();
      await test.dispose();
    }
  });

  it("preserves same-document navigation while an operation is pending", async () => {
    const entered = deferred<void>();
    const release = deferred<void>();
    const test = fixture({
      execute: vi.fn(async () => {
        entered.resolve();
        await release.promise;
        return { ownerId: "owner", harnessId: "harness" };
      }),
    });
    try {
      const pending = test.invoke();
      await entered.promise;
      test.source.emit("did-start-navigation", {}, "http://localhost:5173/?serverPort=3001#hash", true, true, 0, 0);
      release.resolve();
      await expect(pending).resolves.toEqual({ ok: true, value: { ownerId: "owner", harnessId: "harness" } });
    } finally {
      release.resolve();
      await test.dispose();
    }
  });

  it("aborts the main-owned transport when its web contents is destroyed", async () => {
    const entered = deferred<void>();
    const release = deferred<void>();
    const test = fixture({
      execute: vi.fn(async () => {
        entered.resolve();
        await release.promise;
        return { ownerId: "owner", harnessId: "harness" };
      }),
    });
    try {
      const pending = test.invoke();
      await entered.promise;
      test.source.emit("destroyed");
      await setImmediate();
      release.resolve();
      await expect(pending).resolves.toEqual({ ok: false, error: { code: "aborted" } });
      expect(test.source.listenerCount("destroyed")).toBe(0);

    } finally {
      release.resolve();
      await test.dispose();
    }
  });

  it("prevents a replacement window from starting a broker after configuration settles", async () => {
    const configuration = deferred<CalibrationHarnessConfigLoadResult>();
    const current = { value: webContents("http://localhost:5173/?serverPort=3001") };
    const test = fixture({ current, loadConfig: vi.fn(() => configuration.promise) });
    try {
      const pending = test.invoke();
      current.value = webContents("http://localhost:5173/?serverPort=3001");
      configuration.resolve(configured);
      await expect(pending).resolves.toEqual({ ok: false, error: { code: "aborted" } });
      expect(test.execute).not.toHaveBeenCalled();
    } finally {
      configuration.resolve(configured);
      await test.dispose();
    }
  });

  it("waits for an aborted operation to settle before idempotent disposal resolves", async () => {
    const entered = deferred<void>();
    const release = deferred<void>();
    const test = fixture({
      execute: vi.fn(async () => {
        entered.resolve();
        await release.promise;
        return { ownerId: "owner", harnessId: "harness" };
      }),
    });
    const pending = test.invoke();
    await entered.promise;
    let settled = false;
    const disposing = test.dispose().then(() => { settled = true; });
    try {
      await setImmediate();
      expect(settled).toBe(false);
      expect(test.ipcMain.removeHandler).toHaveBeenCalledWith("calibration-harness:execute");
      release.resolve();
      await Promise.all([pending, disposing, test.dispose()]);
      expect(test.ipcMain.removeHandler).toHaveBeenCalledTimes(1);
    } finally {
      release.resolve();
      await Promise.allSettled([pending, disposing]);
    }
  });
});
