# Code-review TD action map

Program epic: **td-236ee1** — Code review remediation: reliable reusable proxy-printing platform

179 single-operation tasks under 10 outcome epics; all 54 findings covered. 148 explicit prerequisite edges.

Each leaf is type task, one point, with explicit acceptance and a <=15-minute sizing/stop rule. If actual complexity exceeds the estimate, split before broadening implementation. Tests belonging to the same behavior are closure evidence, not a second implementation operation.

Source: [review](README.md), reviewed commit `518787ecdb74c827731724b83ba62358b26b4acb`. The original review documents and verification hashes are unchanged.

There are no whole-epic dependencies: these are concurrent outcome groups, not sequential phases. Cross-epic prerequisites are explicit on leaf tasks. Hypothesis tasks require real probes followed by a disposition; evidence of a defect requires new atomic remediation children before the parent outcome can close.

All tasks remain unclaimed/open at creation. No implementation, commits or deployments were performed. Logical slice keys below are not review finding IDs.

## td-e418fc — Keep card mutations isolated and reference counts exact

20 tasks.

| TD ID | Slice | Finding(s) | Single operation | Blocked by |
|---|---|---|---|---|
| td-349805 | D01 | C01 | Bind enrichment responses to request UUID order | None |
| td-8f0167 | D02 | C02 | Restrict enrichment candidate reads to a captured project | None |
| td-c65991 | D03 | C02 | Assign the front project ID to synthesized DFC backs | td-8f0167 |
| td-f2dcdf | D04 | C02 | Fence enrichment writes after a project switch | td-8f0167 |
| td-5e94cf | D05 | C04 | Make same-image back relinking refcount-neutral | None |
| td-e86b88 | D06 | C04 | Remove duplicate back-reference reservation from Scryfall conversion | td-5e94cf |
| td-b3cf34 | D07 | C04 | Remove duplicate back-reference reservation from direct DFC import | td-5e94cf |
| td-ccd97d | D08 | C04 | Remove duplicate reservation from explicit-back direct import | td-5e94cf |
| td-729784 | D09 | C05 | Scope duplicate ordering reads to the source project | None |
| td-49288c | D10 | C05 | Reject mixed-project UUID inputs to bulk duplicate | td-729784 |
| td-c2d3b8 | D11 | C05 | Restrict shared-image bleed mutation targets by project | None |
| td-a1d08b | D12 | C05 | Restrict same-name bleed selection to the editor project | td-c2d3b8 |
| td-334748 | D13 | U01 | Scope editor Apply to All to the captured project | None |
| td-01847c | D14 | U01 | Reject cross-project selections in editor bulk apply | td-334748 |
| td-9483e9 | D15 | C09 | Add a compound project-order Dexie index | None |
| td-647d3e | D16 | C09 | Use a project-local maximum order in addCards | td-9483e9 |
| td-d4b72a | D17 | C09 | Use a project-local maximum order in stream imports | td-9483e9 |
| td-83163a | D18 | C09 | Serialize append-order reservation with card insertion | td-647d3e, td-d4b72a |
| td-d80f3e | D19 | S05 | Preserve id and oracle_id in cached-card projection | None |
| td-06b42b | D20 | S05 | Verify cached token lookup preserves oracle resolution | td-d80f3e |

## td-3667b0 — Make asynchronous operations settle and respect current user intent

19 tasks.

