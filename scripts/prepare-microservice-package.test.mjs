import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { resolveMicroserviceArtifact, stageMicroservicePackage } from "./prepare-microservice-package.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEST_ROOT_PARENT = path.join(PROJECT_ROOT, ".review-artifacts");

async function fixture() {
  await mkdir(TEST_ROOT_PARENT, { recursive: true });
  const root = await mkdtemp(path.join(TEST_ROOT_PARENT, "td-030b6c-package-"));
  return {
    root,
    manifestPath: path.join(root, "microservice-artifact.json"),
    stagingDir: path.join(root, "microservice-package"),
    alternateTargetDir: path.join(root, "alternate-target", "release"),
    legacyTargetDir: path.join(root, "legacy-sibling", "target", "release"),
  };
}

async function writeManifest(manifestPath, manifest) {
  await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
}

async function writeBinary(directory, name, contents) {
  await mkdir(directory, { recursive: true });
  const binaryPath = path.join(directory, name);
  await writeFile(binaryPath, contents);
  return binaryPath;
}

async function assertRejected(action, field) {
  await assert.rejects(action, new RegExp(field, "i"));
}

test("stages only the alternate Linux manifest binary and excludes the legacy sibling marker", async () => {
  const paths = await fixture();
  const alternateBinary = await writeBinary(paths.alternateTargetDir, "scryfall-cache", "alternate binary bytes");
  await writeBinary(paths.legacyTargetDir, "scryfall-cache", "stale sibling bytes");
  await writeManifest(paths.manifestPath, {
    schemaVersion: 1,
    binaryPath: alternateBinary,
    platform: "linux",
    profile: "release",
  });

  const staged = await stageMicroservicePackage({
    manifestPath: paths.manifestPath,
    stagingDir: paths.stagingDir,
    expectedPlatform: "linux",
  });

  assert.equal(staged.binaryPath, await resolveMicroserviceArtifact({
    manifestPath: paths.manifestPath,
    expectedPlatform: "linux",
  }).then((result) => result.binaryPath));
  assert.equal(await readFile(path.join(paths.stagingDir, "scryfall-cache"), "utf8"), "alternate binary bytes");
  assert.deepEqual(await readdir(paths.stagingDir), ["scryfall-cache"]);
  await assert.rejects(stat(path.join(paths.stagingDir, "scryfall-cache.exe")));
});

test("requires and stages the Windows executable name", async () => {
  const paths = await fixture();
  const binaryPath = await writeBinary(paths.alternateTargetDir, "scryfall-cache.exe", "windows binary bytes");
  await writeManifest(paths.manifestPath, {
    schemaVersion: 1,
    binaryPath,
    platform: "win32",
    profile: "release",
  });

  await stageMicroservicePackage({
    manifestPath: paths.manifestPath,
    stagingDir: paths.stagingDir,
    expectedPlatform: "win32",
  });

  assert.equal(await readFile(path.join(paths.stagingDir, "scryfall-cache.exe"), "utf8"), "windows binary bytes");
  assert.deepEqual(await readdir(paths.stagingDir), ["scryfall-cache.exe"]);
});

test("rejects a manifest platform that differs from the package target", async () => {
  const paths = await fixture();
  const binaryPath = await writeBinary(paths.alternateTargetDir, "scryfall-cache", "linux binary");
  await writeManifest(paths.manifestPath, { schemaVersion: 1, binaryPath, platform: "linux", profile: "release" });

  await assertRejected(
    () => stageMicroservicePackage({ manifestPath: paths.manifestPath, stagingDir: paths.stagingDir, expectedPlatform: "win32" }),
    "platform",
  );
  await assert.rejects(stat(paths.stagingDir));
});

for (const profile of ["dev", "debug"]) {
  test(`rejects ${profile} artifacts for release packaging`, async () => {
    const paths = await fixture();
    const binaryPath = await writeBinary(paths.alternateTargetDir, "scryfall-cache", `${profile} binary`);
    await writeManifest(paths.manifestPath, { schemaVersion: 1, binaryPath, platform: "linux", profile });

    await assertRejected(
      () => stageMicroservicePackage({ manifestPath: paths.manifestPath, stagingDir: paths.stagingDir, expectedPlatform: "linux" }),
      "profile",
    );
  });
}

test("rejects absent, malformed, and schema-invalid manifests", async () => {
  const absent = await fixture();
  await assertRejected(
    () => resolveMicroserviceArtifact({ manifestPath: absent.manifestPath, expectedPlatform: "linux" }),
    "manifest",
  );

  const malformed = await fixture();
  await writeFile(malformed.manifestPath, "not json\n");
  await assertRejected(
    () => resolveMicroserviceArtifact({ manifestPath: malformed.manifestPath, expectedPlatform: "linux" }),
    "manifest",
  );

  const invalid = await fixture();
  await writeManifest(invalid.manifestPath, { schemaVersion: 2, binaryPath: "/binary", platform: "linux", profile: "release" });
  await assertRejected(
    () => resolveMicroserviceArtifact({ manifestPath: invalid.manifestPath, expectedPlatform: "linux" }),
    "schemaVersion",
  );

  const unknownField = await fixture();
  await writeManifest(unknownField.manifestPath, {
    schemaVersion: 1,
    binaryPath: "/binary",
    platform: "linux",
    profile: "release",
    stale: true,
  });
  await assertRejected(
    () => resolveMicroserviceArtifact({ manifestPath: unknownField.manifestPath, expectedPlatform: "linux" }),
    "manifest",
  );
});

