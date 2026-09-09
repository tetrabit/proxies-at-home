# ADR-004: Sandboxed Preload Compatibility Disposition

**Date**: 2026-09-09

**Status**: Accepted — compatibility failure measured; a narrow preload bundle/inline remediation is required.

**Task**: `td-4db26c` (E15), following the closed negative measurement in `td-e20e2c` (E14).

**Decision scope**: the Electron preload entry at `electron/preload.cts`, its `createElectronApi` helper in `electron/preload-api.ts`, and the TypeScript emission path defined by `electron/tsconfig.json` and invoked by root `package.json`'s `build:electron:ts` script.

---

## Context

`electron/preload.cts` exposes the allowlisted `electronAPI` with:

```js
const { createElectronApi } = require('./preload-api.js');
```

The ordinary TypeScript emission produces separate `electron/dist/preload.cjs` and `electron/dist/preload-api.js` files. The source-level preload bridge test replaces that relative `require` with a mock, so it cannot establish whether the sandboxed Electron preload loader can resolve the emitted helper.

E14 measured this exact boundary. This ADR records that result rather than treating the existing unit mock or a successful TypeScript build as runtime compatibility evidence.

## Evidence basis

The linked E14 QA record is [`qa-evidence.json`](../.review-artifacts/qa-preload-probe-final-20260909T200339Z-1422475/qa-evidence.json), SHA-256 `e7ef380917ec94ca148b5076e1751ed89fe6558d7b564f4d471f57b99e6c0a8a`. Its linked candidate manifest is [`candidate.json`](../.review-artifacts/validation-context-candidate-1c68a1b77d1d43ca96d454e1084ab942/candidate.json), SHA-256 `75edcc58606e1b93ca3c887890bcc415daf83fbacd76998b81babb20864e311a`.

The measurement was bound to commit `bb3f52f6939cad901a6d313775283d06975e1b2e`, tree `e35d1634c2e84561923a5f52d2b04f09a4f2373f`, parent `762811f941485b25e68c6564033e1504be52e2fb`. The manifest and QA record agree on the probe scripts, and the QA record confirms the relevant build source hashes, including `electron/preload.cts` SHA-256 `122d42d9e07eaad8cdd943689a62a4e773876057e89be1aa8f0bda59474371e9`, `electron/preload-api.ts` SHA-256 `c5014b28abe38b7cd895d3c564066d5a79391fae7748f30b4d8649084a4f1d58`, and `electron/tsconfig.json` SHA-256 `fa1468738b44ee53344298060f4b3305e051e27159c7be22f9fc2a8c73c71e51`.

The exact recorded checks were:

| Check | Recorded result |
| --- | --- |
| `node --test scripts/preload-compatibility-smoke.test.mjs` | Pass: 3/3 focused ownership tests. This does not test the live preload loader. |
| `node scripts/preload-compatibility-smoke.mjs` | Fail (exit 1): a real repository-installed Electron `39.2.7` run built with TypeScript `5.9.3`. |

The real smoke used an actual Electron `BrowserWindow`, not Electron/preload/contextBridge/ipcRenderer mocks, with `sandbox: true`, `contextIsolation: true`, and `nodeIntegration: false`. It recorded all of the following:

* Electron reported `Unable to load preload script: .../electron/dist/preload.cjs` and `Error: module not found: ./preload-api.js` from `node:electron/js2c/sandbox_bundle`.
* `window.electronAPI` was `undefined`; all 16 allowlisted methods were missing.
* The owned Electron child was reaped and its process-group scan was known empty. The failure was a completed real-runtime measurement, not a timeout or unavailable runtime.

## Decision

The current split preload is **not sandbox-compatible**. Do not claim a working bridge from its unit test or from the successful `tsc -p electron/tsconfig.json` emission.

The required remediation is narrow: make the emitted preload entry self-contained. `electron/dist/preload.cjs` must contain (by build-time bundling or by inlining) the `createElectronApi` implementation used by `electron/preload.cts`; it must not make the failing relative runtime request for `./preload-api.js` in the sandboxed preload loader.

The implementation must preserve the current allowlisted bridge shape and listener-disposal behavior. The exact production/build boundary to change and inspect is:

1. `electron/preload.cts` — remove the sandboxed runtime dependency on the separate helper.
2. `electron/preload-api.ts` — move or bundle its `createElectronApi` implementation into the preload artifact without widening the API.
3. `electron/tsconfig.json` and the `build:electron:ts` invocation in root `package.json` — ensure the build produces the single self-contained `electron/dist/preload.cjs` used by Electron; a separate `preload-api.js` must not be needed at preload runtime.

This decision does **not** authorize disabling `sandbox` or `contextIsolation`, enabling renderer `nodeIntegration`, exposing Node globals to the renderer, or broadening the IPC allowlist.

## Required verification after remediation

A source-only or mocked test is insufficient. After the build/preload change, rerun the exact real-runtime command:

```text
node scripts/preload-compatibility-smoke.mjs
```

A pass requires the probe's existing conditions: a real repository-installed Electron launch, `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`, a present exact allowlist of the 16 bridge methods, no renderer `process` or `require`, the IPC round trip, listener disposal, and verified owned-child shutdown. Record the resulting commit, tree, parent, source/artifact hashes, and report path. If the rerun is blocked or fails, retain that status; do not substitute the focused mock test as a pass.

## Consequences and bounds

This ADR makes no production change. It identifies one load failure: `./preload-api.js` from the sandboxed preload. It does not establish a general Electron loader theory, validate a packaged installer, or prove behavior after the required remediation. A separate real-runtime rerun is required to establish compatibility for the changed artifact.
