# Client state, imports, persistence and sharing

Source: `518787ecdb74c827731724b83ba62358b26b4acb`. Static review, no tests or runtime benchmarks. High findings concern data integrity or lifecycle failures; complexity estimates describe source operations, not measured time. T = all database cards, P = cards in one project, N = input cards, U = user images.

## C01 — High: Concurrent enrichment can assign a response to the wrong card

Evidence: `client/src/hooks/useCardEnrichment.ts:152-184`, `:189-211`, `:258-270`.

Parallel IndexedDB probes push cache misses into cardsToFetch in completion order. The request follows that order, but the response remapping walks the original batch order. Out-of-order probes can bind another card's metadata, DFC faces and art to a UUID. Both current and corrected work are O(N); this is an ordering defect in existing concurrency.

Return probe results from Promise.all in input order, or bind responses to cardsToFetch UUIDs explicitly. Validate with reversed deferred cache-read completion, mixed hits/misses, invalid response rows, and distinct DFC metadata. Parent re-read confirmed the mismatched order mechanism.

## C02 — High: Enrichment scans every project and creates backs without projectId

Evidence: `client/src/hooks/useCardEnrichment.ts:103-125`, `:459-483`, `:565-609`; caller `client/src/pages/ProxyBuilderPage.tsx:404-406`.

The query reads all cards, and the synthesized DFC back omits projectId. Scope work to the captured project and copy that ID to every new card. Fence writes against cancellation/project switches and validate linked faces together. This changes O(T) scans to O(P) plus indexed query overhead and prevents invisible/unscoped backs. Test A/B projects and switching during deferred enrichment. Parent verified both the global read and missing field.

## C03 — High: Direct-import completion precedes persistence completion

Evidence: `client/src/helpers/ImportOrchestrator.ts:101-117`, `:150-369`; `client/src/hooks/useCardImport.ts:44-82`.

executeDirect adds placeholders and launches void updateCardsWithImages, so process can announce onComplete while image/metadata/back-card writes remain outstanding. Stream cancellation is not carried through the direct background path. Clear/cancel/switch can therefore be followed by stale writes and refcount updates.

Keep immediate placeholders as an explicit intermediate phase; own and await resolution before terminal success, with abort/project/generation checks immediately before transactional writes. A reusable import operation should expose progress, result, cancellation and settled completion rather than orphan work. Validate delayed direct MPC/local import, abort/clear/switch, no late writes and no early terminal callback.

## C04 — High: Linked-back refcounts have multiple owners

Evidence: `client/src/helpers/cardConverter.ts:39-45`, `:112-128`; `client/src/helpers/dbUtils.ts:1247-1360`; `client/src/helpers/ImportOrchestrator.ts:217-250`, `:278-286`, `:324-351`.

Back-image creation already reserves references and linking increments them again. Existing-back update logic also increments the new image even when old and new image IDs are equal (`dbUtils.ts:1291-1308`), while the decrement is conditional on an actual change. Repeated no-op relinking can inflate counts. Cache entries may survive deletion of all actual users.

Define one transactional ownership rule for image creation versus card attachment. Aggregate signed deltas per image and skip same-image reassignment. Test quantity-one/multiple DFC imports through each path, repeated same-back assignment, undo/delete, and equality of stored refCount to actual referencing-card count. Cardbacks remain explicitly outside reference counting. Parent checked converter reservation, direct-import reservation, and unconditional increment.

## C05 — High: Bulk duplicate and bleed updates cross project boundaries

Evidence: `client/src/helpers/undoableActions.ts:297-407`, `:789-854`; `client/src/hooks/usePageViewHotkeys.ts:137-142`; `client/src/components/CardEditorModal/ArtworkBleedSettings.tsx:160-170`, `:211-233`.

Duplicate reads/reorders global cards, shared-image bleed scope queries globally, and same-name UI lookup collects UUIDs from every project. Constrain mutation repositories to an explicit project ID and reject mixed-project inputs. Keep linked pairs atomic. O(T) read/write work becomes O(P) for duplicate; image/name targeting should use project-scoped candidate sets or compound indexes. Test projects sharing name/image with byte-identical unaffected project records. See U01 for another independent instance of this isolation defect.

## C06 — High: Automatic backup's change signal misses actual content changes