| TD ID | Slice | Finding(s) | Single operation | Blocked by |
|---|---|---|---|---|
| td-5d58ec | A01 | C03 | Make direct import completion await resolution writes | None |
| td-973e5c | A02 | C03 | Pass import cancellation through direct resolver requests | td-5d58ec |
| td-e6d97d | A03 | C03 | Fence direct-import persistence after cancellation | td-973e5c |
| td-e6ec4f | A04 | C03 | Fence direct-import persistence after project changes | td-e6d97d |
| td-b2b95a | A05 | G01 | Track an image processor's active task per worker | None |
| td-4e58af | A06 | G01 | Reject active processing promises on cancelAll | td-b2b95a |
| td-8a5ba7 | A07 | G01 | Settle queued and active promises on destroy | td-4e58af |
| td-d02523 | A08 | G01 | Verify image-processing hook cleanup after active cancellation | td-4e58af |
| td-08218c | A09 | U02 | Await the editor's single-card apply callback | None |
| td-12a363 | A10 | U02 | Await the editor's selected-card apply callback | td-08218c |
| td-f7abf7 | A11 | U02 | Await the editor's all-card apply callback | td-08218c, td-334748 |
| td-680316 | A12 | U03 | Fence artwork preview search responses by operation generation | None |
| td-d93c15 | A13 | U03 | Fence Scryfall artwork selection writes by target and generation | td-680316 |
| td-fc85eb | A14 | U03 | Fence MPC artwork selection writes by target and generation | td-680316 |
| td-65f9d1 | A15 | U08 | Accept AbortSignal in the MPC search transport | None |
| td-337f82 | A16 | U08 | Fence MPC hook results and loading state by request generation | td-65f9d1 |
| td-943998 | A17 | U08 | Coalesce identical in-flight MPC query requests | td-65f9d1 |
| td-ee502b | A18 | U08 | Isolate cancellation between coalesced MPC subscribers | td-943998 |
| td-fdc8a6 | A19 | U11 | Cancel delayed multi-drag work on teardown | None |

## td-cc790c — Enforce provider request policy and private API boundaries

33 tasks.

| TD ID | Slice | Finding(s) | Single operation | Blocked by |
|---|---|---|---|---|
| td-e657e4 | T01 | S01 | Add a concurrency-one direct-Scryfall request broker | None |
| td-50c7d7 | T02 | S01 | Route catalog requests through the direct-Scryfall broker | td-e657e4 |
| td-eb7d2c | T03 | S01 | Route Scryfall router fallbacks through the shared broker | td-e657e4 |
| td-db0050 | T04 | S01 | Route paged-card direct requests through the shared broker | td-e657e4 |
| td-e1657c | T05 | S01 | Route token direct requests through the shared broker | td-e657e4 |
| td-349a25 | T06 | S01 | Route bulk-metadata requests through the shared broker | td-e657e4 |
| td-2b6438 | T07 | S01 | Verify cross-caller Scryfall rate spacing | td-50c7d7, td-eb7d2c, td-db0050, td-e1657c, td-349a25 |
| td-52be6d | T08 | S02 | Define the supported image-proxy origin policy | None |
| td-9b2485 | T09 | S02 | Reject image-proxy URLs outside the parsed origin policy | td-52be6d |
| td-241b1b | T10 | S02 | Reject private resolved addresses at proxy connection time | td-9b2485 |
| td-f2ca23 | T11 | S02 | Enforce image-proxy policy on every redirect hop | td-241b1b |
| td-85b9b4 | T12 | S02 | Stream proxy downloads with a per-response byte cap | td-f2ca23 |
| td-4ded15 | T13 | S03 | Bind desktop-started Express to loopback explicitly | None |
| td-634a90 | T14 | S03 | Document the private-route authorization contract | None |
| td-5ba14d | T15 | S03 | Add a private-route authentication middleware seam | td-634a90 |
| td-0f168e | T28 | S03 | Create a per-launch desktop API credential | td-5ba14d |
| td-a62424 | T29 | S03 | Expose desktop API authentication through an allowlisted preload method | td-0f168e |
| td-ee0e14 | T30 | S03 | Attach configured authentication in the private client transport | td-a62424 |
| td-20da77 | T31 | S03 | Wire backup calls through the authenticated private transport | td-ee0e14, td-ca8e37 |
| td-f6a08f | T32 | S03 | Wire preference calls through the authenticated private transport | td-ee0e14, td-aa256a |
| td-36e689 | T33 | S03 | Wire calibration calls through the authenticated private transport | td-ee0e14, td-8bc493 |
| td-5a026c | T16 | S03 | Enforce authentication on backup routes | td-5ba14d |
| td-ca8e37 | T17 | S03 | Enforce owner scope on backup record operations | td-5a026c |
| td-aa256a | T18 | S03 | Protect preference routes with the private-route boundary | td-5ba14d |
| td-8bc493 | T19 | S03 | Protect calibration routes with the private-route boundary | td-5ba14d |
| td-f51c75 | T20 | S03 | Protect operational metrics with the private-route boundary | td-5ba14d |
| td-920709 | T21 | S06 | Bound normalized import request cardinality and fields | None |
| td-d33096 | T22 | S06 | Batch deduplicated token identifier lookups | td-e1657c |
| td-bfcfce | T23 | S06 | Cancel stream resolution when its client disconnects | td-db0050 |
| td-1ea1bd | T24 | S06 | Enforce a bounded SSE operation deadline | td-bfcfce |
| td-7dd0a4 | T25 | S07 | Implement the shared client's configured request timeout | None |
| td-dea84f | T26 | S07 | Coalesce concurrent microservice health probes | td-7dd0a4 |
| td-5b1155 | T27 | S07 | Add short-lived health-status caching with explicit expiry | td-dea84f |

