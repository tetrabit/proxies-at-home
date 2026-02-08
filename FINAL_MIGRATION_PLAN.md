# FINAL MIGRATION PLAN: QA & Project Orchestrator Decisions

**Status**: ✅ APPROVED FOR EXECUTION  
**Timeline**: 5-6 weeks (was 4 weeks, considered 7-8 weeks)  
**Risk Level**: MEDIUM → LOW (with approved mitigations)  
**Date**: 2024

---

## Executive Summary

The **build-qa-lead** conducted a comprehensive QA assessment and identified critical testing gaps in the original 6-phase migration plan. The **project-orchestrator** has reviewed and approved a **hybrid approach** that balances timeline constraints with risk mitigation.

**Key Decisions**:
- ✅ Add 3 new testing phases (0.5, 1.5, 3.5)
- ⚠️ Make Electron automation conditional (Phase 4.5)
- ✅ Move Electron strategy decision to Phase 0
- ✅ Accept manual performance testing as fallback
- ✅ Implement feature flag for phased rollout

---

## Approved Phase Structure (10 Phases)

### ✅ Phase 0: OpenAPI Setup (3 days)
**Original Plan**: Set up utoipa, generate TypeScript client  
**NEW ADDITION**: **Decide Electron Deployment Strategy** ← CRITICAL

**Tasks**:
- [ ] Add utoipa dependencies to Rust microservice
- [ ] Annotate API handlers with OpenAPI macros
- [ ] Define schemas for models
- [ ] Generate and serve OpenAPI spec at `/api-docs/openapi.json`
- [ ] Set up TypeScript client generation
- [ ] Package client for private distribution
- [ ] **NEW: DECIDE Electron strategy** (bundled/external/hybrid) ← DO FIRST

**Quality Gate**:
- [ ] OpenAPI spec validates
- [ ] TypeScript client generates without errors
- [ ] Electron strategy decided and documented

**Owner**: Backend Team + Architecture Team  
**Duration**: 3 days

---

### ✅ Phase 0.5: Contract Testing (1-2 days) ← NEW PHASE
**Rationale**: Prevents type mismatches between OpenAPI spec and Rust implementation  
**Priority**: MUST-HAVE (P0)

**Tasks**:
- [ ] Install Dredd (recommended for simplicity)
- [ ] Create contract test suite
- [ ] Test generated client against running Rust service
- [ ] Add contract tests to CI pipeline
- [ ] Document contract testing process

**Quality Gate**:
- [ ] All contract tests pass
- [ ] CI runs contract tests on spec changes
- [ ] Generated client types match Rust API responses

**Owner**: Backend Team + QA  
**Duration**: 1-2 days

---

### ✅ Phase 1: Infrastructure & Configuration (3 days)
**Original Plan**: Add config, health checks (2 days)  
**NEW ADDITIONS**: CI/CD updates, feature flag system, mock server

**Tasks**:
- [ ] Add microservice URL config to client and server
- [ ] Environment variables for SCRYFALL_CACHE_URL, timeout, enabled flag
- [ ] Add health check endpoint call on server startup
- [ ] **NEW: Update CI/CD pipeline** (add test stages)
- [ ] **NEW: Add feature flag system** for gradual rollout
- [ ] **NEW: Create mock microservice** for local development
- [ ] **NEW: Add structured logging and tracing**
- [ ] Update docker-compose.yml to include microservice

**Quality Gate**:
- [ ] Config env vars work in all environments
- [ ] Health check responds correctly
- [ ] Feature flag toggles microservice on/off
- [ ] CI pipeline includes new test stages
- [ ] Mock server works for local dev

**Owner**: Backend Team + DevOps  
**Duration**: 3 days (was 2 days, +1 day for CI/CD)

---

### ✅ Phase 1.5: Test Infrastructure (2-3 days) ← NEW PHASE
**Rationale**: Integration tests can't run without test environment  
**Priority**: MUST-HAVE (P0)

**Tasks**:
- [ ] Create `docker-compose.test.yml` with microservice + server
- [ ] Add test configuration for microservice URL
- [ ] Create shared test fixtures
- [ ] Add `npm run test:integration` script
- [ ] Configure CI to run integration tests
- [ ] Add health check orchestration for tests
- [ ] Document test environment setup

**Quality Gate**:
- [ ] Docker Compose starts all services correctly
- [ ] Integration tests run in CI
- [ ] Health checks work in test environment
- [ ] Test fixtures are shared and consistent

**Owner**: DevOps + QA  
**Duration**: 2-3 days

