import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureRoot = path.join(repoRoot, ".review-artifacts", "shared-build-order-01", "fixture");
const helperPath = path.join(repoRoot, "scripts", "build-parallel.mjs");

function writeFixtureFile(filePath, content) {
  if (fs.existsSync(filePath)) {
    assert.equal(fs.readFileSync(filePath, "utf8"), content, `fixture mismatch: ${filePath}`);
    return;
  }

  fs.writeFileSync(filePath, content);
}

function createFixture() {
  const directories = [
    path.join(repoRoot, ".review-artifacts", "shared-build-order-01"),
    fixtureRoot,
    path.join(fixtureRoot, "shared"),
    path.join(fixtureRoot, "shared", "scryfall-client"),
    path.join(fixtureRoot, "client"),
    path.join(fixtureRoot, "server"),
    path.join(fixtureRoot, "output"),
  ];

  for (const directory of directories) {
    if (!fs.existsSync(directory)) {
      fs.mkdirSync(directory);
    }
  }

  writeFixtureFile(
    path.join(fixtureRoot, "package.json"),
    JSON.stringify(
      {
        private: true,
        scripts: {
          "build:shared-client": "npm run build --prefix shared/scryfall-client",
          "build:client": "npm run build --prefix client",
          "build:server": "npm run build --ignore-scripts --prefix server",
          "build:electron:ts": "node electron-build.mjs",
        },
      },
      null,
      2,
    ),
  );
  writeFixtureFile(
    path.join(fixtureRoot, "shared", "scryfall-client", "package.json"),
    JSON.stringify({ private: true, scripts: { build: "node build.mjs" } }, null, 2),
  );
  writeFixtureFile(
    path.join(fixtureRoot, "client", "package.json"),
    JSON.stringify({ private: true, scripts: { build: "node build.mjs client" } }, null, 2),
  );
  writeFixtureFile(
    path.join(fixtureRoot, "server", "package.json"),
    JSON.stringify(
      {
        private: true,
        scripts: {
          prebuild: "node prebuild.mjs",
          build: "node build.mjs server",
        },
      },
      null,
      2,
    ),
  );
  writeFixtureFile(
    path.join(fixtureRoot, "shared", "scryfall-client", "build.mjs"),
    `import fs from "node:fs";
import path from "node:path";

const outputDir = process.env.BUILD_ORDER_OUTPUT_DIR;
const eventsPath = path.join(outputDir, "events.log");
fs.appendFileSync(eventsPath, "shared:start\\n");
await new Promise((resolve) => setTimeout(resolve, 200));
fs.writeFileSync(path.join(outputDir, "shared-ready"), "ready\\n");
fs.appendFileSync(eventsPath, "shared:finished\\n");
`,
  );
  writeFixtureFile(
    path.join(fixtureRoot, "client", "build.mjs"),
    `import fs from "node:fs";
import path from "node:path";

const outputDir = process.env.BUILD_ORDER_OUTPUT_DIR;
const eventsPath = path.join(outputDir, "events.log");
const name = process.argv[2];
fs.appendFileSync(eventsPath, name + ":start\\n");
if (!fs.existsSync(path.join(outputDir, "shared-ready"))) {
  fs.appendFileSync(eventsPath, name + ":premature\\n");
  process.exit(1);
}
fs.appendFileSync(eventsPath, name + ":finished\\n");
`,
  );
  writeFixtureFile(
    path.join(fixtureRoot, "server", "build.mjs"),
    `import fs from "node:fs";
import path from "node:path";

const outputDir = process.env.BUILD_ORDER_OUTPUT_DIR;
const eventsPath = path.join(outputDir, "events.log");
const name = process.argv[2];
fs.appendFileSync(eventsPath, name + ":start\\n");
if (!fs.existsSync(path.join(outputDir, "shared-ready"))) {
  fs.appendFileSync(eventsPath, name + ":premature\\n");
  process.exit(1);
}
fs.appendFileSync(eventsPath, name + ":finished\\n");
`,
  );
  writeFixtureFile(
    path.join(fixtureRoot, "server", "prebuild.mjs"),
    `import fs from "node:fs";
import path from "node:path";

fs.appendFileSync(path.join(process.env.BUILD_ORDER_OUTPUT_DIR, "events.log"), "server:prebuild\\n");
process.exit(1);
`,
  );
  writeFixtureFile(
    path.join(fixtureRoot, "electron-build.mjs"),
    `import fs from "node:fs";
import path from "node:path";

const outputDir = process.env.BUILD_ORDER_OUTPUT_DIR;
fs.appendFileSync(path.join(outputDir, "events.log"), "electron:start\\nelectron:finished\\n");
`,
  );
}

