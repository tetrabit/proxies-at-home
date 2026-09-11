import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile, symlink } from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtures = path.join(root, '.review-artifacts', 'electron-launcher-tests');

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
  for (const name of ['electron/dist/main.js', 'electron/dist/preload.cjs', 'server/dist/server/src/index.js', 'electron/dist/microservice-package/microservice-artifact.json']) {
    if (name !== omit) await file(name, '{}');
  }
  await file('node_modules/electron/dist/electron', 'fixture');
  await file('scripts/prepare-electron-sqlite.mjs', `console.log(${JSON.stringify(path.join(dir, 'electron-fixture.node'))});`);
  await file('client/node_modules/vite/bin/vite.js', `
    const assert = require('node:assert/strict');
    assert.deepEqual(process.argv.slice(2), ['--host', 'localhost', '--port', '5173', '--strictPort']);
    const fs = require('node:fs');
    const http = require('node:http');
    fs.writeFileSync('frontend.pid', String(process.pid));
    if (process.env.LAUNCHER_FIXTURE_FRONTEND_FAIL) process.exit(23);
    const server = http.createServer((_req, res) => res.end('fixture frontend'));
    server.listen(5173, 'localhost', () => console.log('FIXTURE_FRONTEND_READY'));
  `);
  await file('node_modules/electron/cli.js', `
    const assert = require('node:assert/strict');
    require('node:fs').writeFileSync('electron.pid', String(process.pid));
    assert.equal(process.env.NODE_ENV, 'development');
    assert.equal(process.env.ELECTRON_RUN_AS_NODE, undefined);
    assert.equal(process.env.PROXXIED_SQLITE_NATIVE_BINDING, ${JSON.stringify(path.join(dir, 'electron-fixture.node'))});
    assert.deepEqual(process.argv.slice(2), ['electron/dist/main.js']);
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
  assert.match(result.output, /FIXTURE_FRONTEND_READY/);
  assert.match(result.output, /FIXTURE_ELECTRON_OPENED/);
  await assertFrontendGone(dir);
});

test('missing native staging fails with a useful message before starting anything', async () => {
  const dir = await fixture({ omit: 'electron/dist/microservice-package/microservice-artifact.json' });
  const result = await launch(dir);
  assert.notEqual(result.code, 0, result.output);
  assert.match(result.output, /Missing.*microservice-artifact\.json/);
  assert.doesNotMatch(result.output, /FIXTURE_FRONTEND_READY|FIXTURE_ELECTRON_OPENED/);
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
