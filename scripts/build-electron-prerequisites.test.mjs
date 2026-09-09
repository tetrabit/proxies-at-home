import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const prerequisiteScript = path.join(repositoryRoot, "scripts", "build-electron-prerequisites.mjs");
const fixtureRoot = path.join(repositoryRoot, ".review-artifacts", `td-30c92a-prerequisites-${randomUUID()}`);

function writeExecutable(filePath, source) {
  writeFileSync(filePath, source, { mode: 0o755 });
  chmodSync(filePath, 0o755);
}

function createFixture() {
  const root = path.join(fixtureRoot, randomUUID());
  const scriptsDirectory = path.join(root, "scripts");
  const binDirectory = path.join(root, "bin");
  const eventLog = path.join(root, "events.log");
  mkdirSync(scriptsDirectory, { recursive: true });
  mkdirSync(binDirectory, { recursive: true });

  writeFileSync(path.join(root, "package.json"), JSON.stringify({
    private: true,
    scripts: {
      "build:parallel": "node scripts/js-build.mjs",
      "build:electron:prerequisites": `node ${JSON.stringify(prerequisiteScript)}`,
      "electron:build": "npm run build:electron:prerequisites && node scripts/resolver.mjs && electron-builder",
    },
  }, null, 2));

  writeExecutable(path.join(scriptsDirectory, "build-microservice.sh"), `#!/bin/sh
exec node scripts/rust-build.mjs
`);
  writeExecutable(path.join(binDirectory, "npm"), `#!/bin/sh
if [ "$1" != "run" ] || [ "$2" != "build:parallel" ]; then
  printf 'unexpected npm invocation: %s\\n' "$*" >&2
  exit 64
fi
node scripts/js-build.mjs &
wait "$!"
`);
  writeExecutable(path.join(binDirectory, "electron-builder"), `#!/bin/sh
node scripts/builder.mjs
`);

  writeFileSync(path.join(scriptsDirectory, "rust-build.mjs"), `import fs from "node:fs";
const events = process.env.PREREQUISITE_EVENTS;
const artifact = process.env.RUST_ARTIFACT;
fs.appendFileSync(events, "rust:started\\n");
process.once("SIGTERM", () => {
  fs.appendFileSync(events, "rust:terminated\\n");
  process.exit(0);
});
if (process.env.RUST_MODE === "fail") {
  fs.appendFileSync(events, "rust:failed\\n");
  process.exit(23);
}
await new Promise((resolve) => setTimeout(resolve, 120));
fs.writeFileSync(artifact, "rust artifact\\n");
fs.appendFileSync(events, "rust:complete\\n");
`);
  writeFileSync(path.join(scriptsDirectory, "js-build.mjs"), `import fs from "node:fs";
const events = process.env.PREREQUISITE_EVENTS;
const artifact = process.env.JS_ARTIFACT;
fs.appendFileSync(events, "js:started\\n");
process.once("SIGTERM", () => {
  fs.appendFileSync(events, "js:terminated\\n");
  process.exit(0);
});
if (process.env.JS_MODE === "fail") {
  await new Promise((resolve) => setTimeout(resolve, 80));
  fs.appendFileSync(events, "js:failed\\n");
  process.exit(24);
}
await new Promise((resolve) => setTimeout(resolve, 220));
fs.writeFileSync(artifact, "js artifact\\n");
fs.appendFileSync(events, "js:complete\\n");
`);
  writeFileSync(path.join(scriptsDirectory, "resolver.mjs"), `import fs from "node:fs";
const events = process.env.PREREQUISITE_EVENTS;
fs.appendFileSync(events, "resolver:started\\n");
for (const artifact of [process.env.RUST_ARTIFACT, process.env.JS_ARTIFACT]) {
  if (!fs.existsSync(artifact)) throw new Error("resolver started before a complete prerequisite artifact");
}
fs.appendFileSync(events, "resolver:complete\\n");
`);
  writeFileSync(path.join(scriptsDirectory, "builder.mjs"), `import fs from "node:fs";
const events = process.env.PREREQUISITE_EVENTS;
fs.appendFileSync(events, "builder:started\\n");
const entries = fs.readFileSync(events, "utf8");
if (!entries.includes("resolver:complete\\n")) throw new Error("Builder started before resolver completion");
fs.appendFileSync(events, "builder:complete\\n");
`);

  return { root, binDirectory, eventLog };
}

