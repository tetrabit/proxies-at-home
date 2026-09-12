import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceRelativePaths = ['pyproject.toml', 'requirements.lock', 'build-requirements.lock'];
const runtimeLayoutVersion = 'v4';
const importProbe = 'import pypdf, reportlab, tomli_w, printer_calibration';

function commandError(label, result) {
  const detail = result.error?.message || result.stderr?.toString().trim() || result.stdout?.toString().trim() || `exit status ${result.status}`;
  return new Error(`${label}: ${detail}`);
}

function run(command, args, { spawnSyncImpl = spawnSync, cwd, env } = {}) {
  const result = spawnSyncImpl(command, args, {
    cwd,
    env: {
      ...process.env,
      PIP_CONFIG_FILE: os.devNull,
      PIP_DISABLE_PIP_VERSION_CHECK: '1',
      PIP_NO_INPUT: '1',
      PYTHONNOUSERSITE: '1',
      ...(env ?? {}),
    },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 180_000,
  });
  if (result.status !== 0 || result.error) throw commandError(`${command} ${args.join(' ')}`, result);
  return result;
}

function allSourceFiles(directory) {
  const entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...allSourceFiles(fullPath));
    else if (entry.isFile()) files.push(fullPath);
  }
  return files;
}

export function runtimeSourceHash(source) {
  const sourceRoot = path.resolve(source);
  const files = [
    ...sourceRelativePaths.map(relative => path.join(sourceRoot, relative)),
    ...allSourceFiles(path.join(sourceRoot, 'src')),
  ].sort();
  const hash = createHash('sha256');
  for (const file of files) {
    if (!existsSync(file)) throw new Error(`Printer calibration runtime source is incomplete: ${file}`);
    hash.update(path.relative(sourceRoot, file));
    hash.update('\0');
    hash.update(readFileSync(file));
    hash.update('\0');
  }
  return hash.digest('hex');
}

export function inspectPython(python, { spawnSyncImpl = spawnSync } = {}) {
  const result = run(python, ['-c', 'import json, sys; print(json.dumps({"executable": sys.executable, "version": sys.version.split()[0], "major": sys.version_info.major, "minor": sys.version_info.minor}))'], { spawnSyncImpl });
  let identity;
  try {
    identity = JSON.parse(String(result.stdout).trim());
  } catch {
    throw new Error(`Could not identify Python interpreter: ${python}`);
  }
  if (identity.major !== 3 || identity.minor < 11) {
    throw new Error(`Python 3.11 or newer is required for printer calibration; configured interpreter is ${identity.version}.`);
  }
  return { executable: identity.executable || python, version: `Python ${identity.version}` };
}

function pythonNamespace(version) {
  const match = /^Python (\d+)\.(\d+)(?:\.\d+)?$/.exec(version);
  if (!match) throw new Error(`Invalid Python version identity: ${version}`);
  return `python-${match[1]}.${match[2]}.${version.split('.').at(-1)}`;
}

function verifyFile(file, label) {
  if (!existsSync(file) || !statSync(file).isFile()) throw new Error(`${label} does not exist: ${file}`);
}

function validatePythonImports(python, options = {}) {
  run(python, ['-c', importProbe], options);
  run(python, ['-m', 'printer_calibration', '--help'], options);
}

export function validateConfiguredBin(bin, options = {}) {
  verifyFile(bin, 'PRINTER_CALIBRATION_BIN');
  run(bin, ['--help'], options);
  return bin;
}

export function validateConfiguredPython(python, options = {}) {
  verifyFile(python, 'PRINTER_CALIBRATION_PYTHON');
  inspectPython(python, options);
  validatePythonImports(python, options);
  return python;
}

function sourceReceipt(source, sourceHash, python) {
  return {
    runtimeLayoutVersion,
    sourceHash,
    locks: Object.fromEntries(sourceRelativePaths.map(relative => [relative, createHash('sha256').update(readFileSync(path.join(source, relative))).digest('hex')])),
    python,
  };
}

function validateReceipt(destination, expected, options) {
  const receiptPath = path.join(destination, 'receipt.json');
  let actual;
  try {
    actual = JSON.parse(readFileSync(receiptPath, 'utf8'));
  } catch {
    throw new Error(`Cached printer calibration runtime is missing a valid receipt: ${destination}`);
  }
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Cached printer calibration runtime does not match the current source, locks, or Python interpreter: ${destination}`);
  }
  const python = path.join(destination, 'bin', 'python');
  const bin = path.join(destination, 'bin', 'printer-calibration');
  verifyFile(python, 'Cached printer calibration Python');
  verifyFile(bin, 'Cached printer calibration executable');
  validatePythonImports(python, options);
  validateConfiguredBin(bin, options);
  return { bin, python };
}

export function preparePrinterCalibration(root = projectRoot, options = {}) {
  const source = path.join(root, 'server', 'vendor', 'printer-calibration');
  const sourceHash = runtimeSourceHash(source);
  const python = options.python ?? process.env.PYTHON ?? 'python3';
  const pythonIdentity = options.pythonIdentity ?? inspectPython(python, options);
  const runtimeRoot = path.join(root, '.runtime', 'printer-calibration');
  const destination = path.join(runtimeRoot, `${sourceHash}-${runtimeLayoutVersion}-${pythonNamespace(pythonIdentity.version)}`);
  const receipt = sourceReceipt(source, sourceHash, pythonIdentity);

  if (existsSync(destination)) return validateReceipt(destination, receipt, options);

  mkdirSync(runtimeRoot, { recursive: true });
  const staging = mkdtempSync(path.join(runtimeRoot, '.prepare-'));
  const stagingPython = path.join(staging, 'bin', 'python');
  const stagingBin = path.join(staging, 'bin', 'printer-calibration');
  options.log?.(`Preparing printer-calibration runtime in ${destination} (first use for this source and Python)...`);

  run(python, ['-m', 'venv', staging], options);
  run(stagingPython, ['-m', 'pip', '--isolated', 'install', '--require-hashes', '--no-deps', '-r', path.join(source, 'requirements.lock')], options);
  run(stagingPython, ['-m', 'pip', '--isolated', 'install', '--require-hashes', '--no-deps', '-r', path.join(source, 'build-requirements.lock')], options);
  run(stagingPython, ['-m', 'pip', '--isolated', 'install', '--no-build-isolation', '--no-deps', source], options);
  validatePythonImports(stagingPython, options);
  validateConfiguredBin(stagingBin, options);
  writeFileSync(path.join(staging, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' });

  try {
    // Publishing a symlink is atomic and fails if another launcher already
    // owns this namespace; unlike directory rename, it cannot replace a stale
    // empty runtime. Keep the uniquely built source directory for every result.
    symlinkSync(staging, destination, 'dir');
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    // A concurrent launcher published this same immutable hash namespace first.
  }
  return validateReceipt(destination, receipt, options);
}

function main() {
  const bin = process.env.PRINTER_CALIBRATION_BIN;
  const python = process.env.PRINTER_CALIBRATION_PYTHON;
  if (bin) validateConfiguredBin(bin);
  if (python) validateConfiguredPython(python);
  if (bin || python) {
    // Explicit operator configuration is authoritative and is never replaced.
    console.log(bin || python);
    return;
  }
  const prepared = preparePrinterCalibration(projectRoot, { log: message => console.error(message) });
  console.log(prepared.bin);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`Printer calibration runtime preparation failed: ${error.message}`);
    process.exitCode = 1;
  }
}
