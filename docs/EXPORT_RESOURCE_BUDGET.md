# Export resource budget (R04)

**Decision:** Until a representative browser measurement proves a lower working set, use one high-DPI PDF page worker, admit one high-DPI card decode/effect operation at a time, byte-account effects/cache, and serialize calibration transforms. These are proposed downstream controls only; this document and `scripts/export-resource-probe.mjs` do not alter application runtime behavior.

## Fresh bounded real-PDF evidence

A new collision-free repository-local evidence directory was created:

```text
.review-artifacts/resource-measurement-01/
```

Exact command (run from the repository root):

```sh
node scripts/export-resource-probe.mjs \
  --out-dir .review-artifacts/resource-measurement-01 \
  --python .review-artifacts/resource-runtime-01/bin/python
```

The probe first reads `package.json`, `client/package.json`, and `server/vendor/printer-calibration/pyproject.toml`. Its dedicated repository-local virtual environment was created with:

```sh
python3 -m venv .review-artifacts/resource-runtime-01
.review-artifacts/resource-runtime-01/bin/python -m pip install ./server/vendor/printer-calibration
```

That installs the calibration package's declared real dependencies, rather than using a global or deleted prior environment: Python 3.14.6, `reportlab` 5.0.1, `pypdf` 6.18.0, and `tomli-w` 1.2.0.

The child creates one US-Letter PDF with a **3 × 3 = 9-card** physical 63 × 88 mm grid. It reuses a single 744 × 1039 pixel 300-DPI synthetic raster, reads and rewrites the PDF through the actual installed `pypdf`, then reopens the rewritten file. It does not render the browser application, allocate a 1200-DPI page/card, or make a GPU-memory claim.

### Actual result

| Item | Actual result |
|---|---:|
| Probe exit status | 0 |
| Elapsed wall time | 425.496013 ms |
| Verified pages | 1 |
| Verified media box | `[0, 0, 612, 792]` points (US Letter) |
| Input PDF bytes | 18,874 |
| Rewritten PDF bytes | 18,447 |
| Python child `ru_maxrss` | **53,981,184 bytes** |
| Node 5 ms sampled child `VmRSS` peak | 54,198,272 bytes |
| Node orchestrator `ru_maxrss` | 57,540,608 bytes |

The `resource-probe-result.json` records the exact command, runtime, result values, limits, and source hashes. `commands.sh`, `runtime.txt`, and `source-hashes.sha256` provide small, human-readable copies; the command file is provenance, not a rerun-in-place script, because the helper intentionally refuses to overwrite an existing evidence directory.

### Measured RSS is not a browser/GPU measurement

The 53,981,184-byte primary measurement is Linux `resource.getrusage(RUSAGE_SELF).ru_maxrss` from the bounded Python child process, with Linux KiB converted to bytes. The 54,198,272-byte `/proc/<pid>/status` sample is separate best-effort observation and can miss short-lived peaks. Node's 57,540,608-byte process maximum is also separate; do not add these values together.

None of these RSS values measures React, a browser renderer, JavaScript heap, `OffscreenCanvas` backing stores, PDF encoder buffers, graphics-driver allocation, or GPU memory. Node RSS must not be represented as GPU memory.

### Preserved historical record

The previous document record is retained here rather than overwritten: it reported Python 3.14.6, ReportLab 5.0.1, pypdf 6.18.0, Node v24.14.0, 18,874-byte input / 18,447-byte rewritten PDFs, child `ru_maxrss` 54,267,904 bytes, and a 53,686,272-byte 5 ms sampled `VmRSS` peak. The prior `.todos/cr-execution/wave4/resource-budget` directory is absent on this checkout, so those historical numbers are not claimed as current artifact evidence. The fresh values above come from the new `.review-artifacts/resource-measurement-01` directory; no historical directory was overwritten.

## Current source and evidence identity

The current source still shows the material relationships:

- Default layout is Letter 8.5 × 11 inches (`client/src/store/settings.ts:148-150`, `:220`).
- The PDF worker converts selected page geometry at DPI and creates a full-page `OffscreenCanvas` (`client/src/helpers/pdf.worker.ts:485-486`, `:533-536`).
- `MAX_CONCURRENT_CARDS = 4` remains the source-level card preparation limit (`pdf.worker.ts:23`, `:626`, `:1050`).
- `canvasCache` is a module-level `Map` (`pdf.worker.ts:456`) and inserts prepared render canvases (`:1025-1035`).

Hashes captured by the fresh probe:

| File | SHA-256 |
|---|---|
| `package.json` | `8ae2fd66f5c9463cfb7c19db8f3873fef9e6dec9502a7720a43518bb592ace8e` |
| `client/package.json` | `7e441aaf66b78d0b0ad036946eb6084f731fe550503905f562f5d39331e027bd` |
| `server/vendor/printer-calibration/pyproject.toml` | `6453584e5889d2541f036362faaf9ace541fe2763e69cad805730bd8cccfca39` |
| `scripts/export-resource-probe.mjs` | `580150d2d3a4141df8ed8b1a6745ac9e177aff011b113df8fbc5d688a0c2783b` |
| `client/src/helpers/pdf.worker.ts` | `85b376197c5595c8242978b6c539620af65debeb2c1ca375790b5ce4ee4b6722` |

