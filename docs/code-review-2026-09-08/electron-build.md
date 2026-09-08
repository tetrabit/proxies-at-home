# Electron, build tooling, and release review

Reviewed source: `518787ecdb74c827731724b83ba62358b26b4acb`. Static analysis; no Electron launch, build, release, or benchmark was run. High = significant reliability/security/latency risk; Medium = material maintainability or scaling issue; Low = smaller improvement. Source-confirmed means the mechanism exists, not that its production impact was measured.

## E01 — High: Restart supervision leaks timers and permits restart after stop

Evidence: `electron/microservice-manager.ts:62-83`, `:91-121`, `:194-205`.

Each successful start creates a new interval. Unexpected exit does not clear the previous interval, and `startHealthCheck` overwrites the only saved timer handle. After repeated successful restarts, health-check work grows with restart count and stop clears only the latest interval. The delayed restart handle is not stored; a restart queued before `stop()` can still call `start()` afterward. `start()` neither rejects shutdown nor resets lifecycle state deliberately. The restart count resets after every healthy start, so the configured cap is not a lifetime cap and permits an indefinitely flapping service.

Recommendation: extract a reusable supervised-process state machine with one readiness promise, one cancellable restart timer, one non-overlapping health loop, and explicit stopped/starting/ready/stopping states. Define a rolling restart budget or reset only after a stability interval. Clear owned timers on every transition; handle child `error` as well as `exit`. This is resource ownership, not an opportunity for more parallel restarts.

Validation: fake-clock tests of repeated healthy-then-crash cycles, stop during restart delay/readiness, concurrent start callers, spawn errors, and exact remaining timer count. Existing `electron/microservice-manager.test.ts:195-215` checks one restart, not repeated-cycle timer retention.

## E02 — High: TCP-open is not service readiness; window creation waits behind it

Evidence: `electron/microservice-manager.ts:158-190`, `:221-229`; `electron/main.ts:474-539`, `:637`.

`healthCheckPath` is configured but never requested. Any listener on the fixed port can satisfy the probe, including an unrelated process or a service not ready to answer API calls. A slow or unhealthy startup blocks window creation behind the nominal 30-second readiness loop and then Express initialization. Individual checks can extend the nominal deadline.

Recommendation: inject an HTTP health probe that checks service identity/readiness, with deadline and cancellation. Show a shell/loading window early and gate dependent actions on readiness. Initialize independent startup work concurrently only after proving dependencies; do not simply race server initialization against a missing microservice URL. Report degraded state rather than returning fallback ports as if healthy.

Validation: wrong listener, HTTP 503, hung request, failed spawn, and fully healthy service; measure first-window versus API-ready times. This reduces critical-path latency, not asymptotic work.

## E03 — High: Async quit listener does not establish a shutdown barrier

Evidence: `electron/main.ts:648-651`; `electron/microservice-manager.ts:106-121`.

The `before-quit` event listener awaits `stop()`, but does not prevent the quit event. Event delivery does not itself wait for the returned promise. The intended five-second escalation therefore is not guaranteed to finish before Electron exits.

Recommendation: prevent the first quit, enter a single shutdown promise, stop owned services with a bounded deadline, and explicitly quit afterward with a reentry guard. Preserve updater quit behavior. Make service stop idempotent and account for processes that never emit exit.

Validation: real Electron shutdown smoke with a child that ignores SIGTERM, plus updater and repeated-quit paths. A mock that directly awaits the callback is insufficient.

## E04 — Medium: IPC subscriptions have no disposer

Evidence: `electron/preload-api.ts:3-6`, `:28-37`; `client/src/components/common/UpdateNotification.tsx:11-23`; `client/src/App.tsx:124-142`.

Anonymous IPC listeners are added without a removal API. Component effects cannot unsubscribe on unmount; App cleans only its DOM listener. Remounts/StrictMode replay can accumulate retained callbacks and duplicate deliveries. Cost is O(m) listeners after m mounts rather than a bounded listener count.

Recommendation: a typed subscription adapter should retain the wrapper, return a disposer using `removeListener`, and be consumed as the React effect cleanup. Keep channels allowlisted; do not expose raw ipcRenderer. Update the renderer type declarations with the new contract.

