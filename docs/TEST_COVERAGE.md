# Test coverage policy

This repository tracks coverage for first-party application code only. The final gate is 100% statements, branches, functions, and lines for every policy-included scope.

## Included first-party scopes

| Scope | Included source | Coverage command |
| --- | --- | --- |
| Client | `client/src/**/*.{ts,tsx}` | `npm run coverage:client` |
| Server | `server/src/**/*.ts` | `npm run coverage:server` |
| Electron | `electron/*.{ts,cts}` | `npm run coverage:electron` |
| Shared | `shared/**/*.ts` | `npm run coverage:shared` |

## Allowed exclusions

Coverage configuration may exclude only files that are not executable first-party product logic or that have a documented alternate coverage path:

- Dependency and build output directories: `node_modules`, `dist`, package coverage output, and generated build artifacts.
- Test and harness files: `*.test.ts`, `*.test.tsx`, Vitest setup files, and e2e test folders.
- Generated declaration/source-map artifacts: `*.d.ts`, `*.d.ts.map`, `*.js.map`, and generated compiled JavaScript emitted beside TypeScript sources.
- Type-only modules where runtime coverage is not meaningful, such as shared declaration/type surfaces.

Do not exclude first-party source because it is hard to test. Workers, entrypoints, Electron preload/main code, rendering helpers, and service code must either be covered directly or have the alternate verification named below.

### Configuration exclusion registry

| Scope | Literal exclusion | Reason and alternate verification |
| --- | --- | --- |
| Client | `**/*.test.{ts,tsx}` | Test code is the coverage driver, not product source. |
| Client | `**/vitest.setup.ts` | Harness initialization is exercised by every client Vitest command. |
| Client | `**/vite-env.d.ts` | Generated/type-only Vite declarations have no runtime statements. |
| Client | `**/main.tsx` | Browser bootstrap is verified by `App.test.tsx`, `App.lifecycle.test.tsx`, and `npm --prefix client run build`. |
| Client | `**/*.worker.ts` | The three worker entrypoints—`bleed.webgl.worker.ts`, `effect.worker.ts`, and `pdf.worker.ts`—are browser message-loop shells. Their deterministic logic is verified by image/WebGL/PDF helper tests, and their bundling is verified by `npm --prefix client run build`. |
| Server | `**/*.test.ts` | Test code is the coverage driver, not product source. |
| Electron | `electron/*.test.ts` | Test code is the coverage driver, not product source. |
| Shared | `**/*.test.ts` | Test code is the coverage driver, not product source. |
| Shared | `**/*.d.ts` and `**/schema.d.ts` | Generated/type-only declarations have no executable runtime statements. |
| Shared | `**/types.ts` | Shared type-only surfaces have no executable runtime statements. |

### Source-level V8 directives

A `v8 ignore file` directive is a coverage exclusion and is never implicit. It is allowed only when the same line contains both an inline `--` rationale naming the alternate behavioral/runtime seam and `@preserve`, so the transpiler retains the declaration. `npm run coverage:policy` scans all first-party TypeScript and fails if a file-level directive lacks either marker. New directives must identify the concrete deterministic tests or runtime/build contract that replaces direct instrumentation; “hard to test” is not an acceptable rationale. Temporary directives remain coverage debt and must be removed when deterministic seams become available.

## Baseline commands

Baseline commands collect coverage without enforcing the final 100% threshold. They exist so reviewers can inspect progress while stabilization tasks are still landing. Run the policy check first so a green report cannot hide a configuration or source-level exclusion:

```bash
npm run coverage:policy
npm run coverage:client:baseline
npm run coverage:server:baseline
npm run coverage:electron:baseline
npm run coverage:shared:baseline
npm run coverage:baseline
```

Known starting-point investigation before this coverage epoch:

- Client: `npm --prefix client test -- --coverage.enabled=true` failed with 54.83% statements, 49.38% branches, 58.66% functions, and 55.54% lines. Failures included jsdom `localStorage` availability and React maximum update depth errors.
- Server: `npm --prefix server test -- --coverage.enabled=true` failed with 43.27% statements, 39.37% branches, 50.88% functions, and 43.21% lines. The observed blocker was a `better-sqlite3` native module ABI mismatch.
- Electron and shared did not have project-level baseline scripts before this policy task.

## Final enforcement gate

After all coverage tasks land, reviewers must run:

```bash
npm run coverage:all
```

The gate first runs `coverage:policy`, then delegates to package-level commands. This makes invalid thresholds or undocumented file-level exclusions fail before package coverage starts. Each package command must also pass independently:

```bash
npm run coverage:client
npm run coverage:server
npm run coverage:electron
npm run coverage:shared
```

A package-level failure is a project-wide gate failure; the root aggregator must not hide package failures.