## 1200-DPI RGBA8 capacity estimates — not RSS

Formula: `ceil(width_px) × ceil(height_px) × 4`, where dimensions come from inches × DPI or millimetres / 25.4 × DPI. This is conservative one-buffer RGBA8 arithmetic, not a measured browser allocation. It gives a representative page/card/PDF-render working-set basis without making the bounded probe allocate those surfaces.

| Surface at 1200 DPI | Integer dimensions | Conservative RGBA8 bytes | MiB |
|---|---:|---:|---:|
| Letter page, 8.5 × 11 in | 10,200 × 13,200 | 538,560,000 | 513.61 |
| Card content, 63 × 88 mm | 2,977 × 4,158 | 49,513,464 | 47.22 |
| Card plus 1 mm bleed each side, 65 × 90 mm | 3,071 × 4,252 | 52,231,568 | 49.81 |
| Card plus MPC 3.175 mm bleed each side, 69.35 × 94.35 mm | 3,277 × 4,458 | 58,435,464 | 55.73 |

Representative simultaneous PDF-render compositions, still estimates:

- A PDF page canvas plus same-size full-page guide canvas is `2 × 538,560,000 = 1,077,120,000` bytes (**1,027.22 MiB**) before card preparation or encoding.
- One 1 mm-bleed card with illustrative decode/effect/final RGBA8 surfaces is `3 × 52,231,568 = 156,694,704` bytes (**149.44 MiB**).
- Four active cards at the present source-level concurrency is `12 × 52,231,568 = 626,778,816` bytes (**597.74 MiB**) before retained card canvases, page encoding, or browser overhead.

The 18,874-byte / 18,447-byte real small PDFs above are **observed encoded file sizes**, not a prediction for photographic high-DPI PDFs. PDF compression depends on the image content, encoding, and object structure; a compressed file-size estimate cannot safely be inferred from the RGBA surface size.

Browser implementations may tile or duplicate canvas backing stores, retain CPU/GPU copies, add encoder buffers, or allocate WebGL textures/framebuffers. The estimates are therefore capacity arithmetic only, not measured Canvas, renderer, or GPU memory.

## Proposed conservative downstream limits

| Control | Proposed value | Basis |
|---|---:|---|
| `PDF_WORKERS_MAX` | `1` | A single estimated Letter page plus guides is already ~1.00 GiB of RGBA8 capacity arithmetic. Do not multiply that unknown real working set by CPU count. |
| `PDF_HIGH_DPI_CARD_DECODE_MAX` | `1` at ≥900 DPI | Avoid the present four-card decode/effect burst until a browser/photo measurement supports more. |
| `PDF_EFFECT_ADMISSION_BYTES` | `268,435,456` (256 MiB) | Admits only one illustrative 1200-DPI 1 mm-bleed decode/effect/final set (~149.44 MiB), with limited accounting headroom. |
| `PDF_CANVAS_CACHE_BYTES` | `134,217,728` (128 MiB) | Requires byte accounting plus LRU or clear-at-chunk behavior; a canvas cache must not retain an unbounded card set. |
| `CALIBRATION_UPLOAD_BYTES` | `67,108,864` (64 MiB) | Conservative provisional per-request ceiling; the small synthetic result does not validate photographic output at this size. |
| `CALIBRATION_AGGREGATE_TEMP_BYTES` | `134,217,728` (128 MiB) | Bounds two admitted upload-sized temporary artifacts across requests. |
| `CALIBRATION_SUBPROCESSES_MAX` | `1` | Serialize duplex transforms until representative calibration child-RSS evidence supports more. |

These values are a documented proposal, not implemented behavior. A high-DPI admission path should account for requested page dimensions and guide configuration before creating `OffscreenCanvas`; insufficient configured headroom should reject/downscale the request instead of starting additional workers.

## Probe safety and remaining evidence gap

The probe only creates a new output directory and refuses an existing one, so it cannot overwrite historical evidence. It rejects output inside `.git`, `.todos`, or `.recovery`; use a new collision-free directory under `.review-artifacts` for every measurement run.

Before relaxing or enforcing these proposed values, collect separately:

1. A representative photographic 1200-DPI real-browser export trace with browser/version/backend, peak renderer RSS, and any available GPU instrumentation. Record renderer and GPU values independently.
2. Real duplex calibration-transform RSS and output sizes for representative high-DPI PDFs before enforcing or raising the provisional 64 MiB upload / 128 MiB aggregate limits.
3. Runtime implementations for the proposed limits in their own scoped tasks; R04 documents the evidence and decision only.
