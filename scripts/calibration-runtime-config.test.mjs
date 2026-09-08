import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dockerfile = await readFile(resolve(repositoryRoot, 'server/dockerfile'), 'utf8');
const calibrationSource = 'server/vendor/printer-calibration';
const runtimeLockPath = `${calibrationSource}/requirements.lock`;
const buildLockPath = `${calibrationSource}/build-requirements.lock`;
const lock = await readFile(resolve(repositoryRoot, runtimeLockPath), 'utf8');
const buildLock = await readFile(resolve(repositoryRoot, buildLockPath), 'utf8');

const venv = '/opt/printer-calibration-venv/bin';

const runnerDefaults = [
  `ENV PRINTER_CALIBRATION_BIN=${venv}/printer-calibration \\`,
  `    PRINTER_CALIBRATION_PYTHON=${venv}/python`,
].join('\n');
assert.ok(
  dockerfile.includes(runnerDefaults),
  'the standalone runtime image must declare valid venv runner defaults without Compose',
);

function assertHashLockedClosure(lockContent, lockName) {
  const packageEntries = lockContent.match(/^[-a-z0-9]+==[^\s]+(?:\s+\\)?\n(?:    --hash=sha256:[0-9a-f]{64}(?:\s+\\)?\n)+/gm) ?? [];
  assert.ok(packageEntries.length > 0, `${lockName} must contain hash-locked package entries`);
  assert.doesNotMatch(lockContent, /^[-a-z0-9]+==[^\s]+$/m, `${lockName} cannot contain unhashed package pins`);
}

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
assertHashLockedClosure(lock, runtimeLockPath);
assert.match(buildLock, /^hatchling==[^\s]+(?:\s+\\)?\n(?:    --hash=sha256:[0-9a-f]{64}(?:\s+\\)?\n)+/m, 'the build closure must pin and hash hatchling');
assertHashLockedClosure(buildLock, buildLockPath);

const runtimeCopy = `COPY ${runtimeLockPath} /opt/printer-calibration-src/requirements.lock`;
const buildCopy = `COPY ${buildLockPath} /opt/printer-calibration-src/build-requirements.lock`;
const runtimeInstall = `${venv}/pip install --require-hashes --no-deps -r /opt/printer-calibration-src/requirements.lock`;
const buildInstall = `${venv}/pip install --require-hashes --no-deps -r /opt/printer-calibration-src/build-requirements.lock`;
const packageInstall = `${venv}/pip install --no-build-isolation --no-deps /opt/printer-calibration-src`;

for (const requiredInstruction of [
  runtimeCopy,
  buildCopy,
  'python3 -m venv /opt/printer-calibration-venv',
  runtimeInstall,
  buildInstall,
  packageInstall,
]) {
  assert.ok(dockerfile.includes(requiredInstruction), `Dockerfile must contain: ${requiredInstruction}`);
}
assert.ok(
  dockerfile.indexOf(runtimeInstall) < dockerfile.indexOf(buildInstall) &&
    dockerfile.indexOf(buildInstall) < dockerfile.indexOf(packageInstall),
  'the hash-checked runtime and build closures must be installed before the local package',
);
assert.doesNotMatch(dockerfile, /--system-site-packages/, 'the calibration venv must be isolated');
assert.doesNotMatch(dockerfile, /py3-reportlab/, 'the runtime cannot use an unpinned Alpine ReportLab');
assert.doesNotMatch(dockerfile, /pip install\s+(?:-U|--upgrade)(?:\s|=)/, 'the runtime cannot arbitrarily upgrade pip packages');

console.log('calibration standalone runtime defaults, locks, and Docker install contract verified');
