# MPC Preference Persistence Plan

## Problem

MPC upgrade preferences (the "preferred identifier" used by `bulkUpgradeToMpcAutofill` to pick the right artist/source for each card) currently live only in IndexedDB via Dexie tables (`mpcCalibrationDatasets`, `mpcCalibrationCases`, `mpcCalibrationAssets`, `mpcCalibrationRuns`).

Failure modes:
1. Browser cache clear → all preferences lost.
2. New device → preferences not transferred unless user manually exports/imports the JSON fixture.
3. Team-wide preference curation requires a manual rebuild of the bootstrap fixture.

## Goals

1. Cache-clear safe — preferences survive an IndexedDB wipe.
2. Transferable — moving preferences between machines is one file copy.
3. Source-controllable — plain JSON, diff-friendly, reviewable in PRs.
4. Auto-synced — no manual "export" ritual; mutations persist immediately.
5. Mode-agnostic — works in web-only, web+server, and Electron deployments.

## Architecture

### Two-file model

| File | Location | Lifecycle | Source-controlled |
|---|---|---|---|
| `mpc-preference-defaults.v1.json` | `client/tests/fixtures/` (rename of current bootstrap fixture) | Hand-curated team baseline | Yes |
| `mpc-preferences.user.json` | Per deployment (see below) | Auto-written on every preference mutation | Optional (devs share via PR; users gitignore) |

At startup, the runtime hydrates IndexedDB by **merging defaults + user overrides**, with user wins on conflict. IndexedDB becomes a derived cache, not the source of truth. Wiping cache restores from disk on next load.

### Storage targets per deployment mode

A single `PreferenceSyncTarget` interface, three implementations:

```ts
interface PreferenceSyncTarget {
  load(): Promise<MpcPreferenceFixture | null>;
  write(fixture: MpcPreferenceFixture): Promise<void>;
  describe(): string; // for UI status
}
```

#### Electron (`ElectronPreferenceSyncTarget`)
- Writes via IPC handler to `app.getPath('userData')/mpc-preferences.user.json`.
- Survives app reinstalls.
- "Save to project" button copies the file into the repo for committing.
- Zero permission prompts, zero friction.

#### Web + server (`ServerPreferenceSyncTarget`)
- `GET /api/preferences` and `PUT /api/preferences` on the existing Express server.
- Default server-side path: `./data/mpc-preferences.user.json`.
- Path is configurable via env var `MPC_PREFERENCES_PATH`.
- Auto-syncs across browsers on the same server.

#### Web-only (`FsAccessPreferenceSyncTarget`)
- One-time setup: user grants a `FileSystemFileHandle` via the File System Access API ("choose where to save preferences").
- Handle is persisted in IndexedDB (separate from preference data).
- Subsequent writes are silent.
- Fallback: if the handle is revoked, debounced auto-download with a clear "save this file somewhere safe" prompt.

The active target is selected at runtime from a small detector (`isElectron()` / `serverReachable()` / fallback to FSAA).

### Auto-write hooks

Every code path that mutates a calibration case or `expectedIdentifier` calls `preferenceSync.markDirty()`. A debounce (~2s) serializes the current dataset and writes via the active target. No per-keystroke writes.

Hook points (existing call sites):
- `saveMpcCalibrationCase` (`mpcCalibrationStorage.ts`)
- Manual override flows in the MPC upgrade UI
- Calibration "promote candidate to expected" actions
- `importMpcCalibrationFixture` (treat import as a new write)

### Startup flow

```
1. Load defaults from   client/tests/fixtures/mpc-preference-defaults.v1.json (bundled with app)
2. Detect active target (Electron / server / FSAA)
3. Load user overrides from target (may be null on first run)
4. Merge: user overrides ⊕ defaults  →  effective dataset
5. Write effective dataset into IndexedDB (replacing existing)
6. Hand off to existing query path (`getMpcCalibrationPreferredIdentifier`, etc.)
```

