# Keystone Calibration (Scan Front + Back)

This workflow auto-populates back alignment for duplex printing by analyzing scans of a printed calibration sheet.

## Steps
1. Open **Settings** -> **Advanced Positioning** -> **Keystone Calibration (Scan)**.
2. Click **Download Calibration PDF** and save the 2-page file (front + back).
3. Print the PDF duplex:
   - 100% scale (no "fit to page")
   - Same paper size you selected (Letter or A4)
4. Scan both sides:
   - Prefer flatbed
   - Keep the full page edges visible (avoid auto-crop)
   - Save as PDF (recommended) or image
5. In Proxxied, upload:
   - Front Scan
   - Back Scan
   - Set the correct page number if the scan PDF contains multiple pages
   - Adjust DPI if needed (300 is a good default for PDFs)
6. Click **Analyze Scans**, then **Apply Offsets**.

Applying offsets updates:
- `perCardBackOffsets` (translation + rotation per grid slot) for duplex/back exports
- the "last applied keystone" display in Card Position Adjustment

## Troubleshooting
- "Keystone analyzer unavailable":
  - The analyzer requires `printer-keystone` (Python + OpenCV). In Docker dev this is preconfigured via `PRINTER_KEYSTONE_PYTHON` + `PRINTER_KEYSTONE_REPO`.
- Marker detection fails / weird results:
  - Ensure the scan includes the entire printed page border and all fiducials.
  - Disable scanner auto-crop and auto-rotate if possible.
  - Increase contrast, scan at 300-600 DPI.
  - If your scan is cropped to the printed border, try **Border Inset (mm)**.

## Notes
- Proxxied v1 ignores the analyzer's scale result (rotation + translation only).
- Per-card back offsets are position-dependent; they are intended for duplex/back grid exports (not interleaved exports).