test("builds the shared client once before launching parallel consumers", () => {
  createFixture();

  const outputDir = path.join(fixtureRoot, "output", `run-${process.pid}-${Date.now()}`);
  fs.mkdirSync(outputDir);
  const result = spawnSync(process.execPath, [helperPath], {
    cwd: fixtureRoot,
    env: { ...process.env, BUILD_ORDER_OUTPUT_DIR: outputDir },
    encoding: "utf8",
  });

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

  const events = fs
    .readFileSync(path.join(outputDir, "events.log"), "utf8")
    .trim()
    .split("\n");
  const sharedFinished = events.indexOf("shared:finished");

  assert.equal(events.filter((event) => event === "shared:start").length, 1);
  assert.ok(sharedFinished >= 0, `missing shared completion: ${events.join(", ")}`);
  assert.equal(events.includes("server:prebuild"), false);
  for (const consumer of ["client", "server"]) {
    assert.ok(
      events.indexOf(`${consumer}:start`) > sharedFinished,
      `${consumer} started before the delayed shared build finished: ${events.join(", ")}`,
    );
    assert.equal(events.includes(`${consumer}:premature`), false);
    assert.ok(events.includes(`${consumer}:finished`));
  }
  assert.ok(events.includes("electron:finished"));
});

const prerequisiteFixtureRoot = path.join(
  repoRoot,
  ".review-artifacts",
  "server-build-prerequisite-01",
  "fixture",
);
const productionRootPackage = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
const productionServerPackage = JSON.parse(fs.readFileSync(path.join(repoRoot, "server", "package.json"), "utf8"));

test("production manifests preserve aggregate and standalone server build contracts", () => {
  assert.equal(
    productionRootPackage.scripts["build:server"],
    "npm run build --ignore-scripts --prefix server",
  );
  assert.equal(
    productionServerPackage.scripts.prebuild,
    "npm --prefix ../shared/scryfall-client run build",
  );
});

