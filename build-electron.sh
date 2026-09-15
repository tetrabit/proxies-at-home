#!/usr/bin/env bash
# Rebuild the working-tree artifacts that ./run-electron.sh consumes, so the
# desktop app always starts from the latest code in this repository.
#
# Rebuilt on every run (these track the working tree):
#   - shared/scryfall-client (dependency of server and client builds)
#   - server/dist (Express server; run-electron.sh only checks it, never rebuilds it)
#   - electron/dist main+preload closure (typechecked and rebundled from source)
#
# Rebuilt only when missing:
#   - electron/dist/microservice-package (native microservice). It is produced
#     from a hash-pinned source snapshot, so a present artifact is current until
#     the pin itself changes. A missing artifact triggers the full prerequisite
#     build, which also covers the JavaScript aggregate.
#
# Intentionally not included:
#   - client/dist: the dev launcher serves the client live from Vite, and
#     production packaging uses npm run electron:build.
#   - runtime provisioning (printer-calibration Python runtime, Electron
#     better-sqlite3 binding): ./run-electron.sh prepares those on every start.
set -euo pipefail

project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd -- "$project_dir"

if ! command -v node >/dev/null 2>&1; then
  printf 'Node.js is required to build the desktop app.\n' >&2
  exit 1
fi

microservice_manifest="electron/dist/microservice-package/microservice-artifact.json"

if [[ ! -f "$microservice_manifest" ]]; then
  printf 'Native microservice package missing; running full prerequisite build...\n'
  npm run build:electron:prerequisites
else
  printf 'Rebuilding shared Scryfall client...\n'
  npm run build:shared-client

  printf 'Rebuilding server...\n'
  npm run build:server

  printf 'Rebuilding Electron main process closure...\n'
  node scripts/build-electron-main.mjs >/dev/null
fi

for artifact in \
  server/dist/server/src/index.js \
  electron/dist/main.js \
  electron/dist/preload.cjs \
  electron/dist/calibration-harness-ipc.js \
  "$microservice_manifest"; do
  if [[ ! -f "$artifact" ]]; then
    printf 'Missing build artifact after build: %s\n' "$artifact" >&2
    exit 1
  fi
done

printf 'Desktop build complete: server/dist, electron/dist, and the staged microservice package are current.\n'
printf 'Start the app with ./run-electron.sh\n'
