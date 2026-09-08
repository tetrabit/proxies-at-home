# ADR-002: Private API Authorization Contract

**Date**: 2026-09-08
**Status**: Implementation contract — runtime changes are deferred to the named tasks below
**Decision scope**: Server private routes, browser clients, and Electron’s embedded server.

---

## Context

S03 found that the server listens on all interfaces and mounts backup, preferences, printer-calibration, and metrics routes without application authentication. `Origin`/CORS is not authorization, and current backup storage keys records only by client-controlled `project_id`. The Electron main process currently starts the server on an ephemeral port and exposes only its URL; the renderer calls private routes with ordinary `fetch`.

This ADR freezes the contract before the small implementation tasks. It makes no runtime change. It does not create an identity provider, credentials, environment files, or migrations.

## Decision

### 1. Authorization model

Private route middleware authenticates an opaque bearer credential and attaches this *server-derived* context to the request:

```ts
type PrivateIdentity = {
  ownerId: string;                 // authoritative, opaque stable namespace
  capabilities: ReadonlySet<
    'backup:read' | 'backup:write' |
    'preferences:read' | 'preferences:write' |
    'calibration:read' | 'calibration:write' |
    'metrics:read' | 'metrics:write'
  >;
  transport: 'desktop-loopback' | 'server';
};
```

* Private credentials use only the `Authorization` header with the Bearer scheme; the credential value is opaque. No owner, project, role, or capability request header/body/query value is trusted.
* The verifier maps a token to the complete identity. It uses constant-time comparison (or a constant-time keyed-token lookup) and never logs the raw credential.
* Missing, malformed, unknown, expired, or disabled credentials return `401 {"error":"unauthorized"}` before a route reads data, creates a temporary file, or starts work. An authenticated identity without the route capability returns `403 {"error":"forbidden"}`.
* A private record outside the caller’s owner scope returns `404 {"error":"not_found"}`, including when its `projectId` exists for another owner. This prevents record discovery. Validation errors remain `400`; handler failures retain their existing `5xx` meaning.
* The middleware is a required route-registration seam, not a convention inside individual handlers. New `/api` routes are denied by default until registered as either `private(capability)` or a documented public capability route. There is no “localhost means authenticated” bypass.

`ownerId` is a durable namespace, not a display name and not a bearer token. It must be configured/issued by trusted server-side code. A desktop instance uses the fixed local namespace `desktop-local`; separate Electron profiles have separate data directories. A remote deployment must issue distinct opaque owner IDs.

### 2. Electron desktop bootstrap

Electron is the local trusted credential broker. The server must be started only after main has generated a fresh credential:

1. Main generates at least 32 cryptographically random bytes and base64url-encodes them for the launch. It keeps the value only in main-process memory.
2. Main passes a verifier/identity directly into `startServer` (or its server options): the credential maps to `{ ownerId: 'desktop-local', capabilities: all private capabilities, transport: 'desktop-loopback' }`.
3. The embedded server listens on explicit IPv4 loopback `127.0.0.1` and an ephemeral port. It must not bind `0.0.0.0`, and IPv6 `::1` may be added only as a separately tested explicit listener. Main must not log the credential, append it to `serverPort`, or persist it in settings, SQLite, files, crash reports, URL query strings, local/session storage, or renderer bundles.
4. Preload exposes one narrow `getPrivateApiBootstrap(): Promise<{ baseUrl, bearer }>` method. It exposes no generic IPC channel, server configuration, identity enumeration, or token mutation. The renderer initializes the private adapter from this result and keeps the bearer in module memory only.
5. The IPC handler accepts only the current application window’s **main frame**. It checks `event.sender === mainWindow.webContents`, rejects subframes, and verifies the sender frame URL against the exact trusted application URL: the configured development `http://localhost:5173` origin in development, or the packaged client `file:` URL in production. A new window, navigated page, devtools page, arbitrary `file:` page, and every unexpected sender are rejected. Rejection returns an error without credential material.
6. The preload method may be called repeatedly by the trusted renderer for reload recovery, but never by another sender. The credential remains launch-scoped and is discarded when main/server exits.

