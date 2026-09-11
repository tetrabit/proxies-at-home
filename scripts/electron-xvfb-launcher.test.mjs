import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifacts = path.join(root, '.review-artifacts', 'electron-xvfb-launcher-tests');

async function evidenceDirectory() {
  await mkdir(artifacts, { recursive: true });
  return mkdtemp(path.join(artifacts, 'case-'));
}

test('starts an owned private Xvfb display and reaps only that exact PID', async () => {
  const { startOwnedXvfb } = await import('./electron-xvfb-launcher.mjs');
  const evidence = await evidenceDirectory();
  const display = await startOwnedXvfb({ evidence, parentEnv: { DISPLAY: ':0', WAYLAND_DISPLAY: 'wayland-1' } });
  try {
    assert.match(display.display, /^:\d+$/);
    assert.notEqual(display.display, ':0');
    assert.equal(display.env.DISPLAY, display.display);
    assert.equal(display.env.WAYLAND_DISPLAY, undefined);
    assert.equal(display.env.ELECTRON_OZONE_PLATFORM_HINT, 'x11');
    assert.ok(display.chromiumArgs.includes('--ozone-platform=x11'));
    assert.ok(!display.chromiumArgs.some(arg => arg === '--no-sandbox' || arg === '--disable-setuid-sandbox'));
    assert.ok(display.pid > 0);
  } finally {
    await display.close();
  }
  assert.throws(() => process.kill(display.pid, 0), { code: 'ESRCH' });
  const report = JSON.parse(await readFile(path.join(evidence, 'xvfb.json'), 'utf8'));
  assert.equal(report.lifecycle, 'reaped');
  assert.equal(report.parentDisplay, ':0');
  assert.equal(report.display, display.display);
  assert.deepEqual(report.command.slice(1), ['-displayfd', '3', '-screen', '0', '1280x1024x24', '-nolisten', 'tcp', '-noreset']);
});

test('closes a launched Electron process before reaping Xvfb when runtime isolation verification fails', async () => {
  const { launchElectronOnOwnedXvfb } = await import('./electron-xvfb-launcher.mjs');
  const evidence = await evidenceDirectory();
  let closeCalls = 0;
  await assert.rejects(
    launchElectronOnOwnedXvfb({
      evidence,
      parentEnv: { DISPLAY: ':0' },
      args: ['main.js'],
      launch: async () => ({
        evaluate: async () => ({ display: ':0', waylandDisplay: 'wayland-1', ozonePlatform: '--ozone-platform=wayland' }),
        close: async () => { closeCalls++; },
      }),
    }),
    /Electron isolation verification failed/
  );
  assert.equal(closeCalls, 1);
  const report = JSON.parse(await readFile(path.join(evidence, 'xvfb.json'), 'utf8'));
  assert.equal(report.lifecycle, 'reaped');
});

test('preserves the probe profile, database, and native binding from launchOptions.env', async () => {
  const { launchElectronOnOwnedXvfb } = await import('./electron-xvfb-launcher.mjs');
  const evidence = await evidenceDirectory();
  const env = {
    DISPLAY: ':0', WAYLAND_DISPLAY: 'wayland-1', NODE_ENV: 'development',
    XDG_CONFIG_HOME: path.join(evidence, 'config'),
    XDG_CACHE_HOME: path.join(evidence, 'cache'),
    SERVER_DATA_DIR: path.join(evidence, 'data'),
    PROXXIED_SQLITE_NATIVE_BINDING: path.join(evidence, 'sqlite.node'),
  };
  let actual;
  const owned = await launchElectronOnOwnedXvfb({
    evidence, args: ['main.js'], launchOptions: { env },
    launch: async options => {
      actual = options.env;
      return {
        evaluate: async () => ({ display: actual.DISPLAY, waylandDisplay: actual.WAYLAND_DISPLAY ?? null, ozonePlatform: '--ozone-platform=x11' }),
        close: async () => {},
      };
    },
  });
  try {
    for (const key of ['NODE_ENV', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'SERVER_DATA_DIR', 'PROXXIED_SQLITE_NATIVE_BINDING']) {
      assert.equal(actual[key], env[key], `lost isolated ${key}`);
    }
    assert.equal(actual.WAYLAND_DISPLAY, undefined);
    assert.notEqual(actual.DISPLAY, env.DISPLAY);
  } finally {
    await owned.close();
  }
});

test('fails closed when sandbox-disabling or conflicting ozone flags are supplied', async () => {
  const { isolatedElectronLaunchConfig } = await import('./electron-xvfb-launcher.mjs');
  assert.throws(
    () => isolatedElectronLaunchConfig({ display: ':91', parentEnv: { DISPLAY: ':0', WAYLAND_DISPLAY: 'wayland-1' }, args: ['main.js', '--no-sandbox'] }),
    /forbidden sandbox-disabling/
  );
  assert.throws(
    () => isolatedElectronLaunchConfig({ display: ':91', parentEnv: { DISPLAY: ':0' }, args: ['main.js', '--ozone-platform=wayland'] }),
    /must not override --ozone-platform=x11/
  );
  assert.throws(
    () => isolatedElectronLaunchConfig({ display: ':0', parentEnv: { DISPLAY: ':0' }, args: ['main.js'] }),
    /Refusing inherited DISPLAY/
  );
});
