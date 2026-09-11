import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildElectronMain } from "./build-electron-main.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const artifactRoot = path.join(root, ".review-artifacts");

async function createBuildFixture({ parentName = "electron-build-tests", identifier = randomUUID() } = {}) {
  for (const segment of [parentName, identifier]) {
    if (!segment || segment === "." || segment === ".." || segment.includes("/") || segment.includes("\\")) {
      throw new Error("fixture names must be single contained path segments");
    }
  }
  for (let ancestor = root;; ancestor = path.dirname(ancestor)) {
    const entry = await lstat(ancestor);
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("unsafe fixture ancestor");
    if (ancestor === path.dirname(ancestor)) break;
  }
  const parent = path.join(artifactRoot, parentName);
  for (const directory of [artifactRoot, parent]) {
    try { await mkdir(directory, { mode: 0o700 }); } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    const entry = await lstat(directory);
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("unsafe fixture ancestor");
  }
  const directory = path.join(parent, identifier);
  await mkdir(directory, { mode: 0o700 });
  return directory;
}

test("buildElectronMain emits the flat runtime entrypoint inventory to an explicit output", async () => {
  const outdir = await createBuildFixture();
  const report = await buildElectronMain({ root, outdir });
  assert.deepEqual((await readdir(outdir)).sort(), [
    "calibration-harness-ipc.js", "main.js", "microservice-manager.js",
    "mpc-preferences.js", "package.json", "preload-api.js", "preload.cjs", "quit-gate.js",
  ]);
  assert.equal(report.outdir, outdir);
  assert.equal(report.outputs.length, 8);
  assert.match(report.inputHash, /^[0-9a-f]{64}$/);
});

test("build fixtures initialize an absent controlled parent and retain distinct runs", async () => {
  const parentName = `electron-build-absent-${randomUUID()}`;
  await assert.rejects(lstat(path.join(artifactRoot, parentName)), { code: "ENOENT" });
  const first = await createBuildFixture({ parentName });
  await writeFile(path.join(first, "sentinel.txt"), "retained", { flag: "wx" });
  const second = await createBuildFixture({ parentName });
  assert.notEqual(first, second);
  assert.equal(await readFile(path.join(first, "sentinel.txt"), "utf8"), "retained");
});

test("build fixtures reject traversal, symlink ancestors and exclusive collisions", async () => {
  await assert.rejects(createBuildFixture({ identifier: "../escape" }), /contained/);
  const parentName = `electron-build-collision-${randomUUID()}`;
  const identifier = randomUUID();
  const directory = await createBuildFixture({ parentName, identifier });
  await writeFile(path.join(directory, "sentinel.txt"), "preserve", { flag: "wx" });
  await assert.rejects(createBuildFixture({ parentName, identifier }), { code: "EEXIST" });
  assert.equal(await readFile(path.join(directory, "sentinel.txt"), "utf8"), "preserve");
  const linkedParent = `electron-build-link-${randomUUID()}`;
  await symlink(directory, path.join(artifactRoot, linkedParent), "dir");
  await assert.rejects(createBuildFixture({ parentName: linkedParent, identifier: "must-not-exist" }), /unsafe fixture ancestor/);
  await assert.rejects(lstat(path.join(directory, "must-not-exist")), { code: "ENOENT" });
});

for (const changed of ["source", "config"]) {
  test(`build rejects ${changed} drift after the real typecheck before emitting`, async () => {
    const fixture = await createBuildFixture();
    await mkdir(path.join(fixture, "electron"), { mode: 0o700 });
    const config = { compilerOptions: { strict: true, noEmit: true, target: "ES2022", module: "ESNext", moduleResolution: "bundler", skipLibCheck: true, types: [] }, include: ["*.ts", "*.cts"] };
    await writeFile(path.join(fixture, "package.json"), JSON.stringify({ type: "module", devDependencies: { esbuild: "0.27.2" } }), { flag: "wx" });
    await writeFile(path.join(fixture, "package-lock.json"), JSON.stringify({ packages: { "": { devDependencies: { esbuild: "0.27.2" } }, "node_modules/esbuild": { version: "0.27.2" } } }), { flag: "wx" });
    await writeFile(path.join(fixture, "electron/tsconfig.json"), JSON.stringify(config), { flag: "wx" });
    for (const entry of ["main.ts", "preload.cts", "preload-api.ts", "microservice-manager.ts", "quit-gate.ts", "mpc-preferences.ts", "calibration-harness-ipc.ts"]) {
      await writeFile(path.join(fixture, "electron", entry), "export const value: number = 1;", { flag: "wx" });
    }
    const originalExecFile = childProcess.execFile;
    let mutations = 0;
    childProcess.execFile = (file, args, options, callback) => originalExecFile(file, args, options, (error, stdout, stderr) => {
      if (!error) {
        mutations++;
        if (changed === "source") writeFileSync(path.join(fixture, "electron/main.ts"), 'export const value: number = "unchecked";');
        else writeFileSync(path.join(fixture, "electron/tsconfig.json"), JSON.stringify({ ...config, compilerOptions: { ...config.compilerOptions, strict: false } }));
      }
      callback(error, stdout, stderr);
    });
    syncBuiltinESMExports();
    try {
      const freshBuilder = await import(`./build-electron-main.mjs?type-binding=${randomUUID()}`);
      const outdir = path.join(fixture, "out");
      await assert.rejects(freshBuilder.buildElectronMain({ root: fixture, outdir }), /drifted during typechecking/);
      assert.equal(mutations, 1);
      await assert.rejects(lstat(outdir), { code: "ENOENT" });
    } finally {
      childProcess.execFile = originalExecFile;
      syncBuiltinESMExports();
    }
  });
}
