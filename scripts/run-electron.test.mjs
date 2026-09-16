import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, writeFile, symlink } from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtures = path.join(root, '.review-artifacts', 'electron-launcher-tests');

test('Compose publishes Docker web and API only on IPv4 loopback', () => {
  const result = spawnSync('docker', ['compose', 'config', '--format', 'json'], {
    cwd: root, encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const config = JSON.parse(result.stdout);
  for (const [service, target, published] of [['client', 80, '5173'], ['server', 3001, '3001']]) {
    assert.deepEqual(config.services[service].ports.map(port => ({
      host_ip: port.host_ip, target: port.target, published: port.published,
    })), [{ host_ip: '127.0.0.1', target, published }]);
  }
});

async function fixture({ omit } = {}) {
  await mkdir(fixtures, { recursive: true });
  const dir = await mkdtemp(path.join(fixtures, 'project with spaces-'));
  async function file(relative, contents) {
    const target = path.join(dir, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents);
  }
  await file('run-electron.sh', await readFile(path.join(root, 'run-electron.sh')));
  for (const name of ['concurrently', 'wait-on']) {
    await mkdir(path.join(dir, 'node_modules'), { recursive: true });
    await symlink(path.join(root, 'node_modules', name), path.join(dir, 'node_modules', name));
  }
  for (const name of ['electron/dist/main.js', 'electron/dist/preload.cjs']) {
    if (name !== omit) await file(name, '{}');
  }
  if (omit !== 'server/dist/server/src/index.js') {
    await file('server/dist/server/src/index.js', 'export async function startServer() {}\nexport async function startServerRuntime() {}\n');
  }
  if (omit !== 'electron/dist/microservice-package/microservice-artifact.json') {
    const binaryContents = 'fixture native binary\n';
    await file('electron/dist/microservice-package/scryfall-cache-fixture', binaryContents);
    await chmod(path.join(dir, 'electron', 'dist', 'microservice-package', 'scryfall-cache-fixture'), 0o755);
    await file('electron/dist/microservice-package/microservice-artifact.json', JSON.stringify({
      schemaVersion: 2,
      binary: { fileName: 'scryfall-cache-fixture', sha256: createHash('sha256').update(binaryContents).digest('hex') },
    }));
  }
  await file('scripts/verify-electron-services.mjs', `
    import { appendFileSync } from 'node:fs';
    appendFileSync('verify-services.log', 'verified\\n');
    if (process.env.LAUNCHER_FIXTURE_VERIFY_FAIL) process.exit(28);
  `);
  await file('node_modules/electron/dist/electron', 'fixture');
  await file('scripts/prepare-electron-sqlite.mjs', `console.log(${JSON.stringify(path.join(dir, 'electron-fixture.node'))});`);
  await file('scripts/prepare-printer-calibration.mjs', `
    import { appendFileSync } from 'node:fs';
    import { join } from 'node:path';
    appendFileSync('printer-calibration-prepare.log', 'prepared\\n');
    if (process.env.LAUNCHER_FIXTURE_PRINTER_PREP_FAIL) process.exit(31);
    console.log(process.env.PRINTER_CALIBRATION_BIN || process.env.PRINTER_CALIBRATION_PYTHON || join(process.cwd(), 'printer-calibration-fixture', 'bin', 'printer-calibration'));
  `);
  await file('scripts/build-electron-main.mjs', `
    import { appendFileSync, writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    appendFileSync('electron-build.log', 'built\\n');
    if (process.env.LAUNCHER_FIXTURE_BUILD_FAIL) process.exit(29);
    for (const [name, contents] of Object.entries({
      'main.js': 'registerCalibrationHarnessIpcHandlers',
      'preload.cjs': 'calibrationHarnessExecute',
      'preload-api.js': 'preload api',
      'microservice-manager.js': 'microservice manager',
      'quit-gate.js': 'quit gate',
      'mpc-preferences.js': 'mpc preferences',
      'calibration-harness-ipc.js': 'calibration ipc',
      'package.json': '{"type":"module"}\\n',
    })) writeFileSync(join('electron', 'dist', name), contents);
  `);
  await file('client/node_modules/vite/bin/vite.js', `
    const assert = require('node:assert/strict');
    assert.deepEqual(process.argv.slice(2), ['--host', '::1', '--port', '5173', '--strictPort']);
    const fs = require('node:fs');
    const http = require('node:http');
    fs.writeFileSync('frontend.pid', String(process.pid));
    if (process.env.LAUNCHER_FIXTURE_FRONTEND_FAIL) process.exit(23);
    const server = http.createServer((_req, res) => res.end('fixture frontend'));
    server.listen(5173, '::1', () => console.log('FIXTURE_FRONTEND_READY'));
  `);
  await file('node_modules/electron/cli.js', `
    const assert = require('node:assert/strict');
    const fs = require('node:fs');
    fs.writeFileSync('electron.pid', String(process.pid));
    assert.equal(process.env.NODE_ENV, 'development');
    assert.equal(process.env.ELECTRON_RUN_AS_NODE, undefined);
    assert.equal(process.env.PROXXIED_SQLITE_NATIVE_BINDING, ${JSON.stringify(path.join(dir, 'electron-fixture.node'))});
    const path = require('node:path');
    assert.equal(process.env.PRINTER_CALIBRATION_BIN, process.env.FIXTURE_EXPECT_PRINTER_BIN || path.join(process.cwd(), 'printer-calibration-fixture', 'bin', 'printer-calibration'));
    assert.equal(process.env.PRINTER_CALIBRATION_PYTHON, process.env.FIXTURE_EXPECT_PRINTER_PYTHON || path.join(process.cwd(), 'printer-calibration-fixture', 'bin', 'python'));
    // The launcher may pass an explicit ozone platform flag before the entrypoint.
    const argv = process.argv.slice(2);
    const ozone = argv.filter((arg) => arg.startsWith('--ozone-platform='));
    assert.equal(argv.length, ozone.length + 1, JSON.stringify(argv));
    assert.equal(argv[argv.length - 1], 'electron/dist/main.js');
    assert.match(fs.readFileSync('electron/dist/main.js', 'utf8'), /registerCalibrationHarnessIpcHandlers/);
    assert.match(fs.readFileSync('electron/dist/preload.cjs', 'utf8'), /calibrationHarnessExecute/);
    fetch('http://localhost:5173').then(async response => {
      assert.equal(await response.text(), 'fixture frontend');
      console.log('FIXTURE_ELECTRON_OPENED');
      if (process.env.LAUNCHER_FIXTURE_HOLD) setInterval(() => {}, 1000);
      else process.exit(process.env.LAUNCHER_FIXTURE_ELECTRON_FAIL ? 17 : 0);
    }).catch(error => { console.error(error); process.exit(1); });
  `);
  return dir;
}

async function launch(dir, { env = {}, args = [], interruptOnReady = false } = {}) {
  const child = spawn('bash', [path.join(dir, 'run-electron.sh'), ...args], {
    cwd: root, detached: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', chunk => {
    output += chunk;
    if (interruptOnReady && output.includes('FIXTURE_ELECTRON_OPENED')) {
      interruptOnReady = false;
      child.kill('SIGINT');
    }
  });
  child.stderr.on('data', chunk => { output += chunk; });
  const timer = setTimeout(() => { process.kill(-child.pid, 'SIGKILL'); }, 15000);
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  }).finally(() => clearTimeout(timer));
  return { code, output };
}

