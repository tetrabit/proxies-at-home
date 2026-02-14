# Deployment Guide

**Last Updated:** 2026-02-09

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