function createPrerequisiteFixture() {
  for (const directory of [
    prerequisiteFixtureRoot,
    path.join(prerequisiteFixtureRoot, "shared", "scryfall-client"),
    path.join(prerequisiteFixtureRoot, "client"),
    path.join(prerequisiteFixtureRoot, "server"),
    path.join(prerequisiteFixtureRoot, "output"),
  ]) {
    fs.mkdirSync(directory, { recursive: true });
  }

  writeFixtureFile(
    path.join(prerequisiteFixtureRoot, "package.json"),
    JSON.stringify(
      {
        private: true,
        scripts: {
          "build:shared-client": "npm run build --prefix shared/scryfall-client",
          "build:client": "npm run build --prefix client",
          "build:server": "npm run build --ignore-scripts --prefix server",
          "build:electron:ts": "node electron-build.mjs",
        },
      },
      null,
      2,
    ),
  );
  writeFixtureFile(
    path.join(prerequisiteFixtureRoot, "shared", "scryfall-client", "package.json"),
    JSON.stringify({ private: true, scripts: { build: "node build.mjs" } }, null, 2),
  );
  writeFixtureFile(
    path.join(prerequisiteFixtureRoot, "client", "package.json"),
    JSON.stringify({ private: true, scripts: { build: "node build.mjs" } }, null, 2),
  );
  writeFixtureFile(
    path.join(prerequisiteFixtureRoot, "server", "package.json"),
    JSON.stringify(
      {
        private: true,
        scripts: {
          "prebuild": "npm --prefix ../shared/scryfall-client run build",
          "build": "node build.mjs",
        },
      },
      null,
      2,
    ),
  );
  writeFixtureFile(
    path.join(prerequisiteFixtureRoot, "shared", "scryfall-client", "build.mjs"),
    `import fs from "node:fs";
import path from "node:path";

const outputDir = process.env.BUILD_ORDER_OUTPUT_DIR;
const eventsPath = path.join(outputDir, "events.log");
fs.appendFileSync(eventsPath, "shared:build:start\\n");
await new Promise((resolve) => setTimeout(resolve, 100));
fs.writeFileSync(path.join(outputDir, "shared-ready"), "ready\\n");
fs.appendFileSync(eventsPath, "shared:build:finished\\n");
`,
  );
  writeFixtureFile(
    path.join(prerequisiteFixtureRoot, "server", "build.mjs"),
    `import fs from "node:fs";
import path from "node:path";

const outputDir = process.env.BUILD_ORDER_OUTPUT_DIR;
const eventsPath = path.join(outputDir, "events.log");
fs.appendFileSync(eventsPath, "server:build:start\\n");
if (!fs.existsSync(path.join(outputDir, "shared-ready"))) {
  fs.appendFileSync(eventsPath, "server:missing-prerequisite\\n");
  process.exit(1);
}
fs.appendFileSync(eventsPath, "server:build:finished\\n");
`,
  );
  writeFixtureFile(
    path.join(prerequisiteFixtureRoot, "client", "build.mjs"),
    `import fs from "node:fs";
import path from "node:path";

const outputDir = process.env.BUILD_ORDER_OUTPUT_DIR;
const eventsPath = path.join(outputDir, "events.log");
fs.appendFileSync(eventsPath, "client:read:start\\n");
await new Promise((resolve) => setTimeout(resolve, 300));
const events = fs.readFileSync(eventsPath, "utf8");
if ((events.match(/^shared:build:start$/gm) ?? []).length !== 1) {
  fs.appendFileSync(eventsPath, "client:shared-rebuilt-while-reading\\n");
  process.exit(1);
}
fs.appendFileSync(eventsPath, "client:read:finished\\n");
`,
  );
  writeFixtureFile(
    path.join(prerequisiteFixtureRoot, "electron-build.mjs"),
    `import fs from "node:fs";
import path from "node:path";

fs.appendFileSync(path.join(process.env.BUILD_ORDER_OUTPUT_DIR, "events.log"), "electron:finished\\n");
`,
  );
}

function runPrerequisiteFixture(command, args, runName) {
  const outputDir = path.join(prerequisiteFixtureRoot, "output", `${runName}-${process.pid}-${Date.now()}`);
  fs.mkdirSync(outputDir, { recursive: true });
  const result = spawnSync(command, args, {
    cwd: prerequisiteFixtureRoot,
    env: { ...process.env, BUILD_ORDER_OUTPUT_DIR: outputDir },
    encoding: "utf8",
  });
  return {
    result,
    events: fs.readFileSync(path.join(outputDir, "events.log"), "utf8").trim().split("\n"),
  };
}

test("standalone server build establishes its shared-client prerequisite through nested npm", () => {
  createPrerequisiteFixture();
  const { result, events } = runPrerequisiteFixture(
    process.platform === "win32" ? "npm.cmd" : "npm",
    ["run", "build", "--prefix", "server"],
    "standalone",
  );

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(events.filter((event) => event === "shared:build:start").length, 1);
  assert.ok(events.indexOf("shared:build:finished") < events.indexOf("server:build:start"));
  assert.equal(events.includes("server:missing-prerequisite"), false);
  assert.ok(events.includes("server:build:finished"));
});

test("aggregate build does not let the server rebuild the shared client while the client reads it", () => {
  createPrerequisiteFixture();
  const { result, events } = runPrerequisiteFixture(
    process.execPath,
    [helperPath],
    "aggregate",
  );

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(events.filter((event) => event === "shared:build:start").length, 1);
  assert.equal(events.includes("client:shared-rebuilt-while-reading"), false);
  assert.equal(events.includes("client:read:finished"), true);
  assert.equal(events.includes("server:build:finished"), true);
});
