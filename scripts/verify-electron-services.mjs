#!/usr/bin/env node
/**
 * Preflight verification for the desktop development launcher.
 *
 * Checks the services ./run-electron.sh depends on BEFORE any frontend or
 * Electron process starts:
 *
 *  1. Server build entrypoints (hard): the desktop app calls startServer and,
 *     when present, startServerRuntime from server/dist. A stale or foreign
 *     build that lacks them would silently degrade the app (in particular the
 *     calibration harness backend), so the launcher fails early instead.
 *     The compiled module is text-scanned, never imported: importing the
 *     server entrypoint has load-time side effects (database open, schedulers).
 *  2. Native microservice artifact (hard): the staged manifest must parse and
 *     the binary inside the artifact root must be a regular file, executable,
 *     and match the manifest SHA-256. This mirrors the runtime validation in
 *     electron/microservice-manager.ts so corruption is caught before the GUI.
 *  3. Calibration harness connection (informational, never blocks launch):
 *     the operator-provisioned userData config is validated with the same
 *     rules as electron/calibration-harness-config.ts and the backend origin
 *     is probed. A loopback origin that is not listening yet is expected: the
 *     desktop app runs its own backend on a random port and retargets loopback
 *     origins at startup. An unreachable REMOTE origin would make
 *     "Connect configured service" fail, so it is reported as a warning.
 *
 * Exit codes: 0 = ready (warnings allowed), 1 = a required service is broken.
 */
import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const CONFIG_MAX_BYTES = 16 * 1024;
const CREDENTIAL_PATTERN = /^calibration_pair_[A-Za-z0-9_-]{43}$/;
const CONFIG_KEYS = ['backendOrigin', 'credential', 'harnessId', 'version'];
const PROBE_TIMEOUT_MS = 3000;

function parseArgs(argv) {
  const args = { projectDir: process.cwd(), configPath: null, probe: true };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--project-dir') args.projectDir = path.resolve(argv[++i] ?? '');
    else if (arg === '--config') args.configPath = path.resolve(argv[++i] ?? '');
    else if (arg === '--no-probe') args.probe = false;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (args.projectDir === '') throw new Error('--project-dir requires a value');
  return args;
}

function defaultHarnessConfigPath() {
  const home = os.homedir();
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Electron', 'calibration-harness.connection.json');
  }
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'Electron', 'calibration-harness.connection.json');
  }
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(home, '.config'), 'Electron', 'calibration-harness.connection.json');
}

function report(level, label, detail = '') {
  const line = detail === '' ? `  [${level}] ${label}` : `  [${level}] ${label}: ${detail}`;
  if (level === 'fail') process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
}

// ---------------------------------------------------------------------------
// Check 1: server build entrypoints (text scan; the module is never imported)
// ---------------------------------------------------------------------------

function exportedFunctionPresent(source, name) {
  const declaration = new RegExp(`\\bexport\\s+(?:declare\\s+)?(?:async\\s+)?function\\s+${name}\\s*\\(`);
  const clause = new RegExp(`\\bexport\\s+\\{[^}]*\\b${name}\\b[^}]*\\}`);
  return declaration.test(source) || clause.test(source);
}

async function checkServerEntryPoints(projectDir) {
  const filename = path.join(projectDir, 'server', 'dist', 'server', 'src', 'index.js');
  let source;
  try {
    source = await readFile(filename, 'utf8');
  } catch {
    report('fail', 'server build', `missing ${path.join('server', 'dist', 'server', 'src', 'index.js')} (Run npm run build:parallel first.)`);
    return false;
  }
  if (!exportedFunctionPresent(source, 'startServer')) {
    report('fail', 'server build', `does not export startServer (stale or foreign build; Run npm run build:parallel first.)`);
    return false;
  }
  if (!exportedFunctionPresent(source, 'startServerRuntime')) {
    report('warn', 'server build', 'does not export startServerRuntime: the calibration harness backend will be disabled until the server is rebuilt (Run npm run build:parallel).');
  } else {
    report('ok', 'server build entrypoints (startServer, startServerRuntime)');
  }
  return true;
}

