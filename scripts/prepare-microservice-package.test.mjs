import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { resolveMicroserviceArtifact, stageMicroservicePackage } from "./prepare-microservice-package.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = path.join(PROJECT_ROOT, ".review-artifacts");
const SOURCE_BUILD = {
  kind: "nativeSqliteIsolated",
  sourceCommit: "dcb2825257e196be190d3739560eb92a64db0e8b",
  sourceTree: "dc8dbfb8b8a3dbd8453e99ef3b03d0c1f75dcdf1",
  sourceArchiveSha256: "e7b959549f88943dabb242ec6e50788b06e4876e61a0bb6e0fa38c99103f4c16",
  sourceLockSha256: "976bab6b945b691bb24abd693541f80aebb01c9e0ee530cc8c5167bf44bf5aed",
  patchSha256: "cfdae2db9613af918e3aced537de532b728f718f4e28d71833e2b8e8cc19e6a7",
};

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const nameFor = (platform) => platform === "win32" ? "scryfall-cache.exe" : "scryfall-cache";

async function fixture(platform = "linux") {
  await mkdir(ROOT, { recursive: true });
  const root = await mkdtemp(path.join(ROOT, "td-4496de-stage-"));
  const sourcePath = path.join(root, "producer", nameFor(platform));
  await mkdir(path.dirname(sourcePath), { recursive: true });
  const bytes = Buffer.from(`verified ${platform} native bytes`);
  await writeFile(sourcePath, bytes, { mode: 0o755 });
  const manifest = {
    schemaVersion: 2,
    runtime: "desktopSQLite",
    backend: "sqlite",
    platform,
    profile: "release",
    binary: { sourcePath, fileName: nameFor(platform), sha256: sha256(bytes) },
    sourceBuild: SOURCE_BUILD,
  };
  const manifestPath = path.join(root, "producer", "microservice-artifact.json");
  const manifestBytes = `${JSON.stringify(manifest)}\n`;
  await writeFile(manifestPath, manifestBytes);
  return { root, sourcePath, manifest, manifestPath, manifestBytes, stagingDir: path.join(root, "stage") };
}

async function rejectsWithoutStage(action, stagingDir, expression = /Rejected microservice artifact/) {
  await assert.rejects(action, expression);
  await assert.rejects(lstat(stagingDir));
}

test("stages an exact v2 desktop SQLite producer pair with byte-identical manifest", async () => {
  const f = await fixture();
  const artifact = await resolveMicroserviceArtifact({ manifestPath: f.manifestPath, expectedPlatform: "linux" });
  assert.equal(artifact.binaryPath, f.sourcePath);
  await stageMicroservicePackage({ manifestPath: f.manifestPath, stagingDir: f.stagingDir, expectedPlatform: "linux" });
  assert.deepEqual((await readdir(f.stagingDir)).sort(), ["microservice-artifact.json", "scryfall-cache"]);
  assert.deepEqual(await readFile(path.join(f.stagingDir, "microservice-artifact.json")), Buffer.from(f.manifestBytes));
  assert.deepEqual(await readFile(path.join(f.stagingDir, "scryfall-cache")), await readFile(f.sourcePath));
  assert.ok((await stat(path.join(f.stagingDir, "scryfall-cache"))).mode & 0o100);
});

test("stages the canonical Windows executable name", async () => {
  const f = await fixture("win32");
  await stageMicroservicePackage({ manifestPath: f.manifestPath, stagingDir: f.stagingDir, expectedPlatform: "win32" });
  assert.deepEqual((await readdir(f.stagingDir)).sort(), ["microservice-artifact.json", "scryfall-cache.exe"]);
});