## td-0aefe0 — Bound image and PDF resource ownership

19 tasks.

| TD ID | Slice | Finding(s) | Single operation | Blocked by |
|---|---|---|---|---|
| td-2680c9 | R01 | G03 | Move effect decode behind bounded queue admission | None |
| td-42902e | R02 | G03 | Coalesce queued and active equivalent effect renditions | td-2680c9 |
| td-48e40b | R03 | G03 | Fence effect cache persistence against superseded generations | td-42902e |
| td-1cc7be | R04 | G04,P03 | Document an export working-set budget from a bounded measurement | None |
| td-45918b | R05 | G04 | Cap PDF worker count using the export surface budget | td-1cc7be |
| td-56228c | R06 | G04 | Send page-scoped image maps to PDF workers | None |
| td-802a9d | R07 | G04 | Bound worker canvasCache with byte-accounted eviction | td-1cc7be |
| td-02f3ee | R08 | G03 | Add byte-budget admission to the effect queue | td-2680c9, td-1cc7be |
| td-73737f | R09 | G02 | Probe shared-context export overlap in a real browser | None |
| td-d0091c | R10 | G02 | Record the context lease decision from the overlap probe | td-73737f |
| td-a48d83 | R11 | G02 | Reuse immutable shader pipeline resources per GL context | td-d0091c |
| td-f00be6 | R12 | G07 | Enforce bounded eviction for explicit-DPI effect writes | None |
| td-9c7fc4 | R13 | G07 | Route PDF effect-cache writes through the shared cache policy | td-f00be6 |
| td-f0b687 | R14 | G07 | Settle ZIP cache-write outcomes at export cleanup | td-f00be6 |
| td-09eefb | R15 | S04,P03 | Apply a measured per-upload calibration PDF cap | td-1cc7be |
| td-e8c219 | R16 | S04 | Bound aggregate calibration temporary-file bytes | td-09eefb |
| td-725b33 | R17 | S04 | Remove calibration upload files on disconnect | td-e8c219 |
| td-23f1be | R18 | P03,S04 | Bound simultaneous calibration subprocesses | td-8bc493, td-1cc7be |
| td-a7053b | R19 | S02 | Bound aggregate proxy-download memory and temporary bytes | td-85b9b4 |

## td-fbfed1 — Remove repeated lookup work and make outputs deterministic

17 tasks.

| TD ID | Slice | Finding(s) | Single operation | Blocked by |
|---|---|---|---|---|
| td-884a8e | F01 | C08 | Index linked-back share lookups by UUID | None |
| td-f793ec | F02 | U11 | Index original multi-drag orders by UUID | None |
| td-361220 | F03 | C10 | Merge image reference deltas in a keyed map | td-5e94cf |
| td-3dee89 | F04 | U06 | Reuse one art-crop SSIM result for recommendation layers | None |
| td-6b6152 | F05 | U09 | Bulk-read normalized MPC cache keys | None |
| td-151745 | F06 | U09 | Bulk-write validated MPC batch cache results | td-6b6152 |
| td-29b8bf | F07 | G05 | Preassign ZIP filenames in input order | None |
| td-4eef61 | F08 | G05 | Insert prepared ZIP entries in input order | td-29b8bf |
| td-7c2cd1 | F09 | U04 | Subscribe PageView to source-bleed setting primitives | None |
| td-5ce397 | F10 | U05 | Move drag-overlay object URLs into effect ownership | None |
| td-6bfa1b | F11 | G06 | Replace Pixi blob-size freshness with rendition identity | None |
| td-dfa7aa | F12 | G06 | Correct dormant image-cache rendition keys | None |
| td-e17a95 | F13 | U10 | Preserve CardGrid column width when callers pass style | None |
| td-247f89 | F14 | S08 | Replace proxy fixed-sleep deduplication with an in-flight promise | td-85b9b4 |
| td-9a3a30 | F15 | S08 | Publish proxy cache files by atomic rename | td-247f89 |
| td-083381 | F16 | S08 | Record incremental image-cache size and access metadata | td-9a3a30 |
| td-8e4618 | F17 | S08 | Evict image cache in bounded metadata-driven batches | td-083381 |

