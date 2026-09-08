import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dockerfile = await readFile(resolve(repositoryRoot, 'server/dockerfile'), 'utf8');
const lock = await readFile(
  resolve(repositoryRoot, 'server/vendor/printer-calibration/requirements.lock'),
  'utf8',
);

const venv = '/opt/printer-calibration-venv/bin';

assert.match(
  dockerfile,
  new RegExp(
    `^ENV PRINTER_CALIBRATION_BIN=${venv}/printer-calibration\\n` +
      `    PRINTER_CALIBRATION_PYTHON=${venv}/python$`,
    'm',
  ),
  'the standalone runtime image must declare venv runner defaults without Compose',
);

for (const dependency of ['pypdf', 'tomli-w', 'reportlab', 'pillow', 'charset-normalizer']) {
  assert.match(
    lock,
    new RegExp(
      `^${dependency}==[^\\s]+(?:\\s+\\\\)?\\n` +
        `(?:    --hash=sha256:[0-9a-f]{64}(?:\\s+\\\\)?\\n)+`,
      'm',
    ),
    `${dependency} must be version-pinned with reproducible hashes`,
  );
}

console.log('calibration standalone runtime defaults and lock structure verified');
