#!/usr/bin/env bash
# Run the desktop app using the existing Electron/server/native builds.
set -euo pipefail

project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd -- "$project_dir"

if ! command -v node >/dev/null 2>&1; then
  printf 'Node.js is required to run this development launcher.\n' >&2
  exit 1
fi

for dependency in \
  node_modules/concurrently/dist/bin/concurrently.js \
  node_modules/wait-on/bin/wait-on \
  node_modules/electron/cli.js \
  node_modules/electron/dist/electron \
  client/node_modules/vite/bin/vite.js; do
  if [[ ! -f "$dependency" ]]; then
    printf 'Missing dependency: %s\nInstall the project dependencies first.\n' "$dependency" >&2
    exit 1
  fi
done

for artifact in electron/dist/main.js electron/dist/preload.cjs server/dist/server/src/index.js; do
  if [[ ! -f "$artifact" ]]; then
    printf 'Missing build: %s\nRun npm run build:parallel first.\n' "$artifact" >&2
    exit 1
  fi
done

if [[ ! -f electron/dist/microservice-package/microservice-artifact.json ]]; then
  printf 'Missing native artifact: electron/dist/microservice-package/microservice-artifact.json\nRun npm run build:electron:prerequisites to prepare the native service first.\n' >&2
  exit 1
fi

export NODE_ENV=development
# Electron launched from another Electron-based terminal must still open a GUI.
unset ELECTRON_RUN_AS_NODE

# Do not reuse an unrelated dev server or Docker client on the trusted origin.
if ! node --input-type=module -e '
  import net from "node:net";
  for (const host of ["127.0.0.1", "::1"]) {
    await new Promise((resolve, reject) => {
      const server = net.createServer();
      server.once("error", error => {
        if (host === "::1" && ["EAFNOSUPPORT", "EADDRNOTAVAIL"].includes(error.code)) resolve();
        else reject(error);
      });
      server.listen(5173, host, () => server.close(resolve));
    }).catch(error => { console.error(error.code); process.exit(1); });
  }
'; then
  printf 'Port 5173 is unavailable. Stop the other dev server or Docker client, then try again. Nothing was stopped.\n' >&2
  exit 1
fi

# This may download an Electron-compatible addon on the first run. It never
# replaces the normal Node addon used by npm run dev or the server tests.
PROXXIED_SQLITE_NATIVE_BINDING="$(node scripts/prepare-electron-sqlite.mjs)"
export PROXXIED_SQLITE_NATIVE_BINDING

printf 'Starting Proxxied. Close the Electron window or press Ctrl+C to stop.\n'
exec node node_modules/concurrently/dist/bin/concurrently.js \
  --names frontend,electron --kill-others --kill-timeout 5000 --success command-electron \
  'cd client && node node_modules/vite/bin/vite.js --host localhost --port 5173 --strictPort' \
  'node node_modules/wait-on/bin/wait-on --timeout 60000 --httpTimeout 2000 http-get://localhost:5173 && node node_modules/electron/cli.js electron/dist/main.js'
