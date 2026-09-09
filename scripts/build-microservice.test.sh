#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_SCRIPT="$PROJECT_ROOT/scripts/build-microservice.sh"
RUN_ID="td-4acd86-build-manifest-$(date -u +%Y%m%dT%H%M%SZ)-$$"
FIXTURE_ROOT="$PROJECT_ROOT/.review-artifacts/$RUN_ID"
MICROSERVICE_DIR="$FIXTURE_ROOT/microservice"
FAKE_BIN="$FIXTURE_ROOT/bin"
TARGET_DIR="$FIXTURE_ROOT/custom-target"
SUCCESS_MANIFEST="$FIXTURE_ROOT/output/microservice-artifact.json"
MISSING_MANIFEST="$FIXTURE_ROOT/output/missing-artifact.json"

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

mkdir -p "$MICROSERVICE_DIR" "$FAKE_BIN"
printf '[package]\nname = "fixture-cache"\nversion = "0.0.0"\n' > "$MICROSERVICE_DIR/Cargo.toml"

cat > "$FAKE_BIN/cargo" <<'CARGO'
#!/usr/bin/env bash
set -euo pipefail

if [ "${1:-}" != "build" ]; then
  printf 'unexpected cargo command: %s\n' "${1:-}" >&2
  exit 2
fi

profile_dir=debug
for argument in "$@"; do
  if [ "$argument" = "--release" ]; then
    profile_dir=release
  fi
done

if [ "${FAKE_CARGO_WRITE_BINARY:-1}" = "1" ]; then
  suffix=""
  if [ "${OS:-}" = "Windows_NT" ]; then
    suffix=".exe"
  fi
  mkdir -p "$CARGO_TARGET_DIR/$profile_dir"
  printf 'fixture microservice binary\n' > "$CARGO_TARGET_DIR/$profile_dir/scryfall-cache$suffix"
fi
CARGO
chmod +x "$FAKE_BIN/cargo"

PATH="$FAKE_BIN:$PATH" \
  OS=Windows_NT \
  MICROSERVICE_DIR="$MICROSERVICE_DIR" \
  CARGO_TARGET_DIR="$TARGET_DIR" \
  MICROSERVICE_ARTIFACT_MANIFEST="$SUCCESS_MANIFEST" \
  MICROSERVICE_PROFILE=dev \
  MICROSERVICE_NO_MOLD=1 \
  bash "$BUILD_SCRIPT"

node - "$SUCCESS_MANIFEST" "$TARGET_DIR/debug/scryfall-cache.exe" <<'NODE'
const fs = require("node:fs");
const [manifestPath, expectedBinaryPath] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

if (manifest.schemaVersion !== 1) throw new Error("manifest schemaVersion must be 1");
if (manifest.binaryPath !== expectedBinaryPath) throw new Error(`unexpected binaryPath: ${manifest.binaryPath}`);
if (manifest.platform !== "win32") throw new Error(`unexpected platform: ${manifest.platform}`);
if (manifest.profile !== "dev") throw new Error(`unexpected profile: ${manifest.profile}`);
NODE

if PATH="$FAKE_BIN:$PATH" \
  OS=Windows_NT \
  FAKE_CARGO_WRITE_BINARY=0 \
  MICROSERVICE_DIR="$MICROSERVICE_DIR" \
  CARGO_TARGET_DIR="$TARGET_DIR/missing-output" \
  MICROSERVICE_ARTIFACT_MANIFEST="$MISSING_MANIFEST" \
  MICROSERVICE_PROFILE=release \
  MICROSERVICE_NO_MOLD=1 \
  bash "$BUILD_SCRIPT"; then
  fail "build succeeded when the cargo stand-in produced no binary"
fi

if [ -e "$MISSING_MANIFEST" ]; then
  fail "manifest was written even though the expected binary was missing"
fi

printf 'PASS: %s\n' "$RUN_ID"