## td-5b375b — Make backup and calibration persistence complete and atomic

18 tasks.

| TD ID | Slice | Finding(s) | Single operation | Blocked by |
|---|---|---|---|---|
| td-fb34ab | P01 | C06 | Replace backup length fingerprint with a canonical content digest | None |
| td-71c4a1 | P02 | C06 | Retain dirty backup work skipped by rate or in-flight guards | td-fb34ab |
| td-cc6a87 | P03 | C07 | Validate backup project and card records before writes | None |
| td-f6fed9 | P04 | C07 | Validate backup UUID and linked-face consistency | td-cc6a87 |
| td-ce63ba | P05 | C07 | Validate backup image encoding and decoded-size limits | td-cc6a87 |
| td-4f14b7 | P06 | C07 | Include imported images in the project import transaction | td-f6fed9, td-ce63ba |
| td-2571b7 | P07 | C07 | Batch backup image existence reads and writes | td-4f14b7 |
| td-9d9efe | P08 | P02 | Atomically replace Python profile TOML files | None |
| td-6cb8bf | P09 | P02 | Lock Python profile read-modify-write across processes | td-9d9efe |
| td-84cf61 | P10 | P05 | Reject unsupported calibration profile metadata explicitly | None |
| td-c8e004 | P11 | P05 | Reject non-finite calibration offsets at the public boundary | None |
| td-83ad49 | P12 | P06 | Extract a Node-safe preference-fixture validator | None |
| td-b04776 | P13 | P06 | Validate normalized preference promotion input before replacement | td-83ad49 |
| td-a5999d | P14 | P06 | Publish promoted preference fixtures atomically | td-b04776 |
| td-00b488 | P15 | P03 | Support grouped-duplex offsets in the Python transform | None |
| td-0e8f52 | P16 | P03 | Expose grouped-duplex mode in the calibration route contract | td-00b488 |
| td-451431 | P17 | P03 | Send grouped-duplex metadata from the calibration client | td-0e8f52 |
| td-33c74a | P18 | P03 | Remove client interleave-regroup copies for grouped calibration | td-451431 |

## td-0b5979 — Reuse cancellable immutable MPC preference context

7 tasks.

| TD ID | Slice | Finding(s) | Single operation | Blocked by |
|---|---|---|---|---|
| td-7e0928 | M01 | U07 | Make preference seed harvesting abortable | td-65f9d1 |
| td-d97066 | M02 | U07 | Bound concurrent independent MPC seed searches | td-7e0928 |
| td-a03d04 | M03 | U07 | Bound visual-profile image decoding with cancellation | None |
| td-72722c | M04 | U07 | Cache immutable preference contexts by complete input version | td-d97066, td-a03d04 |
| td-7d1133 | M05 | U07 | Reuse the preference context in the upgrade modal | td-72722c |
| td-c03fcf | M06 | U07 | Reuse the preference context in the calibration modal | td-72722c |
| td-3c6bc4 | M07 | U07 | Hoist seed-profile construction out of held-out evaluation | td-72722c |

## td-d507bf — Make desktop services and IPC lifecycle-owned

15 tasks.

