import compression from "compression";
import cors from "cors";
import express from "express";
import { fileURLToPath } from "url";
import { archidektRouter } from "./routes/archidektRouter.js";
import { moxfieldRouter } from "./routes/moxfieldRouter.js";
import { imageRouter } from "./routes/imageRouter.js";
import { streamRouter } from "./routes/streamRouter.js";
import { mpcAutofillRouter } from "./routes/mpcAutofillRouter.js";
import { scryfallRouter } from "./routes/scryfallRouter.js";
import { shareRouter, cleanupExpiredShares } from "./routes/shareRouter.js";
import { initDatabase } from "./db/db.js";
import { startImportScheduler } from "./services/importScheduler.js";
import { initCatalogs } from "./utils/scryfallCatalog.js";

// Initialize database (creates tables if needed)
initDatabase();

// Initialize Scryfall type catalogs (for t: prefix detection)
initCatalogs();

// Start import scheduler (triggers cold-start import if needed)
startImportScheduler();

// Run share cleanup on startup and schedule hourly
cleanupExpiredShares();
setInterval(() => cleanupExpiredShares(), 60 * 60 * 1000); // Every hour

/**
 * Start the Express server on the specified port.
 * If port is 0, a random available port will be used.
 * @returns Promise resolving to the actual port the server is listening on
 */
export function startServer(port: number = 3001): Promise<number> {
  const app = express();

  app.use(cors({
    origin: (_, cb) => cb(null, true),
    methods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    maxAge: 86400,
  }));

  // Enable gzip compression for JSON responses (skip SSE which needs real-time streaming)
  app.use(compression({
    filter: (req, res) => {
      // Don't compress SSE responses - they need real-time streaming
      if (res.getHeader('Content-Type')?.toString().includes('text/event-stream')) {
        return false;
      }
      return compression.filter(req, res);
    },
  }));

  app.use(express.json({ limit: "1mb" }));
  
  // Health check endpoints
  const startTime = Date.now();
  
  // Simple health check
  app.get("/health", (req, res) => {
    res.json({
      status: "ok",
      uptime: Math.floor((Date.now() - startTime) / 1000),
      timestamp: new Date().toISOString()
    });
  });
  
  // Deep health check (includes database and microservice)
  app.get("/health/deep", async (req, res) => {
    const health: any = {
      status: "ok",
      uptime: Math.floor((Date.now() - startTime) / 1000),
      timestamp: new Date().toISOString(),
      checks: {
        database: "unknown",
        microservice: "unknown"
      }
    };
    
    // Check database
    try {
      const { getDatabase } = await import("./db/db.js");
      const db = getDatabase();
      db.prepare("SELECT 1").get();
      health.checks.database = "ok";
    } catch (error) {
      health.checks.database = "error";
      health.status = "degraded";
    }
    
    // Check microservice
    try {
      const { isMicroserviceAvailable } = await import("./services/scryfallMicroserviceClient.js");
      const available = await isMicroserviceAvailable();
      health.checks.microservice = available ? "ok" : "unavailable";
      if (!available) {
        health.status = "degraded"; // Degraded but functional (falls back to Scryfall API)
      }
    } catch (error) {
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

  return new Promise((resolve) => {
    const server = app.listen(port, "0.0.0.0", () => {
      const addr = server.address();
      const actualPort = typeof addr === "string" ? port : addr?.port || port;
      console.log(`Server listening on port ${actualPort}`);
      resolve(actualPort);
    });
  });
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
