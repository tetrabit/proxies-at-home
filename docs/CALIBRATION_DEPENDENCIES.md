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

## Build-backend closure

`server/vendor/printer-calibration/build-requirements.lock` pins and hashes the
`hatchling` build backend plus its transitive closure. The package's
`pyproject.toml` declares `hatchling` without a version, so the Docker build
installs this separate lock before installing the local package. The local
package install uses `--no-build-isolation --no-deps`: its backend is already
present in the venv from the build lock and its runtime dependencies are
already present from `requirements.lock`.

Regenerate that lock independently when intentionally updating the build
backend:

```sh
python -m pip install pip-tools==7.6.1
printf '%s\n' 'hatchling==1.28.0' | python -m pip-compile \
  --generate-hashes --resolver=backtracking \
  --output-file server/vendor/printer-calibration/build-requirements.lock -
```

## Docker runtime boundary

The `calibration-runtime` Docker target creates an isolated venv, copies and
installs `requirements.lock` with `--require-hashes --no-deps`, then does the
same for `build-requirements.lock`. It installs the local package only after
those closures with `--no-build-isolation --no-deps`.

The target installs only Alpine `python3` and `py3-pip` for bootstrap. It does
not install Alpine `py3-reportlab`, and it does not run a pip upgrade. This
keeps ReportLab on the hash-checked PyPI runtime closure rather than mixing it
with an unpinned system package.

Build the narrow dependency target from the repository-root Docker context:

```sh
DOCKER_BUILDKIT=1 docker build --target calibration-runtime \
  --file server/dockerfile --tag proxxied-b20-calibration:probe .
```

The floating `node:20-alpine` base image and APK repository are outside these
Python lockfiles. A successful target build is required to establish that the
locked artifacts work with the selected Alpine/Python platform; static lock
inspection alone is not that proof.
