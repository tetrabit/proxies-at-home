import { EventEmitter } from "events";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const appMock = { isPackaged: false, getPath: vi.fn(() => "/owned/user-data") };
const fsMock = { existsSync: vi.fn(), mkdirSync: vi.fn(), readFileSync: vi.fn(), lstatSync: vi.fn() };
const spawnMock = vi.fn();
const requestMock = vi.fn();
const SOURCE_BUILD = {
  kind: "nativeSqliteIsolated", sourceCommit: "dcb2825257e196be190d3739560eb92a64db0e8b", sourceTree: "dc8dbfb8b8a3dbd8453e99ef3b03d0c1f75dcdf1",
  sourceArchiveSha256: "e7b959549f88943dabb242ec6e50788b06e4876e61a0bb6e0fa38c99103f4c16", sourceLockSha256: "976bab6b945b691bb24abd693541f80aebb01c9e0ee530cc8c5167bf44bf5aed", patchSha256: "cfdae2db9613af918e3aced537de532b728f718f4e28d71833e2b8e8cc19e6a7",
};
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

vi.mock("electron", () => ({ app: appMock }));
vi.mock("fs", () => ({ default: fsMock }));
vi.mock("child_process", () => ({ spawn: spawnMock }));
vi.mock("http", () => ({ default: { request: requestMock } }));

function child() {
  const process = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; killed: boolean; kill: ReturnType<typeof vi.fn> };
  process.stdout = new EventEmitter(); process.stderr = new EventEmitter(); process.killed = false;
  process.kill = vi.fn((signal?: string) => { process.killed = !!signal; process.emit("exit", 0, signal ?? null); return true; });
  return process;
}
function controlledChild() {
  const process = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; killed: boolean; kill: ReturnType<typeof vi.fn> };
  process.stdout = new EventEmitter(); process.stderr = new EventEmitter(); process.killed = false;
  process.kill = vi.fn((signal?: string) => { process.killed = !!signal; return true; });
  return process;
}
function respond(callback: (response: EventEmitter & { statusCode: number }) => void, statusCode: number, body: unknown) {
  const response = new EventEmitter() as EventEmitter & { statusCode: number };
  response.statusCode = statusCode; callback(response); response.emit("data", JSON.stringify(body)); response.emit("end");
}
function manifest(root: string, bytes: Buffer, overrides: Record<string, unknown> = {}) {
  return JSON.stringify({ schemaVersion: 2, runtime: "desktopSQLite", backend: "sqlite", platform: process.platform, profile: "release", binary: { sourcePath: "/producer/never-used/scryfall-cache", fileName: process.platform === "win32" ? "scryfall-cache.exe" : "scryfall-cache", sha256: sha256(bytes) }, sourceBuild: SOURCE_BUILD, ...overrides });
}
function healthyRequest() {
  requestMock.mockImplementation((_options: unknown, callback: (response: EventEmitter & { statusCode: number }) => void) => {
    const request = new EventEmitter() as EventEmitter & { end: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> };
    request.end = vi.fn(() => { const response = new EventEmitter() as EventEmitter & { statusCode: number }; response.statusCode = 200; callback(response); response.emit("data", JSON.stringify({ service: "scryfall-cache", status: "healthy", version: "fixture" })); response.emit("end"); });
    request.destroy = vi.fn(); return request;
  });
}

