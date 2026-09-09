#!/usr/bin/env node
import { once } from "node:events";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const artifactRoot = path.join(
  repositoryRoot,
  ".review-artifacts",
  "electron-shutdown-runtime-02"
);
const electronExecutable = path.join(
  repositoryRoot,
  "node_modules",
  "electron",
  "dist",
  process.platform === "win32" ? "electron.exe" : "electron"
);
const harnessFixture = path.join(
  repositoryRoot,
  "scripts",
  "fixtures",
  "electron-shutdown-harness.mjs"
);
const healthChild = path.join(
  repositoryRoot,
  "scripts",
  "fixtures",
  "electron-shutdown-health-child.mjs"
);
const compiledManager = path.join(repositoryRoot, "electron", "dist", "microservice-manager.js");
const compiledQuitGate = path.join(repositoryRoot, "electron", "dist", "quit-gate.js");
const compiledMain = path.join(repositoryRoot, "electron", "dist", "main.js");

function runId() {
  return `${new Date().toISOString().replace(/[:.]/g, "-")}-pid${process.pid}`;
}

async function createEvidenceDirectory() {
  await mkdir(artifactRoot, { recursive: true });
  const stem = runId();
  for (let collision = 0; ; collision += 1) {
    const candidate = path.join(
      artifactRoot,
      collision === 0 ? stem : `${stem}-collision${collision}`
    );
    if (!existsSync(candidate)) {
      await mkdir(candidate, { recursive: false });
      return candidate;
    }
  }
}

async function allocateLoopbackPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("could not allocate a loopback port");
  }
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function readJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

async function ownedChildPid(traceFile) {
  try {
    const events = (await readFile(traceFile, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    return events.find((event) => event.event === "healthy")?.pid ?? null;
  } catch {
    return null;
  }
}

async function terminateExactOwnedProcesses(electron, traceFile) {
  const childPid = await ownedChildPid(traceFile);
  if (Number.isInteger(childPid) && childPid > 0) {
    try {
      process.kill(childPid, "SIGKILL");
    } catch (error) {
      if (!(error && typeof error === "object" && error.code === "ESRCH")) {
        throw error;
      }
    }
  }
  if (electron.pid) {
    try {
      electron.kill("SIGKILL");
    } catch (error) {
      if (!(error && typeof error === "object" && error.code === "ESRCH")) {
        throw error;
      }
    }
  }
}

const evidenceDirectory = await createEvidenceDirectory();
const userDataDirectory = path.join(evidenceDirectory, "user-data");
const traceFile = path.join(evidenceDirectory, "trace.jsonl");
const runtimeReportFile = path.join(evidenceDirectory, "runtime-report.json");
const stdoutFile = path.join(evidenceDirectory, "electron.stdout.log");
const stderrFile = path.join(evidenceDirectory, "electron.stderr.log");
const reportFile = path.join(evidenceDirectory, "report.json");
await mkdir(userDataDirectory, { recursive: true });

const prerequisites = [
  electronExecutable,
  process.execPath,
  harnessFixture,
  healthChild,
  compiledManager,
  compiledQuitGate,
  compiledMain,
];
const missing = prerequisites.filter((filePath) => !existsSync(filePath));
const port = missing.length === 0 ? await allocateLoopbackPort() : null;
let stdout = "";
let stderr = "";
let exitCode = null;
let exitSignal = null;
let timedOut = false;
let launchError = null;

if (missing.length === 0) {
  const environment = { ...process.env, ELECTRON_DISABLE_GPU: "1" };
  delete environment.DISPLAY;
  delete environment.WAYLAND_DISPLAY;
  delete environment.XAUTHORITY;
  const electron = spawn(
    electronExecutable,
    [
      "--headless",
      "--disable-gpu",
      "--no-sandbox",
      `--user-data-dir=${userDataDirectory}`,
      harnessFixture,
      `--trace-file=${traceFile}`,
      `--report-file=${runtimeReportFile}`,
      `--harness-user-data-dir=${userDataDirectory}`,
      `--health-child=${healthChild}`,
      `--node-executable=${process.execPath}`,
      `--port=${port}`,
    ],
    { cwd: repositoryRoot, env: environment, stdio: ["ignore", "pipe", "pipe"] }
  );
  electron.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  electron.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  electron.once("error", (error) => {
    launchError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  });
  const deadline = setTimeout(async () => {
    timedOut = true;
    try {
      await terminateExactOwnedProcesses(electron, traceFile);
    } catch (error) {
      launchError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    }
  }, 15_000);
  const [code, signal] = await once(electron, "exit");
  clearTimeout(deadline);
  exitCode = code;
  exitSignal = signal;
}

await Promise.all([writeFile(stdoutFile, stdout, "utf8"), writeFile(stderrFile, stderr, "utf8")]);
const runtime = await readJson(runtimeReportFile);
const status =
  missing.length === 0 &&
  !timedOut &&
  launchError === null &&
  exitCode === 0 &&
  runtime?.status === "PASS"
    ? "PASS"
    : "FAIL";
const report = {
  schema: "electron-shutdown-runtime-smoke/v2",
  status,
  runId: path.basename(evidenceDirectory),
  isolation: {
    evidenceDirectory,
    userDataDirectory,
    desktopDisplayUsed: false,
    xvfbUsed: false,
    headlessSwitch: true,
  },
  production: {
    main: compiledMain,
    microserviceManager: compiledManager,
    quitGate: compiledQuitGate,
    harnessImportsSharedProductionQuitGate: true,
  },
  child: {
    fixture: healthChild,
    loopbackPort: port,
    traceFile,
  },
  process: {
    exitCode,
    exitSignal,
    timedOut,
    launchError,
  },
  runtime,
  logs: { stdoutFile, stderrFile },
  missing,
};
await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify(report, null, 2));
process.exitCode = status === "PASS" ? 0 : 1;
