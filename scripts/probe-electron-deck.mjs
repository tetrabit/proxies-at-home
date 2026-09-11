import { _electron } from 'playwright';
import { expect } from '@playwright/test';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareElectronSqlite } from './prepare-electron-sqlite.mjs';
import { assertFrontendReady, launchElectronOnOwnedXvfb } from './electron-xvfb-launcher.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (!process.argv[2]) throw new Error('Usage: node scripts/probe-electron-deck.mjs <project-backup.json>');
const sourcePath = path.resolve(process.argv[2]);
const sourceBytes = await readFile(sourcePath);
const backup = JSON.parse(sourceBytes.toString());
const expectedFronts = backup.cards.filter(card => !card.linkedFrontId).length;
const id = randomUUID();
const evidence = path.join(root, '.review-artifacts', `electron-deck-${id}`);
await mkdir(path.join(evidence, 'fronts'), { recursive: true });
await mkdir(path.join(evidence, 'pages'), { recursive: true });
const log = createWriteStream(path.join(evidence, 'launch.log'));
const events = { errors: [], consoleErrors: [], imageResponses: [] };
const report = { sourcePath, sourceSha256: createHash('sha256').update(sourceBytes).digest('hex'),
  projectName: backup.project.name, expectedFronts, sourceRows: backup.cards.length, dpi: backup.project.settings.dpi,
  evidence, frontsSeen: [], backsSeen: [], captures: [], passed: false,
};
let probePage;
let owned;
let app;
let probeMain;
try {
  // Refuse before opening an X display or Electron when the parent-owned Vite is absent.
  await assertFrontendReady({ evidence });
  const reservation = net.createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const original = await readFile(path.join(root, 'electron/dist/main.js'), 'utf8');
  if (original.split('createScryfallMicroservice()').length !== 2) throw new Error('Unexpected compiled main seam');
  probeMain = path.join(root, 'electron/dist', `main-deck-probe-${id}.js`);
  await writeFile(probeMain, original.replace('createScryfallMicroservice()', `createScryfallMicroservice(${port})`));
  await writeFile(path.join(evidence, 'main-provenance.json'), JSON.stringify({
    originalSha256: createHash('sha256').update(original).digest('hex'), probeMain, port,
    onlySubstitution: 'explicit microservice port',
  }, null, 2));
  const env = { ...process.env, NODE_ENV: 'development',
    PROXXIED_SQLITE_NATIVE_BINDING: prepareElectronSqlite(root),
    XDG_CONFIG_HOME: path.join(evidence, 'config'), XDG_CACHE_HOME: path.join(evidence, 'cache'),
    SERVER_DATA_DIR: path.join(root, 'server/data', `electron-deck-probe-${id}`),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  owned = await launchElectronOnOwnedXvfb({
    evidence,
    args: [probeMain],
    launch: options => _electron.launch({ ...options, cwd: root, timeout: 30_000 }),
    launchOptions: { env },
  });
  app = owned.app;
  report.isolation = { display: owned.display, xvfbPid: owned.pid, runtime: owned.runtime };
  app.process().stdout.on('data', chunk => log.write(chunk));
  app.process().stderr.on('data', chunk => log.write(chunk));
  await expect.poll(() => app.windows().some(p => p.url().startsWith('http://localhost:5173/')), { timeout: 30000 }).toBe(true);
  const page = app.windows().find(p => p.url().startsWith('http://localhost:5173/'));
  probePage = page;
  page.on('pageerror', error => events.errors.push(error.message));
  page.on('console', message => { if (['warning', 'error'].includes(message.type())) events.consoleErrors.push(message.text()); });
  page.on('response', response => { if (response.url().includes('/api/cards/images/')) events.imageResponses.push({ url: response.url(), status: response.status() }); });
  // Keep optional MPC work from adding requests to a rate-limited provider.
  await page.route('**/api/mpcfill/**', route => route.fulfill({ status: 429, json: { error: 'MPC disabled in full-deck image probe' } }));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(window => window.webContents.closeDevTools()));
  // Navigation to the app URL precedes React's asynchronous project hydration.
  // Wait for the real UI before restoring, so init cannot replace our selection.
  await expect(page.getByRole('button', { name: 'Fetch Cards', exact: true })).toBeVisible({ timeout: 30000 });
  const imported = await page.evaluate(async data => {
    const { importProject } = await import('/src/helpers/projectBackup.ts');
    const { useProjectStore } = await import('/src/store/projectStore.ts');
    const { db } = await import('/src/db.ts');
    const projectId = await importProject(data, `${data.project.name} (verification copy)`);
    await useProjectStore.getState().loadProjects();
    await useProjectStore.getState().switchProject(projectId);
    const cards = await db.cards.where('projectId').equals(projectId).toArray();
    return { projectId, fronts: cards.filter(card => !card.linkedFrontId).map(card => ({ uuid: card.uuid, name: card.name, imageId: card.imageId })), rows: cards.length };
  }, backup);
  report.imported = imported;
  if (imported.fronts.length !== expectedFronts || imported.rows !== backup.cards.length) throw new Error('Restored deck cardinality mismatch');
  const byId = new Map(imported.fronts.map(card => [card.uuid, card]));
  await page.locator('canvas').first().waitFor({ state: 'visible', timeout: 30000 });
  // Let the real background image queue finish before collecting screenshots;
  // otherwise reactive placeholder replacement can detach an overlay mid-shot.
  const processingStarted = Date.now();
  let previousReady = -1;
  report.imageProgress = [];
  await expect.poll(async () => {
    const ready = await page.evaluate(async projectId => {
    const { db } = await import('/src/db.ts');
    const cards = await db.cards.where('projectId').equals(projectId).toArray();
    const images = new Map((await db.images.toArray()).map(image => [image.id, image]));
    return cards.filter(card => !card.linkedFrontId && (images.get(card.imageId)?.displayBlob?.size ?? 0) > 0).length;
    }, imported.projectId);
    if (ready !== previousReady) {
      previousReady = ready;
      const progress = { ready, expected: expectedFronts, elapsedMs: Date.now() - processingStarted };
      report.imageProgress.push(progress);
      console.log(JSON.stringify({ phase: 'processing', ...progress }));
      await writeFile(path.join(evidence, 'progress.json'), JSON.stringify(report, null, 2));
    }
    return ready;
  // Xvfb may use software WebGL. Keep 900-DPI processing intact rather than
  // lowering quality; allow a bounded ten-minute preparation window instead.
  }, { timeout: 600000, intervals: [1000, 2000] }).toBe(expectedFronts);
  await page.evaluate(() => {
    const scroller = [...document.querySelectorAll('canvas')].map(c => c.closest('.overflow-y-auto')).find(Boolean);
    if (!scroller) throw new Error('Page scroller not found');
    scroller.dataset.deckProbeScroller = 'true';
  });
  const scroller = page.locator('[data-deck-probe-scroller]');
  const extent = await scroller.evaluate(element => ({ width: element.clientWidth, height: element.clientHeight, max: element.scrollHeight - element.clientHeight, maxX: element.scrollWidth - element.clientWidth }));
  const step = Math.max(40, Math.floor(extent.height / 4));
  const positions = [];
  // At the saved zoom, a paper page can be wider than the pane. Sweep both
  // scroll axes rather than mistaking the clipped right column for missing art.
  const horizontalPositions = new Set([0, extent.maxX]);
  for (let x = 0; x < extent.maxX; x += Math.max(40, Math.floor(extent.width / 4))) horizontalPositions.add(x);
  for (const x of [...horizontalPositions].sort((a, b) => a - b)) {
    for (let y = 0; y < extent.max; y += step) positions.push({ x, y });
    positions.push({ x, y: extent.max });
  }
  report.scrollExtent = extent;

  for (const side of ['front', 'back']) {
    const seen = new Set();
    for (const [index, position] of positions.entries()) {
      await scroller.evaluate((element, { x, y }) => { element.scrollLeft = x; element.scrollTop = y; }, position);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const visible = await page.evaluate(() => {
        const bounds = document.querySelector('[data-deck-probe-scroller]').getBoundingClientRect();
        return [...document.querySelectorAll('[data-dnd-sortable-item]')].filter(element => {
          const r = element.getBoundingClientRect();
          return r.width > 0 && r.top >= bounds.top && r.bottom <= bounds.bottom && r.left >= bounds.left && r.right <= bounds.right;
        }).map(element => element.getAttribute('data-dnd-sortable-item'));
      });
      for (const uuid of visible) {
        if (!byId.has(uuid) || seen.has(uuid)) continue;
        const card = page.locator(`[data-dnd-sortable-item="${uuid}"]`);
        await expect(card).toBeVisible();
        if (side === 'back') await card.locator('[data-testid="flip-button"][title="Show back"]').click();
        await expect.poll(() => card.locator('.animate-spin').count(), { timeout: 90000 }).toBe(0);
        await expect(card).not.toContainText('Click to replace');
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        if (side === 'front') {
          const screenshot = path.join(evidence, 'fronts', `${String(seen.size + 1).padStart(3, '0')}-${uuid}.png`);
          const clip = await card.boundingBox();
          if (!clip) throw new Error(`Card ${uuid} detached before capture`);
          await page.screenshot({ path: screenshot, clip });
          report.captures.push({ ...byId.get(uuid), screenshot });
        }
        seen.add(uuid);
      }
      report[side === 'front' ? 'frontsSeen' : 'backsSeen'] = [...seen];
      if (index % 4 === 0 || index === positions.length - 1) {
        await page.screenshot({ path: path.join(evidence, 'pages', `${side}-${String(index).padStart(3, '0')}.png`) });
        console.log(JSON.stringify({ side, seen: seen.size, expected: expectedFronts, position }));
        await writeFile(path.join(evidence, 'progress.json'), JSON.stringify(report, null, 2));
      }
    }
    if (seen.size !== expectedFronts) throw new Error(`${side}: rendered ${seen.size}/${expectedFronts} cards`);
  }
  report.final = await page.evaluate(async projectId => {
    const { db } = await import('/src/db.ts');
    const { useSettingsStore } = await import('/src/store/settings.ts');
    const cards = await db.cards.where('projectId').equals(projectId).toArray();
    const images = new Map((await db.images.toArray()).map(image => [image.id, image]));
    const fronts = cards.filter(card => !card.linkedFrontId);
    const backIds = [...new Set(cards.filter(card => card.linkedFrontId).map(card => card.imageId))];
    const { isCardbackId } = await import('/src/helpers/cardbackLibrary.ts');
    const backs = await Promise.all(backIds.map(id => isCardbackId(id) ? db.cardbacks.get(id) : images.get(id)));
    return { rows: cards.length, fronts: fronts.length, dpi: useSettingsStore.getState().dpi,
      readyFronts: fronts.filter(card => (images.get(card.imageId)?.displayBlob?.size ?? 0) > 0).length,
      readyUniqueImages: [...images.values()].filter(image => (image.displayBlob?.size ?? 0) > 0).length,
      failures: fronts.filter(card => card.lookupError || !(images.get(card.imageId)?.displayBlob?.size > 0)).map(card => ({ name: card.name, imageId: card.imageId, error: card.lookupError })),
      backImages: backs.map((back, index) => ({ id: backIds[index], displayBytes: back?.displayBlob?.size ?? 0 })),
    };
  }, imported.projectId);
  if (report.final.readyFronts !== expectedFronts || report.final.failures.length || report.final.dpi !== report.dpi || report.final.backImages.some(image => image.displayBytes === 0)) throw new Error('Final image/settings verification failed');
  report.passed = true;
} catch (error) {
  report.failure = error.stack ?? String(error);
  if (probePage && !probePage.isClosed()) {
    await probePage.screenshot({ path: path.join(evidence, 'failure.png') }).catch(() => {});
    report.failureDom = await probePage.locator('body').innerText().catch(() => 'unavailable');
  }
  process.exitCode = 1;
} finally {
  try {
    await owned?.close();
  } finally {
    await rm(probeMain, { force: true }).catch(() => {});
    await new Promise(resolve => log.end(resolve));
    await writeFile(path.join(evidence, 'events.json'), JSON.stringify(events, null, 2));
    await writeFile(path.join(evidence, 'report.json'), JSON.stringify(report, null, 2));
  }
}
console.log(JSON.stringify({ passed: report.passed, expectedFronts, frontsSeen: report.frontsSeen.length,
  backsSeen: report.backsSeen.length, final: report.final, failure: report.failure, evidence }, null, 2));
