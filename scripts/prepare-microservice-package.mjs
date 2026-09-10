import { createHash } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SUPPORTED_PLATFORMS = new Set(["win32", "darwin", "linux"]);
const TOP_LEVEL_KEYS = ["backend", "binary", "platform", "profile", "runtime", "schemaVersion", "sourceBuild"];
const BINARY_KEYS = ["fileName", "sha256", "sourcePath"];
const SOURCE_BUILD_KEYS = ["kind", "patchSha256", "sourceArchiveSha256", "sourceCommit", "sourceLockSha256", "sourceTree"];
const SOURCE_BUILD = {
  kind: "nativeSqliteIsolated",
  sourceCommit: "dcb2825257e196be190d3739560eb92a64db0e8b",
  sourceTree: "dc8dbfb8b8a3dbd8453e99ef3b03d0c1f75dcdf1",
  sourceArchiveSha256: "e7b959549f88943dabb242ec6e50788b06e4876e61a0bb6e0fa38c99103f4c16",
  sourceLockSha256: "976bab6b945b691bb24abd693541f80aebb01c9e0ee530cc8c5167bf44bf5aed",
  patchSha256: "cfdae2db9613af918e3aced537de532b728f718f4e28d71833e2b8e8cc19e6a7",
};
const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;

function packageBinaryName(platform) {
  return platform === "win32" ? "scryfall-cache.exe" : "scryfall-cache";
}

function reject(field, detail) {
  throw new Error(`Rejected microservice artifact ${field}: ${detail}`);
}

function exactKeys(value, expected, field) {
  if (value === null || Array.isArray(value) || typeof value !== "object") reject(field, "must be an object");
  const keys = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (keys.length !== sortedExpected.length || keys.some((key, index) => key !== sortedExpected[index])) {
    reject(field, `must contain only ${sortedExpected.join(", ")}`);
  }
}

function validateManifestShape(manifest) {
  exactKeys(manifest, TOP_LEVEL_KEYS, "manifest");
  if (manifest.schemaVersion !== 2) reject("schemaVersion", "must equal 2");
  if (manifest.runtime !== "desktopSQLite") reject("runtime", "must equal desktopSQLite");
  if (manifest.backend !== "sqlite") reject("backend", "must equal sqlite");
  if (manifest.profile !== "release") reject("profile", "must equal release");
  if (typeof manifest.platform !== "string" || !SUPPORTED_PLATFORMS.has(manifest.platform)) reject("platform", "must be a supported platform");

  exactKeys(manifest.binary, BINARY_KEYS, "binary");
  if (typeof manifest.binary.sourcePath !== "string" || !path.isAbsolute(manifest.binary.sourcePath)) reject("binary.sourcePath", "must be an absolute string");
  if (typeof manifest.binary.fileName !== "string") reject("binary.fileName", "must be a string");
  if (typeof manifest.binary.sha256 !== "string" || !SHA256.test(manifest.binary.sha256)) reject("binary.sha256", "must be a lower-case SHA-256");
  if (manifest.binary.fileName !== packageBinaryName(manifest.platform) || path.basename(manifest.binary.fileName) !== manifest.binary.fileName || manifest.binary.fileName === "." || manifest.binary.fileName === "..") {
    reject("binary.fileName", `must be canonical basename ${packageBinaryName(manifest.platform)}`);
  }

  exactKeys(manifest.sourceBuild, SOURCE_BUILD_KEYS, "sourceBuild");
  for (const [key, expected] of Object.entries(SOURCE_BUILD)) {
    if (manifest.sourceBuild[key] !== expected) reject(`sourceBuild.${key}`, "does not match pinned desktop SQLite provenance");
  }
  if (!COMMIT.test(manifest.sourceBuild.sourceCommit) || !COMMIT.test(manifest.sourceBuild.sourceTree)) reject("sourceBuild", "contains invalid source identifiers");
  for (const key of ["sourceArchiveSha256", "sourceLockSha256", "patchSha256"]) {
    if (!SHA256.test(manifest.sourceBuild[key])) reject(`sourceBuild.${key}`, "must be a lower-case SHA-256");
  }
}

