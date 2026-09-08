# Full-project static code review — 2026-09-08

## Executive assessment

Proxxied has useful building blocks for a reusable card/document-printing platform: shared types and API client, pure geometry helpers, worker-backed image processing, indexed project storage, bulk database operations, virtualized rendering, and separate Python calibration library/CLI surfaces. The main obstacle to reuse is inconsistent policy at their boundaries: project scope, request ownership, cancellation, image reference counts, cache identity, and resource budgets are implemented differently across callers.

The highest-priority work is correctness before throughput. Source inspection found cross-project mutations, response/card misalignment, backup change-detection gaps, unfinished asynchronous work, unrestricted server-side URL fetching, and unsafe release-shell interpolation. Adding more parallelism before fixing these ownership rules would amplify existing failure modes.

This report contains **54 numbered findings: 22 High, 30 Medium, 2 Low**, plus supporting reuse/verification observations. These are review entries, not 54 independent reproduced bugs: some entries cover different sides of the same issue (notably S04/P03 resource admission), and explicit hypotheses remain unverified. Each entry supplies source locations, impact, a specific improvement and proposed validation.

## Read the subsystem reports

| Report | Entries | Scope |
|---|---:|---|
| [Client data](client-data.md) | 10 | State, Dexie, imports, reference counting, backups, sharing |
| [Rendering/export](rendering-export.md) | 7 | Workers, GPU ownership, pixel budgets, rendition caches, PDF/ZIP |
| [Server/API](server-api.md) | 8 | Provider throttling, URL proxy, authorization, SQL/cache, streaming |
| [UI/MPC](ui-mpc.md) | 11 | Project actions, async selection, reactive settings, ranking, bootstrap |
| [Electron/build](electron-build.md) | 12 | Process supervision, startup/shutdown, IPC, build DAG, release tooling |
| [Calibration/deployment](calibration-deployment.md) | 6 | Python persistence/API, duplex memory, Docker runtime, fixture promotion |

## Most consequential findings

- **C01:** Concurrent enrichment cache probes reorder request cards, but response mapping uses the original batch order. Metadata/art can be assigned to the wrong UUID.
- **C02/C05/U01:** Enrichment, duplication, shared-image bleed changes and editor Apply to All do not consistently preserve project scope. Enrichment also creates backs without projectId.
- **C03/G01/U02:** Terminal success/cancellation does not consistently settle owned work. Direct imports can finish early; active image-worker promises can remain pending; editor actions discard mutation promises.
- **C04/C06:** Reference ownership can overcount images, while automatic backup fingerprints miss actual content changes.
- **G03/G04/P03:** High-resolution decode, export surfaces, retained canvases and duplex PDF copies lack a unified working-set budget.
- **S01/S02/S03:** Direct Scryfall requests lack one global policy; image proxy permits unrestricted server-side fetching; private APIs need an explicit exposure/authentication boundary.
- **E01/E03/E07/E10:** Restart/quit ownership is incomplete, parallel builds race shared output destruction, and release-note generation treats commit text as shell syntax.

Severity prioritizes potential impact and reachability, not measured incidence. In particular, remote API risks depend on listener exposure; no live deployment was probed.

## Genuine linear-time opportunities

Maps/Sets below assume expected constant-time lookup; they require extra memory and are not a promise of strict worst-case O(1) hash access.

| Location / finding | Current work | Proposed work | Preserve |
|---|---|---|---|
| Share linked-back resolution, **C08** | O(N²) repeated find | Expected O(N), UUID map | Front-first payload and DFC indices |
| Multi-drag order restoration, **U11** | O(N²) repeated find | Expected O(N), original-order map | One-step undo and full restoration |
| Image refcount merge, **C10** | O(M²) searching growing update list | Expected O(M + links), signed-delta map | No-op/swap semantics and exact counts |
| Project-global scans/writes, **C02/C05/U01** | O(T), all projects | O(P), selected project plus index overhead | Isolation and linked pairs |
| Duplicate rendition work, **G03** | O(N × pixels) | O(U × pixels + N), U unique keys | Per-card overrides and image revision |
| MPC bootstrap across folds, **U07** | O(cases × seeds) setup | O(seeds) shared setup + per-case work | Independent fold training; no label leakage |

Do not relabel existing linear algorithms as quadratic. SSIM reuse **U06** removes a duplicate pass, not a big-O class. Bulk cache calls **U09/C07** reduce database round trips while total data work stays linear. PDF-copy removal **P03** reduces passes and peak memory. Comparison sorting is generally O(N log N); this review does not recommend replacing it with an incorrect O(N) claim. Per-pixel effects must still process relevant pixels, and exhaustive pairwise comparison cannot become linear merely by adding promises.

## Where concurrency helps — and where it does not

Safe candidates after ownership fixes:

- Bounded independent MPC/provider cache queries and image fetch/decode admission; coalesce identical in-flight requests and retain abort signals (**U07/U08/G03/S08**).
- Batched IndexedDB reads/writes instead of serial transactions (**C07/U09**).
- Early Electron loading shell and independent startup preparation, with explicit service-readiness dependencies (**E02**).
- Independent validation/component builds and Rust/JS builds after shared prerequisites, with packaging joining complete artifacts (**E07/E09/E11**).
- Parallel image preparation with preassigned output indices/names and ordered assembly (**G05**).