Validation: repeated mount/unmount and StrictMode effect replay with actual emitter listener counts and one delivery per mounted subscriber.

## E05 — Medium: Synchronous settings I/O blocks the main event loop

Evidence: `electron/main.ts:34-62`, `:547-564`.

Settings reads synchronously check and read the file; writes synchronously read, merge, and overwrite it on IPC callbacks. This is probably a small file and low-frequency operation, so impact needs measurement, but it blocks the Electron main thread and the in-process Express server. A direct overwrite also lacks the atomic write discipline already used by MPC preferences at `:208-242`.

Recommendation: reuse an asynchronous, serialized atomic JSON settings store with validation and an in-memory snapshot. Serialize read/modify/write operations to avoid lost updates; do not parallelize writes to the same file. Retain synchronous emergency crash logging only as a deliberate separate policy.

Validation: concurrent setting updates, failed write/rename, corrupted file recovery and main-loop delay under slow storage.

## E06 — Medium: Development microservice path uses a CommonJS global in ESM

Evidence: `electron/microservice-manager.ts:124-136`; `electron/tsconfig.json:3-5`; `electron/package.json:2`. Contrast `electron/main.ts:261-263`.

The development branch references `__dirname` without defining it in that module, while Electron emits ESNext modules and the package is ESM. Native ESM does not supply that global. The packaged branch does not take this path; this is a development-mode defect, not a claim that every packaged launch fails.

Recommendation: derive the directory from `import.meta.url`, as main already does, or inject a binary locator into the reusable supervisor. Keep runtime paths separate from build artifact discovery.

Validation: launch emitted Electron development code outside Vitest's transform environment with a known binary location.

## E07 — High: Parallel build races a destructive rebuild of its shared dependency

Evidence: `package.json:15`; `scripts/ensure-scryfall-client-built.mjs:9-13`, `:25-34`; `server/package.json:13-16`; `shared/scryfall-client/package.json:34`.

The root first ensures the shared package exists, then starts client/server/Electron in parallel. Server's npm prebuild rebuilds the shared package, whose build removes `dist`. Client can resolve that same package while its outputs are absent or partially rebuilt. The ensure step checks existence, not freshness. Thus parallelism is already present but the dependency graph is wrong.

Recommendation: model shared-client build as a single prerequisite node, followed by parallel consumers that do not mutate that node. Keep standalone server build able to establish its prerequisite without duplicating it inside the aggregate build. Prefer atomic publication of built output or project-reference/incremental orchestration. Do not solve this by serializing every build unnecessarily.

Validation: repeated cold/warm aggregate builds with an intentional delay after shared dist removal, and changed shared source with preexisting artifacts. Assert all consumers see one complete, current artifact generation.

## E08 — Medium: Server build defeats its incremental compiler configuration

Evidence: `server/package.json:13`; `server/tsconfig.build.json:6-7`; `docs/BUILD_SPEED.md:19-25`.

Normal build deletes `.tsbuildinfo` and `dist` before invoking a compiler configured as incremental. Every invocation discards previous dependency-analysis state; the documented incremental behavior is not delivered by the normal command.

Recommendation: separate clean/release build from ordinary incremental build. Preserve cache for local builds, with an explicit clean command and stale-output handling for removed sources. Compare cold, unchanged, one-file-changed and removed-file builds; never trade release reproducibility for a warm-build number.

## E09 — Medium: Release validation is narrower than the product and could run independent gates concurrently

Evidence: `scripts/release.mjs:152-167`; `client/package.json:7`; `package.json:27-38`.

Release validation builds and lints only the client. Vite build is not a TypeScript typecheck; server/Electron/shared gates and existing tests are not called here. Sequential client build/lint also misses safe concurrency after prerequisites are settled.

Recommendation: extract a project-configured validation DAG with explicit typecheck, lint, tests and component builds. Independent checks may run in bounded parallelism; shared-output dependencies must follow E07. Keep manual override explicit and distinguish skipped gates from passed gates. Use the existing self-hosted tooling, not GitHub Actions.

