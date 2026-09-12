import assert from 'node:assert/strict';
import { spawnSync as realSpawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtures = path.join(root, '.review-artifacts', 'printer-calibration-runtime-tests');

function fixtureRoot() {
  mkdirSync(fixtures, { recursive: true });
  const directory = mkdtempSync(path.join(fixtures, `runtime-${process.pid}-${randomUUID()}-`));
  const source = path.join(directory, 'server', 'vendor', 'printer-calibration');
  mkdirSync(path.join(source, 'src', 'printer_calibration'), { recursive: true });
  writeFileSync(path.join(source, 'pyproject.toml'), '[project]\nname = "printer-calibration"\n');
  writeFileSync(path.join(source, 'requirements.lock'), 'pypdf==1 --hash=sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n');
  writeFileSync(path.join(source, 'build-requirements.lock'), 'hatchling==1 --hash=sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n');
  writeFileSync(path.join(source, 'src', 'printer_calibration', '__init__.py'), '__version__ = "fixture"\n');
  return directory;
}

function executable(file, body = '#!/bin/sh\nexit 0\n') {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, body, { mode: 0o755 });
  chmodSync(file, 0o755);
}

function fakeRunner(calls) {
  return (command, args, options = {}) => {
    calls.push({ command, args, cwd: options.cwd });
    if (args?.[0] === '-m' && args?.[1] === 'venv') {
      const venv = args[2];
      executable(path.join(venv, 'bin', 'python'));
      executable(path.join(venv, 'bin', 'printer-calibration'));
    }
    if (args?.[0] === '-c' && args?.[1]?.includes('sys.version_info')) {
      return { status: 0, stdout: '{"version":"3.14.6","major":3,"minor":14}\n', stderr: '' };
    }
    return { status: 0, stdout: '', stderr: '' };
  };
}

