# Python calibration and deployment review

Source: `518787ecdb74c827731724b83ba62358b26b4acb`. Static review only; no builds, containers, tests, or memory profiling run. Findings describe mechanisms and proposed validation, not measured production performance.

## P01 — High: Standalone server image lacks calibration runtime discovery defaults

Evidence: `server/dockerfile:55-68`, `:79-85`; `server/src/routes/printerCalibrationRouter.ts:90-115`; `docker-compose.yml:6-8`.

The image installs the calibration package in `/opt/printer-calibration-venv`, but neither adds its executables to PATH nor defines the runner environment variables. Compose supplies the missing paths; running the image directly without equivalent overrides does not. System Python does not automatically import packages installed in a separate venv.

Recommendation: put overridable runtime defaults in the image for `PRINTER_CALIBRATION_BIN` and `PRINTER_CALIBRATION_PYTHON`, keeping configuration consistent across deployment adapters. Validate a built image without Compose through profile listing and sheet generation. This is a source-confirmed configuration gap, not a container failure reproduced here.

## P02 — High: Concurrent profile mutations lose updates and expose partial TOML

Evidence: `server/vendor/printer-calibration/src/printer_calibration/profile.py:16-29`, `:40-50`, `:63-69`.

Each CLI invocation loads the entire profile file, mutates its private dictionary, then truncates and rewrites the file. Concurrent subprocesses can overwrite each other's mutations; readers can encounter an incomplete file. Making the Node wrapper async does not serialize independent CLI processes.

Recommendation: a reusable profile repository should lock across the entire read/modify/write sequence, write a same-directory temporary file, flush/fsync as required, and atomically replace the target. All writers must follow the lock convention; atomic replacement alone prevents partial reads but does not prevent lost updates. Reads of atomically replaced files can observe a complete old or new snapshot. Use read locking only if stronger consistency is required.

Complexity: each mutation remains O(p) in number of stored profiles; for large stores, a transactional database avoids full-file rewrites. Do not parallelize writes to the same TOML file.

Validation: two barrier-controlled processes inserting distinct profiles must preserve both; readers racing a write must always parse a complete document; failed writes must leave the prior file intact.

## P03 — High: Duplex calibration multiplies PDF copies across browser and server

Evidence: `client/src/components/LayoutSettings/ExportActions.tsx:385-463`; `client/src/helpers/printerCalibrationApi.ts:141-162`; `server/vendor/printer-calibration/src/printer_calibration/transform.py:50-79`; `server/src/routes/printerCalibrationRouter.ts:380-392`.

The grouped-duplex path parses front/back PDFs, copies into interleaved order, serializes and uploads, receives and parses the calibrated output, then copies/regroups and serializes again. Buffer/object lifetimes overlap, although exact retained memory requires profiling. Python also holds reader/writer state. The server permits uploads up to 10 GiB; that limit is not a safe working-set bound. Concurrent transformations multiply resource demand.

Recommendation: extend the transform contract with grouped-duplex ordering/front-page count so the Python transform chooses front/back offsets directly without client interleave/regroup. Introduce realistic byte/page limits and a bounded subprocess queue. Chunk only where PDF structure, order and calibration semantics are preserved. Do not add unbounded Promise.all or asyncio around CPU-heavy PDF operations.

Complexity: transformations are already broadly linear in PDF contents/pages; eliminate redundant linear passes and copies rather than claim an O(n²) to O(n) improvement. Memory is proportional to PDF content plus library object graphs, not page count alone.

Validation: real high-DPI fixtures, browser and child-process peak RSS, bounded concurrent requests, input rejection, and page-by-page ordering/offset equivalence for grouped and collated duplex modes.

## P04 — Medium: Python dependency resolution is not reproducible

Evidence: `server/vendor/printer-calibration/pyproject.toml:9-13`; `server/dockerfile:59-68`.

Runtime Python dependencies are unconstrained, pip is upgraded during image build, and a system-site-packages venv mixes Alpine ReportLab with PyPI resolution. Identical project source is not sufficient to reproduce the dependency set.

Recommendation: pin dependencies with a reproducible lock/constraints strategy and hashes where applicable; avoid an uncontrolled pip upgrade and explicitly manage the system-package/venv split. Validate two clean builds for identical versions and real PDF fixture output. This is build reliability, not an asymptotic optimization.

## P05 — Medium: Public profile API does not preserve its own contract

Evidence: `server/vendor/printer-calibration/src/printer_calibration/api.py:25-31`, `:34-66`, `:108-123`; `server/vendor/printer-calibration/src/printer_calibration/profile.py:42-49`; `server/vendor/printer-calibration/src/printer_calibration/cli.py:55-86`.

The public dataclass advertises paper size and duplex mode, but save passes only offsets and storage writes fixed letter/long-edge metadata. Save returns the typed input even though a subsequent load can differ. Float coercion also admits non-finite values for direct library/CLI callers; server-side validation is not a substitute for enforcing the reusable Python API boundary.

Recommendation: faithfully persist supported metadata or explicitly reject unsupported values; validate offsets with math.isfinite before persistence/transformation. Test exact metadata round trips or explicit rejection, plus NaN and positive/negative infinity through library and CLI.

## P06 — Medium: Preference promotion bypasses complete fixture validation

Evidence: `client/scripts/promote-preferences.mjs:15-31`; compare `client/src/helpers/mpcCalibrationImport.ts:131-168`.

The promotion script checks only for a cases array, chooses a conversion using truthy version/exportedAt, and directly overwrites the default fixture. Malformed cases may throw incidental errors or serialize incomplete data; interruption can truncate the destination.

Recommendation: extract a Node-safe shared fixture parser/version migrator. Validate the normalized case/candidate schema before any write and atomically replace the destination. Test malformed versioned/unversioned input, invalid candidate fields, and simulated write failure; the destination must remain byte-identical on failure.

## Additional reuse and verification observations

`server/vendor/printer-calibration/src/printer_calibration/cli.py:156-261` repeats command exception/reporting blocks. A narrow CLI command adapter could centralize formatting and exit policy while preserving KeyboardInterrupt/SystemExit. This is a low-priority reuse note, not justification for a general command framework.

The vendored package already has a library API separate from its CLI, an appropriate reusable seam. Its tracked test file, `server/vendor/printer-calibration/tests/test_transform.py`, replaces pypdf classes with fakes; those tests alone do not prove actual PDF validity, file persistence, concurrent writes, or installed-image behavior.

## Scope inspected

All tracked Python source under `server/vendor/printer-calibration/src/printer_calibration/`, its pyproject and transform tests; `server/dockerfile`, `client/Dockerfile`, Compose and Docker ignore configuration; calibration route/client API/export integration; `client/scripts/promote-preferences.mjs`, calibration import parser, and default preference fixture. Parent spot-checks reconfirmed profile persistence, public API, image defaults, runner resolution, upload limit, and promotion script against source.
