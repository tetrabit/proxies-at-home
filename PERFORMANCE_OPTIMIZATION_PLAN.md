# Query Performance Optimization Plan

## Problem Statement
Broad queries like `c:red` (6704 results) take 41+ seconds because the microservice:
1. Fetches ALL matching cards from database
2. Paginates in memory (returns only 50 cards)
3. Discards the rest

**Current behavior:**
- User requests: Page 1 (50 cards)
- Microservice fetches: ALL 6704 cards
- Efficiency: ~1% (using 50 of 6704 fetched cards)

## Root Cause
The microservice's pagination happens in memory AFTER fetching all results:

```rust
// Current approach (src/api/handlers.rs)
let cards = state.cache_manager.search(&params.q, params.limit).await?; // Fetches ALL
let total = cards.len();
let start = (page - 1) * page_size;
let paginated_cards = cards[start..end].to_vec(); // Paginate in memory
```

## Solutions

### Solution 1: Database-Level Pagination ⭐ RECOMMENDED
**Impact:** 95% faster for broad queries (41s → <2s)
**Effort:** Medium (4-6 hours)
**Tradeoffs:** Need COUNT query for total (adds ~100ms)

**Implementation:**
1. Add pagination parameters to `QueryExecutor::execute()`
2. Use SQL LIMIT/OFFSET for page fetching
3. Add separate COUNT query for total results
4. Update handler to pass pagination info

```rust
// New approach
pub async fn execute_paginated(
    &self, 
    query: &str, 
    page: usize, 
    page_size: usize
) -> Result<(Vec<Card>, usize)> {
    // 1. COUNT query (fast - no data transfer)
    let total = self.count_matches(query).await?;
    
    // 2. LIMIT/OFFSET query (only fetches requested page)
    let offset = (page - 1) * page_size;
    let sql = format!(
        "SELECT * FROM cards WHERE {} ORDER BY name LIMIT {} OFFSET {}",
        where_clause, page_size, offset
    );
    let cards = self.db.execute_raw_query(&sql, &params).await?;
    
    Ok((cards, total))
}
```

**Performance gains:**
- Page 1 of `c:red`: 41s → 1-2s (20x faster)
- Page 2 of `c:red`: 41s → 1-2s (no penalty for later pages)
- Narrow queries: No change (already fast)

### Solution 2: Smart Default Limits ✅ IMPLEMENTED
**Impact:** 70% faster for queries with >1000 results
**Effort:** 5 minutes
**Tradeoffs:** Users can't see results beyond 1000

**Status:** Already implemented with `limit=1000` in test page.

**Results:**
- `c:red` without limit: 41s (6704 cards)
- `c:red` with limit=1000: 11s (1000 cards)
- Still slow because fetching 1000 cards when only need 50

### Solution 3: Progressive/Chunked Loading
**Impact:** Better UX (shows results immediately)
**Effort:** High (8-12 hours)
**Tradeoffs:** Complex client logic, multiple requests

**Implementation:**
```javascript
// Fetch first page immediately
const page1 = await fetchPage(1);
displayResults(page1);

// Fetch additional pages in background
for (let i = 2; i <= estimatedTotalPages; i++) {
    fetchPage(i).then(page => cacheInBackground(page));
}
```

**Note:** This only improves perceived performance, not actual query speed.

### Solution 4: Database Indexes
**Impact:** 30-50% faster queries overall
**Effort:** Low (1-2 hours)
**Tradeoffs:** Larger database size (+10-20%)

**Indexes to add:**
```sql
CREATE INDEX idx_cards_colors ON cards(colors);
CREATE INDEX idx_cards_color_identity ON cards(color_identity);
CREATE INDEX idx_cards_cmc ON cards(cmc);
CREATE INDEX idx_cards_type_line ON cards(type_line);
CREATE INDEX idx_cards_name ON cards(name);
CREATE INDEX idx_cards_set ON cards(set_code);
```

**Expected gains:**
- `c:red` query: 11s → 5-7s
- `t:creature` query: 60s+ → 20-30s
- Complex queries: Variable improvements

### Solution 5: Query Result Caching
**Impact:** Instant for repeated queries
**Effort:** Low (already partially implemented)
**Tradeoffs:** Stale data for popular queries

**Current:** Server-side caching with TTL
**Enhancement:** Add query result caching in microservice with smart invalidation

## Recommended Implementation Order

### Phase 1: Quick Wins (Already Done ✅)
- [x] Add default limit=1000 to test page

### Phase 2: Database-Level Pagination (NEXT - Highest Impact)
- [ ] Add `count_matches()` method to QueryExecutor
- [ ] Modify `execute()` to support LIMIT/OFFSET
- [ ] Update handlers to use new pagination
- [ ] Test with broad queries
- [ ] Expected: 20x performance improvement

### Phase 3: Database Indexes (Complementary)
- [ ] Add indexes for common query fields
- [ ] Benchmark before/after
- [ ] Expected: 2-3x additional improvement

### Phase 4: Advanced UX (Optional)
- [ ] Implement progressive loading in test page
- [ ] Add loading indicators
- [ ] Show partial results while fetching

## Performance Targets

| Query Type | Current | After Phase 2 | After Phase 3 |
|------------|---------|---------------|---------------|
| Broad (c:red, 6704 results) | 41s | 2s | 1s |
| Medium (t:creature c:red, 1000 results) | 15s | 1s | 0.5s |
| Narrow (specific card name, <10 results) | <1s | <0.5s | <0.3s |
| Paginated (page 10 of broad query) | 41s | 2s | 1s |

## Testing Checklist

After implementing Phase 2:
- [ ] Test broad queries (c:red, t:creature)
- [ ] Test pagination (page 1, page 10, page 100)
- [ ] Test narrow queries (still fast?)
- [ ] Test complex queries (multiple filters)
- [ ] Benchmark with and without indexes
- [ ] Verify total counts are accurate
- [ ] Check memory usage (should be lower)

## Alternative: Just Use Scryfall API for Broad Queries

If implementation effort is too high, we could:
- Detect "broad" queries (estimated >1000 results)
- Route them to Scryfall API instead of microservice
- Keep microservice for specific card lookups

**Pros:** Zero implementation, leverages Scryfall's optimized infrastructure
**Cons:** Rate limited (10/sec), network latency, defeats purpose of microservice
