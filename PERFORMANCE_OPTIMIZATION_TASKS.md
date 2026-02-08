# Performance Optimization - Task Tracker

## 🎯 Sprint Goal
Reduce broad query response time from 41s → <2s via database-level pagination and indexes.

---

## 📋 Phase 1: Database-Level Pagination (CRITICAL)
**Target:** 20x speedup (41s → 2s)  
**Effort:** 4-6 hours  
**Status:** 🔴 NOT STARTED

### Task 1.1: Add COUNT Query Method ⏱️ 1hr
- [ ] **Action:** Implement `count_matches()` in microservice query executor
- [ ] **Files:** Microservice query executor (Rust/TypeScript)
- [ ] **Test:** `c:red` returns total=6704 in <200ms
- [ ] **Test:** Complex queries count accurately
- [ ] **Test:** Invalid queries error gracefully
- [ ] **Owner:** Backend Developer
- [ ] **Dependencies:** None
- [ ] **Blockers:** Need microservice codebase access

**Acceptance:**
```bash
curl "http://localhost:8080/scryfall/search?q=c:red" | jq '.total'
# Expected: 6704, response time: <200ms
```

---

### Task 1.2: Add Paginated Query Method ⏱️ 2hr
- [ ] **Action:** Implement `execute_paginated()` with LIMIT/OFFSET
- [ ] **Files:** Microservice query executor
- [ ] **Test:** Page 1 of `c:red` returns 50 cards in <2s
- [ ] **Test:** Page 10 loads in <2s (no performance penalty)
- [ ] **Test:** Last page (135) returns 4 cards
- [ ] **Test:** Beyond last page returns empty
- [ ] **Test:** Ordering consistent across requests
- [ ] **Owner:** Backend Developer
- [ ] **Dependencies:** Task 1.1 ✅

**Acceptance:**
```bash
time curl "http://localhost:8080/scryfall/search?q=c:red&page=1&page_size=50"  # <2s
time curl "http://localhost:8080/scryfall/search?q=c:red&page=50&page_size=50" # <2s
```

---

### Task 1.3: Update Search Handler ⏱️ 1hr
- [ ] **Action:** Modify `/server/src/routes/scryfallRouter.ts` to use new method
- [ ] **Files:** `/server/src/routes/scryfallRouter.ts` (lines 280-370)
- [ ] **Test:** Search endpoint passes pagination params
- [ ] **Test:** Response format unchanged (PaginatedCardData)
- [ ] **Test:** Fallback to Scryfall API still works
- [ ] **Test:** Test page functionality intact
- [ ] **Owner:** Backend Developer
- [ ] **Dependencies:** Task 1.2 ✅

**Verification:**
```bash
# Test via UI at http://localhost:3000/test
# Search "c:red" → should load in ~2s
```

---

### Task 1.4: Add Comprehensive Tests ⏱️ 2hr
- [ ] **Action:** Create test suite for pagination
- [ ] **Files:** `/tests/scryfall-microservice.test.ts`
- [ ] **Test:** Broad query <2s
- [ ] **Test:** Later pages same performance
- [ ] **Test:** Consistent ordering
- [ ] **Test:** Last page edge case
- [ ] **Test:** Beyond last page edge case
- [ ] **Test:** Complex queries work
- [ ] **Owner:** QA/Backend Developer
- [ ] **Dependencies:** Task 1.3 ✅

**Run:**
```bash
npm test -- scryfall-microservice.test.ts
```

---

## 📊 Phase 2: Database Indexes (HIGH PRIORITY)
**Target:** 2-3x additional speedup (2s → 0.5-1s)  
**Effort:** 1-2 hours  
**Status:** 🔴 NOT STARTED

### Task 2.1: Add Database Indexes ⏱️ 30min
- [ ] **Action:** Add indexes for colors, type_line, cmc, name, set
- [ ] **Files:** Microservice database migration
- [ ] **Test:** Indexes created successfully
- [ ] **Test:** Database size increase <20%
- [ ] **Test:** Index creation completes in <5min
- [ ] **Owner:** Backend Developer
- [ ] **Dependencies:** Phase 1 complete ✅

**SQL:**
```sql
CREATE INDEX IF NOT EXISTS idx_cards_colors ON cards(colors);
CREATE INDEX IF NOT EXISTS idx_cards_color_identity ON cards(color_identity);
CREATE INDEX IF NOT EXISTS idx_cards_cmc ON cards(cmc);
CREATE INDEX IF NOT EXISTS idx_cards_type_line ON cards(type_line);
CREATE INDEX IF NOT EXISTS idx_cards_name ON cards(name);
CREATE INDEX IF NOT EXISTS idx_cards_set ON cards(set_code);
```

---

### Task 2.2: Benchmark Performance ⏱️ 1hr
- [ ] **Action:** Run before/after benchmarks
- [ ] **Test:** `c:red`: 2s → <1s
- [ ] **Test:** `t:creature`: 15s → 5-7s
- [ ] **Test:** Complex queries improved
- [ ] **Test:** No regression for narrow queries
- [ ] **Owner:** QA/Backend Developer
- [ ] **Dependencies:** Task 2.1 ✅

