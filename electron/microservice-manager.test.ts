import { EventEmitter } from "events";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const emittedEsmFixtureDirectory = path.join(
  repositoryRoot,
  ".review-artifacts",
  "electron-esm-path-01"
);

const appMock = {
  isPackaged: false,
  getPath: vi.fn(() => "/tmp/proxxied-user-data"),
};

const existsSyncMock = vi.fn();
const mkdirSyncMock = vi.fn();
const spawnMock = vi.fn();
const httpRequestMock = vi.fn();
let connectMode:
  | "success"
  | "error"
  | "timeout"
  | "pending"
  | "wrong-listener"
  | "http-503"
  | "hung" = "success";
let pendingHealthCallbacks: Array<() => void> = [];
let lastChildProcess: ReturnType<typeof createChildProcess> | null = null;

function respondToHealthRequest(
  callback: (response: EventEmitter & { statusCode: number }) => void,
  statusCode: number,
  body: unknown
) {
  const response = new EventEmitter() as EventEmitter & { statusCode: number };
  response.statusCode = statusCode;
  callback(response);
  response.emit("data", JSON.stringify(body));
  response.emit("end");
}

vi.mock("electron", () => ({ app: appMock }));
vi.mock("fs", () => ({
  default: {
    existsSync: existsSyncMock,
    mkdirSync: mkdirSyncMock,
  },
}));
vi.mock("child_process", () => ({ spawn: spawnMock }));
vi.mock("http", () => ({ default: { request: httpRequestMock } }));

function createChildProcess() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    killed: boolean;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = vi.fn((signal?: string) => {
    child.killed = signal !== undefined;
    child.emit("exit", 0, signal ?? null);
    return true;
  });
  lastChildProcess = child;
  return child;
}