for (const [label, mutate] of [
  ["v1", (m) => { m.schemaVersion = 1; }],
  ["PostgreSQL backend", (m) => { m.backend = "postgres"; }],
  ["external server runtime", (m) => { m.runtime = "externalServer"; }],
  ["debug profile", (m) => { m.profile = "debug"; }],
  ["extra key", (m) => { m.untrusted = true; }],
  ["missing key", (m) => { delete m.sourceBuild; }],
  ["upper-case digest", (m) => { m.binary.sha256 = m.binary.sha256.toUpperCase(); }],
  ["mismatched platform", (m) => { m.platform = "darwin"; }],
  ["non-basename", (m) => { m.binary.fileName = "../scryfall-cache"; }],
  ["wrong basename", (m) => { m.binary.fileName = "cache"; }],
  ["relative source", (m) => { m.binary.sourcePath = "relative/cache"; }],
  ["wrong source provenance", (m) => { m.sourceBuild.patchSha256 = "0".repeat(64); }],
]) {
  test(`rejects ${label} before publishing a stage`, async () => {
    const f = await fixture();
    mutate(f.manifest);
    await writeFile(f.manifestPath, JSON.stringify(f.manifest));
    await rejectsWithoutStage(() => stageMicroservicePackage({ manifestPath: f.manifestPath, stagingDir: f.stagingDir, expectedPlatform: "linux" }), f.stagingDir);
  });
}

test("rejects nonregular, missing, and source-byte-mismatched inputs before publication", async () => {
  const missing = await fixture();
  missing.manifest.binary.sourcePath = path.join(missing.root, "absent");
  await writeFile(missing.manifestPath, JSON.stringify(missing.manifest));
  await rejectsWithoutStage(() => stageMicroservicePackage({ manifestPath: missing.manifestPath, stagingDir: missing.stagingDir, expectedPlatform: "linux" }), missing.stagingDir);

  const directory = await fixture();
  const dirPath = path.join(directory.root, "not-a-binary");
  await mkdir(dirPath);
  directory.manifest.binary.sourcePath = dirPath;
  await writeFile(directory.manifestPath, JSON.stringify(directory.manifest));
  await rejectsWithoutStage(() => stageMicroservicePackage({ manifestPath: directory.manifestPath, stagingDir: directory.stagingDir, expectedPlatform: "linux" }), directory.stagingDir);

  const changed = await fixture();
  await writeFile(changed.sourcePath, "tampered");
  await rejectsWithoutStage(() => stageMicroservicePackage({ manifestPath: changed.manifestPath, stagingDir: changed.stagingDir, expectedPlatform: "linux" }), changed.stagingDir, /sha256/i);
});

test("invalid input never clears or falls back to a pre-existing stage", async () => {
  const f = await fixture();
  await mkdir(f.stagingDir);
  await writeFile(path.join(f.stagingDir, "scryfall-cache"), "old");
  f.manifest.backend = "postgres";
  await writeFile(f.manifestPath, JSON.stringify(f.manifest));
  await assert.rejects(() => stageMicroservicePackage({ manifestPath: f.manifestPath, stagingDir: f.stagingDir, expectedPlatform: "linux" }));
  assert.equal(await readFile(path.join(f.stagingDir, "scryfall-cache"), "utf8"), "old");
});

test("desktop package wiring stages v2 artifact resources and never names the PostgreSQL builder", async () => {
  const packageJson = JSON.parse(await readFile(path.join(PROJECT_ROOT, "package.json"), "utf8"));
  const prerequisiteSource = await readFile(path.join(PROJECT_ROOT, "scripts", "build-electron-prerequisites.mjs"), "utf8");
  assert.match(prerequisiteSource, /prepare-microservice-package/);
  assert.match(prerequisiteSource, /build-native-sqlite-isolated\.sh/);
  assert.doesNotMatch(prerequisiteSource, /build-microservice\.sh/);
  for (const command of [packageJson.scripts["electron:build"], packageJson.scripts["electron:build:win"], packageJson.scripts["electron:dev"]]) {
    assert.match(command, /build:electron:prerequisites/);
    assert.doesNotMatch(command, /build-microservice\.sh/);
  }
  const resource = packageJson.build.extraResources.find((entry) => entry.to === "microservices");
  assert.deepEqual(resource.filter.sort(), ["microservice-artifact.json", "scryfall-cache", "scryfall-cache.exe"]);
  assert.doesNotMatch(JSON.stringify(resource), /target\/release/);
});