describe("MicroserviceManager desktop SQLite artifact resolver", () => {
  beforeEach(() => {
    vi.clearAllMocks(); appMock.isPackaged = false; appMock.getPath.mockReturnValue("/owned/user-data");
    const bytes = Buffer.from("verified staged binary");
    fsMock.readFileSync.mockImplementation((file: string) => file.endsWith("microservice-artifact.json") ? Buffer.from(manifest("", bytes)) : bytes);
    fsMock.lstatSync.mockReturnValue({ isFile: () => true }); fsMock.existsSync.mockReturnValue(false); fsMock.mkdirSync.mockReturnValue(undefined);
    spawnMock.mockImplementation(() => child()); healthyRequest();
  });

  it("creates the default Scryfall manager with its configured port while stopped", async () => {
    const { createScryfallMicroservice } = await import("./microservice-manager");
    const manager = createScryfallMicroservice(8122);
    expect(manager.getPort()).toBe(8122); expect(manager.isRunning()).toBe(false);
  });

  it("proves the emitted development v2 manifest selects a verified staged binary", () => {
    const childProcess = process.getBuiltinModule("node:child_process");
    if (!childProcess) throw new Error("Node child-process APIs are unavailable for the manifest probe");
    const output = childProcess.execFileSync(process.execPath, ["scripts/probe-development-manifest.mjs"], { cwd: repositoryRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    expect(JSON.parse(output) as Record<string, unknown>).toMatchObject({ schema: "td-4496de-development-manifest-probe/v2", binary: expect.stringContaining("scryfall-cache"), sha256: expect.stringMatching(/^[0-9a-f]{64}$/), status: "PASS" });
  });

  it("verifies a development co-staged v2 pair before spawning only its canonical binary with SQLite environment", async () => {
    const { createScryfallMicroservice } = await import("./microservice-manager");
    const manager = createScryfallMicroservice(8123);
    await expect(manager.start()).resolves.toBe(8123);
    const [command, args, options] = spawnMock.mock.calls[0];
    expect(command).toMatch(/microservice-package\/scryfall-cache$/); expect(args).toEqual([]);
    expect(options.env).toMatchObject({ API_HOST: "127.0.0.1", API_PORT: "8123", SQLITE_PATH: "/owned/user-data/databases/scryfall-cache.db", RUST_LOG: "info" });
    expect(options.env.DATABASE_URL).toBeUndefined(); expect(options.env.PORT).toBeUndefined();
    expect(requestMock).toHaveBeenCalledWith(expect.objectContaining({ hostname: "127.0.0.1", port: 8123 }), expect.any(Function));
    await manager.stop();
  });

  it("uses the same hash-verified v2 resolver from packaged microservices", async () => {
    appMock.isPackaged = true; Object.defineProperty(process, "resourcesPath", { configurable: true, value: "/app/resources" });
    const { createScryfallMicroservice } = await import("./microservice-manager");
    const manager = createScryfallMicroservice(8124); await manager.start();
    expect(spawnMock.mock.calls[0][0]).toBe(`/app/resources/microservices/${process.platform === "win32" ? "scryfall-cache.exe" : "scryfall-cache"}`);
    await manager.stop();
  });

  it("uses canonical Windows v2 executable names from development and packaged roots", async () => {
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    try {
      const { createScryfallMicroservice } = await import("./microservice-manager");
      const development = createScryfallMicroservice(81241); await development.start();
      expect(spawnMock.mock.calls.at(-1)?.[0]).toMatch(/microservice-package\/scryfall-cache\.exe$/); await development.stop();
      appMock.isPackaged = true; Object.defineProperty(process, "resourcesPath", { configurable: true, value: "/app/windows-resources" });
      const packaged = createScryfallMicroservice(81242); await packaged.start();
      expect(spawnMock.mock.calls.at(-1)?.[0]).toBe("/app/windows-resources/microservices/scryfall-cache.exe"); await packaged.stop();
    } finally {
      if (platformDescriptor) Object.defineProperty(process, "platform", platformDescriptor);
    }
  });

  it.each([
    ["v1", { schemaVersion: 1 }], ["PostgreSQL", { backend: "postgres" }], ["external server", { runtime: "externalServer" }], ["debug", { profile: "debug" }],
    ["unsupported platform", { platform: "freebsd" }], ["wrong platform", { platform: process.platform === "darwin" ? "linux" : "darwin" }], ["extra key", { extra: true }],
    ["wrong digest", { binary: { sourcePath: "/ignored", fileName: process.platform === "win32" ? "scryfall-cache.exe" : "scryfall-cache", sha256: "0".repeat(64) } }],
  ])("rejects %s before spawn", async (_name, overrides) => {
    const bytes = Buffer.from("verified staged binary"); fsMock.readFileSync.mockImplementation((file: string) => file.endsWith("microservice-artifact.json") ? Buffer.from(manifest("", bytes, overrides)) : bytes);
    const { createScryfallMicroservice } = await import("./microservice-manager");
    await expect(createScryfallMicroservice(8125).start()).rejects.toThrow(/microservice artifact manifest/i); expect(spawnMock).not.toHaveBeenCalled();
  });

  it("rejects staged binary hash/type failures before spawn without opening sourcePath", async () => {
    const bytes = Buffer.from("verified staged binary"); fsMock.readFileSync.mockImplementation((file: string) => file.endsWith("microservice-artifact.json") ? Buffer.from(manifest("", bytes)) : Buffer.from("tampered"));
    const { createScryfallMicroservice } = await import("./microservice-manager");
    await expect(createScryfallMicroservice(8126).start()).rejects.toThrow(/sha-?256/i); expect(spawnMock).not.toHaveBeenCalled();
    fsMock.readFileSync.mockImplementation((file: string) => file.endsWith("microservice-artifact.json") ? Buffer.from(manifest("", bytes)) : bytes); fsMock.lstatSync.mockReturnValue({ isFile: () => false });
    await expect(createScryfallMicroservice(8127).start()).rejects.toThrow(/regular file/i); expect(spawnMock).not.toHaveBeenCalled();
  });

  it("reports a missing hash-verified staged binary before spawn", async () => {
    fsMock.lstatSync.mockImplementation(() => { throw new Error("ENOENT staged binary"); });
    const { createScryfallMicroservice } = await import("./microservice-manager");
    await expect(createScryfallMicroservice(81271).start()).rejects.toThrow(/microservice artifact manifest.*ENOENT staged binary/i);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("keeps resolveLaunch as a lifecycle-only harness seam while using SQLite environment and graceful shutdown", async () => {
    const { MicroserviceManager } = await import("./microservice-manager");
    const manager = new MicroserviceManager({ name: "fixture", binaryName: "scryfall-cache", port: 8128, healthCheckPath: "/health", healthCheckInterval: 60_000, maxRestarts: 0, restartDelay: 1 }, { resolveLaunch: () => ({ command: process.execPath, args: ["fixture"] }) });
    await manager.start(); expect(spawnMock.mock.calls[0][0]).toBe(process.execPath); expect(spawnMock.mock.calls[0][2].env.DATABASE_URL).toBeUndefined(); await manager.stop(); expect(manager.isRunning()).toBe(false);
  });

  it("returns the configured port without spawning again when already running", async () => {
    const { MicroserviceManager } = await import("./microservice-manager");
    const manager = new MicroserviceManager({ name: "fixture", binaryName: "scryfall-cache", port: 81281, healthCheckPath: "/health", healthCheckInterval: 60_000, maxRestarts: 0, restartDelay: 1 }, { resolveLaunch: () => ({ command: process.execPath, args: [] }) });
    await manager.start(); await expect(manager.start()).resolves.toBe(81281); expect(spawnMock).toHaveBeenCalledOnce(); await manager.stop();
  });

  it.each([
    ["unreadable manifest", () => { throw new Error("EACCES manifest"); }],
    ["malformed JSON", () => "{"],
    ["null manifest", () => "null"],
    ["array manifest", () => "[]"],
    ["missing required top-level field", () => JSON.stringify({ schemaVersion: 2 })],
    ["non-object nested binary", () => JSON.stringify({ schemaVersion: 2, runtime: "desktopSQLite", backend: "sqlite", platform: process.platform, profile: "release", binary: null, sourceBuild: SOURCE_BUILD })],
    ["missing nested binary field", () => manifest("", Buffer.from("verified staged binary"), { binary: { fileName: "scryfall-cache", sha256: "0".repeat(64) } })],
    ["empty source path", () => manifest("", Buffer.from("verified staged binary"), { binary: { sourcePath: "", fileName: process.platform === "win32" ? "scryfall-cache.exe" : "scryfall-cache", sha256: sha256(Buffer.from("verified staged binary")) } })],
    ["binary path traversal", () => manifest("", Buffer.from("verified staged binary"), { binary: { sourcePath: "/ignored", fileName: "../scryfall-cache", sha256: "0".repeat(64) } })],
    ["wrong canonical binary basename", () => manifest("", Buffer.from("verified staged binary"), { binary: { sourcePath: "/ignored", fileName: process.platform === "win32" ? "other-cache.exe" : "other-cache", sha256: sha256(Buffer.from("verified staged binary")) } })],
    ["malformed hash", () => manifest("", Buffer.from("verified staged binary"), { binary: { sourcePath: "/ignored", fileName: process.platform === "win32" ? "scryfall-cache.exe" : "scryfall-cache", sha256: "not-a-sha" } })],
    ["wrong source provenance", () => manifest("", Buffer.from("verified staged binary"), { sourceBuild: { ...SOURCE_BUILD, sourceCommit: "0".repeat(40) } })],
  ])("fails closed for %s without spawning", async (_name, payload) => {
    fsMock.readFileSync.mockImplementation((file: string) => file.endsWith("microservice-artifact.json") ? Buffer.from(payload()) : Buffer.from("verified staged binary"));
    const { createScryfallMicroservice } = await import("./microservice-manager");
    await expect(createScryfallMicroservice(8129).start()).rejects.toThrow(/microservice artifact manifest/i);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("releases a pending startup when its child exits so the scheduled restart can launch", async () => {
    vi.useFakeTimers();
    try {
      const first = controlledChild(); const second = controlledChild();
      second.kill.mockImplementation((signal?: string) => { second.killed = !!signal; second.emit("exit", 0, signal ?? null); return true; });
      spawnMock.mockImplementationOnce(() => first).mockImplementationOnce(() => second);
      requestMock.mockImplementation((_options: unknown, callback: (response: EventEmitter & { statusCode: number }) => void) => {
        const request = new EventEmitter() as EventEmitter & { end: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> };
        request.destroy = vi.fn(); request.end = vi.fn(() => { if (spawnMock.mock.calls.length > 1) respond(callback, 200, { service: "scryfall-cache", status: "healthy", version: "fixture" }); }); return request;
      });
      const { MicroserviceManager } = await import("./microservice-manager");
      const manager = new MicroserviceManager({ name: "fixture", binaryName: "scryfall-cache", port: 8130, healthCheckPath: "/health", healthCheckInterval: 60_000, maxRestarts: 1, restartDelay: 10 }, { resolveLaunch: () => ({ command: process.execPath, args: [] }) });
      const firstStart = manager.start(); first.emit("exit", 1, null);
      await expect(firstStart).rejects.toThrow(/exited before becoming healthy/i);
      await vi.advanceTimersByTimeAsync(10);
      expect(spawnMock).toHaveBeenCalledTimes(2);
      await manager.stop();
    } finally { vi.useRealTimers(); }
  });

  it("does not let a stale failed health probe kill a replacement child", async () => {
    vi.useFakeTimers();
    try {
      const first = controlledChild(); const second = controlledChild();
      second.kill.mockImplementation((signal?: string) => { second.killed = !!signal; second.emit("exit", 0, signal ?? null); return true; });
      spawnMock.mockImplementationOnce(() => first).mockImplementationOnce(() => second);
      let probe: ((response: EventEmitter & { statusCode: number }) => void) | undefined; let calls = 0;
      requestMock.mockImplementation((_options: unknown, callback: (response: EventEmitter & { statusCode: number }) => void) => {
        const request = new EventEmitter() as EventEmitter & { end: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> };
        request.destroy = vi.fn(); request.end = vi.fn(() => { calls += 1; if (calls === 2) probe = callback; else respond(callback, 200, { service: "scryfall-cache", status: "healthy", version: "fixture" }); }); return request;
      });
      const { MicroserviceManager } = await import("./microservice-manager");
      const manager = new MicroserviceManager({ name: "fixture", binaryName: "scryfall-cache", port: 8131, healthCheckPath: "/health", healthCheckInterval: 100, maxRestarts: 1, restartDelay: 10 }, { resolveLaunch: () => ({ command: process.execPath, args: [] }) });
      await manager.start(); await vi.advanceTimersByTimeAsync(100); first.emit("exit", 1, null); await vi.advanceTimersByTimeAsync(10);
      respond(probe!, 503, { service: "scryfall-cache", status: "healthy", version: "fixture" }); await Promise.resolve();
      expect(second.kill).not.toHaveBeenCalled(); await manager.stop();
    } finally { vi.useRealTimers(); }
  });

  it("clears the health interval and cancels a pending restart when an owned child exits", async () => {
    vi.useFakeTimers();
    try {
      const running = controlledChild(); running.kill.mockImplementation((signal?: string) => { running.killed = !!signal; running.emit("exit", 0, signal ?? null); return true; }); spawnMock.mockReturnValue(running); healthyRequest();
      const { MicroserviceManager } = await import("./microservice-manager");
      const manager = new MicroserviceManager({ name: "fixture", binaryName: "scryfall-cache", port: 8132, healthCheckPath: "/health", healthCheckInterval: 100, maxRestarts: 1, restartDelay: 10 }, { resolveLaunch: () => ({ command: process.execPath, args: [] }) });
      await manager.start(); running.emit("exit", 1, null);
      expect(vi.getTimerCount()).toBe(1); await manager.stop(); expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(10); expect(spawnMock).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });

  it("kills its owned child when a normal periodic health probe becomes unhealthy", async () => {
    vi.useFakeTimers();
    try {
      const running = child(); spawnMock.mockReturnValue(running);
      let probes = 0;
      requestMock.mockImplementation((_options: unknown, callback: (response: EventEmitter & { statusCode: number }) => void) => {
        const request = new EventEmitter() as EventEmitter & { end: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> };
        request.destroy = vi.fn(); request.end = vi.fn(() => { probes += 1; respond(callback, probes === 1 ? 200 : 503, { service: "scryfall-cache", status: "healthy", version: "fixture" }); }); return request;
      });
      const { MicroserviceManager } = await import("./microservice-manager");
      const manager = new MicroserviceManager({ name: "fixture", binaryName: "scryfall-cache", port: 81321, healthCheckPath: "/health", healthCheckInterval: 100, maxRestarts: 1, restartDelay: 10 }, { resolveLaunch: () => ({ command: process.execPath, args: [] }) });
      await manager.start(); await vi.advanceTimersByTimeAsync(100);
      expect(running.kill).toHaveBeenCalledWith("SIGTERM"); await manager.stop();
    } finally { vi.useRealTimers(); }
  });

  it("keeps exactly one health interval through repeated healthy crash restarts", async () => {
    vi.useFakeTimers();
    try {
      const children = [child(), child(), child()]; spawnMock.mockImplementation(() => children.shift()); healthyRequest();
      const { MicroserviceManager } = await import("./microservice-manager");
      const manager = new MicroserviceManager({ name: "fixture", binaryName: "scryfall-cache", port: 81322, healthCheckPath: "/health", healthCheckInterval: 60_000, maxRestarts: 3, restartDelay: 10 }, { resolveLaunch: () => ({ command: process.execPath, args: [] }) });
      await manager.start();
      for (let restart = 0; restart < 2; restart += 1) {
        (spawnMock.mock.results[restart]?.value as ReturnType<typeof child>).emit("exit", 1, null);
        await vi.advanceTimersByTimeAsync(10); expect(vi.getTimerCount()).toBe(1);
      }
      await manager.stop(); expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it("exhausts the restart budget after repeated short-lived healthy starts", async () => {
    vi.useFakeTimers();
    try {
      const children = [child(), child(), child()]; spawnMock.mockImplementation(() => children.shift()); healthyRequest();
      const { MicroserviceManager } = await import("./microservice-manager");
      const manager = new MicroserviceManager({ name: "fixture", binaryName: "scryfall-cache", port: 8133, healthCheckPath: "/health", healthCheckInterval: 60_000, maxRestarts: 2, restartDelay: 10 }, { resolveLaunch: () => ({ command: process.execPath, args: [] }) });
      await manager.start();
      for (let index = 0; index < 3; index += 1) {
        const running = spawnMock.mock.results[index]?.value as ReturnType<typeof child> | undefined;
        running?.emit("exit", 1, null); await vi.advanceTimersByTimeAsync(10);
      }
      expect(spawnMock).toHaveBeenCalledTimes(3); await manager.stop();
    } finally { vi.useRealTimers(); }
  });

  it("resets the restart budget only after a full healthy stability interval", async () => {
    vi.useFakeTimers();
    try {
      const children = [child(), child(), child()]; spawnMock.mockImplementation(() => children.shift()); healthyRequest();
      const { MicroserviceManager } = await import("./microservice-manager");
      const manager = new MicroserviceManager({ name: "fixture", binaryName: "scryfall-cache", port: 8134, healthCheckPath: "/health", healthCheckInterval: 100, maxRestarts: 1, restartDelay: 10 }, { resolveLaunch: () => ({ command: process.execPath, args: [] }) });
      await manager.start(); await vi.advanceTimersByTimeAsync(100);
      (spawnMock.mock.results[0]?.value as ReturnType<typeof child>).emit("exit", 1, null); await vi.advanceTimersByTimeAsync(10);
      await vi.advanceTimersByTimeAsync(100);
      (spawnMock.mock.results[1]?.value as ReturnType<typeof child>).emit("exit", 1, null); await vi.advanceTimersByTimeAsync(10);
      expect(spawnMock).toHaveBeenCalledTimes(3); await manager.stop();
    } finally { vi.useRealTimers(); }
  });

  it("shares one pending readiness promise between concurrent starts", async () => {
    let release: (() => void) | undefined;
    requestMock.mockImplementation((_options: unknown, callback: (response: EventEmitter & { statusCode: number }) => void) => {
      const request = new EventEmitter() as EventEmitter & { end: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> };
      request.destroy = vi.fn(); request.end = vi.fn(() => { release = () => respond(callback, 200, { service: "scryfall-cache", status: "healthy", version: "fixture" }); }); return request;
    });
    const { MicroserviceManager } = await import("./microservice-manager");
    const manager = new MicroserviceManager({ name: "fixture", binaryName: "scryfall-cache", port: 8135, healthCheckPath: "/health", healthCheckInterval: 60_000, maxRestarts: 0, restartDelay: 1 }, { resolveLaunch: () => ({ command: process.execPath, args: [] }) });
    const first = manager.start(); const second = manager.start();
    expect(first).toBe(second); expect(spawnMock).toHaveBeenCalledOnce(); release?.();
    await expect(Promise.all([first, second])).resolves.toEqual([8135, 8135]); await manager.stop();
  });

  it("does nothing when stopped before a process starts", async () => {
    const { MicroserviceManager } = await import("./microservice-manager");
    const manager = new MicroserviceManager({ name: "fixture", binaryName: "scryfall-cache", port: 81351, healthCheckPath: "/health", healthCheckInterval: 60_000, maxRestarts: 0, restartDelay: 1 }, { resolveLaunch: () => ({ command: process.execPath, args: [] }) });
    await expect(manager.stop()).resolves.toBeUndefined(); expect(spawnMock).not.toHaveBeenCalled();
  });

  it("stops a child during pending readiness and rejects the pending start", async () => {
    vi.useFakeTimers();
    try {
      const pending = child(); spawnMock.mockReturnValue(pending);
      requestMock.mockImplementation(() => {
        const request = new EventEmitter() as EventEmitter & { end: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> };
        request.destroy = vi.fn(); request.end = vi.fn(); return request;
      });
      const { MicroserviceManager } = await import("./microservice-manager");
      const manager = new MicroserviceManager({ name: "fixture", binaryName: "scryfall-cache", port: 81352, healthCheckPath: "/health", healthCheckInterval: 60_000, maxRestarts: 1, restartDelay: 10 }, { resolveLaunch: () => ({ command: process.execPath, args: [] }) });
      const starting = manager.start(); await expect(manager.stop()).resolves.toBeUndefined();
      await expect(starting).rejects.toThrow(/exited before becoming healthy/i); expect(pending.kill).toHaveBeenCalledWith("SIGTERM"); expect(manager.isRunning()).toBe(false);
    } finally { vi.useRealTimers(); }
  });

  it("forwards child stdout and stderr with expected callthrough log counts", async () => {
    const logSpy = vi.spyOn(console, "log"); const errorSpy = vi.spyOn(console, "error");
    try {
      const { MicroserviceManager } = await import("./microservice-manager");
      const manager = new MicroserviceManager({ name: "fixture", binaryName: "scryfall-cache", port: 81353, healthCheckPath: "/health", healthCheckInterval: 60_000, maxRestarts: 0, restartDelay: 1 }, { resolveLaunch: () => ({ command: process.execPath, args: [] }) });
      await manager.start(); const running = spawnMock.mock.results[0]?.value as ReturnType<typeof child>;
      running.stdout.emit("data", Buffer.from("ready\n")); running.stderr.emit("data", Buffer.from("warn\n")); await manager.stop();
      expect(logSpy).toHaveBeenCalledTimes(5); expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(logSpy).toHaveBeenCalledWith("[fixture] ready"); expect(errorSpy).toHaveBeenCalledWith("[fixture] ERROR: warn");
    } finally { logSpy.mockRestore(); errorSpy.mockRestore(); }
  });

  it("logs exactly one restart failure after an unexpected child exit", async () => {
    vi.useFakeTimers(); const errorSpy = vi.spyOn(console, "error");
    try {
      let launches = 0;
      const { MicroserviceManager } = await import("./microservice-manager");
      const manager = new MicroserviceManager({ name: "fixture", binaryName: "scryfall-cache", port: 81354, healthCheckPath: "/health", healthCheckInterval: 60_000, maxRestarts: 1, restartDelay: 10 }, { resolveLaunch: () => {
        if (launches++ === 0) return { command: process.execPath, args: [] };
        throw new Error("staged binary unavailable");
      } });
      await manager.start(); (spawnMock.mock.results[0]?.value as ReturnType<typeof child>).emit("exit", 1, null); await vi.advanceTimersByTimeAsync(10);
      expect(errorSpy).toHaveBeenCalledTimes(1); expect(errorSpy).toHaveBeenCalledWith("[fixture] Restart failed:", expect.objectContaining({ message: "staged binary unavailable" }));
      await manager.stop();
    } finally { errorSpy.mockRestore(); vi.useRealTimers(); }
  });

  it("releases ownership when spawn errors and rejects invalid health identities or HTTP 503", async () => {
    const { MicroserviceManager } = await import("./microservice-manager");
    const manager = new MicroserviceManager({ name: "fixture", binaryName: "scryfall-cache", port: 8136, healthCheckPath: "/health", healthCheckInterval: 60_000, maxRestarts: 0, restartDelay: 1 }, { resolveLaunch: () => ({ command: process.execPath, args: [] }) });
    requestMock.mockImplementation((_options: unknown, _callback: unknown) => {
      const request = new EventEmitter() as EventEmitter & { end: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> }; request.destroy = vi.fn(); request.end = vi.fn(); return request;
    });
    const pending = manager.start(); const spawned = spawnMock.mock.results[0]?.value as ReturnType<typeof child>; spawned.emit("error", new Error("EACCES"));
    await expect(pending).rejects.toThrow("EACCES"); expect(manager.isRunning()).toBe(false);
    for (const [statusCode, body] of [[200, { service: "wrong", status: "healthy", version: "fixture" }], [503, { service: "scryfall-cache", status: "healthy", version: "fixture" }]] as const) {
      requestMock.mockImplementation((_options: unknown, callback: (response: EventEmitter & { statusCode: number }) => void) => {
        const request = new EventEmitter() as EventEmitter & { end: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> }; request.destroy = vi.fn(); request.end = vi.fn(() => respond(callback, statusCode, body)); return request;
      });
      await expect((manager as unknown as { checkHealth: () => Promise<boolean> }).checkHealth()).resolves.toBe(false);
    }
  });

  it("returns false after a bounded health request timeout and rejects a readiness deadline", async () => {
    vi.useFakeTimers();
    try {
      requestMock.mockImplementation(() => {
        const request = new EventEmitter() as EventEmitter & { end: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> };
        request.destroy = vi.fn(); request.end = vi.fn(); return request;
      });
      const { MicroserviceManager } = await import("./microservice-manager");
      const manager = new MicroserviceManager({ name: "fixture", binaryName: "scryfall-cache", port: 8138, healthCheckPath: "/health", healthCheckInterval: 60_000, maxRestarts: 0, restartDelay: 1 }, { resolveLaunch: () => ({ command: process.execPath, args: [] }) });
      const health = (manager as unknown as { checkHealth: () => Promise<boolean> }).checkHealth();
      await vi.advanceTimersByTimeAsync(2000);
      await expect(health).resolves.toBe(false);
      const readiness = (manager as unknown as { waitForHealthy: (timeout: number) => Promise<void> }).waitForHealthy(1);
      const readinessExpectation = expect(readiness).rejects.toThrow(/failed to become healthy within 1ms/i);
      await vi.advanceTimersByTimeAsync(1); await readinessExpectation;
    } finally { vi.useRealTimers(); }
  });

  it("force-kills a child that does not exit after graceful shutdown", async () => {
    vi.useFakeTimers();
    try {
      const stubborn = controlledChild(); spawnMock.mockReturnValue(stubborn); healthyRequest();
      const { MicroserviceManager } = await import("./microservice-manager");
      const manager = new MicroserviceManager({ name: "fixture", binaryName: "scryfall-cache", port: 8137, healthCheckPath: "/health", healthCheckInterval: 60_000, maxRestarts: 0, restartDelay: 1 }, { resolveLaunch: () => ({ command: process.execPath, args: [] }) });
      await manager.start(); const stopping = manager.stop(); await vi.advanceTimersByTimeAsync(5000);
      expect(stubborn.kill).toHaveBeenCalledWith("SIGTERM"); expect(stubborn.kill).toHaveBeenCalledWith("SIGKILL"); stubborn.emit("exit", null, "SIGKILL"); await stopping;
    } finally { vi.useRealTimers(); }
  });

  afterEach(() => { vi.useRealTimers(); });
});
