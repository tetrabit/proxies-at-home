# Deployment Guide

**Last Updated:** 2026-09-12

## Overview

Proxxied supports multiple deployment modes to fit different use cases:

1. **Web Client Only** (Netlify/Static hosting)
2. **Web + Node Server** (Full-stack deployment)
3. **Web + Microservice** (Optimal performance)
4. **Electron Desktop** (Bundled application)

## Deployment Modes

### 1. Web Client Only (Static Hosting)

**Best for:** Simple deployment, CDN distribution  
**Performance:** Direct Scryfall API calls (rate-limited)  
**Hosting:** Netlify, Vercel, GitHub Pages, etc.

```bash
# Build client
cd client
npm run build

# Deploy dist/ directory to your hosting provider
```

**Configuration:**
- Client makes direct API calls to Scryfall
- No server-side caching
- Subject to Scryfall rate limits
- IndexedDB for client-side caching

### 2. Web + Node Server

**Best for:** Custom deployments, enterprise use  
**Performance:** Server-side caching with SQLite  
**Hosting:** VPS, cloud instances, containers

```bash
# Build client
cd client
npm run build

# Start server (serves client + API)
cd ../server
npm start
```

**Configuration:**
- Server proxies Scryfall API calls
- SQLite caching (7-day TTL)
- Handles rate limiting
- Configurable via environment variables

**Environment Variables:**
```bash
PORT=3001                    # Server port
NODE_ENV=production          # Environment mode
SCRYFALL_CACHE_URL=http://localhost:8080  # Optional microservice URL
```

### 3. Web + Microservice (Recommended)

**Best for:** High-traffic, optimal performance  
**Performance:** 41× faster queries with PostgreSQL/SQLite  
**Hosting:** Microservice + Node server + static client

**Architecture:**
```
Client (Netlify) → Server (Node/Express) → Microservice (Rust)
                                         ↓
                                    PostgreSQL/SQLite
```

**Deployment Steps:**

#### 1. Deploy Microservice

```bash
cd ~/path/to/scryfall-cache-microservice

# Build for production
cargo build --release --features postgres

# Run microservice
./target/release/scryfall-cache-microservice

# Or with Docker
docker build -t scryfall-cache .
docker run -p 8080:8080 -e DATABASE_URL=postgresql://... scryfall-cache
```

**Microservice Environment:**
```bash
DATABASE_URL=postgresql://user:pass@host:5432/db  # PostgreSQL connection
# Or for SQLite (Electron/embedded):
# Uses local scryfall-cache.db file
RUST_LOG=info                                      # Logging level
PORT=8080                                          # Service port
```

#### 2. Configure Server

```bash
# Point server to microservice
export SCRYFALL_CACHE_URL=http://your-microservice:8080

cd server
npm start
```

#### 3. Deploy Client

```bash
cd client
npm run build

# Deploy to Netlify/Vercel
# Configure API proxy to your server
```

**Performance Benefits:**
- Queries: <1 second (vs 41 seconds)
- Zero Scryfall rate limits
- Comprehensive indexing
- Graceful fallback support

### 4. Electron Desktop App

**Best for:** Offline use, bundled distribution  
**Performance:** Local SQLite with embedded microservice  
**Distribution:** DMG (macOS), NSIS (Windows), AppImage (Linux)

```bash
# Build for current platform
npm run electron:build

# Build for specific platform
npm run electron:build:win   # Windows
npm run electron:build:mac   # macOS
npm run electron:build:linux # Linux
```

**What's Bundled:**
- React client (prebuilt)
- Express server
- Rust microservice binary
- SQLite database (empty, populated on first run)

**Auto-updates:**
- Uses electron-updater
- Checks for updates on launch
- Two channels: `latest` (auto) and `stable` (manual)

## Shared SQLite Calibration Harness: Deployment, Pairing, and Recovery

This optional service is a separate, credential-scoped SQLite runtime for shared
printer-calibration state. It uses `calibration-harness.db` under
`SERVER_DATA_DIR`; it is not the server card-cache database, an Electron
preference sidecar, or a browser profile. Keep its persistent directory separate
from Chromium/Electron profile storage. The server data directory may also hold
`proxxied-cards.db`; the two database files and their sidecars must remain distinct.

### Accepted deployment and preservation evidence

The accepted canonical deployment uses the Compose server and client bound only
to `127.0.0.1:3001` and `127.0.0.1:5173`. Its Compose configuration explicitly
enables the Web origin `http://127.0.0.1:5173` and preserves
`calibration-harness.db` in the `proxies-at-home_server-data` volume.

