import { spawn, ChildProcess } from "child_process";
import { createHash, randomUUID } from "crypto";
import { createServer } from "net";
import path from "path";
import fs from "fs";
import { app } from "electron";
import http from "http";
import { fileURLToPath } from "url";

export interface MicroserviceConfig {
  name: string;
  binaryName: string;
  port: number;
  healthCheckPath: string;
  healthCheckInterval: number;
  maxRestarts: number;
  restartDelay: number;
}

export interface MicroserviceLaunch { command: string; args: string[]; }
export interface MicroserviceManagerOptions {
  /** Lifecycle-test seam; production callers resolve only the staged v2 artifact. */
  resolveLaunch?: () => MicroserviceLaunch;
}

const SUPPORTED_PLATFORMS = new Set(["linux", "darwin", "win32"]);
const TOP_LEVEL_KEYS = ["backend", "binary", "platform", "profile", "runtime", "schemaVersion", "sourceBuild"];
const BINARY_KEYS = ["fileName", "sha256", "sourcePath"];
const SOURCE_BUILD_KEYS = ["kind", "patchSha256", "sourceArchiveSha256", "sourceCommit", "sourceLockSha256", "sourceTree"];
const SOURCE_BUILD = {
  kind: "nativeSqliteIsolated",
  sourceCommit: "dcb2825257e196be190d3739560eb92a64db0e8b",
  sourceTree: "dc8dbfb8b8a3dbd8453e99ef3b03d0c1f75dcdf1",
  sourceArchiveSha256: "e7b959549f88943dabb242ec6e50788b06e4876e61a0bb6e0fa38c99103f4c16",
  sourceLockSha256: "976bab6b945b691bb24abd693541f80aebb01c9e0ee530cc8c5167bf44bf5aed",
  patchSha256: "cfdae2db9613af918e3aced537de532b728f718f4e28d71833e2b8e8cc19e6a7",
} as const;
const SHA256 = /^[0-9a-f]{64}$/;

function binaryNameFor(platform: string): string {
  return platform === "win32" ? "scryfall-cache.exe" : "scryfall-cache";
}