| TD ID | Slice | Finding(s) | Single operation | Blocked by |
|---|---|---|---|---|
| td-84eabd | E01 | E01 | Own and cancel the delayed microservice restart timer | None |
| td-39d195 | E02 | E01 | Clear the previous health interval before replacement | None |
| td-13d844 | E03 | E01 | Coalesce concurrent microservice start callers | None |
| td-e929f0 | E04 | E01 | Handle child spawn errors as a supervised failure | td-13d844 |
| td-00ea18 | E05 | E01 | Reset restart budget only after a stability interval | td-39d195 |
| td-926532 | E06 | E02 | Probe HTTP identity and readiness instead of TCP-open | td-13d844 |
| td-82cc8c | E07 | E02 | Show a loading window before service readiness completes | td-926532 |
| td-dd90fc | E08 | E03 | Block initial Electron quit until owned shutdown settles | td-84eabd, td-39d195 |
| td-8cf994 | E09 | E04 | Return disposers from allowlisted IPC subscriptions | None |
| td-b47dc7 | E10 | E04 | Dispose renderer updater subscriptions on effect cleanup | td-8cf994 |
| td-ca08ef | E11 | E04 | Dispose the App About subscription on effect cleanup | td-8cf994 |
| td-7f2556 | E12 | E05 | Serialize atomic asynchronous Electron settings writes | None |
| td-f85a52 | E13 | E06 | Resolve the development binary directory from import.meta.url | None |
| td-e20e2c | E14 | E12 | Probe the built preload bridge in sandboxed Electron | None |
| td-4db26c | E15 | E12 | Record the preload compatibility disposition | td-e20e2c |

## td-2e8052 — Make build and release inputs deterministic and safe

21 tasks.

| TD ID | Slice | Finding(s) | Single operation | Blocked by |
|---|---|---|---|---|
| td-a02fa1 | B01 | E07 | Build shared-client output once before parallel consumers | None |
| td-5c5f49 | B02 | E07 | Remove destructive shared rebuild from aggregate server consumption | td-a02fa1 |
| td-c61cc5 | B03 | E07 | Invalidate shared-build readiness when source changes | td-a02fa1 |
| td-02c5ad | B04 | E08 | Separate clean server builds from incremental builds | None |
| td-ed0770 | B05 | E09 | Add an explicit client TypeScript validation command | None |
| td-61d797 | B06 | E09 | Run client type validation from release validation | td-ed0770 |
| td-7f7df3 | B07 | E09 | Run component builds from release validation | td-5c5f49, td-c61cc5 |
| td-65761e | B08 | E09 | Run required component test gates from release validation | None |
| td-9bbe69 | B09 | E09 | Overlap independent release validation gates safely | td-61d797, td-7f7df3, td-65761e |
| td-4cef69 | B10 | E10 | Send release-note prompt through child stdin without a shell | None |
| td-2a4a8d | B11 | E10 | Pin and configure the optional release-note executable | td-4cef69 |
| td-b31ea5 | B12 | E10 | Drain release-note stderr with bounded capture | td-4cef69 |
| td-e0fa0f | B13 | E10 | Terminate the release-note process tree on timeout | td-4cef69 |
| td-4acd86 | B14 | E11 | Emit a microservice build artifact manifest | None |
| td-030b6c | B15 | E11 | Resolve packaged microservice inputs from the artifact manifest | td-4acd86 |
| td-994223 | B16 | E11 | Resolve the development microservice path from the artifact manifest | td-4acd86, td-f85a52 |
| td-30c92a | B17 | E11 | Run independent Rust and JS builds before a packaging join | td-5c5f49, td-030b6c |
| td-6c7560 | B18 | P01 | Set calibration venv runner defaults in the server image | None |
| td-b685bf | B19 | P04 | Lock the calibration runtime Python dependency set | None |
| td-aa6c14 | B20 | P04 | Install the locked Python runtime without uncontrolled pip upgrades | td-b685bf |
| td-7343ce | B21 | P04,P01 | Verify calibration commands in the standalone built image | td-6c7560, td-aa6c14 |

## td-c8a2be — Publish focused regression and runtime evidence for review remediation

10 tasks.

| TD ID | Slice | Finding(s) | Single operation | Blocked by |
|---|---|---|---|---|
| td-71819f | V01 | C08,C10,U11 | Record operation-count scaling for the linear lookup fixes | td-884a8e, td-f793ec, td-361220 |
| td-7ac55e | V02 | G03,G04,P03 | Record a bounded high-DPI export resource probe | td-45918b, td-802a9d, td-02f3ee, td-33c74a |
| td-133886 | V03 | E01,E03,E12 | Record an Electron lifecycle smoke on built artifacts | td-dd90fc, td-4db26c |
| td-2800b0 | V04 | S01 | Move live Scryfall unit-test probes into a serialized contract gate | td-2b6438 |
| td-1b1d77 | V05 | P02,P05 | Add a real small-PDF calibration package smoke | td-84cf61, td-c8e004 |
| td-b2948a | V06 | E08 | Correct build-speed documentation for clean versus incremental commands | td-02c5ad |
| td-5f3df1 | V07 | E11 | Mark historical architecture reviews as non-current guidance | None |
| td-6bc493 | V08 | G02,E12 | Document evidence limits for remaining runtime hypotheses | td-d0091c, td-4db26c |
| td-13be7d | V09 | P05 | Centralize repeated calibration CLI error formatting | None |
| td-9e75f7 | V10 | S08 | Consolidate duplicate bounded-limiter mechanics | td-e1657c, td-247f89 |

