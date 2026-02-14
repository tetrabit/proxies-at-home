# Attribution Map (Fork vs Tetrabit Work)

This repository is a fork.

- **Fork upstream**: `kclipsto/proxies-at-home`
- **This fork (origin)**: `tetrabit/proxies-at-home`

The goal of this doc is to make it obvious which references are intentionally kept as upstream attribution/branding and which components are owned/maintained in this fork (notably the Scryfall cache microservice integration and its local TS client).

## Source Of Truth

- Git remotes:
  - `origin`: tetrabit fork
  - `upstream`: kclipsto upstream

If you’re unsure whether a reference should be updated, check:

1. Whether it impacts user-facing branding or release channels (often upstream).
2. Whether it’s part of the microservice/client integration (tetrabit).

## Tetrabit-Owned (This Fork)

These areas are considered maintained as part of the `tetrabit` fork, and should generally prefer `tetrabit` naming/scope where applicable.

### Scryfall Cache Microservice Integration

- Server-side microservice adapter:
  - `server/src/services/scryfallMicroserviceClient.ts`
- Client-side microservice integration:
  - `client/src/services/scryfallMicroservice.ts`
  - `client/src/helpers/scryfallApi.ts`

### Local TypeScript Client Package (No Registry Publishing)

This repo intentionally consumes the TS client locally via `file:` dependencies and does not publish it to any npm registry.

- Package definition:
  - `shared/scryfall-client/package.json`
    - Package name: `@tetrabit/scryfall-cache-client`
    - `private: true` (publishing should be blocked)
- Consumers:
  - `client/package.json` uses `@tetrabit/scryfall-cache-client: "file:../shared/scryfall-client"`
  - `server/package.json` uses `@tetrabit/scryfall-cache-client: "file:../shared/scryfall-client"`
- Docker build notes that rely on local workspace install:
  - `client/Dockerfile`
  - `server/dockerfile`

### Fork-Specific Migration/Architecture Docs

These documents describe the fork’s microservice integration work and are treated as fork-maintained:

- `MIGRATION_STATUS.md`
- `docs/CLIENT_ARCHITECTURE_FIX.md`
- `docs/ELECTRON_BUNDLING_COMPLETE.md` (and related microservice bundling docs)
- Phase/session summaries and QA docs that discuss the microservice integration

### Tasking (td)

Tasks involving the microservice and the TS client integration are fork-owned work:

- `td-395e1d` Tokens: Fix 'Add Associated Tokens' manual action
- `td-7b2c37` Tokens: Make server token lookup prefer scryfall-cache-microservice
- `td-7b1fd1` Monitor and optimize microservice performance

Use `td context <id>` for the most accurate scope/acceptance criteria.

## Upstream Attribution / Branding (Intentional)

Some references to `kclipsto/proxies-at-home` are expected because this is a fork and the upstream project identity is still relevant.

### UI Links

- About/modal link to upstream repo:
  - `client/src/components/common/AboutModal.tsx`

### Network Identity (User-Agent)

- Server `User-Agent` includes upstream repo URL:
  - `server/src/routes/scryfallRouter.ts`

This is fine to keep if you want requests to be attributable to the upstream project identity.

## High-Risk: Release/Update Channels (Decide Before Publishing)

Electron release/update publishing configuration currently targets upstream owner/repo:

- `package.json` (electron-builder `build.publish`)

If you ever run a release workflow for the fork, you must decide whether releases should go to:

1. Upstream (`kclipsto/proxies-at-home`) (usually not what you want for a fork), or
2. Fork (`tetrabit/proxies-at-home`)

Do not change this casually; it affects where auto-updates and release artifacts are published.

## Rules Of Thumb

- If it’s about the microservice, the TS client, or integration behavior: prefer `tetrabit` scope and fork-controlled docs.
- If it’s about upstream project identity/attribution (repo links, historical branding): keeping `kclipsto` references can be correct.
- If it’s about publishing/releases: treat as a deliberate decision; document the choice.

## Quick Audits

To find upstream references:

```bash
rg -n "kclipsto" -S .
```

To find package/import scope references:

```bash
rg -n "@tetrabit/scryfall-cache-client|@kclipsto/scryfall-cache-client" -S .
```

