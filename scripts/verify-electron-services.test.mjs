import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, unlink, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(root, 'scripts', 'verify-electron-services.mjs');
const fixturesRoot = path.join(root, '.review-artifacts', 'electron-launcher-tests');
const BINARY_CONTENT = 'fixture native binary\n';

const CREDENTIAL = `calibration_pair_${'a'.repeat(43)}`;

async function fixtureProject() {
  await mkdir(fixturesRoot, { recursive: true });
  const dir = await mkdtemp(path.join(fixturesRoot, 'verify-services-'));
  const serverEntry = path.join(dir, 'server', 'dist', 'server', 'src', 'index.js');
  await mkdir(path.dirname(serverEntry), { recursive: true });
  await writeFile(serverEntry, 'export async function startServer(port = 3001) {}\nexport async function startServerRuntime(port = 3001) {}\n');
  const artifactRoot = path.join(dir, 'electron', 'dist', 'microservice-package');
  await mkdir(artifactRoot, { recursive: true });
  await writeFile(path.join(artifactRoot, 'scryfall-cache'), BINARY_CONTENT);
  await chmod(path.join(artifactRoot, 'scryfall-cache'), 0o755);
  await writeFile(path.join(artifactRoot, 'microservice-artifact.json'), JSON.stringify({
    schemaVersion: 2,
    binary: { fileName: 'scryfall-cache', sha256: createHash('sha256').update(BINARY_CONTENT).digest('hex') },
  }));
  return dir;
}

function runVerifier(dir, extraArgs = []) {
  const result = spawnSync(process.execPath, [script, '--project-dir', dir, ...extraArgs], { encoding: 'utf8' });
  return { code: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

async function harnessConfig(dir, value, { mode = 0o600 } = {}) {
  const configPath = path.join(dir, 'harness-config.json');
  const contents = typeof value === 'string' ? value : JSON.stringify(value);
  await writeFile(configPath, contents, { mode });
  if (process.platform !== 'win32') await chmod(configPath, mode);
  return configPath;
}

function validConfig(overrides = {}) {
  return {
    version: 1,
    backendOrigin: 'http://127.0.0.1:39999',
    harnessId: `harness-${'x'.repeat(8)}`,
    credential: CREDENTIAL,
    ...overrides,
  };
}

async function freeLoopbackPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test('a fully prepared project passes with all services reported', async () => {
  const dir = await fixtureProject();
  const config = await harnessConfig(dir, validConfig());
  const result = runVerifier(dir, ['--config', config, '--no-probe']);
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /server build entrypoints \(startServer, startServerRuntime\)/);
  assert.match(result.output, /native microservice artifact \(scryfall-cache, sha256 verified\)/);
  assert.match(result.output, /origin probe skipped/);
  assert.match(result.output, /Required services are ready\./);
});

test('a missing server build fails before anything is reported ready', async () => {
  const dir = await fixtureProject();
  await unlink(path.join(dir, 'server', 'dist', 'server', 'src', 'index.js'));
  const result = runVerifier(dir, ['--no-probe']);
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /missing server\/dist\/server\/src\/index\.js/);
  assert.match(result.output, /Required services are not set up/);
  assert.doesNotMatch(result.output, /Required services are ready/);
});

test('a server build without startServer fails with a rebuild hint', async () => {
  const dir = await fixtureProject();
  await writeFile(path.join(dir, 'server', 'dist', 'server', 'src', 'index.js'), 'export function createApp() {}\n');
  const result = runVerifier(dir, ['--no-probe']);
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /does not export startServer/);
  assert.match(result.output, /npm run build:parallel/);
});

test('a legacy server build without startServerRuntime warns but stays ready', async () => {
  const dir = await fixtureProject();
  await writeFile(path.join(dir, 'server', 'dist', 'server', 'src', 'index.js'), 'export async function startServer(port = 3001) {}\n');
  const result = runVerifier(dir, ['--no-probe']);
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /does not export startServerRuntime/);
  assert.match(result.output, /calibration harness backend will be disabled/);
  assert.match(result.output, /Required services are ready\./);
});

test('a missing staged binary fails with a prerequisites hint', async () => {
  const dir = await fixtureProject();
  await unlink(path.join(dir, 'electron', 'dist', 'microservice-package', 'scryfall-cache'));
  const result = runVerifier(dir, ['--no-probe']);
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /staged binary scryfall-cache is missing/);
  assert.match(result.output, /build:electron:prerequisites/);
});

