import compression from "compression";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import type { Server } from "node:http";
import { fileURLToPath } from "url";
import { archidektRouter } from "./routes/archidektRouter.js";
import { moxfieldRouter } from "./routes/moxfieldRouter.js";
import { imageRouter } from "./routes/imageRouter.js";
import { streamRouter } from "./routes/streamRouter.js";
import { mpcAutofillRouter } from "./routes/mpcAutofillRouter.js";
import { scryfallRouter } from "./routes/scryfallRouter.js";
import { shareRouter, cleanupExpiredShares } from "./routes/shareRouter.js";
import { createBackupRouter } from "./routes/backupRouter.js";
import { createPrinterCalibrationRouter } from "./routes/printerCalibrationRouter.js";
import { createPreferencesRouter } from "./routes/preferencesRouter.js";
import { createMetricsRouter } from "./routes/metricsRouter.js";
import { createPrivateRouteAuth, type PrivateCredentialVerifier } from "./auth/privateRouteAuth.js";
import { logMicroserviceMetrics } from "./services/scryfallMicroserviceClient.js";
import { initDatabase } from "./db/db.js";
import { startImportScheduler } from "./services/importScheduler.js";
import { initCatalogs } from "./utils/scryfallCatalog.js";
import {
  createCalibrationHarnessRuntime,
  resolveCalibrationHarnessServiceOptions,
  type CalibrationHarnessRuntime,
  type CalibrationHarnessServiceOptions,
} from "./services/calibrationHarnessRuntime.js";

// Initialize database (creates tables if needed)
initDatabase();

// Initialize Scryfall type catalogs (for t: prefix detection)
initCatalogs();

// Start import scheduler (triggers cold-start import if needed)
startImportScheduler();

// Run share cleanup on startup and schedule hourly
cleanupExpiredShares();
setInterval(() => cleanupExpiredShares(), 60 * 60 * 1000); // Every hour

// Log microservice performance metrics every 5 minutes (if SCRYFALL_CACHE_URL is configured)
if (process.env.SCRYFALL_CACHE_URL) {
  setInterval(
    () => {
      logMicroserviceMetrics();
    },
    5 * 60 * 1000
  ); // Every 5 minutes
}

/**
 * Start the Express server on the specified port.
 * If port is 0, a random available port will be used.
 * @returns Promise resolving to the actual port the server is listening on
 */
export interface StartServerOptions {
  host?: string;
  /**
   * Server-owned credential verifier injected by Electron main or a trusted
   * server deployment. Missing configuration deliberately denies private routes.
   */
  privateCredentialVerifier?: PrivateCredentialVerifier;
  /**
   * Calibration is disabled unless this explicit configuration or its dedicated
   * environment variable is supplied. It is independent from private routes.
   */
  calibrationHarness?: CalibrationHarnessServiceOptions | false;
}

export interface ApplicationRuntime {
  readonly app: express.Express;
  readonly calibrationHarness: CalibrationHarnessRuntime | undefined;
  close(): void;
}

export interface ServerRuntime extends ApplicationRuntime {
  readonly server: Server;
  readonly port: number;
  close(): Promise<void>;
}

const denyAllPrivateCredentials: PrivateCredentialVerifier = {
  verifyBearer: () => null,
};

type ActiveRuntime = { close(): void | Promise<void> };
const activeRuntimes = new Set<ActiveRuntime>();

function disabledCalibrationHarness(_request: express.Request, response: express.Response): void {
  response.setHeader("Cache-Control", "no-store");
  response.status(404).json({ error: "not_found" });
}

function calibrationHarnessCors(allowedWebOrigins: readonly string[]) {
  const allowed = new Set(allowedWebOrigins);
  return cors({
    origin: (origin, callback) => callback(null, origin !== undefined && allowed.has(origin)),
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "If-Match", "If-None-Match"],
    maxAge: 86400,
  });
}