// ---------------------------------------------------------------------------
// Check 2: staged native microservice artifact
// ---------------------------------------------------------------------------

async function checkMicroserviceArtifact(projectDir) {
  const root = path.join(projectDir, 'electron', 'dist', 'microservice-package');
  const manifestPath = path.join(root, 'microservice-artifact.json');
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch {
    report('fail', 'native microservice artifact', `manifest missing or unreadable at ${path.relative(projectDir, manifestPath)} (Run npm run build:electron:prerequisites).`);
    return false;
  }
  const binary = manifest?.binary;
  if (
    typeof binary?.fileName !== 'string' || binary.fileName.length === 0
    || typeof binary?.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(binary.sha256)
  ) {
    report('fail', 'native microservice artifact', 'manifest is missing its binary fileName/sha256 (Run npm run build:electron:prerequisites).');
    return false;
  }
  const binaryPath = path.join(root, binary.fileName);  if (path.dirname(binaryPath) !== root) {
    report('fail', 'native microservice artifact', 'manifest binary path escapes the artifact root (Run npm run build:electron:prerequisites).');
    return false;
  }
  let stat;
  try {
    stat = await lstat(binaryPath);
  } catch {
    report('fail', 'native microservice artifact', `staged binary ${binary.fileName} is missing (Run npm run build:electron:prerequisites).`);
    return false;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    report('fail', 'native microservice artifact', `staged binary ${binary.fileName} is not a regular file (Run npm run build:electron:prerequisites).`);
    return false;
  }
  if (process.platform !== 'win32' && (stat.mode & 0o111) === 0) {
    report('fail', 'native microservice artifact', `staged binary ${binary.fileName} is not executable (Run npm run build:electron:prerequisites).`);
    return false;
  }
  const digest = createHash('sha256').update(await readFile(binaryPath)).digest('hex');
  if (digest !== binary.sha256) {
    report('fail', 'native microservice artifact', `staged binary ${binary.fileName} does not match the manifest SHA-256 (Run npm run build:electron:prerequisites).`);
    return false;
  }
  report('ok', `native microservice artifact (${binary.fileName}, sha256 verified)`);
  return true;
}

// ---------------------------------------------------------------------------
// Check 3: optional calibration harness connection
// ---------------------------------------------------------------------------

function isCanonicalBackendOrigin(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  const loopbackHttp = parsed.protocol === 'http:'
    && (parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]');
  return (parsed.protocol === 'https:' || loopbackHttp)
    && parsed.username === ''
    && parsed.password === ''
    && parsed.pathname === '/'
    && parsed.search === ''
    && parsed.hash === ''
    && parsed.origin === value;
}

function isBoundedIdentity(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) return false;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return false;
  }
  return true;
}

// Mirrors electron/calibration-harness-config.ts; kept dependency-free so the
// launcher can run it on plain Node without type stripping.
function validateHarnessConfig(bytes) {
  if (bytes.byteLength > CONFIG_MAX_BYTES) return 'larger than 16 KiB';
  let value;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return 'is not valid JSON';
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return 'is not a JSON object';
  const names = Object.getOwnPropertyNames(value).sort();
  const expected = [...CONFIG_KEYS].sort();
  if (names.length !== expected.length || names.some((name, index) => name !== expected[index])) {
    return `has unexpected keys (expected exactly: ${CONFIG_KEYS.join(', ')})`;
  }
  if (value.version !== 1) return 'has unsupported version (expected 1)';
  if (!isCanonicalBackendOrigin(value.backendOrigin)) return 'has a non-canonical backendOrigin';
  if (!isBoundedIdentity(value.harnessId)) return 'has an invalid harnessId';
  if (typeof value.credential !== 'string' || !CREDENTIAL_PATTERN.test(value.credential)) return 'has an invalid credential';
  return null;
}