describe("MicroserviceManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    existsSyncMock.mockImplementation((checkedPath: string) =>
      checkedPath.includes("cache-bin")
    );
    mkdirSyncMock.mockReturnValue(undefined);
    connectMode = "success";
    pendingHealthCallbacks = [];
    lastChildProcess = null;
    spawnMock.mockImplementation(() => createChildProcess());
    httpRequestMock.mockImplementation(
      (_options: unknown, callback: (response: EventEmitter & { statusCode: number }) => void) => {
        const request = new EventEmitter() as EventEmitter & {
          destroy: ReturnType<typeof vi.fn>;
          end: ReturnType<typeof vi.fn>;
        };
        request.destroy = vi.fn();
        request.end = vi.fn(() => {
          if (connectMode === "success") {
            respondToHealthRequest(callback, 200, {
              service: "scryfall-cache",
              status: "healthy",
              version: "0.1.0",
            });
          } else if (connectMode === "wrong-listener") {
            respondToHealthRequest(callback, 200, {
              service: "another-service",
              status: "healthy",
              version: "0.1.0",
            });
          } else if (connectMode === "http-503") {
            respondToHealthRequest(callback, 503, {
              service: "scryfall-cache",
              status: "healthy",
              version: "0.1.0",
            });
          } else if (connectMode === "error") {
            setTimeout(() => request.emit("error", new Error("connection refused")), 0);
          } else if (connectMode === "pending") {
            pendingHealthCallbacks.push(() =>
              respondToHealthRequest(callback, 200, {
                service: "scryfall-cache",
                status: "healthy",
                version: "0.1.0",
              })
            );
          } else if (connectMode === "hung") {
            const response = new EventEmitter() as EventEmitter & { statusCode: number };
            response.statusCode = 200;
            callback(response);
          }
        });
        return request;
      }
    );
    appMock.isPackaged = false;
    appMock.getPath.mockReturnValue("/tmp/proxxied-user-data");
  });

  it("creates the default Scryfall microservice configuration", async () => {
    const { createScryfallMicroservice } =
      await import("./microservice-manager");

    const manager = createScryfallMicroservice(9090);

    expect(manager.getPort()).toBe(9090);
    expect(manager.isRunning()).toBe(false);
  });

  it("resolves the development binary from its emitted ESM module URL", async () => {
    const childProcess = process.getBuiltinModule("node:child_process");
    const fsPromises = process.getBuiltinModule("node:fs/promises");
    if (!childProcess || !fsPromises) {
      throw new Error("Node built-in modules are unavailable for the emitted ESM probe");
    }
    const { execFileSync } = childProcess;
    const { mkdir, writeFile } = fsPromises;
    await mkdir(emittedEsmFixtureDirectory, { recursive: true });
    const electronStub = path.join(emittedEsmFixtureDirectory, "electron-stub.mjs");
    const loader = path.join(emittedEsmFixtureDirectory, "electron-loader.mjs");
    const probe = path.join(emittedEsmFixtureDirectory, "emitted-esm-probe.mjs");
    await writeFile(
      electronStub,
      'export const app = { isPackaged: false, getPath: () => "" };\n'
    );
    await writeFile(
      loader,
      `const electronStub = new URL("./electron-stub.mjs", import.meta.url).href;
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "electron") {
    return { url: electronStub, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
`
    );
    await writeFile(
      probe,
      `import { MicroserviceManager } from "../../electron/dist/microservice-manager.js";
const config = { binaryName: "cache-bin" };
console.log(MicroserviceManager.prototype.getBinaryPath.call({ config }));
`
    );

    execFileSync(
      path.join(repositoryRoot, "node_modules", ".bin", "tsc"),
      ["-p", "electron/tsconfig.json"],
      { cwd: repositoryRoot, stdio: "pipe" }
    );
    const emittedPath = execFileSync(
      process.execPath,
      ["--experimental-loader", loader, probe],
      { cwd: repositoryRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
    ).trim();

    expect(emittedPath).toBe(
      path.join(
        repositoryRoot,
        "..",
        "scryfall-cache-microservice",
        "target",
        "release",
        "cache-bin"
      )
    );
  });

  it("starts an injected harness launch with deterministic environment and stops it cleanly", async () => {
    const { MicroserviceManager } = await import("./microservice-manager");
    const harnessLaunch = {
      command: process.execPath,
      args: ["/review-fixture/health-child.cjs"],
    };
    existsSyncMock.mockImplementation(
      (checkedPath: string) => checkedPath === process.execPath
    );
    const manager = new MicroserviceManager(
      {
        name: "Cache",
        binaryName: "cache-bin",
        port: 7777,
        healthCheckPath: "/health",
        healthCheckInterval: 60_000,
        maxRestarts: 1,
        restartDelay: 10,
      },
      { resolveLaunch: () => harnessLaunch }
    );

    await expect(manager.start()).resolves.toBe(7777);

    expect(spawnMock).toHaveBeenCalledWith(
      process.execPath,
      harnessLaunch.args,
      expect.objectContaining({
        env: expect.objectContaining({
          PORT: "7777",
          RUST_LOG: "info",
          DATABASE_URL: "/tmp/proxxied-user-data/databases/scryfall-cache.db",
        }),
        stdio: ["ignore", "pipe", "pipe"],
      })
    );
    expect(mkdirSyncMock).toHaveBeenCalledWith(
      "/tmp/proxxied-user-data/databases",
      {
        recursive: true,
      }
    );
    expect(manager.isRunning()).toBe(true);

    await manager.stop();

    expect(manager.isRunning()).toBe(false);
  });

  it("returns the configured port when start is called while already running", async () => {
    const { MicroserviceManager } = await import("./microservice-manager");
    const manager = new MicroserviceManager({
      name: "Cache",
      binaryName: "cache-bin",
      port: 7777,
      healthCheckPath: "/health",
      healthCheckInterval: 60_000,
      maxRestarts: 1,
      restartDelay: 10,
    });

    await manager.start();
    await expect(manager.start()).resolves.toBe(7777);

    expect(spawnMock).toHaveBeenCalledTimes(1);
    await manager.stop();
  });

  it("uses packaged binary paths and preserves an existing database directory", async () => {
    appMock.isPackaged = true;
    Object.defineProperty(process, "resourcesPath", {
      configurable: true,
      value: "/opt/proxxied/resources",
    });
    existsSyncMock.mockReturnValue(true);
    const { MicroserviceManager } = await import("./microservice-manager");
    const manager = new MicroserviceManager({
      name: "Cache",
      binaryName: "cache-bin",
      port: 7777,
      healthCheckPath: "/health",
      healthCheckInterval: 60_000,
      maxRestarts: 1,
      restartDelay: 10,
    });

    await manager.start();

    expect(spawnMock).toHaveBeenCalledWith(
      "/opt/proxxied/resources/microservices/cache-bin",
      [],
      expect.any(Object)
    );
    expect(mkdirSyncMock).not.toHaveBeenCalled();
    await manager.stop();
  });

  it("logs child stdout and stderr streams", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const { MicroserviceManager } = await import("./microservice-manager");
    const manager = new MicroserviceManager({
      name: "Cache",
      binaryName: "cache-bin",
      port: 7777,
      healthCheckPath: "/health",
      healthCheckInterval: 60_000,
      maxRestarts: 1,
      restartDelay: 10,
    });

    await manager.start();
    lastChildProcess?.stdout.emit("data", Buffer.from("ready\n"));
    lastChildProcess?.stderr.emit("data", Buffer.from("warn\n"));

    expect(logSpy).toHaveBeenCalledWith("[Cache] ready");
    expect(errorSpy).toHaveBeenCalledWith("[Cache] ERROR: warn");
    await manager.stop();
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("restarts after an unexpected child exit up to the restart limit", async () => {
    vi.useFakeTimers();
    const { MicroserviceManager } = await import("./microservice-manager");
    const manager = new MicroserviceManager({
      name: "Cache",
      binaryName: "cache-bin",
      port: 7777,
      healthCheckPath: "/health",
      healthCheckInterval: 60_000,
      maxRestarts: 1,
      restartDelay: 10,
    });

    await manager.start();
    const firstChild = lastChildProcess;
    firstChild?.emit("exit", 1, null);
    await vi.advanceTimersByTimeAsync(10);

    expect(spawnMock).toHaveBeenCalledTimes(2);
    await manager.stop();
    vi.useRealTimers();
  });

  it("kills a running process when the interval health check fails", async () => {
    vi.useFakeTimers();
    const { MicroserviceManager } = await import("./microservice-manager");
    const manager = new MicroserviceManager({
      name: "Cache",
      binaryName: "cache-bin",
      port: 7777,
      healthCheckPath: "/health",
      healthCheckInterval: 100,
      maxRestarts: 1,
      restartDelay: 10,
    });

    await manager.start();
    const child = lastChildProcess;
    connectMode = "error";
    await vi.advanceTimersByTimeAsync(100);
    await vi.runOnlyPendingTimersAsync();

    expect(child?.kill).toHaveBeenCalledWith("SIGTERM");
    await manager.stop();
    vi.useRealTimers();
  });

  it("uses Windows executable suffixes for development and packaged binaries", async () => {
    const platformDescriptor = Object.getOwnPropertyDescriptor(
      process,
      "platform"
    );
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: "win32",
    });
    existsSyncMock.mockReturnValue(true);
    const { MicroserviceManager } = await import("./microservice-manager");
    const manager = new MicroserviceManager({
      name: "Cache",
      binaryName: "cache-bin",
      port: 7777,
      healthCheckPath: "/health",
      healthCheckInterval: 60_000,
      maxRestarts: 1,
      restartDelay: 10,
    });

    await manager.start();
    expect(spawnMock.mock.calls.at(-1)?.[0]).toContain("cache-bin.exe");
    await manager.stop();

    appMock.isPackaged = true;
    Object.defineProperty(process, "resourcesPath", {
      configurable: true,
      value: "/opt/proxxied/resources",
    });
    const packagedManager = new MicroserviceManager({
      name: "Cache",
      binaryName: "cache-bin",
      port: 7778,
      healthCheckPath: "/health",
      healthCheckInterval: 60_000,
      maxRestarts: 1,
      restartDelay: 10,
    });

    await packagedManager.start();
    expect(spawnMock.mock.calls.at(-1)?.[0]).toBe(
      "/opt/proxxied/resources/microservices/cache-bin.exe"
    );
    await packagedManager.stop();

    if (platformDescriptor) {
      Object.defineProperty(process, "platform", platformDescriptor);
    }
  });

  it("reports unhealthy HTTP requests and times out while waiting for readiness", async () => {
    vi.useFakeTimers();
    const { MicroserviceManager } = await import("./microservice-manager");
    const manager = new MicroserviceManager({
      name: "Cache",
      binaryName: "cache-bin",
      port: 7777,
      healthCheckPath: "/health",
      healthCheckInterval: 60_000,
      maxRestarts: 1,
      restartDelay: 10,
    });

    connectMode = "timeout";
    const healthCheck = (
      manager as unknown as { checkHealth: () => Promise<boolean> }
    ).checkHealth();
    await vi.advanceTimersByTimeAsync(2000);
    await expect(healthCheck).resolves.toBe(false);

    connectMode = "error";
    const waitForHealthy = (
      manager as unknown as {
        waitForHealthy: (timeout: number) => Promise<void>;
      }
    ).waitForHealthy(1);
    const waitForHealthyExpectation = expect(waitForHealthy).rejects.toThrow(
      "failed to become healthy within 1ms"
    );
    await vi.runOnlyPendingTimersAsync();
    await vi.advanceTimersByTimeAsync(501);
    await waitForHealthyExpectation;
    vi.useRealTimers();
  });

  it("force kills a child process that ignores graceful shutdown and waits for its exit", async () => {
    vi.useFakeTimers();
    const stubbornChild = createChildProcess();
    stubbornChild.kill = vi.fn((signal?: string) => {
      stubbornChild.killed = signal !== undefined;
      return true;
    });
    spawnMock.mockReturnValueOnce(stubbornChild);
    const { MicroserviceManager } = await import("./microservice-manager");
    const manager = new MicroserviceManager({
      name: "Cache",
      binaryName: "cache-bin",
      port: 7777,
      healthCheckPath: "/health",
      healthCheckInterval: 60_000,
      maxRestarts: 1,
      restartDelay: 10,
    });

    await manager.start();
    const stopPromise = manager.stop();
    let stopped = false;
    void stopPromise.then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(5000);

    expect(stubbornChild.kill).toHaveBeenCalledWith("SIGTERM");
    expect(stubbornChild.kill).toHaveBeenCalledWith("SIGKILL");
    expect(stopped).toBe(false);

    stubbornChild.emit("exit", null, "SIGKILL");
    await stopPromise;
    vi.useRealTimers();
  });

  it("does nothing when stopped before a process starts", async () => {
    const { MicroserviceManager } = await import("./microservice-manager");
    const manager = new MicroserviceManager({
      name: "Cache",
      binaryName: "cache-bin",
      port: 7777,
      healthCheckPath: "/health",
      healthCheckInterval: 60_000,
      maxRestarts: 1,
      restartDelay: 10,
    });

    await expect(manager.stop()).resolves.toBeUndefined();
  });

  it("cancels a pending restart when stopped during its delay", async () => {
    vi.useFakeTimers();
    const { MicroserviceManager } = await import("./microservice-manager");
    const manager = new MicroserviceManager({
      name: "Cache",
      binaryName: "cache-bin",
      port: 7777,
      healthCheckPath: "/health",
      healthCheckInterval: 60_000,
      maxRestarts: 1,
      restartDelay: 10,
    });

    await manager.start();
    lastChildProcess?.emit("exit", 1, null);
    await manager.stop();
    await vi.advanceTimersByTimeAsync(10);

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it("keeps one health interval through repeated healthy crash restarts", async () => {
    vi.useFakeTimers();
    const { MicroserviceManager } = await import("./microservice-manager");
    const manager = new MicroserviceManager({
      name: "Cache",
      binaryName: "cache-bin",
      port: 7777,
      healthCheckPath: "/health",
      healthCheckInterval: 60_000,
      maxRestarts: 3,
      restartDelay: 10,
    });

    await manager.start();
    for (let restart = 0; restart < 2; restart++) {
      lastChildProcess?.emit("exit", 1, null);
      await vi.advanceTimersByTimeAsync(10);
      expect(vi.getTimerCount()).toBe(1);
    }

    await manager.stop();
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it("shares readiness between concurrent starts until health succeeds", async () => {
    const { MicroserviceManager } = await import("./microservice-manager");
    const manager = new MicroserviceManager({
      name: "Cache",
      binaryName: "cache-bin",
      port: 7777,
      healthCheckPath: "/health",
      healthCheckInterval: 60_000,
      maxRestarts: 1,
      restartDelay: 10,
    });
    connectMode = "pending";

    const firstStart = manager.start();
    const secondStart = manager.start();
    const sharesReadinessPromise = firstStart === secondStart;
    let secondStartReportedReady = false;
    void secondStart.then(() => {
      secondStartReportedReady = true;
    });
    await Promise.resolve();
    const reportedReadyBeforeHealth = secondStartReportedReady;

    expect(pendingHealthCallbacks).toHaveLength(1);
    pendingHealthCallbacks.shift()?.();
    await Promise.all([firstStart, secondStart]);
    await manager.stop();

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(sharesReadinessPromise).toBe(true);
    expect(reportedReadyBeforeHealth).toBe(false);
  });

  it("logs restart failures after an unexpected child exit", async () => {
    vi.useFakeTimers();
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const { MicroserviceManager } = await import("./microservice-manager");
    const manager = new MicroserviceManager({
      name: "Cache",
      binaryName: "cache-bin",
      port: 7777,
      healthCheckPath: "/health",
      healthCheckInterval: 60_000,
      maxRestarts: 1,
      restartDelay: 10,
    });

    await manager.start();
    existsSyncMock.mockReturnValue(false);
    lastChildProcess?.emit("exit", 1, null);
    await vi.advanceTimersByTimeAsync(10);

    expect(errorSpy).toHaveBeenCalledWith(
      "[Cache] Restart failed:",
      expect.objectContaining({
        message: expect.stringContaining("binary not found"),
      })
    );
    errorSpy.mockRestore();
    vi.useRealTimers();
  });

  it("fails when the microservice binary is missing", async () => {
    existsSyncMock.mockReturnValue(false);
    const { MicroserviceManager } = await import("./microservice-manager");
    const manager = new MicroserviceManager({
      name: "Cache",
      binaryName: "cache-bin",
      port: 7777,
      healthCheckPath: "/health",
      healthCheckInterval: 60_000,
      maxRestarts: 1,
      restartDelay: 10,
    });

    await expect(manager.start()).rejects.toThrow("Cache binary not found at:");
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("rejects readiness and releases process ownership when spawn emits an error", async () => {
    const { MicroserviceManager } = await import("./microservice-manager");
    const manager = new MicroserviceManager({
      name: "Cache",
      binaryName: "cache-bin",
      port: 7777,
      healthCheckPath: "/health",
      healthCheckInterval: 60_000,
      maxRestarts: 1,
      restartDelay: 10,
    });
    connectMode = "pending";

    const start = manager.start();
    const spawnFailure = new Error("spawn EACCES");

    expect(() => lastChildProcess?.emit("error", spawnFailure)).not.toThrow();
    await expect(start).rejects.toBe(spawnFailure);
    expect(manager.isRunning()).toBe(false);
  });

  it("exhausts the restart budget after repeated short-lived healthy starts", async () => {
    vi.useFakeTimers();
    const { MicroserviceManager } = await import("./microservice-manager");
    const manager = new MicroserviceManager({
      name: "Cache",
      binaryName: "cache-bin",
      port: 7777,
      healthCheckPath: "/health",
      healthCheckInterval: 60_000,
      maxRestarts: 2,
      restartDelay: 10,
    });

    await manager.start();
    for (let restart = 0; restart < 3; restart++) {
      lastChildProcess?.emit("exit", 1, null);
      await vi.advanceTimersByTimeAsync(10);
    }

    expect(spawnMock).toHaveBeenCalledTimes(3);
    await manager.stop();
    vi.useRealTimers();
  });

  it("resets the restart budget only after a healthy stability interval", async () => {
    vi.useFakeTimers();
    const { MicroserviceManager } = await import("./microservice-manager");
    const manager = new MicroserviceManager({
      name: "Cache",
      binaryName: "cache-bin",
      port: 7777,
      healthCheckPath: "/health",
      healthCheckInterval: 100,
      maxRestarts: 1,
      restartDelay: 10,
    });

    await manager.start();
    await vi.advanceTimersByTimeAsync(99);
    lastChildProcess?.emit("exit", 1, null);
    await vi.advanceTimersByTimeAsync(10);
    expect(spawnMock).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(100);
    lastChildProcess?.emit("exit", 1, null);
    await vi.advanceTimersByTimeAsync(10);

    expect(spawnMock).toHaveBeenCalledTimes(3);
    await manager.stop();
    vi.useRealTimers();
  });

  it("requires the Scryfall Cache HTTP health identity before reporting ready", async () => {
    vi.useFakeTimers();
    const { MicroserviceManager } = await import("./microservice-manager");
    const manager = new MicroserviceManager({
      name: "Cache",
      binaryName: "cache-bin",
      port: 7777,
      healthCheckPath: "/health",
      healthCheckInterval: 60_000,
      maxRestarts: 1,
      restartDelay: 10,
    });
    const checkHealth = () =>
      (
        manager as unknown as { checkHealth: () => Promise<boolean> }
      ).checkHealth();

    await expect(checkHealth()).resolves.toBe(true);

    connectMode = "wrong-listener";
    await expect(checkHealth()).resolves.toBe(false);

    connectMode = "http-503";
    await expect(checkHealth()).resolves.toBe(false);

    connectMode = "hung";
    const hungCheck = checkHealth();
    await vi.advanceTimersByTimeAsync(2000);
    await expect(hungCheck).resolves.toBe(false);

    expect(httpRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        hostname: "localhost",
        method: "GET",
        path: "/health",
        port: 7777,
      }),
      expect.any(Function)
    );
    vi.useRealTimers();
  });
});
