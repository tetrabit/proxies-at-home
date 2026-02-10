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