## Finding coverage

| Finding | Task IDs |
|---|---|
| P01 | td-6c7560, td-7343ce |
| P02 | td-9d9efe, td-6cb8bf, td-1b1d77 |
| P03 | td-1cc7be, td-09eefb, td-23f1be, td-00b488, td-0e8f52, td-451431, td-33c74a, td-7ac55e |
| P04 | td-b685bf, td-aa6c14, td-7343ce |
| P05 | td-84cf61, td-c8e004, td-1b1d77, td-13be7d |
| P06 | td-83ad49, td-b04776, td-a5999d |
| C01 | td-349805 |
| C02 | td-8f0167, td-c65991, td-f2dcdf |
| C03 | td-5d58ec, td-973e5c, td-e6d97d, td-e6ec4f |
| C04 | td-5e94cf, td-e86b88, td-b3cf34, td-ccd97d |
| C05 | td-729784, td-49288c, td-c2d3b8, td-a1d08b |
| C06 | td-fb34ab, td-71c4a1 |
| C07 | td-cc6a87, td-f6fed9, td-ce63ba, td-4f14b7, td-2571b7 |
| C08 | td-884a8e, td-71819f |
| C09 | td-9483e9, td-647d3e, td-d4b72a, td-83163a |
| C10 | td-361220, td-71819f |
| E01 | td-84eabd, td-39d195, td-13d844, td-e929f0, td-00ea18, td-133886 |
| E02 | td-926532, td-82cc8c |
| E03 | td-dd90fc, td-133886 |
| E04 | td-8cf994, td-b47dc7, td-ca08ef |
| E05 | td-7f2556 |
| E06 | td-f85a52 |
| E07 | td-a02fa1, td-5c5f49, td-c61cc5 |
| E08 | td-02c5ad, td-b2948a |
| E09 | td-ed0770, td-61d797, td-7f7df3, td-65761e, td-9bbe69 |
| E10 | td-4cef69, td-2a4a8d, td-b31ea5, td-e0fa0f |
| E11 | td-4acd86, td-030b6c, td-994223, td-30c92a, td-5f3df1 |
| E12 | td-e20e2c, td-4db26c, td-133886, td-6bc493 |
| G01 | td-b2b95a, td-4e58af, td-8a5ba7, td-d02523 |
| G02 | td-73737f, td-d0091c, td-a48d83, td-6bc493 |
| G03 | td-2680c9, td-42902e, td-48e40b, td-02f3ee, td-7ac55e |
| G04 | td-1cc7be, td-45918b, td-56228c, td-802a9d, td-7ac55e |
| G05 | td-29b8bf, td-4eef61 |
| G06 | td-6bfa1b, td-dfa7aa |
| G07 | td-f00be6, td-9c7fc4, td-f0b687 |
| S01 | td-e657e4, td-50c7d7, td-eb7d2c, td-db0050, td-e1657c, td-349a25, td-2b6438, td-2800b0 |
| S02 | td-52be6d, td-9b2485, td-241b1b, td-f2ca23, td-85b9b4, td-a7053b |
| S03 | td-4ded15, td-634a90, td-5ba14d, td-0f168e, td-a62424, td-ee0e14, td-20da77, td-f6a08f, td-36e689, td-5a026c, td-ca8e37, td-aa256a, td-8bc493, td-f51c75 |
| S04 | td-09eefb, td-e8c219, td-725b33, td-23f1be |
| S05 | td-d80f3e, td-06b42b |
| S06 | td-920709, td-d33096, td-bfcfce, td-1ea1bd |
| S07 | td-7dd0a4, td-dea84f, td-5b1155 |
| S08 | td-247f89, td-9a3a30, td-083381, td-8e4618, td-9e75f7 |
| U01 | td-334748, td-01847c |
| U02 | td-08218c, td-12a363, td-f7abf7 |
| U03 | td-680316, td-d93c15, td-fc85eb |
| U04 | td-7c2cd1 |
| U05 | td-5ce397 |
| U06 | td-3dee89 |
| U07 | td-7e0928, td-d97066, td-a03d04, td-72722c, td-7d1133, td-c03fcf, td-3c6bc4 |
| U08 | td-65f9d1, td-337f82, td-943998, td-ee502b |
| U09 | td-6b6152, td-151745 |
| U10 | td-e17a95 |
| U11 | td-fdc8a6, td-f793ec, td-71819f |