async function probeHarnessOrigin(origin) {
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    return null;
  }
  const isLoopback = parsed.hostname === '127.0.0.1' || parsed.hostname === '::1' || parsed.hostname === '[::1]';
  const attempt = new Promise((resolve) => {
    const socket = net.connect({ host: parsed.hostname === '[::1]' ? '::1' : parsed.hostname, port: Number(parsed.port) || (parsed.protocol === 'https:' ? 443 : 80) });
    const timer = setTimeout(() => { socket.destroy(); resolve({ kind: 'timeout' }); }, PROBE_TIMEOUT_MS);
    // destroy() (not end()) so the probe never leaves a handle that keeps the
    // launcher child process alive.
    socket.once('error', (error) => { clearTimeout(timer); socket.destroy(); resolve({ kind: 'refused', code: error.code }); });
    socket.once('connect', () => { clearTimeout(timer); socket.destroy(); resolve({ kind: 'open' }); });
  });
  const result = await attempt;
  if (result.kind === 'open') {
    // A live listener is enough for preflight: the desktop app performs the
    // real authenticated session check at connect time.
    return { reachable: true, loopback: isLoopback };
  }
  return { reachable: false, loopback: isLoopback };
}

async function checkHarnessConnection(configPath, probe) {
  let stat;
  try {
    stat = await lstat(configPath);
  } catch {
    report('info', 'calibration harness', 'not configured (optional service; connect from the calibration modal when needed).');
    return;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    report('warn', 'calibration harness', `config path is not a regular file; "Connect configured service" will fail until it is repaired.`);
    return;
  }
  if (process.platform !== 'win32') {
    const uid = typeof process.getuid === 'function' ? process.getuid() : null;
    if ((stat.mode & 0o777) !== 0o600 || (uid !== null && stat.uid !== uid)) {
      report('warn', 'calibration harness', `config file is not a private 0600 file owned by this user; "Connect configured service" will refuse it.`);
    }
  }
  const problem = validateHarnessConfig(await readFile(configPath));
  if (problem !== null) {
    report('warn', 'calibration harness', `config file ${problem}; "Connect configured service" will fail until it is repaired.`);
    return;
  }
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  if (!probe) {
    report('ok', `calibration harness configured (${config.backendOrigin}); origin probe skipped`);
    return;
  }
  const status = await probeHarnessOrigin(config.backendOrigin);
  if (status === null) {
    report('warn', 'calibration harness', 'configured origin is not parseable; "Connect configured service" will fail.');
    return;
  }
  if (!status.reachable) {
    if (status.loopback) {
      report('ok', `calibration harness configured (${config.backendOrigin})`, 'loopback port is not listening yet; the desktop app runs its own backend and targets its local server port at startup.');
    } else {
      report('warn', `calibration harness configured (${config.backendOrigin})`, 'backend is unreachable; "Connect configured service" will fail until it is up.');
    }
    return;
  }
  report('ok', `calibration harness configured (${config.backendOrigin})`, 'backend is listening; the app verifies the credential at connect time.');
}

// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  process.stdout.write('Verifying Proxxied desktop services...\n');
  const checks = [
    checkServerEntryPoints(args.projectDir),
    checkMicroserviceArtifact(args.projectDir),
  ];
  let ready = true;
  for (const check of checks) {
    if (!(await check)) ready = false;
  }
  await checkHarnessConnection(args.configPath ?? defaultHarnessConfigPath(), args.probe);
  if (!ready) {
    process.stderr.write('Required services are not set up; nothing was started.\n');
    process.exit(1);
  }
  process.stdout.write('Required services are ready.\n');
}

main().catch((error) => {
  process.stderr.write(`Service verification failed: ${error?.message ?? error}\n`);
  process.exit(1);
});
