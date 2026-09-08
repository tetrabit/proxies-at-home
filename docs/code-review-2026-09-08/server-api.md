# Server APIs, caches and shared client

Source: `518787ecdb74c827731724b83ba62358b26b4acb`. Static review only; no server, adversarial request, tests or benchmark run. Exposure depends on deployment/network policy; source-level missing boundaries are not claims about a particular live deployment.

## S01 — High: Direct Scryfall requests do not share one rate/concurrency policy

Evidence: `server/src/utils/scryfallCatalog.ts:37-43`; callers `server/src/index.ts:25-26`, `server/src/services/importScheduler.ts:101-106`; `server/src/routes/scryfallRouter.ts:28-38`, `:125-127`, `:188-190`, `:368-370`; `server/src/utils/getCardImagesPaged.ts:37-48`, `:169-172`; `server/src/utils/tokenLookup.ts:50-66`; `server/src/services/bulkDataService.ts:29-34`; `server/src/routes/imageRouter.ts:343-370`.

Catalogs explicitly fan out nine direct requests. Other paths have distinct clocks/limiters; some reserve timestamps without owning the physical request lifecycle. The enrichment fallback can invoke multiple searches concurrently. Local limiter correctness is insufficient when other modules bypass it.

Create one direct-Scryfall broker owning every physical request and retry: FIFO, concurrency one, at least 100ms between dispatches. Keep its lease through settlement under the repository's no-parallel-direct-call rule. Batch supported identifiers before queueing. Microservice/CDN work may use separate bounded policies. Validate fake-clock mixed callers, retries and aborts: max one active direct request and minimum spacing. Do not optimize this by increasing direct-request parallelism.

## S02 — High: Image proxy permits unrestricted server-side requests and full-response buffering

Evidence: `server/src/routes/imageRouter.ts:465-475`, `:517-538`; image limiter `:97-98`.

User-supplied URL reaches the network client without an origin/private-address/redirect policy. Relative URLs are explicitly routed to localhost. Content-Type is checked only after arraybuffer reception; an image concurrency count does not cap response bytes. This enables SSRF wherever an untrusted caller can reach the route and creates memory-exhaustion risk.

Use a provider-specific HTTPS origin allowlist, enforce scheme/port/userinfo/address rules at actual connection/redirect time, and protect against DNS rebinding. Allow only explicitly intended internal relative routes, not arbitrary loopback paths. Stream with per-response/global byte limits to a temporary file, validate content and atomically publish. Test prohibited private/link-local/metadata targets and redirect/DNS edge cases with zero forbidden transport; oversized data must not leave a cache file. Parent verified direct URL-to-fetch path and post-buffer validation.

## S03 — High, deployment-dependent: Private mutable APIs have no application authentication

Evidence: `server/src/index.ts:80-83`, `:193-211`; `server/src/routes/backupRouter.ts:21-66`, `:77-146`, `:157-175`; `server/src/routes/printerCalibrationRouter.ts:486-556`, `:587-645`.

The application binds all interfaces and mounts backup/preferences/calibration/metrics routes without an authentication boundary. No-Origin requests pass CORS; CORS is not authorization. A reachable untrusted client can enumerate backup identifiers and retrieve/mutate data or request calibration work unless an external gateway supplies protection.

Bind loopback by default in desktop mode; make remote exposure explicit. Server mode needs authenticated owner/project authorization or scoped capabilities on private routes. Separate public sharing from private backups. Verify unauthenticated and cross-project denial, authorized success, and desktop bind address. Do not assume an external reverse proxy exists or is absent in a deployment not inspected.

## S04 — High: Calibration upload admission lacks a realistic aggregate resource bound

Evidence: `server/src/routes/printerCalibrationRouter.ts:380-393`, `:630-639`; `server/src/index.ts:201`; test `server/src/routes/printerCalibrationRouter.test.ts:110-112`.

A disk-backed multipart upload permits 10 GiB per request, with no corresponding aggregate admission guarantee. Concurrent/interrupted uploads can pressure temporary storage and subprocess memory. This is the server admission side of P03, not a separate measured memory incident.

Select a product-validated byte/page limit (repository guidance says ordinary uploads are 10MB; high-DPI PDF needs must be measured before imposing that blindly), authenticate, cap aggregate temp bytes/concurrency, and clean abort/error paths. Validate over-limit rejection, disconnect cleanup and concurrent quota handling. Do not parallelize unbounded PDF subprocesses.

## S05 — Medium: SQL row conversion drops card identity

Evidence: `server/src/db/db.ts:197-223`; `server/src/db/proxxiedCardLookup.ts:265-306`; `server/src/utils/getCardImagesPaged.ts:255-280`; `server/src/utils/tokenLookup.ts:137-155`; caller `server/src/routes/imageRouter.ts:401-456`.

