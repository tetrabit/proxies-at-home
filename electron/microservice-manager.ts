import { spawn, ChildProcess } from "child_process";
import path from "path";
import fs from "fs";
import { app } from "electron";
import http from "http";

export interface MicroserviceConfig {
  name: string;
  binaryName: string;
  port: number;
  healthCheckPath: string;
  healthCheckInterval: number;
  maxRestarts: number;
  restartDelay: number;
}

export interface MicroserviceLaunch {
  command: string;
  args: string[];
}

export interface MicroserviceManagerOptions {
  /**
   * Supplies a process launch only for an explicitly constructed manager.
   * Production callers use the default repository/package binary resolution.
   */
  resolveLaunch?: () => MicroserviceLaunch;
}

export class MicroserviceManager {
  private process: ChildProcess | null = null;
  private config: MicroserviceConfig;
  private restartCount = 0;
  private healthCheckTimer: NodeJS.Timeout | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private healthySince: number | null = null;
  private startPromise: Promise<number> | null = null;
  private isShuttingDown = false;

  constructor(
    config: MicroserviceConfig,
    private readonly options: MicroserviceManagerOptions = {}
  ) {
    this.config = config;
  }

  start(): Promise<number> {
    if (this.startPromise) {
      return this.startPromise;
    }

    if (this.process) {
      console.log(`[${this.config.name}] Already running`);
      return Promise.resolve(this.config.port);
    }

    const startPromise = this.startInternal();
    this.startPromise = startPromise;
    void startPromise.then(
      () => {
        if (this.startPromise === startPromise) {
          this.startPromise = null;
        }
      },
      () => {
        if (this.startPromise === startPromise) {
          this.startPromise = null;
        }
      }
    );
    return startPromise;
  }

  private async startInternal(): Promise<number> {
    const launch = this.getLaunch();

    if (!fs.existsSync(launch.command)) {
      throw new Error(`${this.config.name} binary not found at: ${launch.command}`);
    }

    console.log(`[${this.config.name}] Starting from: ${launch.command}`);

    const env = {
      ...process.env,
      PORT: this.config.port.toString(),
      RUST_LOG: "info",
      DATABASE_URL: this.getDatabasePath(),
    };

    const childProcess = spawn(launch.command, launch.args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.process = childProcess;

    let rejectSpawnError: (error: Error) => void = () => undefined;
    const spawnError = new Promise<never>((_, reject) => {
      rejectSpawnError = reject;
    });

    childProcess.on("error", (error) => {
      if (this.process === childProcess) {
        this.process = null;
      }
      rejectSpawnError(error);
    });

    childProcess.stdout?.on("data", (data) => {
      console.log(`[${this.config.name}] ${data.toString().trim()}`);
    });

    childProcess.stderr?.on("data", (data) => {
      console.error(`[${this.config.name}] ERROR: ${data.toString().trim()}`);
    });

    childProcess.on("exit", (code, signal) => {
      console.log(
        `[${this.config.name}] Exited with code ${code}, signal ${signal}`
      );
      if (this.process !== childProcess) {
        return;
      }
      this.process = null;
      if (
        this.healthySince !== null &&
        Date.now() - this.healthySince >= this.config.healthCheckInterval
      ) {
        this.restartCount = 0;
      }
      this.healthySince = null;

      if (!this.isShuttingDown && this.restartCount < this.config.maxRestarts) {
        this.restartCount++;
        console.log(
          `[${this.config.name}] Attempting restart ${this.restartCount}/${this.config.maxRestarts}`
        );
        this.restartTimer = setTimeout(() => {
          this.restartTimer = null;
          this.start().catch((err) => {
            console.error(`[${this.config.name}] Restart failed:`, err);
          });
        }, this.config.restartDelay);
      }
    });

    await Promise.race([this.waitForHealthy(), spawnError]);
    this.startHealthCheck();
    this.healthySince = Date.now();

    console.log(
      `[${this.config.name}] Started successfully on port ${this.config.port}`
    );
    return this.config.port;
  }

  async stop(): Promise<void> {
    this.isShuttingDown = true;

    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }

    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }

