import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, lstat, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { build, version as esbuildVersion } from "esbuild";
import ts from "typescript";

const execFileAsync = promisify(execFile);
const builderPath = fileURLToPath(import.meta.url);
const typescriptCli = fileURLToPath(new URL("../node_modules/typescript/bin/tsc", import.meta.url));
const typescriptPackage = fileURLToPath(new URL("../node_modules/typescript/package.json", import.meta.url));
const esbuildPackage = fileURLToPath(new URL("../node_modules/esbuild/package.json", import.meta.url));

const entrypoints = Object.freeze({
  "main.js": "electron/main.ts",
  "preload.cjs": "electron/preload.cts",
  "preload-api.js": "electron/preload-api.ts",
  "microservice-manager.js": "electron/microservice-manager.ts",
  "quit-gate.js": "electron/quit-gate.ts",
  "mpc-preferences.js": "electron/mpc-preferences.ts",
  "calibration-harness-ipc.js": "electron/calibration-harness-ipc.ts",
});
const packageOutput = "package.json";
const declaredOutputs = Object.freeze([...Object.keys(entrypoints), packageOutput].sort());

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalPath(root, filename) {
  const resolved = path.resolve(root, filename);
  const relative = path.relative(root, resolved);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`electron build input escaped root: ${filename}`);
  }
  return relative.split(path.sep).join("/");
}

async function readInput(root, filename) {
  const normalized = canonicalPath(root, filename);
  const bytes = await readFile(path.join(root, normalized));
  return Object.freeze({ path: normalized, sha256: sha256(bytes), byteLength: bytes.byteLength });
}

function aggregateInputs(inputs) {
  const serialized = inputs.map(({ path: filename, sha256: digest, byteLength }) => `${filename}\u0000${byteLength}\u0000${digest}\n`).join("");
  return sha256(serialized);
}

