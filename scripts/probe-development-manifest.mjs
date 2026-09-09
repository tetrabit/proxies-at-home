#!/usr/bin/env node
import { execFile as execFileCallback } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { promisify } from "node:util";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const execFile = promisify(execFileCallback);
const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const fixtureRoot = path.join(
  repositoryRoot,
  ".review-artifacts",
  `td-994223-development-manifest-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`
);
const sourceDirectory = path.join(fixtureRoot, "source");
const emittedDirectory = path.join(fixtureRoot, "emitted");
const userDataDirectory = path.join(fixtureRoot, "user-data");
const managerSource = path.join(
  repositoryRoot,
  "electron",
  "microservice-manager.ts"
);
const copiedManagerSource = path.join(
  sourceDirectory,
  "microservice-manager.mts"
);
const emittedManager = path.join(emittedDirectory, "microservice-manager.mjs");
const manifestPath = path.join(emittedDirectory, "microservice-artifact.json");
const fixtureBinary = path.join(fixtureRoot, "scryfall-cache");
const loaderPath = path.join(fixtureRoot, "electron-loader.mjs");
const electronStubPath = path.join(fixtureRoot, "electron-stub.mjs");
const runnerPath = path.join(fixtureRoot, "run-manager-probe.mjs");

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function writeExclusive(filePath, contents, options = {}) {
  await writeFile(filePath, contents, { ...options, flag: "wx" });
}

const fixtureProgram = `#!/usr/bin/env node
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const port = Number(process.env.PORT);
const recordPath = path.join(${JSON.stringify(fixtureRoot)}, "fixture-record.json");
const record = (value) => fs.writeFileSync(recordPath, JSON.stringify(value));
record({ phase: "listening", pid: process.pid, port, databaseUrl: process.env.DATABASE_URL, rustLog: process.env.RUST_LOG });
const server = http.createServer((request, response) => {
  if (request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ service: "scryfall-cache", status: "healthy", version: "node-fixture" }));
    return;
  }
  response.writeHead(404);
  response.end();
});
server.listen(port, "127.0.0.1");
process.on("SIGTERM", () => {
  server.close(() => {
    record({ phase: "exited", pid: process.pid, port, databaseUrl: process.env.DATABASE_URL, rustLog: process.env.RUST_LOG, exitCode: 0, exitSignal: "SIGTERM" });
    process.exit(0);
  });
});
`;

async function main() {
  await mkdir(sourceDirectory, { recursive: true });
  await mkdir(emittedDirectory, { recursive: true });

  const sourceBytes = await readFile(managerSource);
  await writeExclusive(copiedManagerSource, sourceBytes);
  await writeExclusive(fixtureBinary, fixtureProgram, { mode: 0o755 });
  await chmod(fixtureBinary, 0o755);
  await writeExclusive(
    manifestPath,
    JSON.stringify({
      schemaVersion: 1,
      binaryPath: fixtureBinary,
      platform: process.platform,
      profile: "debug",
    })
  );
  await writeExclusive(
    electronStubPath,
    `export const app = { isPackaged: false, getPath: () => ${JSON.stringify(userDataDirectory)} };\n`
  );
  await writeExclusive(
    loaderPath,
    `const electronStub = new URL("./electron-stub.mjs", import.meta.url).href;
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "electron") return { url: electronStub, shortCircuit: true };
  return nextResolve(specifier, context);
}
`
  );

  await execFile(
    path.join(repositoryRoot, "node_modules", ".bin", "tsc"),
    [
      copiedManagerSource,
      "--target",
      "ES2022",
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      "--esModuleInterop",
      "--strict",
      "--skipLibCheck",
      "--outDir",
      emittedDirectory,
    ],
    { cwd: repositoryRoot }
  );

  const runnerProgram = `import { readFile } from "node:fs/promises";
import { MicroserviceManager } from ${JSON.stringify(pathToFileURL(emittedManager).href)};

const fixtureRoot = ${JSON.stringify(fixtureRoot)};
const fixtureBinary = ${JSON.stringify(fixtureBinary)};
const manifestPath = ${JSON.stringify(manifestPath)};
const userDataDirectory = ${JSON.stringify(userDataDirectory)};
const port = 39100 + (process.pid % 1000);
const originalLog = console.log;
console.log = (...values) => process.stderr.write(values.join(" ") + "\\n");
let manager;
try {
  manager = new MicroserviceManager({
    name: "Scryfall Cache",
    binaryName: "scryfall-cache",
    port,
    healthCheckPath: "/health",
    healthCheckInterval: 60_000,
    maxRestarts: 0,
    restartDelay: 10,
  });
  const selectedPath = manager.getBinaryPath();
  if (selectedPath !== fixtureBinary) throw new Error("default manifest selection did not choose the fixture binary");
  const startedPort = await manager.start();
  const listening = JSON.parse(await readFile(fixtureRoot + "/fixture-record.json", "utf8"));
  if (startedPort !== port || listening.pid <= 0 || listening.port !== port) throw new Error("fixture pid/port record is invalid");
  if (listening.databaseUrl !== userDataDirectory + "/databases/scryfall-cache.db" || listening.rustLog !== "info") throw new Error("fixture environment is invalid");
  await manager.stop();
  const exited = JSON.parse(await readFile(fixtureRoot + "/fixture-record.json", "utf8"));
  let orphaned = false;
  try {
    process.kill(exited.pid, 0);
    orphaned = true;
  } catch (error) {
    if (error && error.code !== "ESRCH") throw error;
  }
  if (exited.phase !== "exited" || exited.exitCode !== 0 || exited.exitSignal !== "SIGTERM" || orphaned) throw new Error("fixture did not exit cleanly");
  process.stdout.write(JSON.stringify({ fixtureRoot, manifestPath, selectedPath, fixturePid: exited.pid, port, databaseUrl: exited.databaseUrl, rustLog: exited.rustLog, exitCode: exited.exitCode, exitSignal: exited.exitSignal, orphaned }) + "\\n");
} finally {
  if (manager?.isRunning()) await manager.stop();
  console.log = originalLog;
}
`;
  await writeExclusive(runnerPath, runnerProgram);

  const { stdout } = await execFile(
    process.execPath,
    ["--experimental-loader", loaderPath, runnerPath],
    { cwd: repositoryRoot }
  );
  const result = JSON.parse(stdout);
  const copiedSourceBytes = await readFile(copiedManagerSource);
  const emittedBytes = await readFile(emittedManager);
  process.stdout.write(
    `${JSON.stringify({
      ...result,
      sourceSha256: sha256(sourceBytes),
      copiedSourceSha256: sha256(copiedSourceBytes),
      emittedSha256: sha256(emittedBytes),
    })}\n`
  );
}

await main();
