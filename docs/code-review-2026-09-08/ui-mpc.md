# UI, artwork selection and MPC workflows

Source: `518787ecdb74c827731724b83ba62358b26b4acb`. Static analysis only; no browser interaction or tests run. Performance recommendations identify work reductions; user-visible speedups remain unmeasured.

## U01 — High: Card editor Apply to All mutates every project

Evidence: `client/src/components/CardEditorModal/CardEditorModalWrapper.tsx:118-141`; visible action `client/src/components/CardEditorModal/CardEditorModal.tsx:395-400`; wrapper mount `client/src/components/PageView/PageView.tsx:72-75`, `:1297`.

The transaction reads db.cards.toArray and bulk-writes overrides to all records, then queues all their pre-renders. Require a captured card/current project ID and indexed project-scoped query; reject mixed-project selections. O(all cards) becomes O(project cards), also preventing unrelated image work. Test A/B projects and exact affected pre-render task IDs. Parent verified the global transaction. See C02/C05 for sibling isolation failures.

## U02 — Medium: Card editor drops async mutation results

Evidence: `client/src/components/CardEditorModal/CardEditorModal.tsx:366-400`; `client/src/components/CardEditorModal/CardEditorModalWrapper.tsx:103-171`.

Actions call asynchronous mutation callbacks without awaiting them and close immediately. Database rejection can occur after apparent success. Type callbacks as Promise<void>, await persistence, expose pending/failure UI and fence superseded operations; separate optional cache pre-render from required mutation completion. Test rejecting update/bulkPut, modal retention/error and no successful post-write work.

## U03 — Medium: Artwork search/selection can apply stale intent

Evidence: `client/src/components/ArtworkModal/ArtworkModal.tsx:163-194`, `:477-737`, `:741-789`, `:1403-1405`.

Automatic preview responses trigger first-print application, while search and Scryfall/MPC resolution paths lack a shared latest-operation fence. Older lookup/selection can finish after newer user intent. Extract an ArtworkSelectionOperation that snapshots UUID/face/project, cancels/supersedes old work and checks generation before state or DB writes. Keep provider-specific intent construction separate from common resolve/apply/link logic. Test older automatic lookup completing after a manual selection/navigation, and two selections resolving in reverse order.

## U04 — Medium: PageView source-bleed settings are not reactive dependencies

Evidence: `client/src/components/PageView/PageView.tsx:222-232`, `:823`, `:892`, `:1111`, `:1180`; existing fields `client/src/hooks/usePageViewSettings.ts:26-31`, `:65-75`.

sourceSettings reads getState inside a memo that depends only on effectiveBleedWidth. Changing source-specific bleed flags/amounts alone can leave layout/drag geometry stale. Subscribe to the relevant primitives and memoize from those values. This corrects reactive O(1) setup and intentionally triggers necessary O(N) layout work, rather than treating all recomputation as waste. Test each source setting with unchanged global bleed width.

## U05 — Medium: Drag-image URLs are owned by render-time memoization and keyed too weakly

Evidence: `client/src/components/PageView/PageView.tsx:716-742`.

The memo creates/revokes object URLs during render and keys only by image ID. Same-ID blob replacement remains stale; retained entries have no unmount disposal. Move allocation into an effect-owned URL resource manager keyed by identity/revision, clean removed/replaced/unmounted entries, and keep render pure. Test interrupted/remounted lifecycle and blob replacement with exact URL revocation. This shares the rendition identity policy in G06 but is a separate caller defect.

## U06 — Medium: Ranking repeats identical art-crop SSIM scoring

Evidence: `client/src/helpers/mpcBulkUpgradeMatcher.ts:837-876`; candidate bound `:633-665`.

Art Match and Full Process call scoreCandidatesByArtCrop with identical inputs in successive passes. Compute one scored list and derive both layers. Two linear pixel-comparison passes become one: O(2 × K × pixels) to O(K × pixels), a constant-factor improvement, NOT a different big-O class. Preserve failure/fallback behavior deliberately rather than accidentally treating the second pass as a retry. Test a counting injected comparator and exact recommendation equivalence. Parent verified both calls.

## U07 — Medium: Preference bootstrap is repeated, serial in search, unbounded in decoding

