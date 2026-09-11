# Shared SQLite MPC calibration task map

Program: `td-c124f3`. Base: `2c870f2b4d0bb2e3a66b8b45f3b5518620d49b2a`.

## Outcome

One owner-scoped SQLite database in Docker persistent storage is authoritative for full harness datasets, cases, image BLOBs, saved runs and immutable revisions. Web and Electron use the same authenticated API. Local Dexie remains an offline cache with a durable outbox and common-base revision; no stale or unbased empty snapshot is silently published.

## Data preservation

- Actual Thorium origin: `http://127.0.0.1:5173` on this computer. Inventory: 124 cases, 7,227 assets, 25 runs.
- The separate Electron preference sidecar has 107 bundled-default choices; it is not the complete harness.
- Preserve original profiles and repository-local recovery copies. Full asset export must use bounded reads, not one enormous base64 payload or browser download events.
- Do not point two live Chromium profiles at the same LevelDB files. Do not replace complete harness data with the lossy preference fixture.

## Security and synchronization boundaries

- Dedicated SQLite file inside existing Docker server-data volume; do not replace or migrate the cards-cache database accidentally.
- Scoped operator provisioning and authenticated browser pairing; HttpOnly scoped sessions for web, fixed-origin main-process broker for Electron. No credentials in Vite builds, Git, logs or browser local/session storage.
- Revision-checked publication with immutable history; validated content-addressed BLOBs transferred separately with hard request bounds.
- Persist the exact common base and local dirty generation. Three-way merge preserves disjoint edits; divergent edits/deletions require explicit conflict handling.
- Pull before writing. Existing manual local data without a known base is preserved for explicit reconciliation, never silently overwritten.
- Keep Electron’s existing origin/profile. Docker web uses IPv4 loopback and Electron dev frontend retains its localhost binding so both can coexist without moving IndexedDB data.

## Delivery rules

- Existing `main` checkout only; parent is the Git/TD lifecycle writer. No push is part of this program unless requested again.
- Each implementation leaf is committed, submitted to review, then independently QA-closed or returned. Freeze its source/dependencies during review.
- All automated browser work is headless; Electron tests use owned private Xvfb displays. Never restart or raise the user’s visible app as an incidental test operation.
- Operational pairing/activation that requires user input must remain explicitly blocked, not counted as complete.

## Dependency map

### Preserve complete existing calibration data — `td-c4dffd`

| Key | TD task | Scope | Prerequisites |
| --- | --- | --- | --- |
| P1 | `td-0d4de4` | Stream calibration asset export without browser downloads | None |
| P2 | `td-419a09` | Verify full Thorium calibration export | P1 |
| P3 | `td-182f57` | Inventory and preserve Electron calibration cache | P1 |

### Provide an authenticated SQLite calibration service — `td-bc3e6e`

| Key | TD task | Scope | Prerequisites |
| --- | --- | --- | --- |
| T1 | `td-c49f4b` | Define versioned full-harness wire records | None |
| T2 | `td-f78c34` | Validate harness identity and references | T1 |
| S1 | `td-db7254` | Create isolated calibration SQLite schema | None |
| S2 | `td-7d7b8d` | Publish harness revisions with SQLite compare-and-swap | S1, T2 |
| S3 | `td-21aa8b` | Store owner-scoped content-addressed image BLOBs | S1 |
| A1 | `td-304259` | Provision scoped calibration credentials safely | S1 |
| A2 | `td-0a179c` | Authenticate persistent browser harness sessions | A1 |
| H1 | `td-5e2bb7` | Expose authenticated revisioned harness metadata | S2, S3, A2 |
| H2 | `td-2858c9` | Expose bounded authenticated harness image transfer | H1 |
| H3 | `td-b1b266` | Wire calibration service to server lifecycle | H2 |

### Synchronize web and Electron with offline-safe caches — `td-42d137`

| Key | TD task | Scope | Prerequisites |
| --- | --- | --- | --- |
| M1 | `td-14045a` | Merge disjoint offline harness changes | T2 |
| M2 | `td-158fbf` | Preserve deletions and asset conflicts during merge | M1 |
| C1 | `td-09d79c` | Persist local revision base and outgoing edits | T2 |
| C2 | `td-330727` | Implement authenticated web harness transport | H2, T2 |
| C3 | `td-729b89` | Hydrate shared harness into an offline cache safely | C1, C2 |
| C4 | `td-7b267f` | Upload local edits against their recorded revision | C3 |
| C5 | `td-b9689b` | Recover conflicts and reconnect queued edits | C4, M2 |
| C6 | `td-ce21b5` | Mark all harness mutations for durable sync | C5 |
| E1 | `td-30aa34` | Broker fixed shared-backend requests in Electron main | A1, T2 |
| E2 | `td-06d5fb` | Expose sandbox-compatible calibration IPC | E1 |
| E3 | `td-a06826` | Use shared IPC transport for linked Electron caches | E2, C2 |
| U1 | `td-b9b1e1` | Show harness pairing and synchronization state | C6, E3 |

### Migrate actual harness and prove end-to-end preservation — `td-995b8b`

| Key | TD task | Scope | Prerequisites |
| --- | --- | --- | --- |
| D1 | `td-1ee124` | Keep Docker and Electron local frontends coexisting | H3 |
| I1 | `td-d0f277` | Import portable full harness into SQLite atomically | P2, S2, S3 |
| I2 | `td-de86e5` | Seed actual canonical Docker SQLite data | I1, D1, P3 |
| Q1 | `td-d361f7` | Prove browser and Electron bidirectional shared updates | U1, D1 |
| Q2 | `td-b7731f` | Prove offline queue and restart conflict safety | Q1 |
| Q3 | `td-80f260` | Verify actual migrated dataset in both application modes | I2, Q2 |
| R1 | `td-ae23f8` | Document SQLite sharing, pairing and recovery | Q3 |

## Tracker verification

Created and read back 32 one-point leaves and 44 exact dependency edges under four outcome epics. The initial dependency-ready set was P1, T1 and S1.

Local machine-readable map and verification: `.review-artifacts/mpc-sqlite-task-map-244975198eb84e12b48c5343b17d5ceb/`. This document is tasking, not a completion or release claim.
