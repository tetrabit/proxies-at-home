# ADR-003: Export Context Ownership After Native Canvas Snapshot

**Date**: 2026-09-09

**Status**: Accepted — bounded runtime decision

**Task**: `td-d0091c` (G02; follows `td-73737f`)
**Decision scope**: `renderCardWithOverridesWorker` in `client/src/helpers/cardCanvasWorker.ts` and its shared per-realm export context.

---

## Context

G02 was a runtime hypothesis, not a confirmed corruption defect. The export function obtains a reusable canvas/WebGL context, renders into it, calls `canvas.convertToBlob({ type: 'image/png' })`, then awaits that promise before deleting its per-render resources; another invocation can reach the same shared context while the earlier conversion remains unresolved. The original review therefore required real-browser evidence before adding serialization or a bounded context pool.

The relevant source is pinned by both overlap probes to `client/src/helpers/cardCanvasWorker.ts`, working SHA-256 `6fac4ca4d4d90c5028d35f1e8e9b7a3c1786aa22ce87d75d04058f08613c4413`, committed blob `1bb48870a7d767186f2a2fcd28e2a8672040053f`.

## Decision

For this pinned production function, retain the existing native-snapshot ownership model. Do **not** add an application-level mutex/serialization lease and do **not** introduce a bounded context pool.

The ownership boundary supported by the probe is narrow: after the function has rendered and invoked the native `convertToBlob`, the tested browser implementation preserves that conversion's pixel output while a second invocation reuses and changes the shared canvas/context. The promise may remain unresolved during the second conversion; waiting for its settlement is not, by itself, a reason to serialize the next render in the tested runtime.

This ADR makes no runtime change. It does not redefine ownership for another worker realm, another export path, or another browser implementation. `td-a48d83` may proceed with its separately scoped reuse of immutable pipeline resources per GL context; this ADR supplies no global mutex or pool as a prerequisite.

## Evidence basis

### Primary overlap probe

The primary probe ran at source commit `0e4770955ac1aa01a09a477218f80e5c07c294d3`, tree `21125894687d033443667dd8fe3c610fbdd9e728`, on Node `v24.14.0`, Playwright `1.57.0`, Google Chrome `152.0.7977.64`, and esbuild `0.27.2`.

It bundled the production module in memory and served it only from loopback. It established serial baselines, invoked `renderCardWithOverridesWorker` twice without awaiting the first result, and wrapped `OffscreenCanvas.prototype.convertToBlob` only to observe native invocation and settlement. The wrapper immediately called the original method; it added neither delay nor altered result values.

In WebGL 2 (`WebGL 2.0 (OpenGL ES 3.0 Chromium)`) using `ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)`, both pairs observed native overlap (`maxActiveNativeConversions=2`):

| Pair | A raster | B raster | Result |
| --- | --- | --- | --- |
| pair-1 | 41×29, RGBA `[229, 41, 41, 255]` | 67×37, RGBA `[25, 203, 155, 255]` | Each decoded RGBA8 output retained its requested dimensions and color; max delta from serial and expected was 0. |
| pair-2 | 53×31, RGBA `[84, 73, 239, 255]` | 73×43, RGBA `[245, 146, 31, 255]` | Each decoded RGBA8 output retained its requested dimensions and color; max delta from serial and expected was 0. |

Primary records: `.review-artifacts/shared-context-overlap-01/attempt-05/REPORT.md` and `.review-artifacts/shared-context-overlap-01/attempt-05/result.json`.

### Independent QA confirmation

Independent QA repeated the same bounded probe at candidate commit `c05e01e3080d107977696a1db5c44a3b7395f003`, tree `7d03b56289f8c9677a7948b8e7ee5d17200413e9`, whose parent was `0e4770955ac1aa01a09a477218f80e5c07c294d3`. It pinned the same source SHA-256 and committed blob above, and again observed two unresolved native conversions in each of the two pairs with zero deltas and the requested dimensions/colors. Its raw JSON SHA-256 is `05e02d1bdb9017d81e65fc8e93ead8a4c7122b9cc2cb40fe3e63a76649e6543e`; its report SHA-256 is `b5edf5f082607ddb28109f692fb024df5895bab3e1ef4660d38253f25c107b93`.

Independent records: `.review-artifacts/overlap-probe-final-qa-01/REPORT.md`, `.review-artifacts/shared-context-overlap-01/qa-bebf6fdc-386c-48b4-86a2-a1d666945e66/REPORT.md`, and `.review-artifacts/shared-context-overlap-01/qa-bebf6fdc-386c-48b4-86a2-a1d666945e66/result.json`.

## Limits and non-decisions

This is evidence for the exact Chrome 152 headless, SwiftShader/WebGL2 run, the pinned production function, and four small solid-color rasters at the dimensions above. It is not a cross-browser, hardware-GPU, large/photographic-image, cross-realm, or universal `OffscreenCanvas` guarantee. It does not prove a browser specification-level ownership contract, prove that every future resource-lifetime change is safe, or rule out a defect on another runtime/workload.

Conversely, unresolved `convertToBlob` promises alone are not proof that a global mutex is required. The observed native overlap with byte-equivalent outputs is the reason this ADR declines to add serialization or a pool now.

## Reconsideration

No follow-up is required by this decision. Reopen it only when necessary: a supported runtime/workload reproduces incorrect pixels, dimensions, or attribution while native conversion overlap is observed, or a change moves shared-canvas mutation/resource lifetime across the `convertToBlob` boundary. That event warrants one atomic, evidence-backed decision task for the affected scope; it may select a serial lease or a measured bounded pool only if its evidence supports that mechanism.

## Consequences

* Export concurrency keeps the native-snapshot behavior demonstrated by the probe; no throughput-reducing global mutex is introduced.
* The downstream per-context immutable-pipeline work remains independently responsible for its own resource lifecycle and validation.
* The decision is intentionally conditional on its pinned source and tested runtime rather than generalized beyond the evidence.