The accepted Q3 candidate is `9d7d51b70092e84d88e5a6a5cf6a428b6df056fe`.
Independent QA accepted production C3/Dexie hydration through the real browser
and Electron IPC boundaries, plus a session-tolerant, read-only canonical
database/export/history verification. It establishes one dataset with 124 cases,
25 runs, 7,227 logical assets, and 5,817 unique blobs at revision 1; the
canonical snapshot SHA-256 is
`3bb05048e67fbb14d341a48771fd8fd10243694cdbafd9f5e6c101a9dc7afb57`.
The evidence does **not** claim full-application UI validation or a generic
backup/restore drill. The independent QA report is
`.review-artifacts/td-80f260/qa-c3174179-186d-4f58-89ce-21c145ca6680/reports/qa-report.json`
(SHA-256 `69dfc8a559e70ac5d87e68670ced601252b8546b4278fc7483f47782e28b2333`).

The harness is disabled unless `CALIBRATION_HARNESS_ALLOWED_WEB_ORIGINS` is a
nonempty comma-separated list of exact canonical origins. It does not inherit
authority from `ALLOWED_ORIGINS` or ordinary private-route credentials. No
wildcards, spaces, credentials, or non-canonical origins are valid. Use HTTPS
outside loopback; plain HTTP is accepted only for loopback development origins.

### Compose deployment and read-only checks

The repository Dockerfiles build the server and client with Node 20 build stages;
the client proxies `/api/` to the server. Build both services, then start the
already-built images without causing an implicit rebuild:

```bash
docker compose build server client
docker compose up -d --no-build server client
docker compose ps

# Read-only liveness checks. 200 is the expected healthy status.
curl -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3001/health
curl -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:5173/
```

Do not replace the named volume, delete its contents, or use deployment as a
reason to reseed the harness. The deployed configuration already has an
authorized credential and preserved data. Do **not** rerun provisioning against
that live target unless an authorized operator explicitly intends to create a
new credential.

For a non-Compose deployment, set an operator-controlled persistent
`SERVER_DATA_DIR` and the exact `CALIBRATION_HARNESS_ALLOWED_WEB_ORIGINS` before
starting the compiled server. The directory must not be a browser profile; never
substitute another database for `calibration-harness.db`. Never print environment files, connection JSON,
Authorization headers, cookies, credentials, database contents, or private
runtime paths in Git, tickets, logs, or screenshots.

### Credential provisioning and pairing

Provisioning is an explicit mutation that creates a credential and may create or
initialize the dedicated database. Use this template only for a new,
operator-authorized target; it is not a routine deployment command:

```bash
# MUTATING: creates a credential and may initialize the dedicated database.
node scripts/provision-calibration-harness.mjs \
  --database /absolute/operator-controlled/server-data/calibration-harness.db \
  --owner-id OPERATOR_SELECTED_OWNER \
  --harness-id OPERATOR_SELECTED_HARNESS \
  --backend-origin https://service.example.invalid \
  --output /absolute/operator-controlled/private/calibration-harness.connection.json \
  --no-expiry
```

Run the utility from a local source checkout with a compatible installed native
binding for its Node version. It loads TypeScript through the checkout's `tsx`
loader; the production runtime image does not include that loader, so do not
substitute an ad-hoc `docker compose exec` command. The utility refuses to
overwrite an existing connection config and writes a new config with owner-only
`0600` permissions. Keep the config private, outside browser-accessible paths
and version control; never merge or overwrite an existing config file.

`--no-expiry` deliberately creates a permanent pairing credential (stored using
the reserved no-expiry state), not a distant fake expiration. Browser sessions
created from that credential remain finite and default to seven days. A user can
pair again with the permanent credential after a browser session expires.

For Web, an authorized user enters the credential only in **Web pairing
credential** and selects **Pair web service**. The input is transient and is
cleared by the UI. A successful pairing creates an HttpOnly,
`SameSite=Strict` cookie scoped to `/api/calibration-harness`; confirm the
non-secret status **Sync is up to date** after hydration. For Electron, install
the private config as `calibration-harness.connection.json` in the Electron
user-data location and select **Connect configured service**. The Electron main
process owns the credential; the renderer does not receive it.

Use only non-secret observations when checking a paired client:

| Check | Expected result |
| --- | --- |
| `GET /api/calibration-harness/session` through the selected client/session | `401 unauthorized` before pairing is expected; `200` after a valid pairing. A disabled namespace is not a healthy pairing result. |
| `GET /api/calibration-harness/snapshot` through that paired session | An owner/harness-scoped revision, without publishing, clearing, or reseeding data as a check. |
| UI status after initial hydration | **Sync is up to date**. |