**Benchmark queries:**
```bash
c:red
t:creature
t:creature c:red
cmc<=3 c:blue
t:instant c:black
```

---

### Task 2.3: Monitor Database Size ⏱️ 30min
- [ ] **Action:** Document size before/after
- [ ] **Test:** Size increase acceptable (<20%)
- [ ] **Owner:** DevOps/Backend Developer
- [ ] **Dependencies:** Task 2.1 ✅

---

## 🎨 Phase 3: Progressive Loading (OPTIONAL - SKIP IF <2S ACHIEVED)
**Target:** Better UX (perceived <1s)  
**Effort:** 8-12 hours  
**Status:** ⏸️ ON HOLD (Evaluate after Phase 1+2)

**Decision Point:** Only implement if:
- ✅ Phase 1+2 don't achieve <2s
- ✅ User feedback indicates poor UX
- ✅ Frontend resources available

---

## 🚀 Quick Start

### Immediate Actions
1. **Verify microservice access:** Locate query executor code
2. **Review current database schema:** Understand cards table structure
3. **Set up local test environment:** Ensure microservice running locally
4. **Run baseline benchmarks:** Document current performance

### Command Checklist
```bash
# 1. Start microservice locally
cd /path/to/microservice
cargo run --release  # or equivalent

# 2. Run test page
cd /home/nullvoid/projects/proxxied/proxies-at-home
npm run dev

# 3. Test current performance
time curl "http://localhost:8080/scryfall/search?q=c:red"
# Expected: ~41s

# 4. After Phase 1 implementation
time curl "http://localhost:8080/scryfall/search?q=c:red&page=1&page_size=50"
# Target: <2s
```

---

## 📈 Success Metrics

### Phase 1 Success Criteria
- ✅ `c:red` (6704 results) page 1: **<2s** (current: 41s)
- ✅ `c:red` page 50: **<2s** (no pagination penalty)
- ✅ Memory usage: **constant** (not proportional to total results)
- ✅ All tests passing
- ✅ No regression in narrow query performance

### Phase 2 Success Criteria
- ✅ `c:red`: **<1s** (with indexes)
- ✅ `t:creature`: **<7s** (with indexes)
- ✅ Database size: **<20% increase**
- ✅ No performance regressions

### Overall Project Success
- ✅ Broad queries: **95% faster** (41s → <2s)
- ✅ Test page usable for broad searches
- ✅ User satisfaction improved

---

## 🚨 Blockers & Dependencies

### Critical Information Needed
- [ ] **Microservice codebase location:** Where is the query executor code?
- [ ] **Database type:** SQLite, PostgreSQL, or other?
- [ ] **Deployment process:** How to deploy microservice changes?
- [ ] **Testing environment:** How to run microservice locally?

### External Dependencies
- [ ] Microservice write access
- [ ] Database migration process
- [ ] Staging environment for testing

---

## 🎯 Next Steps

1. **IMMEDIATE:** Clarify microservice architecture
   - Is it Rust-based or TypeScript/Node.js?
   - Where is the query executor implemented?
   - How to run locally?

2. **TODAY:** Begin Phase 1, Task 1.1
   - Implement COUNT query
   - Verify performance (<200ms)

3. **THIS WEEK:** Complete Phase 1
   - All 4 tasks completed
   - Benchmarks show 20x improvement

4. **NEXT WEEK:** Complete Phase 2
   - Add indexes
   - Benchmark improvements
   - Production deployment

---

## 📝 Notes

### Architecture Clarification Needed
The exploration revealed the system is **TypeScript/Node.js**, not Rust:
- **Proxy backend:** Express.js (`/server/src/routes/scryfallRouter.ts`)
- **Microservice client:** Fetch wrapper (`/shared/scryfall-client/index.ts`)
- **Microservice itself:** External service (needs clarification)

**QUESTION:** Is the microservice:
- A) External Rust service (separate codebase)?
- B) Part of this Node.js project?
- C) Third-party service?

This affects implementation approach:
- **If A:** Need access to Rust codebase for query executor changes
- **If B:** Can implement directly in TypeScript
- **If C:** Limited to client-side optimizations only

### Risk: External Microservice
If the microservice is external/third-party, Phase 1 may not be feasible. Alternative:
- Implement pagination in **proxy layer** (`scryfallRouter.ts`)
- Cache paginated results
- Add client-side page caching (Phase 3 becomes required)

**ACTION REQUIRED:** Clarify microservice ownership before proceeding with Phase 1.

---

## 📞 Contact

**Questions?** Contact project orchestrator or backend team lead.

**Blockers?** Escalate immediately - this is a critical performance issue affecting user experience.

---

## 📚 Resources

- **Full Implementation Plan:** `/PERFORMANCE_OPTIMIZATION_IMPLEMENTATION_PLAN.md`
- **Performance Analysis:** `/PERFORMANCE_OPTIMIZATION_PLAN.md`
- **Microservice Client:** `/shared/scryfall-client/index.ts`
- **Proxy Router:** `/server/src/routes/scryfallRouter.ts`
- **Test Page:** `http://localhost:3000/test`

---

**Last Updated:** 2024-01-XX  
**Status:** 🔴 Planning Complete, Implementation Not Started  
**Next Review:** After Phase 1 completion
