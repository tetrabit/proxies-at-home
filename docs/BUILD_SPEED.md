# Build Speed Notes

## Parallel Build

The fastest way to build the JS/TS parts of the repo is:

```bash
npm run build:parallel
```

This includes a quick prerequisite step to ensure the local workspace dependency
`shared/scryfall-client` has its `dist/` built (required for client/server builds).

This runs, in parallel:
- `npm run build --prefix client` (Vite build)
- `npm run build --prefix server` (TypeScript compile to `server/dist`)
- `tsc -p electron/tsconfig.json` (TypeScript compile to `electron/dist`)

## Incremental TypeScript Builds

TypeScript incremental compilation is enabled for:
- `server/tsconfig.build.json` (build info at `server/.tsbuildinfo/tsconfig.build.tsbuildinfo`)
- `electron/tsconfig.json` (build info at `electron/.tsbuildinfo/tsconfig.tsbuildinfo`)

These build-info files are intentionally not committed and are safe to delete if you need a clean rebuild.

## Electron Packaging

Electron packaging still needs prerequisites first (microservice + build outputs). Use:

```bash
npm run electron:build
```

This runs microservice build first, then `npm run build:parallel`, then `electron-builder`.

## Rust/Cargo (Microservice) Build Speed

The Electron build expects a sibling checkout of the Rust microservice at `../scryfall-cache-microservice`
and a release binary at `../scryfall-cache-microservice/target/release/scryfall-cache`.

### Faster Local Iteration (Dev Profile + Incremental)

For faster repeated builds while iterating locally:

```bash
MICROSERVICE_PROFILE=dev bash scripts/build-microservice.sh
```

This enables Cargo incremental compilation by default for `dev`/`debug` builds.

### Mold (Optional)

If `mold` is installed, `scripts/build-microservice.sh` will automatically use it for linking on Linux.
To disable mold explicitly:

```bash
MICROSERVICE_NO_MOLD=1 bash scripts/build-microservice.sh
```

### Jobs / Parallelism

The script builds with `-j <cores>` by default. You can override:

```bash
MICROSERVICE_JOBS=8 bash scripts/build-microservice.sh
```

### Clean Build (For Timing/Debugging)

To clean before building:

```bash
MICROSERVICE_CLEAN=1 bash scripts/build-microservice.sh
```

Measured on 2026-02-10 (Linux, 16 cores, mold 2.37.1):
- `MICROSERVICE_PROFILE=dev MICROSERVICE_CLEAN=1` real: ~59s
- `MICROSERVICE_PROFILE=dev` (immediate rebuild) real: ~0.2s

### Release Builds

The script defaults to `MICROSERVICE_PROFILE=release` to match packaging needs.
Release builds default to `CARGO_INCREMENTAL=0` (can be overridden with `MICROSERVICE_INCREMENTAL=1`).