Electron `contextIsolation: true` and `nodeIntegration: false` remain prerequisites, not substitutes for the sender check. Renderer compromise can use an in-memory renderer credential for that running desktop session; loopback binding, short credential lifetime, and the constrained preload surface limit the boundary. This ADR does not claim to make an XSS-safe renderer fully trusted.

### 3. Web and server identity provisioning

There are two supported non-Electron patterns:

| Caller | Credential source | Required property |
| --- | --- | --- |
| Browser web client | An interactive, owner-bound identity flow or an already-authenticated backend-for-frontend returns a short-lived bearer to memory. | The built Vite assets contain no server bearer. If no such identity is configured, private operations are unavailable and fail locally before a request. |
| Server-to-server worker/admin client | A secret injected into that server process by the deployment’s server-side secret mechanism and mapped to one explicit owner/capability set. | The credential never crosses to a browser, static asset, client environment, or public endpoint. |

`VITE_API_BASE` may name a public API origin; **no** `VITE_*` variable may contain a bearer, private credential, identity map, shared secret, or credential-derived value. Do not compile a server bearer into source, `import.meta.env`, HTML, service-worker cache, URL, or test fixture. A browser must never be given a broadly privileged server-to-server bearer. There is no production fallback identity: an absent/misconfigured identity fails closed.

### 4. Owner and project isolation

Backup queries and mutations must derive owner scope solely from `req.privateIdentity.ownerId`.

* The canonical backup key is `(owner_id, project_id)`, not global `project_id`. Listing has `WHERE owner_id = ?`; read/update/delete use `WHERE owner_id = ? AND project_id = ?`; upsert conflicts on the same composite key. The request project identifier is an opaque client key inside that owner namespace.
* Two owners may use the same client project UUID without collision. A client cannot select another owner by adding `ownerId` to its payload.
* Preferences and printer-calibration profiles have no project ID, so their file/data namespace is owner-derived. T18/T19 must use an encoded, validated owner directory/key produced by server code, not a raw user-provided path. There is no shared default preferences/profile file once private enforcement is enabled.
* Metrics are operational data, not owner data. They require explicit `metrics:read` or `metrics:write`; a backup-only owner cannot inspect, reset, or log them.

#### Existing backup migration

Existing `backups(project_id PRIMARY KEY, ...)` rows cannot be safely attributed from their project UUID or payload. The migration must rebuild to an owner-aware table with `owner_id` and composite primary key, copying every legacy row under a reserved non-issuable owner ID such as `legacy-unassigned`.

Normal credentials must never be issued that reserved owner ID, and normal list/read/update/delete queries cannot see or overwrite those rows. This preserves bytes without silently assigning another user’s backups. Claim/export of legacy rows is an explicit authenticated migration/admin workflow outside T14–T33; it must require a deliberate operator decision and copy/verify data before deletion. The migration must run transactionally, preserve timestamps/data/card counts, create an owner/update index, and test both a fresh database and an upgraded v6 database.

### 5. Public shares are a distinct capability

A share link is intentionally public read access to the serialized share payload, not proof of private ownership.

* `GET /api/share/:id` is public and may return only the published share payload/expiry. It never reads backups, preferences, calibration data, metrics, or owner IDs.
* `POST /api/share` remains an explicitly public publication endpoint in this remediation scope. It accepts only the submitted publishable payload, never fetches a private backup on the strength of a client project ID, and receives no private bearer from the adapter. This preserves the existing account-free publication contract rather than silently adding an unowned identity/schema/client migration. If a future revocation/list feature needs owner authentication, it requires separately decomposed server/schema/client tasks before implementation.
* Existing eight-character share IDs remain a legacy public-link format, not a sufficient private authorization credential. A larger-CSPRNG ID and compatibility migration is an explicitly deferred hardening proposal, not required or claimed delivered by T14–T33. Private backups are protected solely by authenticated owner scope; possession or creation of a public share ID conveys none of that authority.
* Public routes never inherit authentication merely because a caller happens to send a bearer. The public-share client path never attaches a private bearer to a share GET.

### 6. Health, CORS, and CSRF boundaries

