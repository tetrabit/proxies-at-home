#!/usr/bin/env node
/**
 * Starts only the supplied isolated native build with an owned SQLite fixture.
 * It proves the runtime configuration from /health and owns SIGTERM shutdown.
 */
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { access, appendFile, mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const buildRoot = path.resolve(process.argv[2] ?? '');
if (!buildRoot || buildRoot === repositoryRoot) {
  throw new Error('usage: node scripts/probe-native-sqlite-isolated.mjs <isolated-build-root>');
}
const binary = path.join(buildRoot, 'target', 'release', 'scryfall-cache');
await access(binary);

const runtimeRoot = path.join(buildRoot, `runtime-${randomUUID()}`);
const databasePath = path.join(runtimeRoot, 'fixture.db');
const stdoutPath = path.join(runtimeRoot, 'stdout.log');
const stderrPath = path.join(runtimeRoot, 'stderr.log');
const reportPath = path.join(runtimeRoot, 'report.json');
await mkdir(runtimeRoot, { recursive: false });

async function reserveLoopbackPort() {
  const server = createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (typeof address === 'string' || !address) throw new Error('failed to reserve a loopback TCP port');
  const { port } = address;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

const port = await reserveLoopbackPort();
const environment = { ...process.env };
delete environment.DATABASE_URL;
Object.assign(environment, {
  API_HOST: '127.0.0.1',
  API_PORT: String(port),
  SQLITE_PATH: databasePath,
  REDIS_ENABLED: 'false',
  BULK_DATA_LOAD_ON_STARTUP: 'false',
  BULK_REFRESH_ENABLED: 'false',
  RUST_LOG: 'info,scryfall_cache=debug',
});

const child = spawn(binary, [], { env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.on('data', chunk => appendFile(stdoutPath, chunk));
child.stderr.on('data', chunk => appendFile(stderrPath, chunk));
let childExit = null;
child.once('exit', (code, signal) => { childExit = { code, signal }; });

async function responseJson(endpoint) {
  const response = await fetch(`http://127.0.0.1:${port}${endpoint}`);
  const body = await response.json();
  return { status: response.status, body };
}

async function waitForHealth() {
  const deadline = Date.now() + 20_000;
  let lastError;
  while (Date.now() < deadline) {
    if (childExit) throw new Error(`native binary exited before readiness: ${JSON.stringify(childExit)}`);
    try { return await responseJson('/health'); } catch (error) { lastError = error; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`native binary did not become healthy: ${lastError}`);
}

let report;
try {
  const health = await waitForHealth();
  const ready = await responseJson('/health/ready');
  const actualPath = await realpath(databasePath);
  const expectedPath = await realpath(runtimeRoot).then(root => path.join(root, 'fixture.db'));
  const healthDatabase = health.body?.environment?.database;
  if (health.status !== 200 || health.body?.status !== 'healthy') throw new Error(`unexpected health: ${JSON.stringify(health)}`);
  if (ready.status !== 200 || ready.body?.status !== 'ready' || ready.body?.checks?.database !== 'ok') throw new Error(`unexpected readiness: ${JSON.stringify(ready)}`);
  if (healthDatabase?.backend !== 'sqlite' || healthDatabase?.path !== databasePath) throw new Error(`health did not report compiled SQLite fixture: ${JSON.stringify(healthDatabase)}`);
  if (actualPath !== expectedPath || !actualPath.startsWith(`${await realpath(runtimeRoot)}${path.sep}`)) throw new Error(`SQLite path escaped owned fixture: ${actualPath}`);
  report = {
    schema: 'native-sqlite-isolated-probe/v1', status: 'PASS', binary, apiHost: environment.API_HOST,
    apiPort: port, databasePath: actualPath, databaseBackend: healthDatabase.backend,
    databaseHealthPath: healthDatabase.path, health, ready, databaseUrlPresent: Object.hasOwn(environment, 'DATABASE_URL'),
    redisEnabled: environment.REDIS_ENABLED, bulkDataLoadOnStartup: environment.BULK_DATA_LOAD_ON_STARTUP,
    bulkRefreshEnabled: environment.BULK_REFRESH_ENABLED,
  };
} catch (error) {
  report = { schema: 'native-sqlite-isolated-probe/v1', status: 'FAIL', binary, apiHost: environment.API_HOST, apiPort: port, databasePath, error: String(error) };
} finally {
  if (!childExit) {
    child.kill('SIGTERM');
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('owned native process did not stop after SIGTERM')), 10_000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  }
  report.shutdown = childExit;
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
}

if (report.status !== 'PASS') {
  process.stderr.write(`${JSON.stringify(report)}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`${JSON.stringify(report)}\n`);
}