async function assertFrontendGone(dir) {
  const pid = Number(await readFile(path.join(dir, 'client', 'frontend.pid'), 'utf8'));
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
}

test('launcher works from another cwd with spaces, waits for frontend, and cleans up on Electron exit', async () => {
  const dir = await fixture();
  const result = await launch(dir);
  assert.equal(result.code, 0, result.output);
  assert.equal(await readFile(path.join(dir, 'verify-services.log'), 'utf8'), 'verified\n');
  assert.match(result.output, /FIXTURE_FRONTEND_READY/);
  assert.match(result.output, /FIXTURE_ELECTRON_OPENED/);
  await assertFrontendGone(dir);
});

test('a failed service verification prevents frontend and Electron launch', async () => {
  const dir = await fixture();
  const result = await launch(dir, { env: { LAUNCHER_FIXTURE_VERIFY_FAIL: '1' } });
  assert.notEqual(result.code, 0, result.output);
  assert.equal(await readFile(path.join(dir, 'verify-services.log'), 'utf8'), 'verified\n');
  assert.doesNotMatch(result.output, /FIXTURE_FRONTEND_READY|FIXTURE_ELECTRON_OPENED/);
});

test('launcher refreshes the full Electron closure before it opens Electron', async () => {
  const dir = await fixture();
  const result = await launch(dir);
  assert.equal(result.code, 0, result.output);
  assert.equal(await readFile(path.join(dir, 'electron-build.log'), 'utf8'), 'built\n');
  assert.match(await readFile(path.join(dir, 'electron', 'dist', 'main.js'), 'utf8'), /registerCalibrationHarnessIpcHandlers/);
  assert.match(await readFile(path.join(dir, 'electron', 'dist', 'preload.cjs'), 'utf8'), /calibrationHarnessExecute/);
  for (const name of ['preload-api.js', 'microservice-manager.js', 'quit-gate.js', 'mpc-preferences.js', 'calibration-harness-ipc.js', 'package.json']) {
    await readFile(path.join(dir, 'electron', 'dist', name), 'utf8');
  }
  assert.match(result.output, /FIXTURE_ELECTRON_OPENED/);
});

