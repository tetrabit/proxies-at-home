#!/usr/bin/env bash
# Run the desktop app using current server/native builds and a fresh Electron closure.
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

for artifact in server/dist/server/src/index.js; do
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

# Docker owns IPv4 loopback; Electron keeps its localhost origin on IPv6.
# Refuse an existing IPv6 frontend instead of reusing an untrusted page.
if ! node --input-type=module -e '
  import net from "node:net";
  await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(5173, "::1", () => server.close(resolve));
  }).catch(error => { console.error(error.code); process.exit(1); });
'; then
  printf 'Port 5173 is unavailable on IPv6 loopback (::1). Enable IPv6 loopback or stop its competing dev server, then try again. The IPv4 Docker client may remain running. Nothing was stopped.\n' >&2
  exit 1
fi

# Rebuild the complete JavaScript closure from current Electron sources before any
# GUI or service process starts. The builder validates its input graph and only
# emits flat closure files, preserving the staged native microservice package.
node scripts/build-electron-main.mjs

# The server's printer-calibration runner is Python, so development Electron
# needs the same repository-local, hash-checked runtime as the production image.
# Explicit operator runners are validated and kept authoritative; an invalid
# configured /opt-style Docker path fails before the GUI starts rather than being
# silently replaced by a different runner.
if [[ -n "${PRINTER_CALIBRATION_BIN:-}" || -n "${PRINTER_CALIBRATION_PYTHON:-}" ]]; then
  validated_printer_runner="$(node scripts/prepare-printer-calibration.mjs)"
  if [[ -n "${PRINTER_CALIBRATION_BIN:-}" ]]; then
    export PRINTER_CALIBRATION_BIN="$validated_printer_runner"
  else
    export PRINTER_CALIBRATION_PYTHON="$validated_printer_runner"
  fi
else
  PRINTER_CALIBRATION_BIN="$(node scripts/prepare-printer-calibration.mjs)"
  PRINTER_CALIBRATION_PYTHON="$(dirname -- "$PRINTER_CALIBRATION_BIN")/python"
  export PRINTER_CALIBRATION_BIN PRINTER_CALIBRATION_PYTHON
fi

# This may download an Electron-compatible addon on the first run. It never
# replaces the normal Node addon used by npm run dev or the server tests.
PROXXIED_SQLITE_NATIVE_BINDING="$(node scripts/prepare-electron-sqlite.mjs)"
export PROXXIED_SQLITE_NATIVE_BINDING

printf 'Starting Proxxied. Close the Electron window or press Ctrl+C to stop.\n'
exec node node_modules/concurrently/dist/bin/concurrently.js \
  --names frontend,electron --kill-others --kill-timeout 5000 --success command-electron \
  'cd client && node node_modules/vite/bin/vite.js --host ::1 --port 5173 --strictPort' \
  'node node_modules/wait-on/bin/wait-on --timeout 60000 --httpTimeout 2000 "http-get://[::1]:5173" && node node_modules/electron/cli.js electron/dist/main.js'