test('a hash-mismatched staged binary fails', async () => {
  const dir = await fixtureProject();
  await writeFile(path.join(dir, 'electron', 'dist', 'microservice-package', 'scryfall-cache'), 'tampered\n');
  const result = runVerifier(dir, ['--no-probe']);
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /does not match the manifest SHA-256/);
});

test('a non-executable staged binary fails on POSIX', { skip: process.platform === 'win32' }, async () => {
  const dir = await fixtureProject();
  await chmod(path.join(dir, 'electron', 'dist', 'microservice-package', 'scryfall-cache'), 0o644);
  const result = runVerifier(dir, ['--no-probe']);
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /is not executable/);
});

test('a manifest escaping the artifact root fails', async () => {
  const dir = await fixtureProject();
  await writeFile(path.join(dir, 'electron', 'dist', 'microservice-package', 'microservice-artifact.json'), JSON.stringify({
    schemaVersion: 2,
    binary: { fileName: '../escape', sha256: '0'.repeat(64) },
  }));
  const result = runVerifier(dir, ['--no-probe']);
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /escapes the artifact root/);
});

test('an unparseable manifest fails', async () => {
  const dir = await fixtureProject();
  await writeFile(path.join(dir, 'electron', 'dist', 'microservice-package', 'microservice-artifact.json'), 'not json');
  const result = runVerifier(dir, ['--no-probe']);
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /manifest missing or unreadable/);
});

test('an absent harness config reports the optional service as not configured', async () => {
  const dir = await fixtureProject();
  const result = runVerifier(dir, ['--config', path.join(dir, 'absent-config.json'), '--no-probe']);
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /not configured \(optional service/);
});

test('an invalid harness config warns without blocking launch', async () => {
  const dir = await fixtureProject();
  const bad = await harnessConfig(dir, validConfig({ credential: 'not-a-credential' }));
  const result = runVerifier(dir, ['--config', bad, '--no-probe']);
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /has an invalid credential/);
  assert.match(result.output, /will fail until it is repaired/);
  assert.match(result.output, /Required services are ready\./);
});

test('a malformed harness config json warns with the JSON reason', async () => {
  const dir = await fixtureProject();
  const bad = await harnessConfig(dir, '{not json');
  const result = runVerifier(dir, ['--config', bad, '--no-probe']);
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /is not valid JSON/);
});

test('a harness config with unexpected keys warns', async () => {
  const dir = await fixtureProject();
  const bad = await harnessConfig(dir, { ...validConfig(), ownerId: 'invented' });
  const result = runVerifier(dir, ['--config', bad, '--no-probe']);
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /has unexpected keys/);
});

test('a non-private harness config warns on POSIX', { skip: process.platform === 'win32' }, async () => {
  const dir = await fixtureProject();
  const open = await harnessConfig(dir, validConfig(), { mode: 0o644 });
  const result = runVerifier(dir, ['--config', open, '--no-probe']);
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /not a private 0600 file/);
});

test('a stale loopback harness origin is recognized as expected app-owned state', async () => {
  const dir = await fixtureProject();
  const port = await freeLoopbackPort();
  const config = await harnessConfig(dir, validConfig({ backendOrigin: `http://127.0.0.1:${port}` }));
  const result = runVerifier(dir, ['--config', config]);
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /loopback port is not listening yet/);
  assert.match(result.output, /Required services are ready\./);
});

test('an unreachable remote harness origin warns', async () => {
  const dir = await fixtureProject();
  const config = await harnessConfig(dir, validConfig({ backendOrigin: 'https://192.0.2.1:8443' }));
  const result = runVerifier(dir, ['--config', config]);
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /backend is unreachable/);
});

test('a listening harness origin is reported as reachable', async () => {
  const dir = await fixtureProject();
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const config = await harnessConfig(dir, validConfig({ backendOrigin: `http://127.0.0.1:${server.address().port}` }));
    const result = runVerifier(dir, ['--config', config]);
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /backend is listening; the app verifies the credential at connect time/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('the real repository passes preflight', async () => {
  const result = runVerifier(root, ['--no-probe']);
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /Required services are ready\./);
});