test("rejects unknown manifest identity values and non-absolute binary paths", async () => {
  const paths = await fixture();
  await writeManifest(paths.manifestPath, {
    schemaVersion: 1,
    binaryPath: "relative/scryfall-cache",
    platform: "linux",
    profile: "release",
  });
  await assertRejected(
    () => resolveMicroserviceArtifact({ manifestPath: paths.manifestPath, expectedPlatform: "linux" }),
    "binaryPath",
  );

  const unknownPlatform = await fixture();
  await writeManifest(unknownPlatform.manifestPath, {
    schemaVersion: 1,
    binaryPath: "/scryfall-cache",
    platform: "freebsd",
    profile: "release",
  });
  await assertRejected(
    () => resolveMicroserviceArtifact({ manifestPath: unknownPlatform.manifestPath, expectedPlatform: "linux" }),
    "platform",
  );

  const unknownProfile = await fixture();
  await writeManifest(unknownProfile.manifestPath, {
    schemaVersion: 1,
    binaryPath: "/scryfall-cache",
    platform: "linux",
    profile: "nightly",
  });
  await assertRejected(
    () => resolveMicroserviceArtifact({ manifestPath: unknownProfile.manifestPath, expectedPlatform: "linux" }),
    "profile",
  );
});

test("rejects an absent or non-regular declared binary before publishing", async () => {
  const absent = await fixture();
  await writeManifest(absent.manifestPath, {
    schemaVersion: 1,
    binaryPath: path.join(absent.root, "missing", "scryfall-cache"),
    platform: "linux",
    profile: "release",
  });
  await assertRejected(
    () => stageMicroservicePackage({ manifestPath: absent.manifestPath, stagingDir: absent.stagingDir, expectedPlatform: "linux" }),
    "binaryPath",
  );

  const directory = await fixture();
  await mkdir(path.join(directory.root, "scryfall-cache"));
  await writeManifest(directory.manifestPath, {
    schemaVersion: 1,
    binaryPath: path.join(directory.root, "scryfall-cache"),
    platform: "linux",
    profile: "release",
  });
  await assertRejected(
    () => stageMicroservicePackage({ manifestPath: directory.manifestPath, stagingDir: directory.stagingDir, expectedPlatform: "linux" }),
    "regular file",
  );
});

test("rejects incompatible canonical binary basenames and extensions", async () => {
  const paths = await fixture();
  const binaryPath = await writeBinary(paths.alternateTargetDir, "scryfall-cache.exe", "wrong extension");
  await writeManifest(paths.manifestPath, { schemaVersion: 1, binaryPath, platform: "linux", profile: "release" });

  await assertRejected(
    () => resolveMicroserviceArtifact({ manifestPath: paths.manifestPath, expectedPlatform: "linux" }),
    "basename",
  );
});

test("does not clear, reuse, or fall back to an old staging directory after invalid current input", async () => {
  const paths = await fixture();
  await mkdir(paths.stagingDir, { recursive: true });
  const oldStage = path.join(paths.stagingDir, "scryfall-cache");
  await writeFile(oldStage, "old staged bytes");
  await writeFile(paths.manifestPath, "malformed manifest");

  await assertRejected(
    () => stageMicroservicePackage({ manifestPath: paths.manifestPath, stagingDir: paths.stagingDir, expectedPlatform: "linux" }),
    "manifest",
  );
  assert.equal(await readFile(oldStage, "utf8"), "old staged bytes");
  assert.deepEqual(await readdir(paths.stagingDir), ["scryfall-cache"]);
});

test("refuses to overwrite a pre-existing staging directory", async () => {
  const paths = await fixture();
  const binaryPath = await writeBinary(paths.alternateTargetDir, "scryfall-cache", "new binary");
  await writeManifest(paths.manifestPath, { schemaVersion: 1, binaryPath, platform: "linux", profile: "release" });
  await mkdir(paths.stagingDir, { recursive: true });
  await writeFile(path.join(paths.stagingDir, "scryfall-cache"), "old binary");

  await assertRejected(
    () => stageMicroservicePackage({ manifestPath: paths.manifestPath, stagingDir: paths.stagingDir, expectedPlatform: "linux" }),
    "staging",
  );
  assert.equal(await readFile(path.join(paths.stagingDir, "scryfall-cache"), "utf8"), "old binary");
});

test("package commands invoke the resolver before Builder and Builder receives only the staging directory", async () => {
  const packageJson = JSON.parse(await readFile(path.join(PROJECT_ROOT, "package.json"), "utf8"));
  const build = packageJson.scripts["electron:build"];
  const buildWin = packageJson.scripts["electron:build:win"];
  const resolver = "node scripts/prepare-microservice-package.mjs";

  for (const command of [build, buildWin]) {
    assert.ok(command.includes(resolver), command);
    assert.ok(command.indexOf("bash scripts/build-microservice.sh") < command.indexOf(resolver), command);
    assert.ok(command.indexOf("npm run build:parallel") < command.indexOf(resolver), command);
    assert.ok(command.indexOf(resolver) < command.indexOf("electron-builder"), command);
  }
  assert.match(buildWin, /node scripts\/prepare-microservice-package\.mjs --platform win32/);

  const microserviceResource = packageJson.build.extraResources.find((resource) => resource.to === "microservices");
  assert.deepEqual(microserviceResource, {
    from: "electron/dist/microservice-package",
    to: "microservices",
    filter: ["scryfall-cache", "scryfall-cache.exe"],
  });
  assert.doesNotMatch(JSON.stringify(packageJson.build.extraResources), /\.\.\/scryfall-cache-microservice\/target\/release/);
});