function runPackagingFixture(fixture, overrides = {}) {
  const environment = {
    ...process.env,
    PATH: `${fixture.binDirectory}${path.delimiter}${process.env.PATH ?? ""}`,
    PREREQUISITE_EVENTS: fixture.eventLog,
    RUST_ARTIFACT: path.join(fixture.root, "rust-artifact"),
    JS_ARTIFACT: path.join(fixture.root, "js-artifact"),
    RUST_MODE: "success",
    JS_MODE: "success",
    ...overrides,
  };
  const result = spawnSync("bash", ["-c", `node ${JSON.stringify(prerequisiteScript)} && node scripts/resolver.mjs && electron-builder`], {
    cwd: fixture.root,
    env: environment,
    encoding: "utf8",
    timeout: 5_000,
  });
  const events = existsSync(fixture.eventLog) ? readFileSync(fixture.eventLog, "utf8").trim().split("\n") : [];
  return { result, events };
}

test("joins the bounded Rust and JS prerequisites before resolving and building", () => {
  const fixture = createFixture();
  const { result, events } = runPackagingFixture(fixture);

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.ok(events.includes("rust:started"));
  assert.ok(events.includes("js:started"));
  const completePrerequisites = Math.max(events.indexOf("rust:complete"), events.indexOf("js:complete"));
  assert.ok(events.indexOf("resolver:started") > completePrerequisites, events.join(", "));
  assert.ok(events.indexOf("builder:started") > events.indexOf("resolver:complete"), events.join(", "));
  assert.deepEqual(events.slice(-2), ["builder:started", "builder:complete"]);
});

test("a failed Rust prerequisite settles the started JS child and prevents stale artifacts reaching resolver or Builder", () => {
  const fixture = createFixture();
  const rustArtifact = path.join(fixture.root, "rust-artifact");
  const jsArtifact = path.join(fixture.root, "js-artifact");
  writeFileSync(rustArtifact, "stale Rust artifact\\n");
  writeFileSync(jsArtifact, "stale JS artifact\\n");
  const { result, events } = runPackagingFixture(fixture, { RUST_MODE: "fail" });

  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.ok(events.includes("rust:failed"));
  assert.ok(events.includes("js:started"));
  assert.ok(events.includes("js:terminated"), events.join(", "));
  assert.equal(events.includes("resolver:started"), false, events.join(", "));
  assert.equal(events.includes("builder:started"), false, events.join(", "));
  assert.equal(events.includes("js:complete"), false, events.join(", "));
  assert.equal(readFileSync(rustArtifact, "utf8"), "stale Rust artifact\\n");
  assert.equal(readFileSync(jsArtifact, "utf8"), "stale JS artifact\\n");
});

test("a failed JavaScript prerequisite settles the started Rust child and prevents resolver and Builder", () => {
  const fixture = createFixture();
  const { result, events } = runPackagingFixture(fixture, { JS_MODE: "fail" });

  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.ok(events.includes("rust:started"), events.join(", "));
  assert.ok(events.includes("js:failed"), events.join(", "));
  assert.ok(events.includes("rust:terminated"), events.join(", "));
  assert.equal(events.includes("rust:complete"), false, events.join(", "));
  assert.equal(events.includes("resolver:started"), false, events.join(", "));
  assert.equal(events.includes("builder:started"), false, events.join(", "));
});

test("production package commands join prerequisites before staging and Builder", () => {
  const packageJson = JSON.parse(readFileSync(path.join(repositoryRoot, "package.json"), "utf8"));
  const prerequisite = "npm run build:electron:prerequisites";
  const resolver = "node scripts/prepare-microservice-package.mjs";

  assert.equal(packageJson.scripts["build:electron:prerequisites"], "node scripts/build-electron-prerequisites.mjs");
  assert.equal(packageJson.scripts["test:electron-prerequisites"], "node --test scripts/build-electron-prerequisites.test.mjs");
  for (const command of [packageJson.scripts["electron:build"], packageJson.scripts["electron:build:win"]]) {
    assert.ok(command.indexOf(prerequisite) >= 0, command);
    assert.ok(command.indexOf(prerequisite) < command.indexOf(resolver), command);
    assert.ok(command.indexOf(resolver) < command.indexOf("electron-builder"), command);
    assert.equal(command.includes("bash scripts/build-microservice.sh"), false, command);
    assert.equal(command.includes("npm run build:parallel"), false, command);
  }
});