Merge semantics:
- Cases keyed by `(name, set, collectorNumber)` (or just `name` when set/collector absent).
- User override wins on duplicate keys.
- New cases from user override are added.
- Default cases not in user override are kept.

### Source-control workflow

- `client/tests/fixtures/mpc-preference-defaults.v1.json` is JSON-formatted and pretty-printed — `git diff` is reviewable.
- `cd client && npm run preferences:promote -- /absolute/path/to/mpc-preferences.user.json` copies the user's local `mpc-preferences.user.json` into the defaults file, ready for `git commit`.
- CI step validates the defaults file against the schema in `mpcCalibrationImport.ts:130 validateMpcCalibrationFixture`.

## Implementation steps

1. **Rename** the existing bootstrap fixture to clarify intent: `mpc-calibration-recovered-live.v1.json` → `mpc-preference-defaults.v1.json`. Update imports in `mpcPreferenceBootstrap.ts`.
2. **Define** `PreferenceSyncTarget` interface and `MpcPreferenceFixture` type (reuse existing `MpcCalibrationFixture` shape).
3. **Implement** the three target adapters:
   - Electron IPC handler (`electron/main.ts` + `electron/preload.cts` + renderer-side wrapper).
   - Server route (`server/src/routes/preferencesRouter.ts`).
   - FSAA wrapper (`client/src/helpers/fsAccessPreferenceTarget.ts`).
4. **Build** the merge function (pure, unit-testable).
5. **Replace** `ensureBootstrapPreferenceDataset` with `hydrateMpcPreferences` that runs the merged-startup flow.
6. **Wire** the auto-write hook into all preference-mutation call sites.
7. **Add** a small status indicator in the Calibration Modal: "Preferences sync: Electron / Server / Local file (last saved 2s ago)".
8. **Add** the `preferences:promote` npm script.
9. **Tests**:
   - Unit: merge function (override wins, additive merge, version compatibility).
   - Unit: each target adapter with mocked IO.
   - Integration: full startup → mutation → write → reload cycle for each mode.
10. **Migration**: on first run after upgrade, if the legacy IndexedDB-only preferences exist and no user file is present, write them out as the user file (one-shot rescue of existing customizations).

## Open questions

1. **Default location for user file in Electron**: `userData` (invisible, just works) vs project directory (visible, easy to commit). Recommendation: `userData` with an explicit "Save to project" button.
2. **Conflict policy on out-of-band edits**: if the user manually edits the JSON file while the app is running, do we reload or warn? Recommendation: file-watcher with a "preferences changed externally — reload?" toast.
3. **Asset embedding**: image assets (`mpcCalibrationAssets`) are base64-inlined. Large datasets balloon the file. Recommendation: keep assets out of the user override file — they are cache-rebuildable from MPC search results. Defaults file already omits assets.
4. **Schema versioning**: the existing `MPC_CALIBRATION_FIXTURE_VERSION = 1` constant is in place. Plan: add a `migrateFixture(fixture)` chain when version changes.

## Non-goals

- Cloud sync (Dropbox/iCloud/etc.) — out of scope. The user file lives in `userData` or a configurable path; users can sync that path themselves.
- Multi-user concurrent editing in web+server mode — last write wins. A real CRDT is overkill for this volume.
- Per-project preferences — preferences are global to the user, not scoped to a project workspace.

## Risks

- **Permission prompts on web-only**: FSAA grant is per-origin and per-handle. If the user denies, we degrade to download-on-change which is annoying. Mitigation: prominent, one-time UX with a clear "why we need this" explanation.
- **Server file path security**: server-mode write target must reject paths outside the configured data directory. Mitigation: resolve and validate against `MPC_PREFERENCES_PATH` at server boot.
- **Merge surprises**: a user override could mask a useful default update. Mitigation: log "user override hides default for {card}" at startup; surface in a "Reset to defaults" UI control.