Do not parallelize:

- Direct Scryfall requests: use one FIFO concurrency-one broker with at least 100ms dispatch spacing, including retries/catalog/bulk metadata (**S01**).
- Writes to one TOML/settings file without transaction/lock ownership (**P02/E05**).
- Mutations outside their project transaction or shared artifact rebuilds while consumers read them (**C05/U01/E07**).
- High-DPI decoding/PDF work without a byte budget; CPU count is not available GPU memory (**G03/G04/P03**).
- Synchronous CPU/SQLite work by wrapping it in promises: JavaScript async is not thread parallelism. Use actual workers/processes only where measurement justifies isolation.

SSE must retain its compression bypass. GPU shared-context overlap is a **hypothesis**, not established corruption: **G02** explicitly calls for real-browser validation of conversion snapshot semantics before adding a mutex.

## Reuse/framework extraction opportunities

Extract narrow policy-bearing libraries, not a general framework or a mass folder reorganization. Keep MTG naming, DFC identity and provider ranking in domain adapters.

| Reusable boundary | Responsibility | Existing anchors / motivation |
|---|---|---|
| Project-scoped card repository | Required project scope, atomic linked-card mutation, revision bump, refcount deltas | dbUtils, projectStore; C02/C04/C05/C06/U01 |
| Cancellable operation lifecycle | Target snapshot, progress phases, generation fence, settled completion, disposal | ImportOrchestrator, useCardImport, MPC upgrade guards; C03/G01/U02/U03 |
| Provider transport and cache adapters | Deadline, retry, rate policy, in-flight deduplication, response validation | Shared client, deduplicatedSearch; S01/S07/S08/U08 |
| Rendition service | Canonical image revision + DPI + overrides key, decode admission, worker lease, byte-budgeted LRU | imageProcessing/effectCache/CardCanvas; G02-G07/U05 |
| Deterministic document export pipeline | Immutable job inputs, bounded preparation, ordered assembly, grouped duplex transform | PDF/ZIP/Python API; G04/G05/P03 |
| Typed fixture/profile storage | Shared schema/version migration, atomic persistence, concurrency policy | MPC import validation, Electron atomic writes, Python profile API; P02/P05/P06 |
| Process and build supervision | Explicit lifecycle/dependency graph, health identity, artifact contract, bounded cleanup | MicroserviceManager/build scripts; E01-E03/E07-E11 |

Formatting alone will not create reuse. CardGrid's style forwarding (**U10**) is a real component contract bug; duplicated CLI/shader/limiter helpers are smaller extraction candidates. Large files indicate responsibility concentration, not proof that every long file needs splitting.

## Scope, measurements and limitations

Reviewed commit: `518787ecdb74c827731724b83ba62358b26b4acb`.
Reviewed Git tree: `f458b9a73f21aa2ae40ad3cfbc80e1d4785fe1fa`.
Branch at start: `main`; tracked source/index unchanged during the review. Five pre-existing untracked client scratch scripts were excluded and left untouched. Review documents are newly created under this directory; no application source, dependency, commit, push or TD issue state was changed. Mandatory TD session initialization did occur, including in one reviewer context.

Repository-wide inventory and subsystem static passes covered client UI/state/import/render/export/MPC, server routes/services/caches, shared client/types surfaces, Electron, build/release scripts, Docker and vendored Python. Definitions and relevant callers/tests were read; each report lists its inspection coverage. This is broad project coverage, **not a claim that every source/test line or dependency was manually audited**.

Tracked code inventory, computed from .ts/.tsx/.js/.mjs/.cts/.py/.rs/.sh files, excluding vendor/dist/node_modules and declaration files:

| Area | Files | Lines | Test files | Test lines |
|---|---:|---:|---:|---:|
| Client | 499 | 126,784 | 254 | 71,672 |
| Server | 61 | 15,155 | 30 | 7,938 |
| Electron | 11 | 2,391 | 5 | 1,403 |
| Shared | 8 | 458 | 2 | 90 |
| Root scripts | 6 | 1,242 | 1 | 13 |

Counts include configuration and client scripts; tests are detected by .test. or tests/ paths, so these are inventory measurements, not coverage percentages or pure production LOC. Vendored Python was separately reviewed but excluded from this table's counting rule. Large production files include dbUtils (1,760 lines), ArtworkModal (1,471), PageView (1,308), and mpcBulkUpgradeMatcher (1,154).

There are **no tracked Rust source/Cargo manifest files in this repository**. The sibling Rust microservice implementation, live infrastructure, third-party package internals and production data were not reviewed. Integration/build assumptions about the sibling were reviewed here; its historical README performance numbers are not freshly verified.

Verification performed: source/caller inspection, targeted parent rechecks, Git target/unchanged-source checks, and programmatic document reference/ID validation. **Tests, builds, browser/GPU exports, security probes and benchmarks were not run.** Proposed tests in findings are future validation criteria, not fabricated passing results. Native Electron/preload and GPU issues explicitly identify where mocked/static evidence is insufficient. See verification.json for final structural checks and document hashes.
