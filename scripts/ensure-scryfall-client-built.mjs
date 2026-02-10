import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();
const pkgDir = path.join(repoRoot, "shared", "scryfall-client");
const distDir = path.join(pkgDir, "dist");

function hasBuiltArtifacts() {
  return (
    fs.existsSync(path.join(distDir, "index.js")) &&
    fs.existsSync(path.join(distDir, "index.d.ts"))
  );
}

function run(cmd, args) {
  execFileSync(cmd, args, { stdio: "inherit" });
}

if (!fs.existsSync(path.join(pkgDir, "package.json"))) {
  console.error("[ensure-scryfall-client-built] Missing shared/scryfall-client/package.json");
  process.exit(1);
}

if (hasBuiltArtifacts()) {
  process.exit(0);
}

console.log("[ensure-scryfall-client-built] Building shared/scryfall-client (dist missing)...");

// This package is a local file: dependency for client/server. Its dist must exist
// so TS + bundlers can resolve the package's exports/types.
run("npm", ["ci", "--prefix", pkgDir]);
run("npm", ["run", "build", "--prefix", pkgDir]);

if (!hasBuiltArtifacts()) {
  console.error("[ensure-scryfall-client-built] Build completed but dist artifacts are still missing.");
  process.exit(1);
}

