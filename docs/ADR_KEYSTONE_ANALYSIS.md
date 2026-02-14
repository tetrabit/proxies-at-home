# ADR: Keystone Scan Analysis Implementation

Date: 2026-02-10

## Context
Proxxied needs to derive duplex back alignment (translation + rotation) by analyzing scans of a printed calibration sheet (front + back). The existing `printer-keystone` project already implements this reliably using Python + OpenCV (ArUco detection) and can also generate the matching calibration PDF.

Proxxied runs in multiple environments:
- Web (hosted): cannot assume Python/OpenCV is available.
- Local development / Docker: Python/OpenCV can be installed in the server container.
- Electron/desktop: can ship or require an analyzer runtime (future work).

## Decision
Use a server-side analyzer integration that shells out to `printer-keystone`:
- `GET /api/keystone/calibration?paper=letter|a4` runs `printer-keystone generate ...` and streams a 2-page calibration PDF.
- `POST /api/keystone/analyze` accepts front/back scans (PDF or image) and calls `printer-keystone analyze ...`, then returns structured JSON.

If the analyzer is unavailable (missing Python/module/binary), the API returns a clear error (HTTP 501) so the UI can fail gracefully in web-only deployments.

## Alternatives Considered
- Browser-only analysis (OpenCV.js / WASM ArUco): heavy bundle size, higher complexity, lower reliability across devices/scanners.
- Porting the algorithm to TypeScript: high effort and maintenance burden, duplicates a working tool.

## Consequences
- Local/Docker/Electron can support the workflow immediately.
- Hosted web deployments need either:
  - an analyzer service with the Python runtime available, or
  - an alternate implementation (future work).

## Follow-ups
- Electron packaging plan: bundle a minimal Python runtime + `printer-keystone` deps, or provide installer steps and detection UX.
- Optional: support scaling correction (currently ignored in Proxxied v1).