function exactKeys(value: unknown, expected: string[], label: string): asserts value is Record<string, unknown> {
  if (!value || Array.isArray(value) || typeof value !== "object") {
    throw new Error(`${label} must be an object`);
  }
  const keys = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (keys.length !== wanted.length || keys.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} has missing or extra keys`);
  }
}

export class MicroserviceManager {
  private process: ChildProcess | null = null;
  private restartCount = 0;
  private healthCheckTimer: NodeJS.Timeout | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private healthySince: number | null = null;
  private startPromise: Promise<number> | null = null;
  private isShuttingDown = false;
  private lifecycleGeneration = 0;
  private readonly instanceId = randomUUID();

  constructor(
    private readonly config: MicroserviceConfig,
    private readonly options: MicroserviceManagerOptions = {}
  ) {}

  start(): Promise<number> {
    if (this.startPromise) return this.startPromise;
    if (this.process) return Promise.resolve(this.config.port);

    // A caller may deliberately start again after a completed stop. Restart callbacks
    // never reach this point while shutdown is active because stop clears their timer.
    this.isShuttingDown = false;
    const generation = ++this.lifecycleGeneration;
    const promise = this.startInternal(generation);
    this.startPromise = promise;
    void promise.then(
      () => { if (this.startPromise === promise) this.startPromise = null; },
      () => { if (this.startPromise === promise) this.startPromise = null; }
    );
    return promise;
  }

  private async startInternal(generation: number): Promise<number> {
    if (this.config.port === 0) {
      const allocatedPort = await this.ensurePort();
      // A stop can win while the asynchronous loopback allocation is pending. The
      // allocation result belongs only to the generation that requested it, so a
      // stale start neither claims its port nor admits a child after shutdown.
      if (!this.isCurrentStart(generation)) return this.config.port;
      this.config.port = allocatedPort;
    }
    if (!this.isCurrentStart(generation)) return this.config.port;
    const launch = this.getLaunch();
    const env = { ...process.env } as NodeJS.ProcessEnv;
    delete env.DATABASE_URL;
    delete env.PORT;
    Object.assign(env, {
      API_HOST: "127.0.0.1",
      API_PORT: String(this.config.port),
      INSTANCE_ID: this.instanceId,
      SQLITE_PATH: this.getDatabasePath(),
      // Desktop lifecycle must never trigger an import or refresh: the smoke owns an
      // empty SQLite profile and must remain offline even when its parent has policy.
      REDIS_ENABLED: "false",
      BULK_DATA_LOAD_ON_STARTUP: "false",
      BULK_REFRESH_ENABLED: "false",
      RUST_LOG: "info",
    });

    const childProcess = spawn(launch.command, launch.args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.process = childProcess;

    let rejectSpawnError: (error: Error) => void = () => undefined;
    const spawnError = new Promise<never>((_, reject) => { rejectSpawnError = reject; });
    let rejectStartupExit: (error: Error) => void = () => undefined;
    const startupExit = new Promise<never>((_, reject) => { rejectStartupExit = reject; });
    let startupSettled = false;

    childProcess.on("error", (error) => {
      if (this.process === childProcess) this.process = null;
      if (!startupSettled) rejectSpawnError(error);
    });
    childProcess.stdout?.on("data", (data) => console.log(`[${this.config.name}] ${data.toString().trim()}`));
    childProcess.stderr?.on("data", (data) => console.error(`[${this.config.name}] ERROR: ${data.toString().trim()}`));
    childProcess.on("exit", (code, signal) => {
      console.log(`[${this.config.name}] Exited with code ${code}, signal ${signal}`);
      if (this.process !== childProcess) return;

      this.process = null;
      this.clearHealthCheck();
      if (!startupSettled) {
        rejectStartupExit(new Error(`${this.config.name} exited before becoming healthy`));
      }
      if (this.healthySince !== null && Date.now() - this.healthySince >= this.config.healthCheckInterval) {
        this.restartCount = 0;
      }
      this.healthySince = null;
      if (!this.isShuttingDown && this.restartCount < this.config.maxRestarts) {
        this.restartCount += 1;
        console.log(`[${this.config.name}] Attempting restart ${this.restartCount}/${this.config.maxRestarts}`);
        this.restartTimer = setTimeout(() => {
          this.restartTimer = null;
          this.start().catch((error) => console.error(`[${this.config.name}] Restart failed:`, error));
        }, this.config.restartDelay);
      }
    });

    try {
      await Promise.race([this.waitForHealthy(), spawnError, startupExit]);
      startupSettled = true;
      if (this.process !== childProcess || !this.isCurrentStart(generation)) {
        throw new Error(`${this.config.name} exited before becoming healthy`);
      }
      this.startHealthCheck(childProcess);
      this.healthySince = Date.now();
      console.log(`[${this.config.name}] Started successfully on port ${this.config.port}`);
      return this.config.port;
    } catch (error) {
      startupSettled = true;
      // A failed readiness attempt must not retain a live child or turn into an
      // unobserved restart after the caller has received the startup failure.
      if (this.process === childProcess) {
        this.process = null;
        this.clearHealthCheck();
        childProcess.kill("SIGTERM");
      }
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.isShuttingDown = true;
    // Invalidate all pre-stop async continuations before inspecting the child. This
    // lets a subsequent start own a distinct generation while an old allocator is
    // still unwinding, and the identity-aware finally cannot clear that new promise.
    this.lifecycleGeneration += 1;
    this.startPromise = null;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this.clearHealthCheck();
    this.healthySince = null;
    if (!this.process) return;

    const runningProcess = this.process;
    console.log(`[${this.config.name}] Stopping...`);
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        console.log(`[${this.config.name}] Force killing after timeout`);
        runningProcess.kill("SIGKILL");
      }, 5000);
      runningProcess.once("exit", () => {
        clearTimeout(timeout);
        if (this.process === runningProcess) this.process = null;
        console.log(`[${this.config.name}] Stopped`);
        resolve();
      });
      runningProcess.kill("SIGTERM");
    });
  }

  private artifactRoot(): string {
    return app.isPackaged
      ? path.join(process.resourcesPath, "microservices")
      : path.join(path.dirname(fileURLToPath(import.meta.url)), "microservice-package");
  }

  private resolveArtifact(): MicroserviceLaunch {
    const root = this.artifactRoot();
    const manifestPath = path.join(root, "microservice-artifact.json");
    try {
      const manifest: unknown = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      exactKeys(manifest, TOP_LEVEL_KEYS, "manifest");
      if (manifest.schemaVersion !== 2 || manifest.runtime !== "desktopSQLite" || manifest.backend !== "sqlite" || manifest.profile !== "release") {
        throw new Error("invalid desktop SQLite discriminators");
      }
      if (typeof manifest.platform !== "string" || !SUPPORTED_PLATFORMS.has(manifest.platform) || manifest.platform !== process.platform) {
        throw new Error("incompatible platform");
      }
      exactKeys(manifest.binary, BINARY_KEYS, "binary");
      if (typeof manifest.binary.sourcePath !== "string" || manifest.binary.sourcePath.length === 0 || typeof manifest.binary.fileName !== "string" || typeof manifest.binary.sha256 !== "string") {
        throw new Error("invalid binary metadata");
      }
      if (!SHA256.test(manifest.binary.sha256) || manifest.binary.fileName !== binaryNameFor(manifest.platform) || path.basename(manifest.binary.fileName) !== manifest.binary.fileName) {
        throw new Error("invalid canonical binary metadata");
      }
      exactKeys(manifest.sourceBuild, SOURCE_BUILD_KEYS, "sourceBuild");
      for (const [key, expected] of Object.entries(SOURCE_BUILD)) {
        if (manifest.sourceBuild[key] !== expected) throw new Error(`invalid source provenance ${key}`);
      }
      const binaryPath = path.join(root, manifest.binary.fileName);
      if (path.dirname(binaryPath) !== root) throw new Error("binary path escaped trusted artifact root");
      if (!fs.lstatSync(binaryPath).isFile()) throw new Error("staged binary is not a regular file");
      const actualHash = createHash("sha256").update(fs.readFileSync(binaryPath)).digest("hex");
      if (actualHash !== manifest.binary.sha256) throw new Error("staged binary SHA-256 does not match manifest");
      return { command: binaryPath, args: [] };
    } catch (error) {
      const reason = error instanceof Error ? error.message : "unknown error";
      throw new Error(`Unable to resolve microservice artifact manifest at ${manifestPath}: ${reason}`);
    }
  }

  private getLaunch(): MicroserviceLaunch {
    return this.options.resolveLaunch ? this.options.resolveLaunch() : this.resolveArtifact();
  }

  private getDatabasePath(): string {
    const dbDir = path.join(app.getPath("userData"), "databases");
    if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
    return path.join(dbDir, "scryfall-cache.db");
  }

  private async waitForHealthy(timeout = 30000): Promise<void> {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (await this.checkHealth(Math.min(2000, deadline - Date.now()))) return;
      const delay = Math.min(500, deadline - Date.now());
      if (delay <= 0) break;
      await this.sleep(delay);
    }
    throw new Error(`${this.config.name} failed to become healthy within ${timeout}ms`);
  }

  private async checkHealth(timeout = 2000): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false;
      let timer: NodeJS.Timeout | null = null;
      const finish = (healthy: boolean) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve(healthy);
      };
      const request = http.request({
        hostname: "127.0.0.1",
        port: this.config.port,
        path: this.config.healthCheckPath,
        method: "GET",
        headers: { Accept: "application/json" },
      }, (response) => {
        let body = "";
        response.on("data", (chunk) => { body += chunk.toString(); });
        response.on("end", () => {
          try {
            const health = JSON.parse(body) as { service?: unknown; status?: unknown; version?: unknown; instance_id?: unknown };
            finish(response.statusCode === 200 && health.service === "scryfall-cache" && health.status === "healthy" && typeof health.version === "string" && health.instance_id === this.instanceId);
          } catch {
            finish(false);
          }
        });
      });
      timer = setTimeout(() => { request.destroy(); finish(false); }, timeout);
      request.on("error", () => finish(false));
      request.end();
    });
  }

  private clearHealthCheck(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }

  private startHealthCheck(childProcess: ChildProcess): void {
    this.clearHealthCheck();
    this.healthCheckTimer = setInterval(async () => {
      // The process identity fence prevents a probe begun for an old generation
      // from terminating a successfully restarted child on the same port.
      if (this.process !== childProcess || this.isShuttingDown) return;
      const healthy = await this.checkHealth();
      if (!healthy && this.process === childProcess && !this.isShuttingDown && this.restartCount < this.config.maxRestarts) {
        console.error(`[${this.config.name}] Health check failed`);
        childProcess.kill("SIGTERM");
      }
    }, this.config.healthCheckInterval);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private isCurrentStart(generation: number): boolean {
    return !this.isShuttingDown && this.lifecycleGeneration === generation;
  }

  private async ensurePort(): Promise<number> {
    if (this.config.port !== 0) return this.config.port;

    const server = createServer();
    try {
      const port = await new Promise<number>((resolve, reject) => {
        server.once("error", reject);
        server.listen({ host: "127.0.0.1", port: 0 }, () => {
          const address = server.address();
          if (!address || typeof address === "string") {
            reject(new Error("unable to determine allocated microservice port"));
            return;
          }
          resolve(address.port);
        });
      });
      return port;
    } finally {
      if (server.listening) {
        await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      }
    }
  }

  isRunning(): boolean { return this.process !== null && !this.process.killed; }
  getPid(): number | undefined { return this.process?.pid; }
  getPort(): number { return this.config.port; }
}

export function createScryfallMicroservice(port = 0): MicroserviceManager {
  return new MicroserviceManager({
    name: "Scryfall Cache",
    binaryName: "scryfall-cache",
    port,
    healthCheckPath: "/health",
    healthCheckInterval: 30000,
    maxRestarts: 3,
    restartDelay: 2000,
  });
}
