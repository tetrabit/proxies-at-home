import { app } from "electron";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { MicroserviceManager } from "../../electron/dist/microservice-manager.js";
import { registerMicroserviceQuitGate } from "../../electron/dist/quit-gate.js";

const options = new Map(
  process.argv.slice(2).map((argument) => {
    const [name, value] = argument.split("=", 2);
    return [name.replace(/^--/, ""), value];
  })
);
const traceFile = options.get("trace-file");
const reportFile = options.get("report-file");
const userDataDirectory = options.get("harness-user-data-dir");
const healthChild = options.get("health-child");
const nodeExecutable = options.get("node-executable");
const port = Number(options.get("port"));

if (
  !traceFile ||
  !reportFile ||
  !userDataDirectory ||
  !healthChild ||
  !nodeExecutable ||
  !Number.isInteger(port) ||
  port <= 0
) {
  throw new Error("electron shutdown harness received invalid arguments");
}

function record(event, details = {}) {
  appendFileSync(traceFile, `${JSON.stringify({ event, at: Date.now(), ...details })}\n`);
}

function childEvents() {
  try {
    return readFileSync(traceFile, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function childIsGone(childPid) {
  if (!Number.isInteger(childPid) || childPid <= 0) {
    return false;
  }

  try {
    process.kill(childPid, 0);
    return false;
  } catch (error) {
    return error && typeof error === "object" && error.code === "ESRCH";
  }
}

function writeReport(report) {
  writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`ELECTRON_SHUTDOWN_SMOKE_REPORT=${JSON.stringify(report)}`);
}

app.setPath("userData", userDataDirectory);
const manager = new MicroserviceManager(
  {
    name: "Shutdown harness health child",
    binaryName: "scryfall-cache",
    port,
    healthCheckPath: "/health",
    healthCheckInterval: 60_000,
    maxRestarts: 0,
    restartDelay: 50,
  },
  {
    resolveLaunch: () => ({
      command: nodeExecutable,
      args: [healthChild, `--trace-file=${traceFile}`],
    }),
  }
);

const beforeQuitEvents = [];
let stopStartedAt = null;
let stopResolvedAt = null;
let failure = null;

app.on("will-quit", () => {
  const events = childEvents();
  const childPid = events.find((entry) => entry.event === "healthy")?.pid ?? null;
  const sigterm = events.find((entry) => entry.event === "sigterm-ignored") ?? null;
  const childTerminated = childIsGone(childPid);
  const stopElapsedMs =
    stopStartedAt === null || stopResolvedAt === null
      ? null
      : stopResolvedAt - stopStartedAt;
  const status =
    failure === null &&
    beforeQuitEvents.length >= 3 &&
    sigterm !== null &&
    childTerminated &&
    stopElapsedMs !== null &&
    stopElapsedMs >= 4_500 &&
    stopElapsedMs <= 6_900
      ? "PASS"
      : "FAIL";
  const report = {
    schema: "electron-shutdown-runtime-smoke/v2",
    status,
    failure,
    pid: process.pid,
    beforeQuitEvents,
    stopStartedAt,
    stopResolvedAt,
    stopElapsedMs,
    childPid,
    childTerminated,
    childEvents: events,
  };
  record("will-quit", { status, childTerminated, stopElapsedMs });
  writeReport(report);
});

app.whenReady()
  .then(async () => {
    await manager.start();
    record("manager-ready", { port });
    registerMicroserviceQuitGate(
      app,
      async () => {
        stopStartedAt ??= Date.now();
        await manager.stop();
        stopResolvedAt = Date.now();
        record("manager-stop-resolved");
      },
      {
        timeoutMs: 7_000,
        logger: (message, error) => record("quit-gate-log", { message, error: String(error ?? "") }),
      }
    );
    app.on("before-quit", (event) => {
      const observation = {
        at: Date.now(),
        defaultPrevented: event.defaultPrevented === true,
      };
      beforeQuitEvents.push(observation);
      record("before-quit-observed", observation);
    });

    record("quit-request-one");
    app.quit();
    setTimeout(() => {
      record("quit-request-two");
      app.quit();
    }, 25);
  })
  .catch(async (error) => {
    failure = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    record("harness-failure", { failure });
    await manager.stop().catch(() => undefined);
    writeReport({
      schema: "electron-shutdown-runtime-smoke/v2",
      status: "FAIL",
      failure,
      beforeQuitEvents,
      childEvents: childEvents(),
    });
    app.exit(2);
  });
