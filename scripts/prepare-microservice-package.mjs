import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rename, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SUPPORTED_PLATFORMS = new Set(["win32", "darwin", "linux"]);
const REQUIRED_PROFILE = "release";
const REQUIRED_MANIFEST_KEYS = ["binaryPath", "platform", "profile", "schemaVersion"];

function packageBinaryName(platform) {
  return platform === "win32" ? "scryfall-cache.exe" : "scryfall-cache";
}

function reject(field, detail) {
  throw new Error(`Rejected microservice artifact ${field}: ${detail}`);
}

function validateManifestShape(manifest) {
  if (manifest === null || Array.isArray(manifest) || typeof manifest !== "object") {
    reject("manifest", "must be a JSON object");
  }

  const keys = Object.keys(manifest).sort();
  if (keys.length !== REQUIRED_MANIFEST_KEYS.length || keys.some((key, index) => key !== REQUIRED_MANIFEST_KEYS[index])) {
    reject("manifest", `must contain only ${REQUIRED_MANIFEST_KEYS.join(", ")}`);
  }
  if (manifest.schemaVersion !== 1) reject("schemaVersion", "must equal 1");
  for (const field of ["binaryPath", "platform", "profile"]) {
    if (typeof manifest[field] !== "string") reject(field, "must be a string");
  }
}

async function readManifest(manifestPath) {
  let contents;
  try {
    contents = await readFile(manifestPath, "utf8");
  } catch (error) {
    reject("manifest", `cannot be read (${error.code ?? "unknown error"})`);
  }

  try {
    return JSON.parse(contents);
  } catch {
    reject("manifest", "is not valid JSON");
  }
}

/**
 * Resolve and validate the one binary that Builder may package.
 * This intentionally never derives a Cargo target path: the producer manifest is authoritative.
 */
export async function resolveMicroserviceArtifact({ manifestPath, expectedPlatform = process.platform }) {
  if (typeof manifestPath !== "string" || manifestPath.length === 0) {
    reject("manifest", "path is required");
  }
  if (!SUPPORTED_PLATFORMS.has(expectedPlatform)) {
    reject("platform", `unsupported package target ${String(expectedPlatform)}`);
  }

  const manifest = await readManifest(manifestPath);
  validateManifestShape(manifest);

  if (!SUPPORTED_PLATFORMS.has(manifest.platform)) {
    reject("platform", `unsupported manifest platform ${manifest.platform}`);
  }
  if (manifest.platform !== expectedPlatform) {
    reject("platform", `manifest ${manifest.platform} does not match package target ${expectedPlatform}`);
  }
  if (!["release", "dev", "debug"].includes(manifest.profile)) {
    reject("profile", `unsupported manifest profile ${manifest.profile}`);
  }
  if (manifest.profile !== REQUIRED_PROFILE) {
    reject("profile", `manifest ${manifest.profile} does not match required ${REQUIRED_PROFILE}`);
  }
  if (!path.isAbsolute(manifest.binaryPath)) {
    reject("binaryPath", "must be absolute");
  }

  const expectedName = packageBinaryName(manifest.platform);
  if (path.basename(manifest.binaryPath) !== expectedName) {
    reject("basename", `must be ${expectedName} for ${manifest.platform}`);
  }

  let resolvedBinaryPath;
  try {
    resolvedBinaryPath = await realpath(manifest.binaryPath);
  } catch (error) {
    reject("binaryPath", `cannot be resolved (${error.code ?? "unknown error"})`);
  }

  let binaryStat;
  try {
    binaryStat = await stat(resolvedBinaryPath);
  } catch (error) {
    reject("binaryPath", `cannot be inspected (${error.code ?? "unknown error"})`);
  }
  if (!binaryStat.isFile()) {
    reject("binaryPath", "must resolve to a regular file");
  }

  return {
    binaryName: expectedName,
    binaryPath: resolvedBinaryPath,
    binaryMode: binaryStat.mode,
    platform: manifest.platform,
  };
}

async function stagingDirectoryExists(stagingDir) {
  try {
    await lstat(stagingDir);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    reject("staging", `cannot be inspected (${error.code ?? "unknown error"})`);
  }
}

/**
 * Copy the validated binary into a newly created staging directory and publish it atomically.
 * Existing stages are deliberately never cleared or reused; the packaging && chain fails closed.
 */
export async function stageMicroservicePackage({ manifestPath, stagingDir, expectedPlatform = process.platform }) {
  if (typeof stagingDir !== "string" || stagingDir.length === 0) {
    reject("staging", "directory is required");
  }

  const artifact = await resolveMicroserviceArtifact({ manifestPath, expectedPlatform });
  if (await stagingDirectoryExists(stagingDir)) {
    reject("staging", "directory already exists; refusing to clear or reuse it");
  }

  const stagingParent = path.dirname(stagingDir);
  const stagingName = path.basename(stagingDir);
  let temporaryDir;
  try {
    await mkdir(stagingParent, { recursive: true });
    temporaryDir = await mkdtemp(path.join(stagingParent, `.${stagingName}.tmp-`));
    const temporaryBinary = path.join(temporaryDir, artifact.binaryName);
    await copyFile(artifact.binaryPath, temporaryBinary);
    await chmod(temporaryBinary, artifact.binaryMode);
  } catch (error) {
    reject("copy", `failed before staging publish (${error.code ?? "unknown error"})`);
  }

  try {
    await rename(temporaryDir, stagingDir);
  } catch (error) {
    reject("atomic publish", `failed (${error.code ?? "unknown error"})`);
  }

  return {
    binaryName: artifact.binaryName,
    binaryPath: artifact.binaryPath,
    stagingDir,
  };
}

function parseCliArguments(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!["--manifest", "--platform", "--staging-dir"].includes(argument)) {
      reject("arguments", `unknown option ${argument}`);
    }
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
    manifestPath: options.manifest ?? process.env.MICROSERVICE_ARTIFACT_MANIFEST ?? path.join(projectRoot, "electron", "dist", "microservice-artifact.json"),
    stagingDir: options.stagingDir ?? path.join(projectRoot, "electron", "dist", "microservice-package"),
    expectedPlatform: options.platform ?? process.platform,
  });
  console.log(`Prepared packaged microservice input: ${result.binaryName}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
