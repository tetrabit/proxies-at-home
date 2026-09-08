# Printer calibration Python dependencies

`server/vendor/printer-calibration/requirements.lock` is the reproducible,
PyPI-based runtime closure for the printer-calibration package. It covers the
runtime dependencies declared in that package's `pyproject.toml`, not the
server's Node.js dependencies.

## Locked closure

| Package | Locked version | Role |
| --- | --- | --- |
| `pypdf` | `6.18.0` | Reads and transforms calibration PDFs (`transform.py`). |
| `reportlab` | `5.0.1` | Provides `reportlab.pdfgen.canvas.Canvas` used to generate sheets (`sheet.py`). |
| `tomli-w` | `1.2.0` | Writes calibration profiles (`profile.py`). |
| `charset-normalizer` | `3.5.1` | Runtime dependency resolved from `reportlab`. |
| `pillow` | `12.3.0` | Runtime dependency resolved from `reportlab`. |

Every locked package has one or more SHA-256 hashes. `reportlab==5.0.1` was
selected from the PyPI package index and resolved successfully on Python 3.14;
the calibration package itself declares `requires-python >=3.11`.

## Regeneration and verification

Use a disposable, non-production environment. Retain the existing direct
versions unless intentionally updating this dependency set.

```sh
python -m pip install pip-tools==7.6.1
printf '%s\n' \
  'pypdf==6.18.0' \
  'reportlab==5.0.1' \
  'tomli-w==1.2.0' > /tmp/printer-calibration-runtime.in
python -m pip-compile --generate-hashes --resolver=backtracking \
  --output-file server/vendor/printer-calibration/requirements.lock \
  /tmp/printer-calibration-runtime.in
python -m pip install --require-hashes \
  -r server/vendor/printer-calibration/requirements.lock
```

The lock was replayed with `pip install --require-hashes` against PyPI, then a
smoke test imported `pypdf`, `reportlab`, and `tomli_w`, generated a calibration
PDF, and read its two pages with `pypdf`.

## Current Docker boundary

This lock deliberately resolves `reportlab` from PyPI rather than documenting
an Alpine system-package pin. The current runtime Docker stage is **not**
reproducible from this lock yet: it uses the floating `node:20-alpine` base,
installs unversioned `py3-reportlab`, and installs the package from
`pyproject.toml` without copying or consuming `requirements.lock`.

Changing that Docker installation wiring is outside this artifact. B20 must
make an explicit runtime choice—consume this hash lock (and avoid a competing
Alpine ReportLab), or pin the image/repository and exact Alpine package version
with verified repository metadata. This document makes no claim that the
current Docker runtime was built or probed.
