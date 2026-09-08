# Image processing, rendering and export

Source: `518787ecdb74c827731724b83ba62358b26b4acb`. Static inspection only; no real GPU export, benchmark or memory profile. G02 is explicitly a concurrency hypothesis requiring browser validation, not confirmed image corruption.

## G01 — High: Cancel/teardown strands active processing promises

Evidence: `client/src/helpers/imageProcessor.ts:97-99`, `:230-244`, `:307-326`; caller `client/src/hooks/useImageProcessing.ts:405-421`, `:558-560`, `:607-611`.

allTasks contains queued tasks only; active task resolvers live in worker callbacks. Cancellation terminates workers without rejecting their active promises. Callers waiting on process cannot reach finally cleanup, including URL revocation. destroy also clears queued tasks without settling them.

Track active ownership per worker, reject queued and active tasks exactly once on cancel/destroy, and fence late messages. Validate cancellation after dispatch but before response, all promises settled, zero activity and URL cleanup. Parent verified queue-only getter and lifecycle paths.

## G02 — Medium, needs runtime validation: Concurrent renders share one context without an explicit lease

Evidence: `client/src/helpers/cardCanvasWorker.ts:105-106`, `:457-586`; ZIP `client/src/helpers/exportImagesZip.ts:99-103`, `:165-180`; PDF `client/src/helpers/pdf.worker.ts:625-627`, `:795-800`, `:987-997`.

Each realm uses a module-level effectContextManager; multiple operations reuse its canvas/context, yield at convertToBlob, then clean per-render GL resources. The async export callers can overlap these lifetimes. However, asynchronous encoding does NOT alone prove that output is corrupted: OffscreenCanvas conversion can snapshot pixels before asynchronous encoding. Workers also have separate realms, not one global cross-worker context. The child review's stronger corruption claim is therefore not accepted without runtime evidence.

Establish/document an exclusive context lease or prove the snapshot/resource lifetime contract with real-browser tests before adding serialization. A bounded context pool is an option if measurements justify it. Independently, shaders/program/VAO are rebuilt per render (`:469-550`); cache immutable per-context pipeline resources and dispose on context loss to reduce compilation/allocation overhead. Work stays linear in rendered pixels; this targets constants and lifecycle safety.

Validate alternating dimensions/colors under delayed conversion with actual browser pixels; verify output attribution, resource counts and performance before/after any mutex/pool. Do not infer native canvas corruption from a mock that invents deferred snapshot semantics.

## G03 — High: Effect pre-rendering allocates pixels before bounded admission

Evidence: `client/src/helpers/effectCache.ts:189-220`, `:376-385`; callers `client/src/components/CardEditorModal/CardEditorModalWrapper.tsx:126-168`, `client/src/pages/ProxyBuilderPage.tsx:662-686`.

Bulk pre-render launches each operation immediately; bitmap decode/canvas/ImageData allocation precede worker-queue admission. Per-card tasks also duplicate work for identical images/renditions. A bounded worker count is not a bound on already-decoded buffers.

Queue lightweight descriptors first; admit by worker slot AND pixel/byte budget before decoding. Coalesce in-flight work by image revision, DPI and canonical overrides, retaining per-subscriber cancellation. For N copies of U unique renditions, render work can fall from O(N × pixels) to O(U × pixels), plus O(N) lookup/notification work. Validate deferred decode counts, one render per shared key, superseded-generation rejection and bounded resident buffers.

## G04 — High: PDF fan-out and canvas retention lack a byte budget

Evidence: `client/src/helpers/exportProxyPageToPdf.tsx:166-168`, `:280-326`; `client/src/helpers/pdf.worker.ts:22-23`, `:456`, `:533-536`, `:625-627`, `:1025-1035`.

