# Build Performance Measurement

No current build duration, total, or speedup is claimed in this document. Build duration depends on the checkout, dependency state, CPU, storage, available memory, Rust cache state, and whether the command packages native artifacts. For the command graph and cache behavior, see [Build Behavior and Iteration](BUILD_SPEED.md).

## What to measure

Measure comparable commands for the question being answered:

| Question | Command | Comparison notes |
| --- | --- | --- |
| Aggregate JavaScript/TypeScript build | `npm run build:parallel` | Includes one shared-client build followed by concurrent client, server, and Electron TypeScript consumers. |
| Normal server incremental build | `npm run build --prefix server` | Retains server output and TypeScript build info; compare unchanged and changed-source runs separately. |
| Server stale-output recovery | `npm run build:clean --prefix server` | Removes generated server `dist` and `.tsbuildinfo` before rebuilding; do not compare it as though it were a warm incremental run. |
| Client production bundle | `npm run build --prefix client` | Measures Vite bundling, not a TypeScript type check. |
| Client type check | `npm run typecheck --prefix client` | Measures the separate `tsc --noEmit --incremental false` command. |
| Electron TypeScript compilation | `npm run build:electron:ts` | Retains Electron TypeScript build info between normal runs. |
| Desktop packaging | `npm run electron:build` | Includes a bounded Rust-plus-JavaScript prerequisite join, Rust staging, and `electron-builder`. |

## Reproducible local measurement

Record the machine and tool versions beside every result. For example:

```bash
node --version
npm --version
```

On a Unix-like host, record operating-system and processor information with the platform utilities available there (for example, `uname -a` and `getconf _NPROCESSORS_ONLN`). Use an equivalent timing utility on other platforms, and identify the exact command in the record. A Unix-like example is:

```bash
time -p npm run build:parallel
time -p npm run build --prefix server
time -p npm run build:clean --prefix server
time -p npm run build --prefix client
time -p npm run electron:build
```

For each command, report at least:

- the command exactly as executed and whether it completed successfully;
- the measurement date and the checkout/revision being measured;
- operating system, CPU count, memory pressure or competing workloads, and storage conditions when known;
- Node, npm, TypeScript, Vite, Electron, and Rust/Cargo versions that can affect the result;
- relevant state: first run, unchanged repeat, source change, explicit server clean recovery, or Rust cache/profile state;
- wall-clock time, plus user/system CPU time when the timing utility provides them.

Do not present an unchanged repeat as a clean build, or a clean recovery as an incremental result. Report failed commands separately rather than treating their elapsed time as a successful build measurement.

## Interpreting results

The aggregate build has an intentional dependency boundary: it builds `shared/scryfall-client` once, then starts client Vite bundling, server compilation, and Electron TypeScript compilation concurrently. Its wall-clock time is therefore not the sum of the component durations.

Server and Electron TypeScript builds retain their configured build-info state during normal commands. The server `build:clean` command is intentionally different: it deletes generated server output and build info so that output for deleted source is removed before rebuilding. Client production builds should be described as Vite bundle measurements; Vite's bundle command is not the client `tsc` type-check command.

Desktop packaging first waits for both the Rust microservice build and the aggregate JavaScript build, then stages a validated release Rust binary, then invokes `electron-builder`. A package timing consequently includes work not represented by an Electron TypeScript-only timing.

## Publication rule

Publish a timing only with its recorded environment and command state. Do not extrapolate a local result into a general speedup, CI expectation, or release-time guarantee without a repeatable benchmark record.