### Canonical data verification and recovery boundaries

The accepted canonical verifier is intentionally dataset-specific and read-only:

```bash
# Authorized operator/auditor only; may take several minutes.
node scripts/verify-calibration-canonical-preservation.mjs --run-live
```

It compares the mounted canonical database with the preserved export, validates
all 7,227 logical asset bytes and 5,817 unique blobs, preserves the original
export and revision/history bytes, and tolerates legitimate credential/browser
session rows. Do not use an older verifier that requires zero session rows after
pairing. This command is evidence for the exact accepted dataset, not a general
health check or a backup/restore proof.

Offline, queued, in-flight, conflict, blocked, and failed statuses are signals
to preserve state, not permission to clear local Dexie data, replace a browser
or Electron profile, reseed, or overwrite the remote snapshot. The client uses
bounded pull-before-write and revision-checked merges. A `412
precondition_failed`, divergence/regression, malformed durable state, or an
exhausted recovery budget must remain conflict/blocked/pending until an
authorized reconciliation decision is available.

There is no documented manual conflict resolver in the UI. In particular, do
not invent or rely on choose-local, choose-remote, merge-editor, or
force-overwrite controls. Stop automated retries, preserve both inputs and
authorized evidence, then escalate. **Disable calibration sync** only stops the
current link and selects local authority; it does not reset data, restore data,
guarantee credential revocation, or reset a browser profile.

Backup and restoration are separate, authorized operations. Stop writers first,
retain the original export and the candidate backup, and use a SQLite-aware
consistent backup/export procedure that accounts for WAL/SHM. A raw copy of an
active SQLite main file alone is not a safe backup. The create-only publisher
refuses an existing database and SQLite sidecars; it is not a restore command.
Do not use `cp`, `mv`, forced reseeding, automatic activation, or an overwrite
recipe for this database. After a future authorized restoration, rerun the
canonical verification and paired session validation before describing the
service as recovered.

## Security Configuration

### Production Security Hardening

**Security Headers (helmet.js):**

The server includes helmet.js for security headers including:
- Content Security Policy (CSP) - Prevents XSS attacks
- HTTP Strict Transport Security (HSTS) - Forces HTTPS
- X-Frame-Options - Prevents clickjacking
- X-Content-Type-Options - Prevents MIME sniffing

**CORS Configuration:**

Production requires explicit origin whitelisting via environment variables:

```bash
# server/.env.production
ALLOWED_ORIGINS=https://proxxied.netlify.app,https://app.proxxied.com
NODE_ENV=production
```

**Development vs. Production:**

- **Development:** Allows all localhost origins automatically
- **Production:** Only allows origins specified in `ALLOWED_ORIGINS`

**Configuration File:**

Copy `server/.env.production.example` to `server/.env.production` and update:

```bash
cd server
cp .env.production.example .env.production
# Edit .env.production with your production domains
```

### Health Check Endpoints

**Simple Health Check:**
```bash
GET /health
# Returns: {"status":"ok","uptime":123,"timestamp":"2026-02-09T..."}
```

**Deep Health Check:**
```bash
GET /health/deep
# Returns: {"status":"ok|degraded","checks":{"database":"ok","microservice":"ok"}}
```

Use these endpoints for:
- Load balancer health checks
- Kubernetes liveness/readiness probes
- Monitoring system integration
- Production status dashboards

**Response Codes:**
- `200` - All systems healthy
- `503` - Degraded or unavailable (database/microservice issues)

## Production Checklist

### Pre-Deployment

- [ ] Run full test suite: `npm test` (client + server)
- [ ] Build succeeds without errors
- [ ] Environment variables configured
- [ ] Database connection verified
- [ ] Microservice health check passes

### Client

- [ ] Production build: `npm run build`
- [ ] Bundle size acceptable (<5MB recommended)
- [ ] PWA manifest configured
- [ ] Service worker caching tested
- [ ] API endpoints configured correctly

### Server

- [ ] SQLite database initialized
- [ ] Cache TTLs configured (default: 7 days)
- [ ] Security headers enabled (helmet.js configured)
- [ ] CORS origins restricted (ALLOWED_ORIGINS set)
- [ ] Health endpoints responding (`/health` and `/health/deep`)
- [ ] Rate limiting configured (if needed)
- [ ] Error logging enabled

### Shared calibration harness (only when intentionally enabled)

