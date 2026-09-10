#!/usr/bin/env bash
# Build the pinned native source snapshot in a new, repository-local evidence root.
# The source snapshot is intentionally not taken from this checkout: the original
# commit is no longer present in this repository's object database.
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
readonly expected_source_sha256='e7b959549f88943dabb242ec6e50788b06e4876e61a0bb6e0fa38c99103f4c16'
readonly expected_lock_sha256='976bab6b945b691bb24abd693541f80aebb01c9e0ee530cc8c5167bf44bf5aed'
readonly source_commit='dcb2825257e196be190d3739560eb92a64db0e8b'
readonly source_tree='dc8dbfb8b8a3dbd8453e99ef3b03d0c1f75dcdf1'
readonly default_source_archive="$repo_root/.review-artifacts/td-994223-native-build-dcb2825257e1/source.tar"
readonly default_source_lock="$repo_root/.review-artifacts/td-994223-native-build-dcb2825257e1/source/Cargo.lock"
readonly patch_file="$repo_root/scripts/patches/native-sqlite-config.patch"

source_archive=${NATIVE_SQLITE_SOURCE_ARCHIVE:-$default_source_archive}
source_lock=${NATIVE_SQLITE_SOURCE_LOCK:-$default_source_lock}
run_token=${NATIVE_SQLITE_RUN_TOKEN:-"native-sqlite-${source_commit:0:12}-$(cat /proc/sys/kernel/random/uuid)"}
if [[ ! "$run_token" =~ ^[A-Za-z0-9._-]+$ ]]; then
  printf 'NATIVE_SQLITE_RUN_TOKEN has unsupported characters: %s\n' "$run_token" >&2
  exit 64
fi
build_root="$repo_root/.review-artifacts/$run_token"

[[ -r "$source_archive" ]] || { printf 'source archive is not readable: %s\n' "$source_archive" >&2; exit 66; }
[[ -r "$source_lock" ]] || { printf 'source lock is not readable: %s\n' "$source_lock" >&2; exit 66; }
[[ -r "$patch_file" ]] || { printf 'patch is not readable: %s\n' "$patch_file" >&2; exit 66; }
[[ ! -e "$build_root" ]] || { printf 'refusing to reuse existing evidence root: %s\n' "$build_root" >&2; exit 73; }

actual_source_sha256=$(sha256sum "$source_archive" | awk '{print $1}')
actual_lock_sha256=$(sha256sum "$source_lock" | awk '{print $1}')
[[ "$actual_source_sha256" == "$expected_source_sha256" ]] || {
  printf 'source archive SHA-256 mismatch: expected %s, got %s\n' "$expected_source_sha256" "$actual_source_sha256" >&2
  exit 65
}
[[ "$actual_lock_sha256" == "$expected_lock_sha256" ]] || {
  printf 'source lock SHA-256 mismatch: expected %s, got %s\n' "$expected_lock_sha256" "$actual_lock_sha256" >&2
  exit 65
}

mkdir -p "$build_root/source.unpatched"
cp --reflink=auto -- "$source_archive" "$build_root/source.tar"
printf '%s  %s\n' "$expected_source_sha256" "$build_root/source.tar" | sha256sum -c -
cp --reflink=auto -- "$source_lock" "$build_root/Cargo.lock"
printf '%s  %s\n' "$expected_lock_sha256" "$build_root/Cargo.lock" | sha256sum -c -
# The archived snapshot predates its lockfile; append the separately hash-pinned
# lock only to this fresh evidence archive before extraction and --locked build.
tar -rf "$build_root/source.tar" -C "$build_root" Cargo.lock
tar -xf "$build_root/source.tar" -C "$build_root/source.unpatched"
cp -a --reflink=auto "$build_root/source.unpatched" "$build_root/source"
patch --batch --fuzz=0 -d "$build_root/source" -p1 -i "$patch_file"

# Cargo receives an owned CARGO_HOME. Reusing the host registry is a copy-only
# optimization; cargo locks, downloads, and target outputs remain in build_root.
mkdir -p "$build_root/cargo-home"
if [[ -d "${CARGO_HOME:-$HOME/.cargo}/registry" ]]; then
  cp -a --reflink=auto "${CARGO_HOME:-$HOME/.cargo}/registry" "$build_root/cargo-home/registry"
fi
if [[ -d "${CARGO_HOME:-$HOME/.cargo}/git" ]]; then
  cp -a --reflink=auto "${CARGO_HOME:-$HOME/.cargo}/git" "$build_root/cargo-home/git"
fi

patch_sha256=$(sha256sum "$patch_file" | awk '{print $1}')
{
  printf 'source_commit=%s\n' "$source_commit"
  printf 'source_tree=%s\n' "$source_tree"
  printf 'source_archive=%s\n' "$source_archive"
  printf 'source_archive_sha256=%s\n' "$expected_source_sha256"
  printf 'source_lock=%s\n' "$source_lock"
  printf 'source_lock_sha256=%s\n' "$expected_lock_sha256"
  printf 'patch=%s\n' "$patch_file"
  printf 'patch_sha256=%s\n' "$patch_sha256"
  printf 'build_root=%s\n' "$build_root"
  printf 'cargo=%s\n' "$(cargo --version)"
  printf 'rustc=%s\n' "$(rustc --version)"
  printf 'command=cargo build --locked --release --no-default-features --features sqlite --jobs 2\n'
} > "$build_root/provenance.env"

CARGO_HOME="$build_root/cargo-home" \
CARGO_TARGET_DIR="$build_root/target" \
CARGO_BUILD_JOBS=2 \
cargo build --manifest-path "$build_root/source/Cargo.toml" --locked --release --no-default-features --features sqlite --jobs 2 \
  2>&1 | tee "$build_root/build.log"

binary="$build_root/target/release/scryfall-cache"
[[ -x "$binary" ]] || { printf 'expected release binary is missing: %s\n' "$binary" >&2; exit 69; }
{
  sha256sum "$build_root/source.tar" "$patch_file" "$build_root/source/Cargo.toml" "$build_root/source/Cargo.lock" "$binary"
  file "$binary"
} > "$build_root/provenance.sha256"
printf '%s\n' "$build_root" | tee "$build_root/build-root.txt"
