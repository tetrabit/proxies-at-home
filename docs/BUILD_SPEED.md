# Build Behavior and Iteration

This is the current build contract. It describes commands and artifact state; it does **not** claim benchmark times or speedups. See [measurement guidance](BUILD_PERFORMANCE.md) when collecting local timings.

Sources of truth: root [package scripts](../package.json), [aggregate helper](../scripts/build-parallel.mjs), [server build helper](../server/scripts/server-build.mjs), and [Electron prerequisite helper](../scripts/build-electron-prerequisites.mjs).

## Choose the command

| Goal | Command | What it does |
| --- | --- | --- |
| Build all JavaScript/TypeScript outputs | `npm run build:parallel` | Builds the shared client once, then builds client, server, and Electron TypeScript concurrently. |
| Build the server during normal iteration | `npm run build --prefix server` | Runs the standalone server prerequisite, then preserves `server/dist` and `server/.tsbuildinfo` for incremental compilation. |
| Recover server output after deleting or renaming server source | `npm run build:clean --prefix server` | Removes only the server's generated `dist` and `.tsbuildinfo`, then rebuilds them. Use this when stale emitted files for removed source must disappear. |
| Build the client bundle | `npm run build --prefix client` | Runs Vite's production bundler. |
| Type-check the client separately | `npm run typecheck --prefix client` | Runs the client `tsc --noEmit` check; it is not part of the Vite bundle command. |
| Compile Electron TypeScript | `npm run build:electron:ts` | Preserves `electron/.tsbuildinfo` and compiles the configured Electron entrypoints to `electron/dist`. |
| Create a desktop package | `npm run electron:build` | Joins the Rust and JavaScript prerequisites, stages the validated Rust binary, then invokes `electron-builder`. |

## Aggregate JavaScript build order

`npm run build:parallel` has one sequential prerequisite and three concurrent consumers:

1. `npm run build:shared-client` builds `shared/scryfall-client`.
2. After that succeeds, it starts all of the following together:
   - `npm run build:client` — `vite build` in `client`.
   - `npm run build:server` — the server build with `--ignore-scripts`.
   - `npm run build:electron:ts` — `tsc -p electron/tsconfig.json`.

The shared client's own build recreates `shared/scryfall-client/dist`. Building it before the consumers and using `--ignore-scripts` for the aggregate server build prevents the server's standalone `prebuild` hook from rebuilding that shared output while the client consumes it. The aggregate path therefore builds the shared client once per invocation.

A standalone `npm run build --prefix server` intentionally behaves differently: npm runs the server `prebuild` hook, which builds the shared client before the server compiler runs. Use that command when the server is the only consumer being built.

## Incremental and clean server builds

The normal server build calls [the server build helper](../server/scripts/server-build.mjs) without first cleaning. The helper retains `server/dist` and `server/.tsbuildinfo`; the server TypeScript configuration enables incremental compilation and stores its build info at `.tsbuildinfo/tsconfig.build.tsbuildinfo`.

`npm run build:clean --prefix server` is the explicit recovery path. It removes only those two generated server directories, then runs the usual build. This matters after a server source file is deleted: a normal incremental build can leave its old emitted JavaScript in `server/dist`, while the clean recovery rebuild emits only remaining source. It also recreates the incremental build-info file. The helper rejects a generated path that is a symlink or not a real directory rather than following it during a build.

Do not delete source files or manually remove generated directories merely to obtain a routine incremental build. Use `build:clean` only when a clean server artifact is needed, especially after source removal or suspected stale output.

## TypeScript and Vite boundaries

- **Server:** the build is `tsc -p server/tsconfig.build.json`; incremental state is enabled and retained by a normal server build.
- **Electron:** `npm run build:electron:ts` runs `tsc -p electron/tsconfig.json`; incremental state is enabled at `electron/.tsbuildinfo/tsconfig.tsbuildinfo` and is retained between normal Electron TypeScript builds.
- **Client:** `npm run build --prefix client` is `vite build`, which bundles the application and produces `client/dist`. It is not a `tsc` compilation command and must not be described as one. The separate client `typecheck` command uses `tsc --noEmit --incremental false`.

## Electron packaging order

`npm run electron:build` is a serial package pipeline with a bounded concurrent prerequisite stage:

1. `npm run build:electron:prerequisites` starts exactly two branches at once:
   - `bash scripts/build-microservice.sh` for the Rust microservice.
   - `npm run build:parallel` for the JavaScript aggregate build.
2. The helper waits until **both** branches settle successfully. If either fails, it terminates an unfinished sibling and does not continue.
3. `node scripts/prepare-microservice-package.mjs` reads and validates the Rust artifact manifest, requires a release-profile binary for the package target, and stages that binary under `electron/dist/microservice-package`.
4. `electron-builder` runs only after staging succeeds.

The Rust and JavaScript branches are concurrent only within step 1; staging and `electron-builder` are ordered after their join. The Rust script defaults to a release profile for packaging. It can use dev/debug profiles for local Rust iteration, but the packaging stage rejects a non-release manifest.

`npm run electron:build:win` follows the same prerequisite join and staging order, then fetches the Windows Electron-native `better-sqlite3` prebuild before running `electron-builder --win`.

## Rust microservice iteration

The microservice helper defaults to the sibling checkout at `../scryfall-cache-microservice` and accepts `MICROSERVICE_DIR` to select another checkout. Its default profile is `release`; release defaults to `CARGO_INCREMENTAL=0`. For local Rust-only iteration, a developer may select a dev/debug profile, which defaults to `CARGO_INCREMENTAL=1`:

```bash
MICROSERVICE_PROFILE=dev bash scripts/build-microservice.sh
```

`MICROSERVICE_CLEAN=1` runs `cargo clean` before the Rust build. It is a Rust clean build control, separate from the server `build:clean` recovery command. The helper chooses a job count from `MICROSERVICE_JOBS` or the available processor count and uses `mold` on Linux when available unless `MICROSERVICE_NO_MOLD=1`.
