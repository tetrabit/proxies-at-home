# Calibration standalone-image smoke

Run the bounded smoke from the repository root:

```sh
node scripts/calibration-image-smoke.mjs
```

The helper builds the final `runtime` target in `server/dockerfile` from a
repository-local filtered context containing only `server/` and `shared/`. It
excludes `.env*`, `.git`, `.todos`, `.recovery`, existing review artifacts,
server data, dependency directories, build outputs, tests, and Python bytecode.
No Compose service or server process is started.

Each invocation creates a new `.review-artifacts/b21-image-smoke-01` directory;
if that ID is already present it uses the next numbered suffix. The artifact
contains the exact Docker build/run metadata, build and runtime logs, a manifest,
and the generated `runtime-output/` PDFs/profile data. The helper intentionally
retains its uniquely named exited container and never runs Docker cleanup,
prune, or removal commands.

The runtime command uses only image-provided
`PRINTER_CALIBRATION_BIN` and `PRINTER_CALIBRATION_PYTHON` defaults, with no
Compose configuration. It runs with no network, a read-only root filesystem, a
16 MiB `/tmp` tmpfs, and an owned repository-local output bind. It creates and
lists the `smoke` profile, generates a two-page Letter calibration PDF, applies
the profile, and reopens both PDFs with the image's `pypdf`. The manifest records
page counts, `612 x 792` point media boxes, resolved Python package versions,
image ID, output SHA-256 values, and retained-container isolation state.

Run the helper's focused contract test with:

```sh
node --test scripts/calibration-image-smoke.test.mjs
```