test('launcher keeps explicit validated printer runner paths', async () => {
  const dir = await fixture();
  const bin = path.join(dir, 'operator runtime', 'printer-calibration');
  const python = path.join(dir, 'operator runtime', 'python');
  const result = await launch(dir, {
    env: {
      PRINTER_CALIBRATION_BIN: bin,
      PRINTER_CALIBRATION_PYTHON: python,
      FIXTURE_EXPECT_PRINTER_BIN: bin,
      FIXTURE_EXPECT_PRINTER_PYTHON: python,
    },
  });
  assert.equal(result.code, 0, result.output);
  assert.equal(await readFile(path.join(dir, 'printer-calibration-prepare.log'), 'utf8'), 'prepared\n');
  assert.match(result.output, /FIXTURE_ELECTRON_OPENED/);
});

test('a failed Electron closure rebuild prevents frontend and Electron launch', async () => {
  const dir = await fixture();
  const result = await launch(dir, { env: { LAUNCHER_FIXTURE_BUILD_FAIL: '1' } });
  assert.notEqual(result.code, 0, result.output);
  assert.equal(await readFile(path.join(dir, 'electron-build.log'), 'utf8'), 'built\n');
  assert.doesNotMatch(result.output, /FIXTURE_FRONTEND_READY|FIXTURE_ELECTRON_OPENED/);
});

test('a failed printer runtime preparation prevents frontend and Electron launch', async () => {
  const dir = await fixture();
  const result = await launch(dir, { env: { LAUNCHER_FIXTURE_PRINTER_PREP_FAIL: '1' } });
  assert.notEqual(result.code, 0, result.output);
  assert.equal(await readFile(path.join(dir, 'printer-calibration-prepare.log'), 'utf8'), 'prepared\n');
  assert.doesNotMatch(result.output, /FIXTURE_FRONTEND_READY|FIXTURE_ELECTRON_OPENED/);
});