test('installs a hash-keyed repository-local venv with locked runtime and build closures', async () => {
  const { preparePrinterCalibration } = await import('./prepare-printer-calibration.mjs');
  const directory = fixtureRoot();
  const calls = [];

  const result = preparePrinterCalibration(directory, {
    python: '/fixture/python3',
    pythonIdentity: { executable: '/fixture/python3', version: 'Python 3.14.6' },
    spawnSyncImpl: fakeRunner(calls),
  });

  assert.match(result.bin, new RegExp(`^${directory.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/\\.runtime/printer-calibration/[a-f0-9]{64}-v4-python-3\\.14\\.6/bin/printer-calibration$`));
  assert.equal(result.python, path.join(path.dirname(result.bin), 'python'));
  assert.equal(lstatSync(path.dirname(path.dirname(result.bin))).isSymbolicLink(), true);
  assert.match(readFileSync(result.bin, 'utf8'), /^#!/);
  assert.equal(existsSync(result.bin), true);
  const installCalls = calls.filter(({ args }) => args?.[0] === '-m' && args?.[1] === 'pip');
  for (const call of installCalls) assert.equal(call.args.includes('--isolated'), true);
  assert.deepEqual(installCalls.map(({ args }) => args.filter(arg => !['-m', 'pip', '--isolated'].includes(arg)).slice(0, 4)), [
    ['install', '--require-hashes', '--no-deps', '-r'],
    ['install', '--require-hashes', '--no-deps', '-r'],
    ['install', '--no-build-isolation', '--no-deps', path.join(directory, 'server', 'vendor', 'printer-calibration')],
  ]);
  assert.ok(installCalls[0].args.includes(path.join(directory, 'server', 'vendor', 'printer-calibration', 'requirements.lock')));
  assert.ok(installCalls[1].args.includes(path.join(directory, 'server', 'vendor', 'printer-calibration', 'build-requirements.lock')));
  assert.equal(installCalls[2].args.at(-1), path.join(directory, 'server', 'vendor', 'printer-calibration'));
  assert.ok(calls.some(({ command, args }) => command === '/fixture/python3' && args?.join(' ') === '-m venv ' + path.join(path.dirname(path.dirname(result.bin)), '.prepare-fixture')) === false, 'staging name must remain collision-safe');
  const receipt = JSON.parse(readFileSync(path.join(path.dirname(path.dirname(result.bin)), 'receipt.json'), 'utf8'));
  assert.equal(receipt.python.executable, '/fixture/python3');
  assert.equal(receipt.python.version, 'Python 3.14.6');
  assert.equal(receipt.sourceHash.length, 64);
});

test('reuses only a matching cached runtime after import and CLI validation', async () => {
  const { preparePrinterCalibration } = await import('./prepare-printer-calibration.mjs');
  const directory = fixtureRoot();
  const firstCalls = [];
  const first = preparePrinterCalibration(directory, {
    python: '/fixture/python3',
    pythonIdentity: { executable: '/fixture/python3', version: 'Python 3.14.6' },
    spawnSyncImpl: fakeRunner(firstCalls),
  });
  const reuseCalls = [];
  const second = preparePrinterCalibration(directory, {
    python: '/fixture/python3',
    pythonIdentity: { executable: '/fixture/python3', version: 'Python 3.14.6' },
    spawnSyncImpl: fakeRunner(reuseCalls),
  });

  assert.deepEqual(second, first);
  assert.equal(reuseCalls.some(({ args }) => args?.[0] === '-m' && args?.[1] === 'venv'), false);
  assert.ok(reuseCalls.some(({ command, args }) => command === first.python && args?.[0] === '-c' && args[1].includes('import pypdf, reportlab, tomli_w, printer_calibration')));
  assert.ok(reuseCalls.some(({ command, args }) => command === first.bin && args?.[0] === '--help'));
});

test('configured executable paths are validated without installing or replacing them', async () => {
  const { validateConfiguredBin, validateConfiguredPython } = await import('./prepare-printer-calibration.mjs');
  const directory = fixtureRoot();
  const bin = path.join(directory, 'operator bin', 'printer-calibration');
  const python = path.join(directory, 'operator python', 'python');
  executable(bin);
  executable(python);
  const calls = [];

  assert.equal(validateConfiguredBin(bin, { spawnSyncImpl: fakeRunner(calls) }), bin);
  assert.equal(validateConfiguredPython(python, { spawnSyncImpl: fakeRunner(calls) }), python);
  assert.ok(calls.some(({ command, args }) => command === bin && args?.[0] === '--help'));
  assert.ok(calls.some(({ command, args }) => command === python && args?.[0] === '-c'));
});

test('CLI preserves a validated operator binary and fails closed for a missing one', () => {
  const directory = fixtureRoot();
  const bin = path.join(directory, 'operator runtime with spaces', 'printer-calibration');
  executable(bin);
  const valid = realSpawnSync(process.execPath, ['scripts/prepare-printer-calibration.mjs'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, PRINTER_CALIBRATION_BIN: bin, PRINTER_CALIBRATION_PYTHON: '' },
  });
  assert.equal(valid.status, 0, valid.stderr);
  assert.equal(valid.stdout.trim(), bin);

  const missing = path.join(directory, 'missing operator runtime', 'printer-calibration');
  const invalid = realSpawnSync(process.execPath, ['scripts/prepare-printer-calibration.mjs'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, PRINTER_CALIBRATION_BIN: missing, PRINTER_CALIBRATION_PYTHON: '' },
  });
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, new RegExp(`PRINTER_CALIBRATION_BIN does not exist: ${missing.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
});

test('the runtime source hash changes when a lock or vendored source changes', async () => {
  const { runtimeSourceHash } = await import('./prepare-printer-calibration.mjs');
  const directory = fixtureRoot();
  const source = path.join(directory, 'server', 'vendor', 'printer-calibration');
  const before = runtimeSourceHash(source);
  writeFileSync(path.join(source, 'src', 'printer_calibration', 'new_module.py'), 'value = 1\n');
  const afterSource = runtimeSourceHash(source);
  writeFileSync(path.join(source, 'requirements.lock'), 'pypdf==2 --hash=sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc\n');
  const afterLock = runtimeSourceHash(source);
  assert.notEqual(afterSource, before);
  assert.notEqual(afterLock, afterSource);
  assert.match(afterLock, /^[a-f0-9]{64}$/);
});
