import { spawn } from "node:child_process";
import path from "node:path";

const MAX_CONCURRENT_PREREQUISITES = 2;
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

function commandFailure(label, code, signal, cause) {
  if (cause) return new Error(`${label} could not start: ${cause.message}`);
  return new Error(signal ? `${label} terminated by ${signal}` : `${label} failed with exit code ${code}`);
}

function startCommand({ command, args, label, captureOutput = false }) {
  let child;
  let hasSettled = false;
  let stdout = "";
  const completed = new Promise((resolve, reject) => {
    child = spawn(command, args, { stdio: captureOutput ? ["ignore", "pipe", "inherit"] : "inherit", detached: process.platform !== "win32" });
    child.stdout?.on("data", (chunk) => { stdout += chunk.toString(); process.stdout.write(chunk); });
    child.once("error", (error) => { hasSettled = true; reject(commandFailure(label, undefined, undefined, error)); });
    child.once("exit", (code, signal) => { hasSettled = true; code === 0 ? resolve(stdout) : reject(commandFailure(label, code, signal)); });
  });
  return { completed, get child() { return child; }, get hasSettled() { return hasSettled; } };
}

function terminateUnsettled(commands) {
  for (const command of commands) {
    if (command.hasSettled || !command.child) continue;
    if (process.platform !== "win32" && command.child.pid) {
      try { process.kill(-command.child.pid, "SIGTERM"); continue; } catch { /* direct child fallback */ }
    }
    command.child.kill("SIGTERM");
  }
}

function parseBuildRoot(output) {
  const roots = output.split(/\r?\n/).map((line) => line.trim()).filter((line) => path.isAbsolute(line));
  if (roots.length !== 1) throw new Error("Native SQLite producer did not report exactly one build root");
  return roots[0];
}

async function runStage({ buildRoot, expectedPlatform }) {
  const args = ["scripts/prepare-microservice-package.mjs", "--manifest", path.join(buildRoot, "microservice-artifact.json"), "--staging-dir", "electron/dist/microservice-package", "--platform", expectedPlatform];
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 ? resolve() : reject(commandFailure("Desktop SQLite artifact staging", code, signal)));
  });
}

/** Builds only the isolated SQLite producer and JavaScript aggregate concurrently, then stages their verified pair. */
export async function buildElectronPrerequisites({ expectedPlatform = process.platform } = {}) {
  const commands = [
    { command: "bash", args: ["scripts/build-native-sqlite-isolated.sh"], label: "Native SQLite microservice build", captureOutput: true },
    { command: npmCommand, args: ["run", "build:parallel"], label: "JavaScript aggregate build" },
  ];
  if (commands.length !== MAX_CONCURRENT_PREREQUISITES) throw new Error(`Expected exactly ${MAX_CONCURRENT_PREREQUISITES} Electron prerequisite branches`);
  const started = commands.map(startCommand);
  let failure;
  const settled = started.map((command) => command.completed.catch((error) => { if (!failure) { failure = error; terminateUnsettled(started); } throw error; }));
  const results = await Promise.allSettled(settled);
  if (failure) throw failure;
  const producer = results[0];
  if (producer.status !== "fulfilled") throw new Error("Native SQLite producer result was unavailable");
  await runStage({ buildRoot: parseBuildRoot(producer.value), expectedPlatform });
}

function parseCliArguments(args) {
  if (args.length === 0) return { expectedPlatform: process.platform };
  if (args.length === 2 && args[0] === "--platform" && ["linux", "darwin", "win32"].includes(args[1])) return { expectedPlatform: args[1] };
  throw new Error("usage: build-electron-prerequisites.mjs [--platform linux|darwin|win32]");
}

if (import.meta.url === new URL(process.argv[1], "file:").href) {
  buildElectronPrerequisites(parseCliArguments(process.argv.slice(2))).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
