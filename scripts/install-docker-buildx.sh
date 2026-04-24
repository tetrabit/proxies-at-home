#!/usr/bin/env bash
set -euo pipefail

REPO="${BUILDX_GITHUB_REPO:-docker/buildx}"
VERSION="${BUILDX_VERSION:-latest}"
PLUGIN_DIR="${DOCKER_CLI_PLUGIN_DIR:-$HOME/.docker/cli-plugins}"
PLUGIN_NAME="docker-buildx"
PLUGIN_PATH="$PLUGIN_DIR/$PLUGIN_NAME"

usage() {
  cat <<'USAGE'
Install the Docker Buildx CLI plugin for the current user.

Environment:
  BUILDX_VERSION        Buildx version to install, for example v0.33.0.
                        Defaults to latest.
  DOCKER_CLI_PLUGIN_DIR Plugin directory.
                        Defaults to ~/.docker/cli-plugins.
  BUILDX_GITHUB_REPO    GitHub repo to download from.
                        Defaults to docker/buildx.
USAGE
}

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  usage
  exit 0
fi

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "ERROR: required command not found: $1" >&2
    exit 1
  fi
}

require_command curl
require_command docker

case "$(uname -s)" in
  Linux) OS="linux" ;;
  Darwin) OS="darwin" ;;
  MINGW*|MSYS*|CYGWIN*) OS="windows" ;;
  *)
    echo "ERROR: unsupported OS: $(uname -s)" >&2
    exit 1
    ;;
esac

case "$(uname -m)" in
  x86_64|amd64) ARCH="amd64" ;;
  aarch64|arm64) ARCH="arm64" ;;
  armv6l) ARCH="arm-v6" ;;
  armv7l) ARCH="arm-v7" ;;
  ppc64le) ARCH="ppc64le" ;;
  riscv64) ARCH="riscv64" ;;
  s390x) ARCH="s390x" ;;
  *)
    echo "ERROR: unsupported architecture: $(uname -m)" >&2
    exit 1
    ;;
esac

EXT=""
if [ "$OS" = "windows" ]; then
  EXT=".exe"
fi

if [ "$VERSION" = "latest" ]; then
  RELEASE_JSON="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest")"
  TAG="$(printf '%s\n' "$RELEASE_JSON" | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -n 1)"
else
  case "$VERSION" in
    v*) TAG="$VERSION" ;;
    *) TAG="v$VERSION" ;;
  esac
fi

if [ -z "${TAG:-}" ]; then
  echo "ERROR: could not resolve Buildx release tag" >&2
  exit 1
fi

ASSET="buildx-$TAG.$OS-$ARCH$EXT"
BASE_URL="https://github.com/$REPO/releases/download/$TAG"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

echo "Installing Docker Buildx $TAG for $OS/$ARCH"
curl -fsSL "$BASE_URL/$ASSET" -o "$TMP_DIR/$ASSET"

if command -v sha256sum >/dev/null 2>&1; then
  CHECKSUMS="$TMP_DIR/checksums.txt"
  curl -fsSL "$BASE_URL/checksums.txt" -o "$CHECKSUMS"
  EXPECTED="$(awk -v asset="*$ASSET" '$2 == asset { print $1 }' "$CHECKSUMS")"
  if [ -z "$EXPECTED" ]; then
    echo "ERROR: checksum not found for $ASSET" >&2
    exit 1
  fi
  ACTUAL="$(sha256sum "$TMP_DIR/$ASSET" | awk '{print $1}')"
  if [ "$ACTUAL" != "$EXPECTED" ]; then
    echo "ERROR: checksum verification failed for $ASSET" >&2
    exit 1
  fi
elif command -v shasum >/dev/null 2>&1; then
  CHECKSUMS="$TMP_DIR/checksums.txt"
  curl -fsSL "$BASE_URL/checksums.txt" -o "$CHECKSUMS"
  EXPECTED="$(awk -v asset="*$ASSET" '$2 == asset { print $1 }' "$CHECKSUMS")"
  if [ -z "$EXPECTED" ]; then
    echo "ERROR: checksum not found for $ASSET" >&2
    exit 1
  fi
  ACTUAL="$(shasum -a 256 "$TMP_DIR/$ASSET" | awk '{print $1}')"
  if [ "$ACTUAL" != "$EXPECTED" ]; then
    echo "ERROR: checksum verification failed for $ASSET" >&2
    exit 1
  fi
else
  echo "WARNING: sha256sum/shasum unavailable; skipping checksum verification" >&2
fi

mkdir -p "$PLUGIN_DIR"
install -m 0755 "$TMP_DIR/$ASSET" "$PLUGIN_PATH"

docker buildx version
