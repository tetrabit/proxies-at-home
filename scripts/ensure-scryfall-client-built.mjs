import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();
const pkgDir = path.join(repoRoot, "shared", "scryfall-client");
const distDir = path.join(pkgDir, "dist");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

// These are the package manifest/lockfile plus every compiler input named by
// shared/scryfall-client/tsconfig.build.json. The lockfile pins the TypeScript
// compiler, so a compiler upgrade also invalidates a prior dist build.
const buildInputs = [
  "package.json",
  "package-lock.json",
  "tsconfig.build.json",
  "index.ts",
  "schema.d.ts",
].map((relativePath) => path.join(pkgDir, relativePath));
const buildArtifacts = ["index.js", "index.d.ts", "schema.d.ts"].map((relativePath) =>
  path.join(distDir, relativePath),
);

function allExist(filePaths) {
  return filePaths.every((filePath) => fs.existsSync(filePath));
}

function hasCurrentBuild() {
  if (!allExist(buildArtifacts)) {
    return false;
  }

  const newestInput = Math.max(...buildInputs.map((filePath) => fs.statSync(filePath).mtimeMs));
  const oldestArtifact = Math.min(...buildArtifacts.map((filePath) => fs.statSync(filePath).mtimeMs));
  return newestInput <= oldestArtifact;
}

function run(cmd, args) {
  execFileSync(cmd, args, { stdio: "inherit" });
}

if (!allExist(buildInputs)) {
  console.error("[ensure-scryfall-client-built] Missing shared/scryfall-client build input.");
  process.exit(1);
}

if (hasCurrentBuild()) {
  process.exit(0);
}

console.log("[ensure-scryfall-client-built] Building shared/scryfall-client (dist missing or stale)...");

// This package is a local file: dependency for client/server. Its dist must be
// current so TypeScript + bundlers can resolve the package's exports/types.
run(npmCommand, ["run", "build", "--prefix", pkgDir]);

if (!hasCurrentBuild()) {
  console.error("[ensure-scryfall-client-built] Build completed but dist artifacts are still missing or stale.");
  process.exit(1);
}