## Dependency-ready leaf tasks

Read from TD critical-path output and intersected with this exact program, not inferred from a global ready list.

- td-00b488: Support grouped-duplex offsets in the Python transform
- td-02c5ad: Separate clean server builds from incremental builds
- td-08218c: Await the editor's single-card apply callback
- td-13d844: Coalesce concurrent microservice start callers
- td-1cc7be: Document an export working-set budget from a bounded measurement
- td-2680c9: Move effect decode behind bounded queue admission
- td-29b8bf: Preassign ZIP filenames in input order
- td-334748: Scope editor Apply to All to the captured project
- td-39d195: Clear the previous health interval before replacement
- td-4acd86: Emit a microservice build artifact manifest
- td-4cef69: Send release-note prompt through child stdin without a shell
- td-52be6d: Define the supported image-proxy origin policy
- td-5d58ec: Make direct import completion await resolution writes
- td-5e94cf: Make same-image back relinking refcount-neutral
- td-634a90: Document the private-route authorization contract
- td-65761e: Run required component test gates from release validation
- td-65f9d1: Accept AbortSignal in the MPC search transport
- td-680316: Fence artwork preview search responses by operation generation
- td-6b6152: Bulk-read normalized MPC cache keys
- td-6c7560: Set calibration venv runner defaults in the server image
- td-729784: Scope duplicate ordering reads to the source project
- td-73737f: Probe shared-context export overlap in a real browser
- td-7dd0a4: Implement the shared client's configured request timeout
- td-83ad49: Extract a Node-safe preference-fixture validator
- td-84cf61: Reject unsupported calibration profile metadata explicitly
- td-84eabd: Own and cancel the delayed microservice restart timer
- td-884a8e: Index linked-back share lookups by UUID
- td-8cf994: Return disposers from allowlisted IPC subscriptions
- td-8f0167: Restrict enrichment candidate reads to a captured project
- td-9483e9: Add a compound project-order Dexie index
- td-9d9efe: Atomically replace Python profile TOML files
- td-a02fa1: Build shared-client output once before parallel consumers
- td-a03d04: Bound visual-profile image decoding with cancellation
- td-b2b95a: Track an image processor's active task per worker
- td-b685bf: Lock the calibration runtime Python dependency set
- td-c2d3b8: Restrict shared-image bleed mutation targets by project
- td-c8e004: Reject non-finite calibration offsets at the public boundary
- td-cc6a87: Validate backup project and card records before writes
- td-d80f3e: Preserve id and oracle_id in cached-card projection
- td-e20e2c: Probe the built preload bridge in sandboxed Electron
- td-e657e4: Add a concurrency-one direct-Scryfall request broker
- td-ed0770: Add an explicit client TypeScript validation command
- td-f00be6: Enforce bounded eviction for explicit-DPI effect writes
- td-f793ec: Index original multi-drag orders by UUID
- td-f85a52: Resolve the development binary directory from import.meta.url
- td-fb34ab: Replace backup length fingerprint with a canonical content digest

## Verification artifacts

- tasking-verification.json: persisted issue fields, membership, acceptance, dependency pairs, coverage and frontier.
- tasking-critical-path.json: actual TD frontier output.
- tasking-slices.tsv: input operation/acceptance/dependency specification.
- Helper: repository-root scripts/code-review-tasking.py. Use --verify for readback; --apply resumes creation and verifies.
- Ignored recovery journal: .todos/code-review-tasking.json.