/** Creates a closeable app owner while preserving createApp's Express return contract. */
export function createApplicationRuntime(options: StartServerOptions = {}): ApplicationRuntime {
  let calibrationHarness: CalibrationHarnessRuntime | undefined;
  try {
    const calibrationOptions = resolveCalibrationHarnessServiceOptions(options.calibrationHarness);
    calibrationHarness = calibrationOptions === undefined
      ? undefined
      : createCalibrationHarnessRuntime(calibrationOptions);
    const app = express();
    const privateRouteAuth = createPrivateRouteAuth(
      options.privateCredentialVerifier ?? denyAllPrivateCredentials,
    );

  // Security headers via helmet.js
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          scriptSrc: ["'self'"],
          imgSrc: ["'self'", "data:", "https:"],
          connectSrc: ["'self'"],
        },
      },
      hsts: {
        maxAge: 31536000, // 1 year
        includeSubDomains: true,
        preload: true,
      },
    })
  );

  // The calibration namespace is intentionally before generic CORS/JSON:
  // independently configured origins must not be rejected or preflighted by
  // unrelated API policy, and its router authenticates before body parsing.
    if (calibrationHarness === undefined) {
      app.use("/api/calibration-harness", disabledCalibrationHarness);
    } else {
      app.use("/api/calibration-harness", (_request, response, next) => {
        response.setHeader("Cache-Control", "no-store");
        next();
      }, calibrationHarnessCors(calibrationHarness.allowedWebOrigins), calibrationHarness.router);
    }

  // CORS configuration with environment-based origin restriction
  const allowedOrigins = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(",")
    : ["http://localhost:5173", "http://localhost:3000"];

  app.use(
    cors({
      origin: (origin, cb) => {
        // Allow requests with no origin (mobile apps, curl, etc.)
        if (!origin) return cb(null, true);

        // Check if origin is in allowed list
        if (allowedOrigins.includes(origin)) {
          return cb(null, true);
        }

        try {
          const { hostname } = new URL(origin);

          if (
            hostname === "localhost" ||
            hostname === "127.0.0.1" ||
            hostname === "::1" ||
            hostname === "[::1]"
          ) {
            return cb(null, true);
          }
        } catch {
          // Invalid origin URLs are rejected below.
        }

        cb(new Error("Not allowed by CORS"));
      },
      methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization"],
      maxAge: 86400,
    })
  );

  // Enable gzip compression for JSON responses (skip SSE which needs real-time streaming)
  app.use(
    compression({
      filter: (req, res) => {
        // Don't compress SSE responses - they need real-time streaming
        if (
          res
            .getHeader("Content-Type")
            ?.toString()
            .includes("text/event-stream")
        ) {
          return false;
        }
        return compression.filter(req, res);
      },
    })
  );

  app.use(express.json({ limit: "10mb" }));

  // Health check endpoints
  const startTime = Date.now();

  // Simple health check
  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      uptime: Math.floor((Date.now() - startTime) / 1000),
      timestamp: new Date().toISOString(),
    });
  });

  // Deep health check (includes database and microservice)
  app.get("/health/deep", privateRouteAuth.private("metrics:read"), async (_req, res) => {
    const health: {
      status: string;
      uptime: number;
      timestamp: string;
      checks: {
        database: string;
        microservice: string;
      };
    } = {
      status: "ok",
      uptime: Math.floor((Date.now() - startTime) / 1000),
      timestamp: new Date().toISOString(),
      checks: {
        database: "unknown",
        microservice: "unknown",
      },
    };

    // Check database
    try {
      const { getDatabase } = await import("./db/db.js");
      const db = getDatabase();
      db.prepare("SELECT 1").get();
      health.checks.database = "ok";
    } catch {
      health.checks.database = "error";
      health.status = "degraded";
    }

    // Check microservice
    try {
      const { isMicroserviceAvailable } =
        await import("./services/scryfallMicroserviceClient.js");
      const available = await isMicroserviceAvailable();
      health.checks.microservice = available ? "ok" : "unavailable";
      if (!available) {
        health.status = "degraded"; // Degraded but functional (falls back to Scryfall API)
      }
    } catch {
      health.checks.microservice = "error";
      health.status = "degraded";
    }

    const statusCode = health.status === "ok" ? 200 : 503;
    res.status(statusCode).json(health);
  });

  app.use("/api/archidekt", archidektRouter);
  app.use("/api/moxfield", moxfieldRouter);
  app.use("/api/cards/images", imageRouter);
  app.use("/api/stream", streamRouter);
  app.use("/api/mpcfill", mpcAutofillRouter);
  app.use("/api/scryfall", scryfallRouter);
  app.use("/api/share", shareRouter);
  app.use("/api/backup", createBackupRouter({ privateRouteAuth }));
  app.use("/api/printer-calibration", createPrinterCalibrationRouter({ privateRouteAuth }));
  app.use("/api/preferences", createPreferencesRouter({ privateRouteAuth }));
  app.use("/api/metrics", createMetricsRouter(privateRouteAuth));

    const runtime: ApplicationRuntime = {
      app,
      calibrationHarness,
      close(): void {
        calibrationHarness?.close();
        activeRuntimes.delete(runtime);
      },
    };
    activeRuntimes.add(runtime);
    return runtime;
  } catch (error) {
    try {
      calibrationHarness?.close();
    } catch {
      // Preserve the construction error over best-effort cleanup failure.
    }
    throw error;
  }
}