---

### ✅ Phase 2: Server-Side Migration (5.5 days)
**Original Plan**: Refactor server to use microservice (5 days)  
**NEW ADDITIONS**: Data migration validation, microservice timeout config

**Tasks**:
- [ ] Install and configure generated client
- [ ] Create microservice client wrapper (`scryfallCacheClient.ts`)
- [ ] Add circuit breaker pattern for microservice calls
- [ ] Refactor `scryfallRouter.ts` to use microservice
- [ ] Update routes: `/autocomplete`, `/named`, `/search`, `/cards/:set/:number`, `/prints`
- [ ] Update token/type detection utilities
- [ ] Refactor bulk data service (decision: keep or remove?)
- [ ] Update database schema (if keeping SQLite as secondary cache)
- [ ] **NEW: Add data migration validation tests**
- [ ] **NEW: Configure microservice timeout** (default 30s)
- [ ] Update image router and stream router

**Quality Gate**:
- [ ] All existing server unit tests pass
- [ ] New microservice client tests pass
- [ ] Integration tests pass (server + microservice)
- [ ] Data migration validated
- [ ] Error handling tests pass
- [ ] Performance within baseline (captured in Phase 1)

**Owner**: Backend Team  
**Duration**: 5.5 days (was 5 days, +0.5 for validation)

---

### ✅ Phase 3: Client-Side Migration (4 days)
**Original Plan**: Update client to use new server endpoints (4 days)  
**No major changes - already solid**

**Tasks**:
- [ ] Update `client/src/helpers/scryfallApi.ts` (keep existing interface)
- [ ] Update hooks: `useCardAutocomplete`, `useScryfallPrints`, `useScryfallSearch`, `useScryfallPreview`
- [ ] Update import helpers: `ImportOrchestrator`, `importParsers`, `streamCards`
- [ ] Update syntax helpers to match microservice parser
- [ ] Add type safety validation tests (NEW)
- [ ] Add backward compatibility tests (NEW)

**Quality Gate**:
- [ ] All existing client unit tests pass
- [ ] All E2E Playwright tests pass
- [ ] Type safety validation passes
- [ ] No console errors in browser
- [ ] Integration tests with full stack pass

**Owner**: Frontend Team  
**Duration**: 4 days

---

### ✅ Phase 3.5: Integration & Performance Validation (2 days) ← NEW PHASE
**Rationale**: Must validate no regressions before deployment  
**Priority**: Integration = P0, Performance automation = P1

**Tasks**:
**Integration Testing** (MUST-HAVE):
- [ ] Full stack smoke tests
- [ ] Cross-service error handling tests
- [ ] Data consistency checks
- [ ] Rollback testing (feature flag toggle)

**Performance Testing** (BEST-EFFORT AUTOMATION):
- [ ] Capture baseline metrics (P50/P95/P99) - **Manual if needed**
- [ ] Create k6/Artillery scripts - **If time permits**
- [ ] Test concurrent users - **Manual if needed**
- [ ] Verify under load - **Manual if needed**

**Rollback Validation**:
- [ ] Test switching back to old implementation
- [ ] Test feature flag toggling
- [ ] Validate data compatibility

**Quality Gate**:
- [ ] All integration tests pass (MUST)
- [ ] Performance within 10% of baseline (manual OK)
- [ ] Rollback verified (MUST)
- [ ] Full stack validated (MUST)

**Owner**: QA + Backend Team  
**Duration**: 2 days (integration focus, manual perf if needed)

---

### ✅ Phase 4: Testing & Validation (3.5 days)
**Original Plan**: Manual testing checklist (3 days)  
**NEW ADDITIONS**: Expanded error scenarios, performance validation

**Expanded Manual Testing Checklist**:

**Core Functionality**:
- [ ] Card search with complex queries
- [ ] Autocomplete functionality
- [ ] Artwork modal (prints fetching)
- [ ] Decklist import from various sources
- [ ] Token detection and querying
- [ ] DFC (double-faced card) handling

**Performance Tests** (Manual):
- [ ] Response time P95 < [baseline + 10%]
- [ ] Cache hit rate >= [baseline]
- [ ] Memory usage stable over 1 hour
- [ ] Concurrent requests handled correctly

**Error Scenarios** (SPECIFIC):
- [ ] Microservice returns 503 → Retry logic works
- [ ] Microservice times out → User sees timeout error
- [ ] Microservice unreachable → Falls back to SQLite (if hybrid)
- [ ] Microservice returns 500 → Error propagates correctly
- [ ] Malformed JSON response → Validation catches it
- [ ] Network partition → User sees connection error
- [ ] Rate limited by Scryfall → Exponential backoff works