Evidence: `client/src/hooks/useAutoBackup.ts:110-125`, `:167-190`.

The fingerprint is card count plus JSON settings string length. Reorders, overrides, link/artwork changes and equal-length settings changes leave it unchanged. JSON serialization itself costs O(settings bytes); the fingerprint is neither a content hash nor a complete mutation signal.

Maintain a per-project revision transactionally across all exported-data mutations for O(1) signal comparison, or compute a canonical O(P + settings bytes) digest. Preserve debounce but schedule pending dirty revisions after rate-limit/in-flight skips. Test each mutation after an initial successful backup; assert the next uploaded payload contains it. Parent reconfirmed fingerprint and early-return logic.

## C07 — Medium: Backup import validates only its envelope and writes images outside the project transaction

Evidence: `client/src/helpers/projectBackup.ts:227-254`, `:282-344`.

Envelope validation/casting does not establish complete project/card/link/user-image validity. Images are written before the transaction that creates project/cards; later failure can leave orphan blobs. Validate schema, UUID/link consistency, base64 and decoded-size/card-count limits before allocating/writing. Use bulkGet/bulkPut for deduplicated images and one appropriately bounded transaction covering the import's database effects. Work stays O(U + N); reduce O(U) serialized DB calls to batched calls. Test malformed/missing fields and injected mid-import failure with zero persisted partial project state.

## C08 — Medium: Share DFC serialization is quadratic

Evidence: `client/src/helpers/shareHelper.ts:279-347`, especially `:318-321`.

A find over cards inside the DFC pass is O(N²) worst case. Build a UUID-to-card Map alongside the existing UUID-to-output-index map, reducing lookup work to expected O(N) with O(N) additional memory. Preserve front-first ordering, skipped uploads and DFC indices. Validate exact payload equivalence on mixed/DFC-heavy fixtures and operation-count growth. Parent verified nested lookup.

## C09 — Medium: Append-order allocation depends on unrelated projects

Evidence: `client/src/helpers/dbUtils.ts:400-421`; `client/src/helpers/streamCards.ts:115-120`; `client/src/db.ts:660-680`.

Global orderBy(order).last() couples a project's order space to other projects. Query a project-scoped maximum, preferably via a migrated [projectId+order] index, and serialize reservation with insertion if concurrent appends must be unique. This is indexed lookup/scope work, not an O(N²) to O(N) claim. Preserve explicit import order and linked-face ordering. Test widely different project orders and concurrent appends.

## C10 — Medium: Refcount merge performs another avoidable quadratic lookup

Evidence: `client/src/helpers/dbUtils.ts:1313-1339`.

For every incremented image, imageUpdates.find scans an expanding update array. With M distinct image IDs this is O(M²) worst case. Build one Map<imageId, signedDelta>, apply once to loaded images, then materialize updates: expected O(M + number of card links). Fold same-image no-ops into this calculation (C04). Test swaps, shared images, no-ops, and exact final refcounts; count map operations on large batches. This additional finding was identified during parent verification.

## Existing strengths and useful reusable seams

Project-scoped UI reads already exist in ProxyBuilderPage:298-303. dbUtils addRemoteImages:139-210 and basic-land deletion:939-1027 demonstrate bulk/transaction patterns worth reusing. ImportOrchestrator snapshots settings and cleans managed stream controllers. useCardImport has a generation guard for surfaced errors. useFilteredAndSortedCards:30-37 uses a UUID map. projectBackup:202-217 revokes download URLs and remaps imported links; shareHelper:590-613 uses SHA-256. Reuse these policies through project-scoped repositories and operation objects rather than creating a framework around all components.

## Inspection coverage

Definitions/callers inspected: client db; stores cards/projectStore/indexedDbStorage/undoRedo/selection/userPreferences/settings; helpers dbUtils/undoableActions/ImportOrchestrator/streamCards/cardConverter/importParsers/importSession/importResult/importConfig/tokenImportHelper/sortAndFilterUtils/projectBackup/shareHelper/mpcImportIntegration/mpcCalibrationImport; hooks useCardImport/useCardEnrichment/useFilteredAndSortedCards/useShareUrl/useAutoBackup/usePageViewHotkeys; ProxyBuilderPage, PageView, ArtworkBleedSettings and DecklistUploader. Tests/call sites were searched, not executed.
