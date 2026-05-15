import { EventEmitter } from "events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const appMock = {
  isPackaged: false,
  getPath: vi.fn(() => "/tmp/proxxied-user-data"),
};

const existsSyncMock = vi.fn();
const mkdirSyncMock = vi.fn();
const spawnMock = vi.fn();
let connectMode: "success" | "error" | "timeout" = "success";
let lastChildProcess: ReturnType<typeof createChildProcess> | null = null;

class SocketMock extends EventEmitter {
  destroy = vi.fn();

  connect(_port: number, _host: string, callback: () => void) {
    if (connectMode === "success") {
      callback();
    } else if (connectMode === "error") {
      setTimeout(() => this.emit("error", new Error("connection refused")), 0);
    }
    return this;
  }
}

vi.mock("electron", () => ({ app: appMock }));
vi.mock("fs", () => ({
  default: {
    existsSync: existsSyncMock,
    mkdirSync: mkdirSyncMock,
  },
}));
vi.mock("child_process", () => ({ spawn: spawnMock }));
vi.mock("net", () => ({ default: { Socket: SocketMock } }));

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
    lastChildProcess = null;
    spawnMock.mockImplementation(() => createChildProcess());
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

  it("starts the binary with deterministic environment and stops it cleanly", async () => {
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

    await expect(manager.start()).resolves.toBe(7777);

    expect(spawnMock).toHaveBeenCalledWith(
      expect.stringContaining("cache-bin"),
      [],
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

  it("reports unhealthy sockets and times out while waiting for readiness", async () => {
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

  it("force kills a child process that ignores graceful shutdown", async () => {
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
    await vi.advanceTimersByTimeAsync(5000);
    await stopPromise;

    expect(stubbornChild.kill).toHaveBeenCalledWith("SIGTERM");
    expect(stubbornChild.kill).toHaveBeenCalledWith("SIGKILL");
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
});
