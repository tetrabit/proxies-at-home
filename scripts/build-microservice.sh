#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MICROSERVICE_DIR="$PROJECT_ROOT/../scryfall-cache-microservice"

echo "Building Scryfall Cache Microservice..."

if [ ! -d "$MICROSERVICE_DIR" ]; then
    echo "ERROR: Microservice directory not found at $MICROSERVICE_DIR"
    exit 1
fi

cd "$MICROSERVICE_DIR"

# Build with release profile (no SQLite feature by default - PostgreSQL is default)
cargo build --release

# Check if binary was created
BINARY="target/release/scryfall-cache"
if [ "$OS" = "Windows_NT" ]; then
    BINARY="${BINARY}.exe"
fi

if [ ! -f "$BINARY" ]; then
    echo "ERROR: Binary not created at $BINARY"
    exit 1
fi

SIZE=$(du -h "$BINARY" | cut -f1)
echo "✅ Microservice built successfully: $SIZE"