Rows contain id/oracle_id, but rowToScryfallCard omits them. Cache-hit consumers lose identity aliases and latest-token oracle resolution. Preserve identity in a shared cache DTO conversion contract; include release metadata if recency parity requires it. Test database round-trip parity and latest oracle-matched token resolution on cache hits versus network data.

## S06 — Medium: Import/metadata input is unbounded and token fallback misses batching opportunities

Evidence: `server/src/utils/cardUtils.ts:15-24`; `server/src/routes/streamRouter.ts:167-174`, `:191-269`, `:291-332`; `server/src/utils/tokenLookup.ts:320-347`; batch support `server/src/utils/getCardImagesPaged.ts:322-511`.

Every input element can create validation/resolution work and long-lived stream activity. Per-token fallback is serialized and can make multiple direct requests per token. Validate cardinality/field lengths/languages at admission, deduplicate identifiers, batch supported lookups, and bound request duration/queue residency. Retain ordered SSE completion, client disconnect cancellation and no SSE compression.

Data processing remains O(N); U unique identifiers with batch size B can reduce physical lookup calls toward O(ceil(U/B)) before unavoidable fallbacks. Test duplicate-heavy input, maximum cardinality, direct-call counts and cancellation through the shared broker.

## S07 — Medium: Shared client's configured timeout is unused

Evidence: `shared/scryfall-client/index.ts:20-22`, `:33-47`; `server/src/services/scryfallMicroserviceClient.ts:20-25`; health-first routes `server/src/routes/scryfallRouter.ts:115-127`, `:173-190`; `server/src/index.ts:175-190`.

The timeout field is accepted but request does not implement it. RequestInit is spread, so an explicitly supplied caller signal DOES pass through; the defect is the absent configured timeout and missing guaranteed cancellation from callers, not that the class strips all signals. A stalled health request can delay fallback indefinitely.

Compose the caller signal with a configured deadline, including body consumption; coalesce concurrent health checks and use a short status TTL with explicit stale/fallback policy. Validate timeout, caller abort, body stall, one in-flight health probe and recovery after an earlier failure. Parent re-read confirmed timeout omission and existing RequestInit pass-through.

## S08 — Medium: Filesystem cache eviction scans/sorts everything; miss deduplication uses a fixed sleep

Evidence: `server/src/routes/imageRouter.ts:122-168`, `:477-479`, `:503-545`.

Periodic maintenance enumerates and serially stats all files, then sorts them: O(F log F) plus O(F) filesystem calls for F entries. The per-path write guard sleeps 100ms, then may start a duplicate writer if the original is still pending. Async functions do not make serial stats concurrent or make sleeps a lock.

Track cache bytes/access metadata incrementally and evict bounded batches using an index; a one-time startup reconciliation scan may remain necessary. Await one in-flight promise per key and atomically publish files. If retaining scans initially, use bounded stat concurrency and one maintenance task at a time. Validate one upstream request for many identical misses, crash recovery, correct LRU and bounded maintenance work. Parent reconfirmed sleep guard and direct final-path write.

## Additional reuse/verification notes

batchFetchCards already combines local cache, token groups and collection batches; reuse it instead of per-route parallel fallback. deduplicatedSearch at `server/src/utils/getCardImagesPaged.ts:51-95` is an existing in-flight coalescing seam. pLimit is duplicated in `server/src/routes/imageRouter.ts:58-93` and `server/src/utils/tokenLookup.ts:158-193`; share the mechanism but keep provider policies explicit.

SQLite import transactions are already chunked (`server/src/db/proxxiedCardLookup.ts:201-216`); do not replace them with one enormous transaction or assume Promise.all parallelizes synchronous better-sqlite3 work. Moving large synchronous database/CPU jobs off Electron's main process is worth profiling, not an automatic rewrite.

SSE compression exclusion exists at `server/src/index.ts:112-128`; preserve it. Tests `server/src/utils/getCardImagesPaged_rarity.test.ts:5-12` and `server/src/utils/getCardImagesPaged_colors.test.ts:5-22` make live Scryfall calls with weak/no substantive assertions; move these into an explicit serialized contract suite or mock them. Line coverage is not evidence of rate-policy or real-native integration correctness.

## Inspection coverage

Production files under server/src db/routes/services/utils and index; server manifest/test config; shared/scryfall-client source/schema/manifest/README/tests. A reviewer also inspected ignored/generated shared-client dist, but this report bases findings on tracked source rather than treating generated bytes as commit-bound evidence. Targeted route/cache/shared-client tests inspected, not executed. Rust implementation and live reverse-proxy policy excluded.