**Data Scenarios**:
- [ ] Large decklist import (1000+ cards)
- [ ] Rapid autocomplete queries
- [ ] Concurrent artwork modal opens
- [ ] DFC card fetch and link
- [ ] Token detection with edge cases

**Quality Gate**:
- [ ] All manual tests pass
- [ ] All error scenarios handled correctly
- [ ] Performance validated manually
- [ ] Cross-browser testing complete

**Owner**: QA Team  
**Duration**: 3.5 days (was 3 days, +0.5 for error scenarios)

---

### ⚠️ Phase 4.5: Electron Integration Testing (0-3 days) ← CONDITIONAL PHASE
**Rationale**: Important but can fallback to comprehensive manual testing  
**Priority**: CONDITIONAL on DevOps capacity

**IF DevOps Available** (Automated):
- [ ] Test bundled microservice scenario (if Option A chosen)
- [ ] Test microservice startup/shutdown in Electron
- [ ] Test crash recovery
- [ ] Test update scenarios
- [ ] Cross-platform testing (Windows/Linux/Mac)
- [ ] E2E Playwright tests in Electron context
- [ ] Test with microservice unavailable
- [ ] Test with network errors

**IF DevOps Unavailable** (Manual Fallback):
- [ ] Manual Electron testing on Windows
- [ ] Manual Electron testing on Linux
- [ ] Manual Electron testing on Mac
- [ ] Test first launch after install
- [ ] Test update scenario
- [ ] Test microservice crash recovery
- [ ] Test system sleep/wake with microservice

**Quality Gate**:
- [ ] Electron builds pass on all platforms (MUST)
- [ ] Core functionality works in Electron (MUST)
- [ ] Fallback behavior tested (if applicable)
- [ ] E2E tests pass (automated or manual)

**Owner**: Electron Team + QA  
**Duration**: 3 days if automated, 0-1 days if manual  
**Decision Point**: End of Phase 1 (based on DevOps capacity)

---

### ✅ Phase 5: Deployment & Documentation (2 days)
**Original Plan**: Deploy and update docs (2 days)  
**NEW ADDITIONS**: Feature flag rollout strategy, monitoring setup

**Tasks**:
- [ ] Update deployment docs (add microservice as dependency)
- [ ] Update docker-compose.yml to include microservice
- [ ] Add health check monitoring
- [ ] Update Electron build scripts (based on chosen strategy)
- [ ] Update copilot-instructions.md
- [ ] Create migration guide with rollback plan
- [ ] **NEW: Add production monitoring setup**
- [ ] **NEW: Add alerting for microservice health**
- [ ] **NEW: Create metrics dashboard**
- [ ] **NEW: Create deployment runbook**

**Phased Rollout Strategy**:
1. **Week 1-2 (Internal)**: Feature flag OFF for users, ON for team
2. **Week 3 (Beta)**: 10% of users with feature flag ON
3. **Week 4 (Full)**: 100% if metrics look good
4. **Rollback Ready**: Feature flag can disable microservice instantly

**Quality Gate**:
- [ ] Production deployment successful
- [ ] Monitoring shows healthy metrics
- [ ] Rollback procedure documented
- [ ] Post-deployment validation complete
- [ ] Beta rollout successful

**Owner**: DevOps + Documentation Team  
**Duration**: 2 days

---

### ✅ Phase 6: Cleanup & Optimization (2 days)
**Original Plan**: Remove obsolete code, optimize (2 days)  
**No major changes**

**Tasks**:
- [ ] Remove obsolete code (rate limiting, bulk data import if not needed)
- [ ] Clean up unused SQLite tables/indexes
- [ ] Optimize caching strategy
- [ ] Add metrics for microservice response times
- [ ] Monitor and tune performance

**Quality Gate**:
- [ ] No dead code remaining
- [ ] Performance optimizations verified
- [ ] Metrics collection working
- [ ] Documentation updated

**Owner**: Backend Team  
**Duration**: 2 days

---

## Timeline Summary

| Phase | Duration | Cumulative |
|-------|----------|------------|
| 0: OpenAPI Setup | 3 days | 3 days |
| **0.5: Contract Testing** | 1-2 days | 4-5 days |
| 1: Infrastructure | 3 days | 7-8 days |
| **1.5: Test Infrastructure** | 2-3 days | 9-11 days |
| 2: Server Migration | 5.5 days | 14.5-16.5 days |
| 3: Client Migration | 4 days | 18.5-20.5 days |
| **3.5: Integration & Performance** | 2 days | 20.5-22.5 days |
| 4: Testing & Validation | 3.5 days | 24-26 days |
| **4.5: Electron Testing** | 0-3 days | 24-29 days |
| 5: Deployment | 2 days | 26-31 days |
| 6: Cleanup | 2 days | 28-33 days |