Worker count follows CPU hardware concurrency while each worker allocates a full page canvas, prepares multiple cards and retains a canvasCache without byte/count eviction. Page tasks carry the complete imagesById map rather than a page subset. Blob structured cloning need not copy every underlying byte, but unnecessary full-map transport still increases serialization/reference retention; do not equate payload size with proven byte duplication.

Choose concurrency from a conservative page/card/effect working-set budget, not CPU count alone. Send only page assets; use byte-accounted LRU/clear-at-chunk lifecycle for canvasCache. Validate high-DPI/large-paper/long exports for bounded workers, decoded surfaces and cache bytes, plus deterministic page order and cleanup on all outcomes. This is memory/constant-factor reduction, not making pixel processing sublinear.

## G05 — Medium: Concurrent ZIP completion changes suffixes and insertion order

Evidence: `client/src/helpers/exportImagesZip.ts:127-180`, `:198-207`.

usedNames suffix allocation and zip.file calls happen after asynchronous image work. Duplicate-name suffixes and entry ordering therefore depend on completion timing. Precompute names in input order, render with bounded concurrency, store results by input index, then insert deterministically. This stays O(N) bookkeeping and retains parallel preparation. Validate reverse-completing duplicate names and exact entry order across repeated runs.

## G06 — Medium: Blob size is not image freshness

Evidence: `client/src/components/PixiPage/PixiVirtualCanvas.tsx:484-504`, `:695-707`; dormant helper `client/src/hooks/useImageCache.ts:47-58`, `:77-90`.

Image ID plus byte length can remain equal after pixels change, so old URLs/textures can survive a rendition replacement. The dormant hook additionally collapses per-card darken variants to one per image; no production caller was found, so its variant issue is not claimed as an active user bug.

Use stable persisted rendition revision/digest or suitable Blob identity, with card/face-specific keys when overrides differ. Dispose textures and revoke the exact superseded URL at a safe replacement point. Validate distinct equal-length blobs and two cards sharing an image with different overrides. Avoid hashing large blobs on every render; compute revision at write time.

## G07 — Medium: Export effect-cache writes bypass its storage policy

Evidence: `client/src/helpers/effectCache.ts:331-346`; `client/src/helpers/cacheUtils.ts:74-78`; `client/src/helpers/exportImagesZip.ts:104-109`; `client/src/helpers/pdf.worker.ts:123-131`, `:795-800`, `:995-998`.

The explicit-DPI setter skips normal LRU enforcement and PDF duplicates unrestricted database writes. Fire-and-forget ZIP writes lack a terminal storage-error boundary. Large exports can exceed the intended cache budget; IndexedDB quota remains browser-dependent.

Use one worker-safe rendition-cache contract with byte accounting, coalesced writes and bounded batch eviction. Cache failures should be reported as cache failures without falsely failing an otherwise complete export or claiming caching succeeded. Validate export-originated writes beyond the cap, eviction order, quota failures and cleanup completion.

## Reuse and positive patterns

imageProcessing is already a shared geometry/fetch seam. Consolidate duplicated shader/program construction in CardCanvas and helpers/webgl/webglUtils around explicit ownership, not around a domain-wide renderer framework. Existing worker offload, URL cleanup and Pixi virtualization are useful; the missing pieces are complete cancellation and resource budgets. P03 covers the additional duplex-calibration PDF-copy path.

## Inspection coverage

Helpers/workers: imageProcessor, imageProcessing, webglImageProcessing, webgl/webglUtils, bleed.webgl.worker, effect.worker, pdf.worker, cardCanvasWorker, effectCache, cacheUtils, exportImagesZip, exportProxyPageToPdf, exportCuttingTemplate, exportPageLimit, imageHelper. Hooks/components: useImageProcessing, useImageCache, CardCanvas and shader/type files, PixiVirtualCanvas, PixiCardPreview, cardFilterUtils, pixiSingleton. Callers include App, ProxyBuilderPage, CardEditorModalWrapper and ExportActions. Focused existing tests inspected, not executed.