    this.healthySince = null;

    if (!this.process) {
      return;
    }

    console.log(`[${this.config.name}] Stopping...`);
    const runningProcess = this.process;

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        console.log(`[${this.config.name}] Force killing after timeout`);
        runningProcess.kill("SIGKILL");
      }, 5000);

      runningProcess.once("exit", () => {
        clearTimeout(timeout);
        this.process = null;
        console.log(`[${this.config.name}] Stopped`);
        resolve();
      });

      runningProcess.kill("SIGTERM");
    });
  }

  private getBinaryPath(): string {
    const isDev = !app.isPackaged;

    if (isDev) {
      const ext = process.platform === "win32" ? ".exe" : "";
      return path.join(
        __dirname,
        "../../..",
        "scryfall-cache-microservice",
        "target",
        "release",
        `${this.config.binaryName}${ext}`
      );
    } else {
      const ext = process.platform === "win32" ? ".exe" : "";
      return path.join(
        process.resourcesPath,
        "microservices",
        `${this.config.binaryName}${ext}`
      );
    }
  }

  private getLaunch(): MicroserviceLaunch {
    if (this.options.resolveLaunch) {
      return this.options.resolveLaunch();
    }

    return { command: this.getBinaryPath(), args: [] };
  }

  private getDatabasePath(): string {
    const userDataPath = app.getPath("userData");
    const dbDir = path.join(userDataPath, "databases");

    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }

    return path.join(dbDir, "scryfall-cache.db");
  }

  private async waitForHealthy(timeout = 30000): Promise<void> {
    const deadline = Date.now() + timeout;

    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        break;
      }

      if (await this.checkHealth(Math.min(2000, remaining))) {
        return;
      }

      const retryDelay = Math.min(500, deadline - Date.now());
      if (retryDelay <= 0) {
        break;
      }
      await this.sleep(retryDelay);
    }

    throw new Error(
      `${this.config.name} failed to become healthy within ${timeout}ms`
    );
  }

  private async checkHealth(timeout = 2000): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false;
      let timer: NodeJS.Timeout | null = null;
      const finish = (healthy: boolean) => {
        if (settled) {
          return;
        }
        settled = true;
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        resolve(healthy);
      };

      const request = http.request(
        {
          hostname: "localhost",
          port: this.config.port,
          path: this.config.healthCheckPath,
          method: "GET",
          headers: { Accept: "application/json" },
        },
        (response) => {
          let body = "";
          response.on("data", (chunk) => {
            body += chunk.toString();
          });
          response.on("end", () => {
            if (response.statusCode !== 200) {
              finish(false);
              return;
            }

            try {
              const health = JSON.parse(body) as {
                service?: unknown;
                status?: unknown;
                version?: unknown;
              };
              finish(
                health.service === "scryfall-cache" &&
                  health.status === "healthy" &&
                  typeof health.version === "string"
              );
            } catch {
              finish(false);
            }
          });
        }
      );

      timer = setTimeout(() => {
        request.destroy();
        finish(false);
      }, timeout);
      if (settled && timer) {
        clearTimeout(timer);
        timer = null;
      }

      request.on("error", () => finish(false));
      request.end();
    });
  }

  private startHealthCheck(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
    }

    this.healthCheckTimer = setInterval(async () => {
      if (!(await this.checkHealth())) {
        console.error(`[${this.config.name}] Health check failed`);
        if (this.process && this.restartCount < this.config.maxRestarts) {
          console.log(
            `[${this.config.name}] Restarting due to failed health check`
          );
          this.process.kill("SIGTERM");
        }
      }
    }, this.config.healthCheckInterval);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  isRunning(): boolean {
    return this.process !== null && !this.process.killed;
  }

  getPort(): number {
    return this.config.port;
  }
}

export function createScryfallMicroservice(port = 8080): MicroserviceManager {
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
