import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const helperPath = path.join(repoRoot, "scripts", "ensure-scryfall-client-built.mjs");
const runRoot = path.join(
  repoRoot,
  ".review-artifacts",
  `ensure-scryfall-client-built-${randomUUID()}`,
);
fs.mkdirSync(runRoot);

function writeFixtureFile(filePath, content) {
  if (fs.existsSync(filePath)) {
    assert.equal(fs.readFileSync(filePath, "utf8"), content, `fixture mismatch: ${filePath}`);
    return;
  }

  fs.writeFileSync(filePath, content);
}

function createFixture(fixtureName) {
  const fixtureRoot = path.join(runRoot, fixtureName);
  const sharedClientDir = path.join(fixtureRoot, "shared", "scryfall-client");
  const outputDir = path.join(fixtureRoot, "output");
  fs.mkdirSync(fixtureRoot);

  for (const directory of [sharedClientDir, path.join(sharedClientDir, "dist"), path.join(fixtureRoot, "client"), outputDir]) {
    fs.mkdirSync(directory, { recursive: true });
  }

  writeFixtureFile(path.join(fixtureRoot, "package.json"), JSON.stringify({ private: true }, null, 2));
  writeFixtureFile(
    path.join(sharedClientDir, "package.json"),
    JSON.stringify({ private: true, scripts: { build: "node build.mjs" } }, null, 2),
  );
  writeFixtureFile(path.join(sharedClientDir, "package-lock.json"), JSON.stringify({ lockfileVersion: 3 }, null, 2));
  fs.writeFileSync(
    path.join(sharedClientDir, "tsconfig.build.json"),
    JSON.stringify({ compilerOptions: { outDir: "dist" }, include: ["index.ts", "schema.d.ts"] }, null, 2),
  );
  writeFixtureFile(path.join(sharedClientDir, "schema.d.ts"), "export interface Schema {}\n");
  writeFixtureFile(
    path.join(sharedClientDir, "build.mjs"),
    `import fs from "node:fs";
import path from "node:path";

const packageDir = path.dirname(new URL(import.meta.url).pathname);
const outputDir = process.env.BUILD_FRESHNESS_OUTPUT_DIR;
const eventsPath = path.join(outputDir, "events.log");
const source = fs.readFileSync(path.join(packageDir, "index.ts"), "utf8");
const version = source.match(/version = "([^"\\n]+)"/)?.[1];
if (!version) throw new Error("missing source version");
fs.appendFileSync(eventsPath, "shared:start\\n");
await new Promise((resolve) => setTimeout(resolve, 50));
fs.mkdirSync(path.join(packageDir, "dist"), { recursive: true });
fs.writeFileSync(path.join(packageDir, "dist", "index.js"), "export const version = \\"" + version + "\\";\\n");
fs.writeFileSync(path.join(packageDir, "dist", "index.d.ts"), "export declare const version: string;\\n");
fs.writeFileSync(path.join(packageDir, "dist", "schema.d.ts"), "export interface Schema {}\\n");
fs.appendFileSync(eventsPath, "shared:finished\\n");
`,
  );
  writeFixtureFile(
    path.join(fixtureRoot, "client", "package.json"),
    JSON.stringify({ private: true, scripts: { build: "node build.mjs" } }, null, 2),
  );
  writeFixtureFile(
    path.join(fixtureRoot, "client", "build.mjs"),
    `import fs from "node:fs";
import path from "node:path";

const outputDir = process.env.BUILD_FRESHNESS_OUTPUT_DIR;
const eventsPath = path.join(outputDir, "events.log");
const sharedOutput = fs.readFileSync(path.join("..", "shared", "scryfall-client", "dist", "index.js"), "utf8");
fs.appendFileSync(eventsPath, "consumer:start\\n");
if (!sharedOutput.includes('version = "current"')) {
  fs.appendFileSync(eventsPath, "consumer:stale\\n");
  process.exit(1);
}
fs.appendFileSync(eventsPath, "consumer:finished\\n");
`,
  );

  return { fixtureRoot, sharedClientDir, outputDir };
}

function setMtime(filePath, seconds) {
  const timestamp = new Date(seconds * 1000);
  fs.utimesSync(filePath, timestamp, timestamp);
}

function prepareStaleBuild(sharedClientDir) {
  const inputTime = 1_700_000_100;
  const outputTime = 1_700_000_000;

  fs.writeFileSync(path.join(sharedClientDir, "index.ts"), 'export const version = "current";\n');
  for (const input of ["package.json", "package-lock.json", "tsconfig.build.json", "index.ts", "schema.d.ts"]) {
    setMtime(path.join(sharedClientDir, input), inputTime);
  }
  for (const artifact of ["index.js", "index.d.ts", "schema.d.ts"]) {
    fs.writeFileSync(path.join(sharedClientDir, "dist", artifact), "stale\n");
    setMtime(path.join(sharedClientDir, "dist", artifact), outputTime);
  }
}

function run(fixtureRoot, outputDir, command, args) {
  return spawnSync(command, args, {
    cwd: fixtureRoot,
    env: { ...process.env, BUILD_FRESHNESS_OUTPUT_DIR: outputDir },
    encoding: "utf8",
  });
}

test("rebuilds stale existing shared dist before a nested npm consumer runs", () => {
  const { fixtureRoot, sharedClientDir, outputDir } = createFixture("stale-existing-dist");
  prepareStaleBuild(sharedClientDir);

  const readiness = run(fixtureRoot, outputDir, process.execPath, [helperPath]);
  assert.equal(readiness.status, 0, `${readiness.stdout}\n${readiness.stderr}`);

  const consumer = run(fixtureRoot, outputDir, process.platform === "win32" ? "npm.cmd" : "npm", ["run", "build", "--prefix", "client"]);
  assert.equal(consumer.status, 0, `${consumer.stdout}\n${consumer.stderr}`);

  const events = fs.readFileSync(path.join(outputDir, "events.log"), "utf8").trim().split("\n");
  assert.deepEqual(events, ["shared:start", "shared:finished", "consumer:start", "consumer:finished"]);
});

test("rebuilds when the shared compiler configuration is newer than existing dist", () => {
  const { fixtureRoot, sharedClientDir, outputDir } = createFixture("newer-compiler-configuration");
  fs.writeFileSync(path.join(sharedClientDir, "index.ts"), 'export const version = "current";\n');
  for (const input of ["package.json", "package-lock.json", "tsconfig.build.json", "index.ts", "schema.d.ts"]) {
    setMtime(path.join(sharedClientDir, input), 1_700_001_000);
  }
  for (const artifact of ["index.js", "index.d.ts", "schema.d.ts"]) {
    fs.writeFileSync(path.join(sharedClientDir, "dist", artifact), "current\n");
    setMtime(path.join(sharedClientDir, "dist", artifact), 1_700_001_100);
  }
  fs.writeFileSync(
    path.join(sharedClientDir, "tsconfig.build.json"),
    JSON.stringify({ compilerOptions: { outDir: "dist", strict: true }, include: ["index.ts", "schema.d.ts"] }, null, 2),
  );
  setMtime(path.join(sharedClientDir, "tsconfig.build.json"), 1_700_001_200);

  const readiness = run(fixtureRoot, outputDir, process.execPath, [helperPath]);
  assert.equal(readiness.status, 0, `${readiness.stdout}\n${readiness.stderr}`);

  const events = fs.readFileSync(path.join(outputDir, "events.log"), "utf8").trim().split("\n");
  assert.deepEqual(events, ["shared:start", "shared:finished"]);
});