export function createApp(options: StartServerOptions = {}): express.Express {
  return createApplicationRuntime(options).app;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined || !server.listening ? resolve() : reject(error)));
  });
}

/** Starts an owned HTTP/runtime pair and closes HTTP settlement before SQLite. */
export async function startServerRuntime(port: number = 3001, options: StartServerOptions = {}): Promise<ServerRuntime> {
  const application = createApplicationRuntime(options);
  let server: Server | undefined;
  let closePromise: Promise<void> | undefined;
  let closed = false;
  try {
    server = application.app.listen(port, options.host ?? "0.0.0.0");
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server!.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server!.off("error", onError);
        resolve();
      };
      server!.once("error", onError);
      server!.once("listening", onListening);
    });
    const address = server.address();
    const actualPort = typeof address === "string" ? port : address?.port || port;
    const runtime: ServerRuntime = {
      ...application,
      server,
      port: actualPort,
      async close(): Promise<void> {
        if (closed) return;
        if (closePromise !== undefined) return closePromise;
        closePromise = (async () => {
          try {
            await closeServer(server!);
          } finally {
            application.close();
          }
          closed = true;
          activeRuntimes.delete(runtime);
        })();
        try {
          await closePromise;
        } finally {
          if (!closed) closePromise = undefined;
        }
      },
    };
    activeRuntimes.delete(application);
    activeRuntimes.add(runtime);
    return runtime;
  } catch (error) {
    try {
      if (server !== undefined) await closeServer(server);
    } catch {
      // Preserve the listener-start failure over best-effort listener cleanup.
    }
    try {
      application.close();
    } catch {
      // Preserve the listener-start failure over best-effort database cleanup.
    }
    throw error;
  }
}

export async function startServer(port: number = 3001, options: StartServerOptions = {}): Promise<number> {
  const runtime = await startServerRuntime(port, options);
  const actualPort = runtime.port;

  console.log(`Server listening on port ${actualPort}`);
  return actualPort;
}

// Check if run directly (not imported by Electron)
const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] === __filename) {
  const PORT = Number(process.env.PORT || 3001);
  startServer(PORT);
}

// Graceful shutdown handler
async function handleShutdown(signal: string): Promise<void> {
  console.log(`\n[Server] ${signal} received. Shutting down gracefully...`);
  try {
    await Promise.all([...activeRuntimes].map((runtime) => runtime.close()));
    const { closeDatabase } = await import("./db/db.js");
    closeDatabase();
    console.log("[Server] Cleanup complete. Exiting.");
    process.exit(0);
  } catch (error) {
    console.error("[Server] Error during shutdown:", error);
    process.exit(1);
  }
}

process.on("SIGTERM", () => handleShutdown("SIGTERM"));
process.on("SIGINT", () => handleShutdown("SIGINT"));