- [ ] `SERVER_DATA_DIR` is persistent, controlled, and separate from browser-profile storage; calibration and card-cache database files remain distinct.
- [ ] `CALIBRATION_HARNESS_ALLOWED_WEB_ORIGINS` contains only exact canonical origins.
- [ ] The existing volume/database has been preserved; deployment did not reseed or overwrite it.
- [ ] A separately retained source export and SQLite-aware backup exist before any authorized recovery work.
- [ ] Provisioning output is private, owner-only, and absent from Git, logs, and browser storage.
- [ ] Web/Electron pairing is performed by the authorized user, and status reaches **Sync is up to date**.
- [ ] Canonical verification confirms 124 cases, 25 runs, 7,227 logical assets, 5,817 unique blobs, revision 1, and the accepted snapshot SHA-256.
- [ ] Conflicts are preserved and escalated; no unsupported UI or overwrite resolution is claimed.

### Microservice

- [ ] Database populated with Scryfall bulk data
- [ ] Indexes created (Phase 2 optimizations)
- [ ] Health endpoint responding: `GET /health`
- [ ] Performance validated (<2s queries)
- [ ] Monitoring/logging configured

### Post-Deployment

- [ ] Health checks passing
- [ ] Performance metrics baseline established
- [ ] Error tracking configured
- [ ] Monitoring alerts set up
- [ ] Backup strategy implemented

## Performance Validation

### Query Benchmarks

Run the test app to validate performance:

```bash
cd test-app
./start-test.sh
```

**Expected Results:**
- `c:red` (6,704 cards): <1 second ✅
- `t:creature` (broad): <2 seconds ✅
- `cmc<=3 c:blue`: <0.5 seconds ✅
- Autocomplete: <100ms ✅

### Health Checks

```bash
# Microservice health
curl http://localhost:8080/health

# Server health
curl http://localhost:3001/health

# Expected response
{"status":"ok","uptime":12345}
```

## Monitoring

### Key Metrics

- Query response time (p50, p95, p99)
- Cache hit rate (target: >80%)
- Error rate (target: <1%)
- Database size growth
- Memory usage

### Recommended Tools

- **Application Performance:** New Relic, DataDog, Sentry
- **Database:** PostgreSQL logs, query analyzer
- **Infrastructure:** CloudWatch, Prometheus + Grafana
- **Uptime:** Pingdom, UptimeRobot

## Troubleshooting

### Slow Queries

1. Check database indexes: `\d+ cards` (PostgreSQL)
2. Verify Phase 2 optimizations applied
3. Check database size and vacuum status
4. Review query patterns in logs

### High Memory Usage

1. Check cache size: `td status` (SQLite)
2. Verify TTL settings
3. Review connection pool settings
4. Check for memory leaks with profiler

### Microservice Unavailable

1. Check microservice logs
2. Verify database connection
3. Check port availability
4. Verify firewall rules
5. Server should fallback to Scryfall API

### Database Connection Issues

1. Verify DATABASE_URL format
2. Check database permissions
3. Test connection with `psql` or similar
4. Check SSL requirements

## CI/CD Policy

- Do not use GitHub Actions for builds, tests, or deployments.
- If automation is needed, prefer self-hosted runners or manual scripts and document the approach here.

## Rollback Strategy

### Client Rollback

```bash
# Netlify: Use UI or CLI
netlify rollback

# Manual: Redeploy previous build
npm run build:previous
netlify deploy --prod
```

### Server Rollback

```bash
# Git: Revert to previous version
git revert <commit-hash>
git push origin main

# Or checkout previous version
git checkout <previous-tag>
npm install && npm start
```

### Database Rollback

The PostgreSQL example below is unrelated to calibration-harness recovery. The
calibration harness uses SQLite and follows the authorized, SQLite-aware
recovery boundary above: no `pg_restore`, overwrite, automatic activation, or
reseed operation is documented for it.

```bash
# Restore from backup
pg_restore -d database backup.sql

# Or use point-in-time recovery
```

## Security Considerations

- Use HTTPS for all production deployments
- Configure CORS appropriately
- Set secure cookie flags
- Implement rate limiting
- Keep dependencies updated
- Use environment variables for secrets
- Enable security headers
- Regular security audits

## Support

For deployment issues:
- Check logs: `npm run logs`
- Review health endpoints
- Consult troubleshooting section
- Open GitHub issue with deployment details

---

**Related Documentation:**
- [README.md](../README.md) - Project overview
- [PHASE_2_INDEXES.md](./PHASE_2_INDEXES.md) - Database optimizations
- [ELECTRON_BUNDLING_COMPLETE.md](./ELECTRON_BUNDLING_COMPLETE.md) - Desktop app