test('headless Chromium reaches distinct frontends at both preserved origins', async () => {
  await mkdir(fixtures, { recursive: true });
  const directory = await mkdtemp(path.join(fixtures, 'browser-origins-'));
  const listeners = [];
  let context;
  try {
    for (const [host, marker] of [['127.0.0.1', 'docker frontend'], ['::1', 'electron frontend']]) {
      const server = http.createServer((_request, response) => response.end(marker));
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(5173, host, resolve);
      });
      listeners.push(server);
    }
    context = await chromium.launchPersistentContext(path.join(directory, 'profile'), {
      headless: true, chromiumSandbox: true, serviceWorkers: 'block',
    });
    const allowedOrigins = new Set(['http://127.0.0.1:5173', 'http://localhost:5173']);
    await context.route('**/*', route => allowedOrigins.has(new URL(route.request().url()).origin)
      ? route.continue() : route.abort());
    const page = context.pages()[0] ?? await context.newPage();
    const observations = [];
    for (const [origin, marker] of [['http://127.0.0.1:5173', 'docker frontend'], ['http://localhost:5173', 'electron frontend']]) {
      await page.goto(origin);
      const observed = await page.evaluate(() => ({ origin: location.origin, text: document.body.textContent }));
      assert.deepEqual(observed, { origin, text: marker });
      observations.push(observed);
    }
    await writeFile(path.join(directory, 'observations.json'), JSON.stringify(observations), { flag: 'wx' });
  } finally {
    await context?.close();
    await Promise.all(listeners.map(server => new Promise(resolve => server.close(resolve))));
  }
});

test('missing native staging fails with a useful message before starting anything', async () => {
  const dir = await fixture({ omit: 'electron/dist/microservice-package/microservice-artifact.json' });
  const result = await launch(dir);
  assert.notEqual(result.code, 0, result.output);
  assert.match(result.output, /Missing.*microservice-artifact\.json/);
  assert.doesNotMatch(result.output, /FIXTURE_FRONTEND_READY|FIXTURE_ELECTRON_OPENED/);
});

test('an IPv4 Docker frontend can coexist with the original localhost Electron frontend', async () => {
  const dockerFrontend = http.createServer((_request, response) => response.end('docker frontend'));
  await new Promise((resolve, reject) => {
    dockerFrontend.once('error', reject);
    dockerFrontend.listen(5173, '127.0.0.1', resolve);
  });
  try {
    const dir = await fixture();
    const result = await launch(dir);
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /FIXTURE_ELECTRON_OPENED/);
    assert.equal(await (await fetch('http://127.0.0.1:5173')).text(), 'docker frontend');
    assert.equal(dockerFrontend.listening, true);
    await assertFrontendGone(dir);
  } finally {
    await new Promise(resolve => dockerFrontend.close(resolve));
  }
});

test('Electron failure returns a failure and still cleans up its frontend', async () => {
  const dir = await fixture();
  const result = await launch(dir, { env: { LAUNCHER_FIXTURE_ELECTRON_FAIL: '1' } });
  assert.notEqual(result.code, 0, result.output);
  assert.match(result.output, /FIXTURE_ELECTRON_OPENED/);
  await assertFrontendGone(dir);
});

test('frontend failure stops the waiter without opening Electron', async () => {
  const dir = await fixture();
  const result = await launch(dir, { env: { LAUNCHER_FIXTURE_FRONTEND_FAIL: '1' } });
  assert.notEqual(result.code, 0, result.output);
  assert.doesNotMatch(result.output, /FIXTURE_ELECTRON_OPENED/);
  await assertFrontendGone(dir);
});

test('an occupied port fails early without starting or killing a process', async () => {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(5173, 'localhost', resolve);
  });
  try {
    const dir = await fixture();
    const result = await launch(dir);
    assert.notEqual(result.code, 0, result.output);
    assert.match(result.output, /Port 5173 is unavailable/);
    await assert.rejects(readFile(path.join(dir, 'printer-calibration-prepare.log')), { code: 'ENOENT' });
    await assert.rejects(readFile(path.join(dir, 'client', 'frontend.pid')), { code: 'ENOENT' });
    assert.equal(server.listening, true);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('Ctrl+C stops the owned frontend and Electron command', async () => {
  const dir = await fixture();
  const result = await launch(dir, { env: { LAUNCHER_FIXTURE_HOLD: '1' }, interruptOnReady: true });
  assert.notEqual(result.code, null, result.output);
  assert.match(result.output, /FIXTURE_ELECTRON_OPENED/);
  assert.match(result.output, /SIGINT/);
  await assertFrontendGone(dir);
  const electronPid = Number(await readFile(path.join(dir, 'electron.pid'), 'utf8'));
  assert.throws(() => process.kill(electronPid, 0), { code: 'ESRCH' });
});
