import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("desktop prerequisites bound exactly two concurrent producer/JS branches then stage the reported v2 manifest", async () => {
  const source = await readFile(path.join(root, "scripts", "build-electron-prerequisites.mjs"), "utf8");
  assert.match(source, /MAX_CONCURRENT_PREREQUISITES = 2/);
  assert.match(source, /build-native-sqlite-isolated\.sh/);
  assert.match(source, /npmCommand, args: \["run", "build:parallel"\]/);
  assert.match(source, /parseBuildRoot/);
  assert.match(source, /microservice-artifact\.json/);
  assert.match(source, /prepare-microservice-package\.mjs/);
  assert.doesNotMatch(source, /build-microservice\.sh/);
});

test("packaged and development Electron commands establish prerequisites before Electron can run", async () => {
  const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  for (const key of ["electron:dev", "electron:build", "electron:build:win"]) {
    assert.match(packageJson.scripts[key], /build:electron:prerequisites/);
    assert.doesNotMatch(packageJson.scripts[key], /build-microservice\.sh/);
  }
  assert.match(packageJson.scripts["electron:build:win"], /--platform win32/);
});
