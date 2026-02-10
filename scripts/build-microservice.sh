#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MICROSERVICE_DIR="${MICROSERVICE_DIR:-$PROJECT_ROOT/../scryfall-cache-microservice}"
MICROSERVICE_FEATURES="${MICROSERVICE_FEATURES:-}"
MICROSERVICE_NO_DEFAULT_FEATURES="${MICROSERVICE_NO_DEFAULT_FEATURES:-}"
MICROSERVICE_PROFILE="${MICROSERVICE_PROFILE:-release}" # release|dev|debug
MICROSERVICE_JOBS="${MICROSERVICE_JOBS:-}"
MICROSERVICE_CLEAN="${MICROSERVICE_CLEAN:-}"
MICROSERVICE_NO_MOLD="${MICROSERVICE_NO_MOLD:-}"
MICROSERVICE_INCREMENTAL="${MICROSERVICE_INCREMENTAL:-}" # 0|1 (optional override)

echo "Building Scryfall Cache Microservice..."

if [ ! -d "$MICROSERVICE_DIR" ]; then
    echo "ERROR: Microservice directory not found at $MICROSERVICE_DIR"
    exit 1
fi

if [ ! -f "$MICROSERVICE_DIR/Cargo.toml" ]; then
    echo "ERROR: Cargo.toml not found at $MICROSERVICE_DIR/Cargo.toml"
    exit 1
fi

case "$MICROSERVICE_PROFILE" in
    release) PROFILE_DIR="release"; PROFILE_ARGS=(--release) ;;
    dev|debug) PROFILE_DIR="debug"; PROFILE_ARGS=() ;;
    *)
        echo "ERROR: Unsupported MICROSERVICE_PROFILE=$MICROSERVICE_PROFILE (expected release|dev|debug)"
        exit 1
        ;;
esac

if [ -n "$MICROSERVICE_JOBS" ]; then
    JOBS="$MICROSERVICE_JOBS"
else
    if command -v nproc >/dev/null 2>&1; then
        JOBS="$(nproc)"
    elif command -v getconf >/dev/null 2>&1; then
        JOBS="$(getconf _NPROCESSORS_ONLN)"
    else
        JOBS="8"
    fi
fi

# Keep outputs in the microservice repo so Electron packaging paths remain stable.
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$MICROSERVICE_DIR/target}"

# Incremental builds are useful for dev/debug, and usually not desired for release artifacts.
if [ -n "$MICROSERVICE_INCREMENTAL" ]; then
    export CARGO_INCREMENTAL="$MICROSERVICE_INCREMENTAL"
else
    if [ "$MICROSERVICE_PROFILE" = "release" ]; then
        export CARGO_INCREMENTAL="0"
    else
        export CARGO_INCREMENTAL="1"
    fi
fi

USE_MOLD="0"
MOLD_VERSION=""
if [ "$MICROSERVICE_NO_MOLD" != "1" ] && command -v mold >/dev/null 2>&1; then
    USE_MOLD="1"
    MOLD_VERSION="$(mold --version 2>/dev/null || true)"
fi

echo "  microservice: $MICROSERVICE_DIR"
echo "  profile:      $MICROSERVICE_PROFILE"
echo "  target-dir:   $CARGO_TARGET_DIR"
echo "  jobs:         $JOBS"
echo "  incremental:  $CARGO_INCREMENTAL"
if [ "$USE_MOLD" = "1" ]; then
    echo "  mold:         enabled (${MOLD_VERSION:-mold})"
else
    echo "  mold:         disabled"
fi

# Build with release profile (no SQLite feature by default - PostgreSQL is default)
FEATURE_ARGS=()
if [ -n "$MICROSERVICE_FEATURES" ]; then
    FEATURE_ARGS+=(--features "$MICROSERVICE_FEATURES")
fi
if [ "$MICROSERVICE_NO_DEFAULT_FEATURES" = "1" ]; then
    FEATURE_ARGS+=(--no-default-features)
fi

cd "$PROJECT_ROOT"

CONFIG_ARGS=()
if [ "$USE_MOLD" = "1" ]; then
    # Only apply the mold config when mold exists; otherwise this would break builds.
    CONFIG_ARGS+=(--config "$PROJECT_ROOT/.cargo/mold.toml")
fi

if [ "$MICROSERVICE_CLEAN" = "1" ]; then
    cargo clean --manifest-path "$MICROSERVICE_DIR/Cargo.toml" "${CONFIG_ARGS[@]}"
fi

cargo build \
    --manifest-path "$MICROSERVICE_DIR/Cargo.toml" \
    "${PROFILE_ARGS[@]}" \
    -j "$JOBS" \
    "${FEATURE_ARGS[@]}" \
    "${CONFIG_ARGS[@]}"

# Check if binary was created
BINARY="$CARGO_TARGET_DIR/$PROFILE_DIR/scryfall-cache"
if [ "$OS" = "Windows_NT" ]; then
    BINARY="${BINARY}.exe"
fi

if [ ! -f "$BINARY" ]; then
    echo "ERROR: Binary not created at $BINARY"
    exit 1
fi

SIZE=$(du -h "$BINARY" | cut -f1)
echo "✅ Microservice built successfully: $SIZE"