**Total**: 28-33 days ≈ **5-6.5 weeks**

---

## Risk Assessment & Acceptance

### ✅ Mitigated Risks (Now LOW)
- ✅ **Type mismatches** → Contract testing (Phase 0.5)
- ✅ **Integration failures** → Dedicated test infrastructure (Phase 1.5, 3.5)
- ✅ **Broken CI/CD** → Pipeline updates (Phase 1)
- ✅ **Undefined architecture** → Electron decision moved to Phase 0
- ✅ **Silent failures** → Comprehensive error scenario testing (Phase 4)

### ⚠️ Accepted Risks (MEDIUM, with Manual Fallbacks)
- ⚠️ **Performance regressions**: Manual baseline capture if k6 automation is complex
  - *Mitigation*: Manual perf testing in Phase 4, post-launch automation
- ⚠️ **Electron edge cases**: Manual cross-platform testing if Phase 4.5 cut
  - *Mitigation*: Comprehensive manual checklist, beta testing with Electron users
- ⚠️ **Complex debugging**: Limited observability initially
  - *Mitigation*: Add logging in Phase 1, defer tracing to post-launch

### ✅ Unacceptable Risks (MUST Mitigate)
- ❌ No contract testing → **MITIGATED** (Phase 0.5 added)
- ❌ No integration testing → **MITIGATED** (Phase 1.5 added)
- ❌ Broken builds → **MITIGATED** (CI/CD updates in Phase 1)

**Overall Risk Level**: MEDIUM-HIGH → **LOW** ✅

---

## Immediate Action Items

### This Week (Before Phase 0)
1. [ ] **Architecture Team**: Decide Electron strategy (recommend Option A: bundled binary)
2. [ ] **DevOps**: Confirm capacity for docker-compose.test.yml setup (affects Phase 4.5)
3. [ ] **Backend**: Choose contract testing tool (recommend Dredd)
4. [ ] **QA**: Expand Phase 4 manual checklist with specific error scenarios from assessment
5. [ ] **All**: Read full assessment in `QA_MIGRATION_ASSESSMENT.md`

### Next Week (Phase 0 Kickoff)
6. [ ] Schedule kickoff meeting with Architecture, DevOps, Backend, QA
7. [ ] Update project timeline with new phases
8. [ ] Assign phase owners
9. [ ] Capture performance baseline (for comparison in Phase 3.5)
10. [ ] Set up contract testing framework

---

## Quality Gates Checklist

### ✅ Phase 0 Gate
- [ ] OpenAPI spec validates
- [ ] TypeScript client generates
- [ ] Electron strategy decided and documented

### ✅ Phase 0.5 Gate
- [ ] All contract tests pass
- [ ] CI runs contract tests automatically

### ✅ Phase 1 Gate
- [ ] Config env vars work
- [ ] Feature flag system works
- [ ] CI/CD pipeline updated and tested

### ✅ Phase 1.5 Gate
- [ ] Docker Compose test environment works
- [ ] Integration tests run in CI

### ✅ Phase 2 Gate
- [ ] All server unit tests pass
- [ ] Integration tests pass
- [ ] Data migration validated

### ✅ Phase 3 Gate
- [ ] All client unit tests pass
- [ ] All E2E tests pass
- [ ] Type safety validated

### ✅ Phase 3.5 Gate
- [ ] All integration tests pass
- [ ] Performance within 10% of baseline (manual OK)
- [ ] Rollback verified

### ✅ Phase 4 Gate
- [ ] Manual test checklist complete
- [ ] All error scenarios tested
- [ ] Performance validated

### ✅ Phase 4.5 Gate (if executed)
- [ ] Electron builds on all platforms
- [ ] Core functionality works in Electron

### ✅ Phase 5 Gate
- [ ] Production deployment successful
- [ ] Beta rollout successful (10% users)
- [ ] Monitoring shows healthy metrics

---

## Recommended Rollout Strategy

### Week 1-2: Internal Testing
- Feature flag: **OFF for users, ON for team**
- Validate: Core functionality, error handling, performance

### Week 3: Beta Rollout
- Feature flag: **ON for 10% of users** (random selection)
- Monitor: Response times, error rates, cache hit rates
- Feedback: Collect user reports

