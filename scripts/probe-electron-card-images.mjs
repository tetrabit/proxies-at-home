import { _electron } from 'playwright';
import { expect } from '@playwright/test';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareElectronSqlite } from './prepare-electron-sqlite.mjs';
import { assertFrontendReady, launchElectronOnOwnedXvfb } from './electron-xvfb-launcher.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const streamMode = process.env.PROBE_STREAM_MODE ?? 'normal';
if (!['normal', 'http-error', 'fatal'].includes(streamMode)) throw new Error('Unsupported PROBE_STREAM_MODE');
const id = randomUUID();
const evidence = path.join(root, '.review-artifacts', `electron-card-images-${id}`);
await mkdir(evidence, { recursive: true });
let logs = '';
let result;
let launchError;
let owned;
let probeMain;
try {
  // Fail before opening an X display or Electron when the parent-owned Vite is absent.
  await assertFrontendReady({ evidence });
  const reservation = net.createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const original = await readFile(path.join(root, 'electron/dist/main.js'), 'utf8');
  if (original.split('createScryfallMicroservice()').length !== 2) throw new Error('Unexpected compiled main seam');
  probeMain = path.join(root, 'electron/dist', `main-image-probe-${id}.js`);
  await writeFile(probeMain, original.replace('createScryfallMicroservice()', `createScryfallMicroservice(${port})`));
  await writeFile(path.join(evidence, 'main-provenance.json'), JSON.stringify({
    originalSha256: createHash('sha256').update(original).digest('hex'),
    probeMain, port, onlySubstitution: 'explicit microservice port',
  }, null, 2));
  const env = {
    ...process.env, NODE_ENV: 'development',
    PROXXIED_SQLITE_NATIVE_BINDING: prepareElectronSqlite(root),
    XDG_CONFIG_HOME: path.join(evidence, 'config'),
    XDG_CACHE_HOME: path.join(evidence, 'cache'),
    SERVER_DATA_DIR: path.join(root, 'server/data', `electron-image-probe-${id}`),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  owned = await launchElectronOnOwnedXvfb({
    evidence,
    args: [probeMain],
    launch: options => _electron.launch({ ...options, cwd: root, timeout: 30_000 }),
    launchOptions: { env },
  });
  const app = owned.app;
  app.process().stdout.on('data', chunk => { logs += chunk; });
  app.process().stderr.on('data', chunk => { logs += chunk; });
  const events = { console: [], errors: [], requests: [], failed: [] };
  await expect.poll(() => app.windows().some(p => p.url().startsWith('http://localhost:5173/')), { timeout: 30_000 }).toBe(true);
  const page = app.windows().find(p => p.url().startsWith('http://localhost:5173/'));
  page.on('console', message => events.console.push({ type: message.type(), text: message.text() }));
  page.on('pageerror', error => events.errors.push(error.message));
  page.on('response', response => events.requests.push({ url: response.url(), status: response.status() }));
  page.on('requestfailed', request => events.failed.push({ url: request.url(), error: request.failure()?.errorText }));
  await page.route('**/api/mpcfill/**', route => route.fulfill({ status: 429, json: { error: 'Controlled reproduction: provider rate limited' } }));
  let streamAttempts = 0;
  if (streamMode !== 'normal') {
    await page.route('**/api/stream/cards', async route => {
      streamAttempts++;
      if (streamMode === 'http-error') await route.fulfill({ status: 503, body: 'Controlled stream failure' });
      else await route.fulfill({ contentType: 'text/event-stream', body: 'event: fatal-error\ndata: {"message":"Controlled stream timeout"}\n\n' });
    });
  }
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(window => window.webContents.closeDevTools()));
  await page.getByPlaceholder(/1x Sol Ring/).first().fill('1 Sol Ring');
  await page.getByRole('button', { name: 'Fetch Cards', exact: true }).click();
  let completed = false;
  try {
    await expect.poll(async () => page.evaluate(async mode => {
      const { db } = await import('/src/db.ts');
      const { useProjectStore } = await import('/src/store/projectStore.ts');
      const cards = await db.cards.where('projectId').equals(useProjectStore.getState().currentProjectId).toArray();
      const card = cards.find(c => c.name === 'Sol Ring');
      if (mode !== 'normal') return !!card?.lookupError;
      if (!card?.imageId) return false;
      const image = await db.images.get(card.imageId);
      return (image?.displayBlob?.size ?? 0) > 0;
    }, streamMode), { timeout: 45_000, intervals: [500, 1000] }).toBe(true);
    completed = true;
  } catch { /* Retain the actual loading failure for diagnosis. */ }
  if (streamMode !== 'normal') {
    await page.waitForTimeout(1500);
    completed = completed && streamAttempts === 1;
  }
  const state = await page.evaluate(async () => {
    const { db } = await import('/src/db.ts');
    const { useProjectStore } = await import('/src/store/projectStore.ts');
    const { useSettingsStore } = await import('/src/store/settings.ts');
    const cards = await db.cards.where('projectId').equals(useProjectStore.getState().currentProjectId).toArray();
    const images = await db.images.toArray();
    return {
      artSource: useSettingsStore.getState().preferredArtSource,
      cards: cards.map(({ name, imageId, lookupError }) => ({ name, imageId, lookupError })),
      images: images.map(({ id, originalBlob, displayBlob, sourceUrl }) => ({ id, originalBytes: originalBlob?.size, displayBytes: displayBlob?.size, sourceUrl })),
      renderedImages: [...document.querySelectorAll('[data-dnd-sortable-item] img')].map(image => ({ src: image.src, loaded: image.complete && image.naturalWidth > 0 })),
      cardText: [...document.querySelectorAll('[data-dnd-sortable-item]')].map(card => card.textContent),
    };
  });
  await page.screenshot({ path: path.join(evidence, 'page.png'), fullPage: true });
  const disposedRendition = events.console.some(message => message.text.includes('Rendition identity admission is disposed'));
  result = { completed: completed && !disposedRendition, streamMode, streamAttempts, disposedRendition, state, events, evidence, isolation: { display: owned.display, xvfbPid: owned.pid, runtime: owned.runtime } };
} catch (error) {
  launchError = error.stack ?? String(error);
  process.exitCode = 1;
} finally {
  try {
    await owned?.close();
  } finally {
    await rm(probeMain, { force: true }).catch(() => {});
    if (launchError) logs += `\n[probe failure]\n${launchError}\n`;
    await writeFile(path.join(evidence, 'launch.log'), logs);
    await writeFile(path.join(evidence, 'result.json'), JSON.stringify(result ?? { completed: false, streamMode, evidence, failure: launchError }, null, 2));
  }
}
console.log(JSON.stringify(result ? {
  completed: result.completed, streamMode, streamAttempts: result.streamAttempts, disposedRendition: result.disposedRendition,
  state: result.state, errors: result.events.errors, consoleErrors: result.events.console.filter(message => message.type === 'error'),
  apiResponses: result.events.requests.filter(request => request.url.includes('/api/')), evidence, isolation: result.isolation,
} : { completed: false, streamMode, evidence, failure: launchError }, null, 2));
if (!result?.completed) process.exitCode = 1;