async function parseJson(root, filename) {
  try {
    const parsed = JSON.parse(await readFile(path.join(root, filename), "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    return parsed;
  } catch {
    throw new Error(`invalid electron build ${filename}`);
  }
}

async function assertToolLock(root) {
  const manifest = await parseJson(root, "package.json");
  const lock = await parseJson(root, "package-lock.json");
  const requested = manifest.devDependencies?.esbuild;
  const locked = lock.packages?.[""]?.devDependencies?.esbuild;
  const installed = lock.packages?.["node_modules/esbuild"]?.version;
  if (requested !== esbuildVersion || locked !== esbuildVersion || (installed !== undefined && installed !== esbuildVersion)) {
    throw new Error("esbuild manifest, lock, and installed version disagree");
  }
}

async function typecheck(root) {
  try {
    await execFileAsync(process.execPath, [typescriptCli, "-p", path.join(root, "electron", "tsconfig.json"), "--pretty", "false"], {
      cwd: root,
      maxBuffer: 1024 * 1024,
    });
  } catch {
    throw new Error("electron TypeScript typecheck failed");
  }
}

function localInputs(root, metafile) {
  return Object.keys(metafile.inputs).map((filename) => canonicalPath(root, filename)).sort();
}

async function snapshotInputs(root, sourceFiles) {
  const records = await Promise.all(sourceFiles.map((filename) => readInput(root, filename)));
  return records.sort((left, right) => left.path.localeCompare(right.path));
}

function sameSnapshot(left, right) {
  return left.length === right.length && left.every((entry, index) => {
    const other = right[index];
    return entry.path === other.path && entry.sha256 === other.sha256 && entry.byteLength === other.byteLength;
  });
}

async function controlInputs(root) {
  const records = await snapshotInputs(root, ["electron/tsconfig.json", "package.json", "package-lock.json"]);
  for (const [name, filename] of [
    ["$builder/scripts/build-electron-main.mjs", builderPath],
    ["$tool/typescript/package.json", typescriptPackage],
    ["$tool/esbuild/package.json", esbuildPackage],
  ]) {
    const bytes = await readFile(filename);
    records.push(Object.freeze({ path: name, sha256: sha256(bytes), byteLength: bytes.byteLength }));
  }
  return records.sort((left, right) => left.path.localeCompare(right.path));
}

async function hashDeclaredOutputs(outdir) {
  const records = await Promise.all(declaredOutputs.map(async (name) => {
    const filename = path.join(outdir, name);
    const stat = await lstat(filename);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`invalid declared electron build output: ${name}`);
    const bytes = await readFile(filename);
    return Object.freeze({ name, path: name, sha256: sha256(bytes), byteLength: bytes.byteLength });
  }));
  return records.sort((left, right) => left.path.localeCompare(right.path));
}

function buildOptions(root, outfile, entry, write) {
  return {
    absWorkingDir: root,
    bundle: true,
    platform: "node",
    target: "node22",
    external: ["electron", "electron-updater"],
    logLevel: "warning",
    sourcemap: false,
    legalComments: "none",
    metafile: true,
    write,
    entryPoints: [entry],
    outfile,
    format: outfile.endsWith(".cjs") ? "cjs" : "esm",
  };
}

/** Emits the declared flat Electron closure after typechecking and source/provenance stabilization. */
export async function buildElectronMain({ root = process.cwd(), outdir } = {}) {
  const resolvedRoot = path.resolve(root);
  const resolvedOutdir = path.resolve(outdir ?? path.join(resolvedRoot, "electron", "dist"));
  const controlsBefore = await controlInputs(resolvedRoot);
  await assertToolLock(resolvedRoot);

  const previewInputs = new Set();
  for (const [outfile, entry] of Object.entries(entrypoints)) {
    const preview = await build(buildOptions(resolvedRoot, path.join(resolvedOutdir, outfile), entry, false));
    for (const input of localInputs(resolvedRoot, preview.metafile)) previewInputs.add(input);
  }
  const before = await snapshotInputs(resolvedRoot, [...previewInputs].sort());

  await typecheck(resolvedRoot);
  if (!sameSnapshot(before, await snapshotInputs(resolvedRoot, [...previewInputs].sort()))
    || !sameSnapshot(controlsBefore, await controlInputs(resolvedRoot))) {
    throw new Error("electron build inputs drifted during typechecking");
  }

  await mkdir(resolvedOutdir, { recursive: true, mode: 0o700 });
  const emittedInputs = new Set();
  for (const [outfile, entry] of Object.entries(entrypoints)) {
    const emitted = await build(buildOptions(resolvedRoot, path.join(resolvedOutdir, outfile), entry, true));
    for (const input of localInputs(resolvedRoot, emitted.metafile)) emittedInputs.add(input);
  }
  await writeFile(path.join(resolvedOutdir, packageOutput), "{\"type\":\"module\"}\n", "utf8");

  const emittedFiles = [...emittedInputs].sort();
  if (previewInputs.size !== emittedInputs.size || [...previewInputs].some((input) => !emittedInputs.has(input))) {
    throw new Error("electron build input graph drifted during emission");
  }
  const after = await snapshotInputs(resolvedRoot, emittedFiles);
  if (!sameSnapshot(before, after)) throw new Error("electron build input bytes drifted during emission");

  const controlsAfter = await controlInputs(resolvedRoot);
  if (!sameSnapshot(controlsBefore, controlsAfter)) throw new Error("electron build controls drifted during emission");
  const provenanceInputs = [
    ...after,
    ...controlsBefore,
  ].sort((left, right) => left.path.localeCompare(right.path));
  const outputs = await hashDeclaredOutputs(resolvedOutdir);
  return Object.freeze({
    root: resolvedRoot,
    outdir: resolvedOutdir,
    inputHash: aggregateInputs(provenanceInputs),
    inputs: Object.freeze(provenanceInputs),
    tools: Object.freeze({ esbuild: esbuildVersion, typescript: ts.version, node: process.version }),
    outputs: Object.freeze(outputs),
  });
}

function parseCli(args) {
  if (args.length === 0) return {};
  if (args.length === 2 && args[0] === "--outdir") return { outdir: args[1] };
  throw new Error("usage: build-electron-main.mjs [--outdir <directory>]");
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) {
  buildElectronMain(parseCli(process.argv.slice(2))).then(report => {
    process.stdout.write(`${JSON.stringify(report)}\n`);
  }).catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