Evidence: `client/src/components/CalibrationModal/CalibrationModal.tsx:199-320`, `:256-269`; `client/src/components/MpcUpgradeModal/MpcUpgradeModal.tsx:122-152`, `:206-266`; `client/src/helpers/mpcPreferenceBootstrap.ts:353-386`; `client/src/helpers/mpcVisualPreference.ts:123-158`; `client/src/helpers/mpcCalibrationRunner.ts:79-119`.

Modal flows rebuild context; seed queries await serially, then visual profile decodes fan out without a signal/budget. Held-out evaluation repeats seed harvest/profile construction for each evaluated case even though those seed profiles do not depend on the held-out trained model.

Extract an immutable context loader keyed by dataset/source preferences, provider content revision and profile algorithm version. Coalesce builds, make transport/decode admission cancellable, and apply bounded independent MPC-query concurrency. Reuse seed-derived profiles across folds while continuing to train each fold separately; do not leak held-out labels into shared context. Bootstrap work can drop from O(cases × seeds) to O(seeds) plus per-case scoring/training. This does not make the entire leave-one-out evaluation linear.

Validate one context build across consumers/folds, invalidation when sources/data change, abort during query/decode, and fold-isolation equivalence. Parent confirmed harvest/profile build inside the held-out loop.

## U08 — Medium: MPC search cleanup cancels debounce, not in-flight results

Evidence: `client/src/hooks/useMpcSearch.ts:103-175`; `client/src/helpers/mpcAutofillApi.ts:45-103`; contrast `client/src/hooks/useScryfallSearch.ts:96-124`, `:219-225`.

Old results can overwrite a newer query and clear its loading state. Carry an optional AbortSignal through transport and add request-generation checks to every success/error/finally state write. Coalesce identical query misses with subscriber-aware cancellation so one consumer cannot abort another's shared request. Validate A-after-B completion, unmount, cache hits/misses and independent subscriber abort.

## U09 — Low: Batch MPC caching still performs serial per-query database calls

Evidence: `client/src/helpers/mpcAutofillApi.ts:121-135`, `:162-172`; existing cache schema `client/src/db.ts:475-489`.

O(Q) cache operations are serialized around one network batch. Normalize/deduplicate with a Set, bulkGet compound keys, and bulkPut validated results transactionally. Data work stays O(Q); round trips fall to bounded batch calls, not constant total data cost. Test duplicate/normalized queries, original result mapping and operation counts on a large batch.

## U10 — Low: CardGrid overwrites its merged style

Evidence: `client/src/components/common/CardGrid.tsx:22-35`; callers `client/src/components/ArtworkModal/ArtworkTabContent.tsx:196`, `client/src/components/CalibrationModal/CalibrationModal.tsx:596`.

Spreading props after computed style lets a caller style replace --card-grid-col-width, defeating cardSize. Destructure style and merge once after remaining props. Test cardSize with an unrelated background style. This is a concrete reusable primitive contract bug, not a formatting preference.

## U11 — Medium: Multi-drag restoration derives orders with quadratic searches

Evidence: `client/src/components/PageView/PageView.tsx:583-596`.

Each newLocalCards entry searches originalLocalCards. Build Map<uuid, originalOrder> once and derive adjustments in one pass: expected O(N) instead of O(N²), with O(N) memory. Preserve all-card restoration semantics for one-step undo. Validate exact adjustment equivalence, large-deck lookup counts and linked/project invariants. Parent verified nested lookup.

Additional lifecycle note: delayed drag work at `client/src/components/PageView/PageView.tsx:496-519`, `:529-532` lacks clear unmount/cancel ownership. Retain timer handles and cancel them as part of the drag operation; use fake timers to verify no late state write.

## Inspection coverage

PageView, CardGrid, ArtworkModal/ArtworkTabContent/AdvancedSearch, CardEditorModal/wrapper, CalibrationModal, MpcUpgradeModal, UploadSection, ProxyBuilderPage; search/filter/page-view hooks; MPC API/cache/upgrade/matcher/layer-adapter/calibration runner/compare/storage/bootstrap/model/visual-profile helpers; layout and db; relevant UI and MPC tests. Existing virtualization, source adapters, generation guards in parts of MPC upgrade, and Scryfall abortable search are useful patterns to reuse. No test or runtime success is asserted.
