# ADR-001: Bundle Rust Microservice Binary with Electron

**Date**: 2024-02-07  
**Status**: ✅ ACCEPTED  
**Decision Makers**: Architecture Team, Project Orchestrator  
**Context**: Phase 0 - OpenAPI Setup

---

## Context and Problem Statement

The Proxxied application is migrating from an integrated Node.js server with SQLite caching to a microservice architecture using a Rust-based Scryfall Cache Microservice. We need to decide how to deploy this microservice alongside the Electron desktop application.

### Three Options Considered:

**Option A: Bundle Rust Binary with Electron** (✅ CHOSEN)
- Package compiled Rust binary inside Electron app
- Electron manages microservice lifecycle (start/stop)
- Self-contained, single installer

**Option B: External Microservice**
- User runs microservice separately (via Docker or binary)
- Electron connects to external service
- Maximum flexibility but complex setup

**Option C: Hybrid - Bundle with SQLite Fallback**
- Bundle binary but fallback to SQLite if unavailable
- Most resilient but most complex
- Dual caching strategies to maintain

---

## Decision

We have chosen **Option A: Bundle Rust Binary with Electron** as the deployment strategy.

---

## Rationale

### Simplicity Wins
- **Single installer**: Users get everything in one package
- **Zero external dependencies**: No Docker, no manual setup
- **Familiar UX**: Just like any desktop app - install and run

### Technical Feasibility
- Rust compiles to native binaries for each platform (Windows, macOS, Linux)
- Electron Builder supports extraResources for bundling binaries
- Child process management in Electron is well-established
- Binary size is reasonable (~5-15 MB compiled)

### User Experience
- **Instant startup**: Microservice starts with app
- **Offline capable**: Fully offline operation after initial data load
- **No configuration**: Works out-of-box

---

## Implementation

See FINAL_MIGRATION_PLAN.md Phase 1-5 for detailed implementation steps.

Key components:
- Electron microservice manager (lifecycle management)
- Health check monitoring
- Graceful shutdown handling
- Cross-platform binary bundling

---

## Consequences

**Positive** ✅
- Simplified distribution and UX
- Guaranteed compatibility
- Easier testing

**Negative** ⚠️
- Larger installer size (+5-15 MB)
- Build complexity (cross-compilation)
- Microservice always runs with app

---

**Decision Log**:
- 2024-02-07: Option A approved
- Phase 0 complete