| Boundary | Contract |
| --- | --- |
| `GET /health` | Public, shallow liveness only (`status`, uptime, timestamp). It has no credential requirement and must not disclose identity, configuration, backup state, or deep dependency detail. |
| `GET /health/deep` | Private operational diagnostic; require `metrics:read` unless a separately designed probe identity/route is introduced. |
| `/api/metrics/*` | Private; `GET` requires `metrics:read`, while `/log` and `/reset` require `metrics:write`. `/api/metrics/health` is not a substitute for public `/health`. |
| CORS | CORS is a browser read policy, never authorization. Private routes allow only explicitly configured web origins and the documented Electron renderer case, allow `Authorization` and `Content-Type`, do not reflect arbitrary origins, and do not use `Access-Control-Allow-Credentials`. No-Origin non-browser requests still need bearer authentication. Public share/health CORS, if enabled, is separately minimal and never widens private routes. |
| CSRF | Private authentication is bearer-header only; private fetches use `credentials: 'omit'`, and the server does not authenticate private routes with ambient cookies. Therefore no CSRF token is required for this bearer contract. If a future cookie session is introduced, unsafe methods must require an Origin check plus a CSRF token before the cookie can authorize them; cookie acceptance cannot be silently added. |

### 7. Private client adapter

T30 introduces one browser-side `privateApi` adapter. Private callers must not call `fetch(API_BASE + privatePath)` directly after T30.

The adapter accepts a fixed private base URL and an async credential provider. It:

1. obtains the desktop bootstrap only through preload, or the web user credential through the configured interactive provider;
2. attaches its Bearer authorization header only to the exact configured private API origin and the allowlisted private routes (`/api/backup`, `/api/preferences`, `/api/printer-calibration`, and `/api/metrics`);
3. uses `credentials: 'omit'`, never puts the bearer in a URL, and refuses redirects or cross-origin targets before forwarding credentials;
4. does **not** attach a private bearer to Scryfall, MPC, Moxfield, Archidekt, image URLs, the cache microservice, public share GET/POST requests, or any arbitrary caller-supplied URL; and
5. rejects with a typed `PrivateApiIdentityUnavailableError` before network I/O when bootstrap/identity is absent or invalid. It never retries a private request anonymously.

The current unload `sendBeacon` backup marker cannot carry `Authorization`; T31 must remove it or replace it with an authenticated adapter-compatible operation. It must not preserve an unauthenticated mutable request merely for best-effort behavior. Regular debounced and restore backup flows retain their behavior through the adapter.

## Route classification and access matrix

The status/result cells are acceptance expectations for future focused tests; no test is introduced by this ADR.

| Route(s) | Classification and capability | Anonymous / invalid | Valid wrong scope or other owner | Valid authorized identity |
| --- | --- | --- | --- | --- |
| `GET /health` | Public shallow health | `200` minimal health | n/a | `200`; bearer ignored |
| `GET /health/deep` | Private `metrics:read` | `401` before checks | `403` | `200` or existing `503` health result |
| `GET /api/backup` | Private `backup:read`, owner list | `401` before DB query | `403` capability failure | `200` only caller owner’s metadata |
| `GET /api/backup/:projectId` | Private `backup:read`, `(owner, project)` | `401` before DB query | `403` for no read capability; `404` for another owner | `200` only own backup; own absent `404` |
| `PUT /api/backup/:projectId` | Private `backup:write`, owner-derived upsert | `401` before gzip/DB | `403` no write; cannot overwrite another owner | own `200`; same project ID under another owner remains separate |
| `DELETE /api/backup/:projectId` | Private `backup:write`, owner-derived delete | `401` before DB | `403` no write; other owner `404` | own `200`; own absent `404` |
| `GET` / `PUT /api/preferences` | Private `preferences:read` / `preferences:write`, owner namespace | `401` before file access | `403`; owner B cannot read/write owner A path | expected `200`/current `404` semantics, isolated by owner |
| `GET /api/printer-calibration/sheet`, `/profiles`, `/profiles/:name` | Private `calibration:read`, owner profile namespace | `401` before CLI/file work | `403`; other owner’s profile is `404` | existing successful response only for own namespace |
| `PUT` / `DELETE /api/printer-calibration/profiles/:name`, `POST /calculate`, `POST /apply` | Private `calibration:write` | `401` before parsing/upload/temp file/subprocess | `403`; cannot mutate/run with another owner’s profile | existing valid response, including upload/abort cleanup behavior |
| `GET /api/metrics`, `/api/metrics/health` | Private `metrics:read` | `401` | `403` | `200` |
| `POST /api/metrics/log`, `/api/metrics/reset` | Private `metrics:write` | `401` | `403` | `200` |
| `POST /api/share` | Explicitly public payload publication, no private-state lookup | current validated-publication response | n/a | same public response; no private bearer; never grants backup access |
| `GET /api/share/:id` | Public share capability | valid ID `200`; unknown/expired `404` | n/a | same public result, without adapter bearer |
| Existing card/import/provider routes (`/api/scryfall`, `/api/mpcfill`, `/api/stream`, `/api/cards/images`, `/api/moxfield`, `/api/archidekt`) | Explicitly public legacy data-provider routes; not covered by the private adapter | retain their documented behavior | n/a | retain behavior; no private credential is sent |