Validation: inject a failure in each required gate and verify release refuses to proceed; verify client type errors fail even if Vite transpilation succeeds. No claim is made here about the latest actual gate results.

## E10 — High: Release-note generation interpolates commit text into a shell

Evidence: `scripts/release.mjs:169-175`, `:229-240`, `:298-300`.

Git commit subjects become a prompt embedded inside `sh -c` double quotes. Only double quotes are escaped; shell substitutions/backticks in commit text are still interpreted. This is a source-confirmed command-injection mechanism in developer release tooling, not a remotely demonstrated exploit. The command also downloads an unpinned CLI at execution time, pipes stderr without consuming it, and kills the shell rather than explicitly managing the complete descendant lifecycle.

Recommendation: use a configured/pinned executable with argv and send prompt data through stdin, never shell interpolation. Drain or inherit stderr, cap output, and supervise cancellation/timeouts. Extract an optional release-notes provider interface so release orchestration works without a particular AI service or network installation.

Validation: harmless literal dollar/backtick/newline fixtures must reach child stdin unchanged; use a local stub executable, not the real release command. Include large stderr, timeout, nonzero exit, offline fallback, and descendant cleanup cases.

## E11 — Medium: Build and package paths do not share an artifact contract

Evidence: `scripts/build-microservice.sh:6-13`, `:27-34`, `:48-49`, `:109-115`; `package.json:85-91`; `electron/microservice-manager.ts:124-144`.

The build script accepts an alternate microservice directory, target directory, and debug profile, while packaging always reads a sibling release directory and the development launcher also assumes that location. A successful customized build need not be the artifact packaged or launched.

Recommendation: produce a platform/profile artifact manifest consumed by builder and launcher, or reject unsupported override combinations at packaging time. Inject the artifact resolver rather than mixing project naming into process supervision. Rust and JS builds can run concurrently after this contract is defined and machine resource limits are considered; packaging must join both.

Validation: alternate target directory, debug/release, missing/stale binary, and target-platform mismatch. Do not claim to have reviewed the external Rust implementation.

## E12 — Medium: Desktop transport loading needs real-runtime evidence, not just mocked coverage

Evidence: `electron/preload.cts:1-4`; `electron/preload-api.ts:8`; `electron/main.ts:335-339`; `electron/preload-bridge.test.ts:14-21`.

The CommonJS preload requires a separate ES-module helper. The test replaces that require with a mock, so it does not establish that the helper loads under the actual Electron preload/sandbox module loader. This is a runtime-compatibility risk requiring a real launch, not a reproduced failure in this review.

Recommendation: keep a bundled/sandbox-compatible preload boundary and exercise its built artifact in real Electron. Do not enable renderer Node integration to bypass the problem. Assert the allowlisted bridge exists and listener disposal works.

## Cross-cutting documentation drift

`README.md:68-87` contains historical performance guarantees without a current reproducible benchmark artifact; this review does not validate those timings. `ARCHITECTURE_SUMMARY.md:20-46` still describes Electron strategy as undefined and recommends GitHub Actions and registry publishing, conflicting with the accepted bundled strategy and current repository conventions. `docs/BUILD_SPEED.md:19-25` conflicts with E08. These are maintenance hazards when reusing the project as a template: mark historical reviews as historical and keep one current architecture/build contract.

## Files inspected

`electron/main.ts`, `electron/microservice-manager.ts`, `electron/mpc-preferences.ts`, `electron/preload-api.ts`, `electron/preload.cts`, `electron/tsconfig.json`, `electron/package.json`, `electron/microservice-manager.test.ts` (first 300 lines), `electron/main-lifecycle.test.ts` (setup), `electron/preload-bridge.test.ts`, `scripts/release.mjs` (validation and release-note paths), `scripts/build-microservice.sh`, `scripts/ensure-scryfall-client-built.mjs`, root/client/server/shared-client package manifests, server/client TypeScript configs, `client/vite.config.ts`, update subscription callers, `README.md`, `ARCHITECTURE_SUMMARY.md`, `docs/ADR-001-bundled-microservice.md`, `docs/BUILD_SPEED.md`, `docker-compose.yml`.