### Week 4: Full Rollout
- Feature flag: **ON for 100% of users** (if beta successful)
- Monitor: All metrics, ready to rollback if issues
- Success criteria: P95 < baseline + 10%, error rate < 1%, no critical bugs

### Rollback Plan
- **Immediate**: Toggle feature flag OFF (reverts to SQLite)
- **1-hour**: Validate all users back to SQLite
- **24-hour**: Investigate, fix, prepare for re-deployment

---

## Tools & Technologies

### Contract Testing
- **Tool**: Dredd (recommended for simplicity)
- **Alternative**: Schemathesis (more powerful, steeper learning curve)

### Integration Testing
- **Tool**: Docker Compose + Vitest
- **Alternative**: Testcontainers

### Performance Testing
- **Tool**: k6 (if automating)
- **Fallback**: Manual testing with browser DevTools + server logs

### Mocking
- **Tool**: MSW (Mock Service Worker) for browser tests
- **Alternative**: json-server for simple REST mocking

---

## Success Criteria

### Technical Success
- ✅ All contract tests pass
- ✅ All integration tests pass in CI
- ✅ All E2E tests pass
- ✅ Performance within 10% of baseline
- ✅ Error scenarios handled correctly
- ✅ Rollback procedure tested and works

### Business Success
- ✅ Beta users report no major issues
- ✅ P95 response time improves or stays same
- ✅ Cache hit rate improves (Rust microservice faster)
- ✅ No production incidents during rollout
- ✅ Successful deployment to 100% of users

---

## Appendix: Decision Log

| Decision | Made By | Rationale | Date |
|----------|---------|-----------|------|
| Add Phase 0.5 (Contract Testing) | project-orchestrator | Prevents type mismatches (critical) | 2024 |
| Add Phase 1.5 (Test Infrastructure) | project-orchestrator | Enables integration testing (critical) | 2024 |
| Add Phase 3.5 (Integration) | project-orchestrator | Validates full stack (critical) | 2024 |
| Make Phase 4.5 conditional | project-orchestrator | Manual Electron testing acceptable fallback | 2024 |
| Downgrade perf automation to P1 | project-orchestrator | Manual testing acceptable if needed | 2024 |
| Move Electron decision to Phase 0 | build-qa-lead | Blocks architecture decisions | 2024 |
| Recommend bundled binary (Option A) | project-orchestrator | Simplest Electron strategy | 2024 |
| Use feature flag for rollout | project-orchestrator | Safe phased deployment | 2024 |

---

## Appendix: Resource Requirements

| Phase | Team | Capacity Needed | Critical? |
|-------|------|-----------------|-----------|
| 0 | Backend | 3 days | ✅ Yes |
| 0 | Architecture | 0.5 days (decision) | ✅ Yes |
| 0.5 | Backend + QA | 1-2 days | ✅ Yes |
| 1 | Backend + DevOps | 3 days | ✅ Yes |
| 1.5 | DevOps + QA | 2-3 days | ✅ Yes |
| 2 | Backend | 5.5 days | ✅ Yes |
| 3 | Frontend | 4 days | ✅ Yes |
| 3.5 | QA + Backend | 2 days | ✅ Yes |
| 4 | QA | 3.5 days | ✅ Yes |
| 4.5 | Electron + QA | 0-3 days | ⚠️ Conditional |
| 5 | DevOps + Docs | 2 days | ✅ Yes |
| 6 | Backend | 2 days | ✅ Yes |

**Critical Path**: 0 → 0.5 → 1 → 1.5 → 2 → 3 → 3.5 → 5

---

## Next Steps

1. **Schedule kickoff meeting** (this week)
2. **Confirm resource availability** (DevOps for Phase 1.5, 4.5)
3. **Begin Phase 0** (OpenAPI + Electron decision)
4. **Set up contract testing** (Phase 0.5 prep)
5. **Capture performance baseline** (before Phase 2)

---

**Status**: ✅ APPROVED  
**Confidence**: HIGH  
**Ready to Execute**: YES  

**Full Assessment**: See `QA_MIGRATION_ASSESSMENT.md` (24KB detailed analysis)  
**Quick Reference**: See `QA_ACTION_ITEMS.md` (executive summary)  
**This Document**: Authoritative migration plan with QA + orchestrator decisions

**Project-orchestrator Decision**: "Your assessment was excellent. We're adopting 80% of your recommendations with pragmatic adjustments for timeline. Let's proceed with the modified plan."