async function readManifest(manifestPath) {
  let contents;
  try {
    contents = await readFile(manifestPath);
  } catch (error) {
    reject("manifest", `cannot be read (${error.code ?? "unknown error"})`);
  }
  try {
    return { manifest: JSON.parse(contents.toString("utf8")), bytes: contents };
  } catch {
    reject("manifest", "is not valid JSON");
  }
}

async function sha256File(filePath) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

/** Validates the producer-only source path before a desktop stage is published. */
export async function resolveMicroserviceArtifact({ manifestPath, expectedPlatform = process.platform }) {
  if (typeof manifestPath !== "string" || manifestPath.length === 0) reject("manifest", "path is required");
  if (!SUPPORTED_PLATFORMS.has(expectedPlatform)) reject("platform", `unsupported package target ${String(expectedPlatform)}`);
  const { manifest, bytes: manifestBytes } = await readManifest(manifestPath);
  validateManifestShape(manifest);
  if (manifest.platform !== expectedPlatform) reject("platform", `manifest ${manifest.platform} does not match package target ${expectedPlatform}`);

  let binaryPath;
  try { binaryPath = await realpath(manifest.binary.sourcePath); } catch (error) { reject("binary.sourcePath", `cannot be resolved (${error.code ?? "unknown error"})`); }
  let binaryStat;
  try { binaryStat = await stat(binaryPath); } catch (error) { reject("binary.sourcePath", `cannot be inspected (${error.code ?? "unknown error"})`); }
  if (!binaryStat.isFile()) reject("binary.sourcePath", "must resolve to a regular file");
  if (await sha256File(binaryPath) !== manifest.binary.sha256) reject("binary.sha256", "does not match source bytes");
  return { binaryName: manifest.binary.fileName, binaryPath, binaryMode: binaryStat.mode, manifest, manifestBytes, platform: manifest.platform };
}

async function stagingDirectoryExists(stagingDir) {
  try { await lstat(stagingDir); return true; } catch (error) { if (error.code === "ENOENT") return false; reject("staging", `cannot be inspected (${error.code ?? "unknown error"})`); }
}

/** Copies only a hash-verified v2 pair and atomically publishes both files together. */
export async function stageMicroservicePackage({ manifestPath, stagingDir, expectedPlatform = process.platform }) {
  if (typeof stagingDir !== "string" || stagingDir.length === 0) reject("staging", "directory is required");
  const artifact = await resolveMicroserviceArtifact({ manifestPath, expectedPlatform });
  if (await stagingDirectoryExists(stagingDir)) reject("staging", "directory already exists; refusing to clear or reuse it");
  const parent = path.dirname(stagingDir);
  const name = path.basename(stagingDir);
  let temporaryDir;
  try {
    await mkdir(parent, { recursive: true });
    temporaryDir = await mkdtemp(path.join(parent, `.${name}.tmp-`));
    await copyFile(artifact.binaryPath, path.join(temporaryDir, artifact.binaryName));
    await chmod(path.join(temporaryDir, artifact.binaryName), artifact.binaryMode);
    await writeFile(path.join(temporaryDir, "microservice-artifact.json"), artifact.manifestBytes, { flag: "wx" });
  } catch (error) {
    reject("copy", `failed before staging publish (${error.code ?? "unknown error"})`);
  }
  try { await rename(temporaryDir, stagingDir); } catch (error) { reject("atomic publish", `failed (${error.code ?? "unknown error"})`); }
  return { binaryName: artifact.binaryName, binaryPath: artifact.binaryPath, stagingDir };
}

function parseCliArguments(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!["--manifest", "--platform", "--staging-dir"].includes(argument)) reject("arguments", `unknown option ${argument}`);
    const value = args[index + 1];
    if (!value || value.startsWith("--")) reject("arguments", `${argument} requires a value`);
    options[argument.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
    index += 1;
  }
  return options;
}

async function main() {
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const options = parseCliArguments(process.argv.slice(2));
  const result = await stageMicroservicePackage({
    manifestPath: options.manifest ?? process.env.MICROSERVICE_ARTIFACT_MANIFEST,
    stagingDir: options.stagingDir ?? path.join(projectRoot, "electron", "dist", "microservice-package"),
    expectedPlatform: options.platform ?? process.platform,
  });
  console.log(`Prepared packaged microservice input: ${result.binaryName}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
