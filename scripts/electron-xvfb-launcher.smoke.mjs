import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron } from 'playwright';
import { expect } from '@playwright/test';
import { assertFrontendReady, launchElectronOnOwnedXvfb } from './electron-xvfb-launcher.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const evidence = path.join(root, '.review-artifacts', `electron-xvfb-launcher-smoke-${randomUUID()}`);
await mkdir(evidence, { recursive: true });
const main = path.join(evidence, 'minimal-main.cjs');
let owned;
let report = { schema: 'electron-xvfb-launcher-smoke/v1', evidence, passed: false };
try {
  await assertFrontendReady({ evidence });
  await writeFile(main, `
    const { app, BrowserWindow } = require('electron');
    app.whenReady().then(async () => {
      const window = new BrowserWindow({ width: 640, height: 480, show: false });
      await window.loadURL('data:text/html,<main><h1>Xvfb-only Electron probe</h1><p>invisible desktop smoke</p></main>');
    });
  `);
  const env = { ...process.env, XDG_CONFIG_HOME: path.join(evidence, 'config'), XDG_CACHE_HOME: path.join(evidence, 'cache') };
  delete env.ELECTRON_RUN_AS_NODE;
  owned = await launchElectronOnOwnedXvfb({
    evidence,
    parentEnv: env,
    args: [main],
    launch: options => _electron.launch({ ...options, cwd: root, timeout: 30_000 }),
  });
  await expect.poll(() => owned.app.windows().length, { timeout: 10_000 }).toBe(1);
  const page = owned.app.windows()[0];
  await page.getByRole('heading', { name: 'Xvfb-only Electron probe' }).waitFor({ state: 'visible', timeout: 10_000 });
  const screenshot = path.join(evidence, 'page.png');
  await page.screenshot({ path: screenshot });
  report = { ...report, passed: true, screenshot, isolation: { display: owned.display, xvfbPid: owned.pid, runtime: owned.runtime } };
} catch (error) {
  report.failure = error.stack ?? String(error);
  process.exitCode = 1;
} finally {
  try {
    const pid = owned?.pid;
    await owned?.close();
    if (pid) {
      assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
      report.cleanup = { xvfbPid: pid, reaped: true };
    }
  } catch (error) {
    report.cleanupFailure = error.stack ?? String(error);
    process.exitCode = 1;
  }
  await rm(main, { force: true });
  await writeFile(path.join(evidence, 'report.json'), JSON.stringify(report, null, 2));
}
console.log(JSON.stringify(report, null, 2));
if (!report.passed || report.cleanupFailure) process.exitCode = 1;