Every private-route test also covers: malformed `Authorization`, unknown bearer, no-Origin bearer request, disallowed CORS origin (browser response not made readable), no `Access-Control-Allow-Credentials`, and a token value absent from logs/errors. Desktop integration tests cover `127.0.0.1` binding, new token per launch, a successful main-frame preload bootstrap, and rejection for a non-main-window/subframe/untrusted URL sender.

## Implementation boundaries by task

| Task | Required bounded change under this ADR |
| --- | --- |
| T15 | Define identity/verifier/request context and `private(capability)` middleware seam; focused `401`/`403` tests; migrate no routes yet. |
| T13 | Add the explicit desktop loopback listener option and focused binding proof. This is independent of identity generation, and does not grant authentication. |
| T28 | Generate one cryptographic desktop credential before server start and inject its desktop identity; no persistence/logging. Use the listener option from T13 when available; final desktop readiness requires both T13 and T28, but T28 does not implement T13. |
| T29 | Add the narrowly sender-validated preload bootstrap API and its Electron types/tests. |
| T30 | Implement the allowlisted, fail-closed `privateApi` adapter; prove public/external origins receive no bearer. |
| T16–T17, T31 | Protect backup routes, perform the reserved-owner composite-key migration, then move list/read/write/delete/auto-backup to the adapter. |
| T18, T32 | Protect owner-namespaced preferences and move its helper to the adapter. |
| T19, T33 | Protect owner-namespaced calibration paths and move all calibration calls to the adapter without changing valid upload/abort behavior. |
| T20 | Protect all operational metrics while retaining only shallow `GET /health` as public. |

Keep the declared leaf dependencies: T15's verifier seam precedes route protection and T28 identity injection; T13 independently provides loopback binding; T29/T30 provide renderer bootstrap/adapter before T31–T33 migrate callers. A route-protection slice can be tested with an injected identity before the renderer is wired; the final desktop integration must include both loopback and bootstrap. No temporary “allow unauthenticated while migrating” switch is permitted. Tests must exercise the real Express middleware order so denial happens before the route’s data/file/subprocess work. Share-publication authorization/schema changes and larger share IDs are explicitly outside this contract's required scope rather than silently assigned to these tasks.

## Consequences

* Desktop continues to work without user-managed credentials, but its local API stops being an unauthenticated loopback service.
* A bare web deployment no longer gets private backup/preference/calibration access by accident; it needs explicit browser identity provisioning.
* Existing backups survive migration but are intentionally unavailable until an explicit ownership claim/export process exists.
* Public deck sharing remains possible without an account, but it is formally separated from private project data.
* This decision favors denial and explicit configuration over backward-compatible anonymous private writes.

## Evidence basis

This contract is grounded in the S03 review (`docs/code-review-2026-09-08/server-api.md`) and the T14/T15–T33 task slice, plus current callers: server route registration, Electron startup/preload, backup auto-save/restore, preference sync, calibration API, metrics router, share helper, client API constants, and SQLite backup schema. It is documentation only; runtime behavior remains unchanged until downstream tasks land.
