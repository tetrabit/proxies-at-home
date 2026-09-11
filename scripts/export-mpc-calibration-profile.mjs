import { chromium } from 'playwright';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCalibrationBlobChunkReader, exportCalibrationBlob } from './calibration-blob-export.mjs';

// Read only this application's origin, never browser cookies or credentials.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (!process.argv[2]) throw new Error('Usage: node scripts/export-mpc-calibration-profile.mjs <browser-profile/IndexedDB>');
const source = await realpath(process.argv[2]);
const origin = 'http://127.0.0.1:5173';
const prefix = 'http_127.0.0.1_5173.indexeddb';
const destination = path.join(root, '.recovery', `mpc-calibration-origin-${randomUUID()}`);
await mkdir(destination, { recursive: false });
const snapshot = path.join(destination, 'original', 'Default', 'IndexedDB');
const working = path.join(destination, 'working');
await mkdir(snapshot, { recursive: true });
await mkdir(path.join(working, 'Default', 'IndexedDB'), { recursive: true });

async function inventory(directory, relative = '') {
  const rows = [];
  for (const entry of await readdir(path.join(directory, relative), { withFileTypes: true })) {
    const name = path.join(relative, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Refusing storage symlink: ${name}`);
    if (entry.isDirectory()) rows.push(...await inventory(directory, name));
    else if (entry.isFile()) {
      const info = await stat(path.join(directory, name), { bigint: true });
      rows.push({ path: name, bytes: Number(info.size), mtimeNs: String(info.mtimeNs) });
    }
  }
  return rows.sort((a, b) => a.path.localeCompare(b.path));
}

function copyOnWrite(from, to) {
  const result = spawnSync('cp', ['--reflink=always', '-a', '--', from, to], { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Copy-on-write backup failed: ${result.stderr}`);
}

let context;
const report = { origin, source, destination, passed: false };
try {
  const selected = [`${prefix}.leveldb`, `${prefix}.blob`];
  const before = {};
  for (const name of selected) {
    before[name] = await inventory(path.join(source, name));
    copyOnWrite(path.join(source, name), snapshot);
    const after = await inventory(path.join(source, name));
    if (JSON.stringify(before[name]) !== JSON.stringify(after)) throw new Error('Origin storage changed during backup; preserved copy is not yet verified');
    copyOnWrite(path.join(snapshot, name), path.join(working, 'Default', 'IndexedDB'));
  }
  await writeFile(path.join(destination, 'source-inventory.json'), JSON.stringify(before, null, 2));
  report.sourceFiles = Object.values(before).flat().length;
  report.sourceBytes = Object.values(before).flat().reduce((sum, row) => sum + row.bytes, 0);

  context = await chromium.launchPersistentContext(working, {
    headless: true,
    chromiumSandbox: true,
    serviceWorkers: 'block',
    acceptDownloads: false,
  });
  // The copied browser sees the original storage origin, but never runs app
  // bootstrap, sync, migration, or an external network request.
  await context.route('**/*', route => route.request().url().startsWith(`${origin}/`)
    ? route.fulfill({ contentType: 'text/html', body: '<title>Read-only MPC calibration export</title>' })
    : route.abort());
  const page = context.pages()[0] ?? await context.newPage();
  await page.goto(`${origin}/`);
  const metadata = await page.evaluate(async () => {
    const databases = await indexedDB.databases();
    if (!databases.some(item => item.name === 'ProxxiedDB')) throw new Error('Copied origin does not contain ProxxiedDB; refusing to create a new database');
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open('ProxxiedDB');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onupgradeneeded = () => { request.transaction.abort(); reject(new Error('Unexpected database creation/upgrade')); };
    });
    try {
      const names = ['mpcCalibrationDatasets', 'mpcCalibrationCases', 'mpcCalibrationAssets', 'mpcCalibrationRuns'];
      const tables = {};
      for (const name of names) {
        if (!database.objectStoreNames.contains(name)) throw new Error(`Missing calibration table: ${name}`);
        tables[name] = await new Promise((resolve, reject) => {
          const request = database.transaction(name, 'readonly').objectStore(name).getAll();
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
      }
      const assets = tables.mpcCalibrationAssets;
      const assetBytes = assets.reduce((sum, asset) => sum + (asset.blob?.size ?? 0), 0);
      // Keep Blob handles in the isolated renderer. The Node-side exporter asks
      // for serial bounded Blob.slice() reads, never a whole-asset base64 value.
      window.__calibrationExportAssets = new Map(assets.map(asset => [asset.id, asset.blob]));
      const serializedAssets = assets.map(({ blob, ...record }) => {
        if (!(blob instanceof Blob)) throw new Error(`Missing calibration asset Blob: ${record.id}`);
        return { ...record, mimeType: record.mimeType || blob.type, bytes: blob.size };
      });
      return {
        schema: 'proxxied-mpc-calibration-backup/v1',
        databaseVersion: database.version,
        datasets: tables.mpcCalibrationDatasets,
        cases: tables.mpcCalibrationCases,
        assets: serializedAssets,
        runs: tables.mpcCalibrationRuns,
        assetBytes,
      };
    } finally {
      database.close();
    }
  });
  console.log(JSON.stringify({ phase: 'metadata', datasets: metadata.datasets.length, cases: metadata.cases.length, assets: metadata.assets.length, assetBytes: metadata.assetBytes, runs: metadata.runs.length }));
  const metadataOutput = path.join(destination, 'calibration-metadata.json');
  await writeFile(metadataOutput, JSON.stringify(metadata), { flag: 'wx', mode: 0o600 });
  report.metadata = metadataOutput;
  await mkdir(path.join(destination, 'assets'), { recursive: false });
  for (const [index, asset] of metadata.assets.entries()) {
    const filename = `${createHash('sha256').update(asset.id).digest('hex')}.blob`;
    const target = path.join(destination, 'assets', filename);
    const result = await exportCalibrationBlob({
      outputPath: target,
      byteLength: asset.bytes,
      readChunk: createCalibrationBlobChunkReader(page, asset.id),
    });
    asset.file = `assets/${filename}`;
    asset.sha256 = result.sha256;
    if ((index + 1) % 100 === 0 || index + 1 === metadata.assets.length) console.log(JSON.stringify({ phase: 'assets', exported: index + 1, total: metadata.assets.length }));
  }
  for (const name of selected) {
    if (JSON.stringify(before[name]) !== JSON.stringify(await inventory(path.join(source, name)))) throw new Error('Live origin changed during extraction; preserve snapshot and reconcile before migration');
  }
  const payload = JSON.stringify(metadata);
  const output = path.join(destination, 'calibration-data.json');
  await writeFile(output, payload, { flag: 'wx', mode: 0o600 });
  report.export = output;
  report.sha256 = createHash('sha256').update(payload).digest('hex');
  report.counts = { datasets: metadata.datasets.length, cases: metadata.cases.length, assets: metadata.assets.length, runs: metadata.runs.length, assetBytes: metadata.assetBytes };
  report.datasets = metadata.datasets.map(dataset => ({ id: dataset.id, name: dataset.name, cases: metadata.cases.filter(item => item.datasetId === dataset.id).length }));
  report.passed = true;
} catch (error) {
  report.error = error.stack ?? String(error);
  process.exitCode = 1;
} finally {
  await context?.close();
  await writeFile(path.join(destination, 'report.json'), JSON.stringify(report, null, 2));
}
console.log(JSON.stringify(report, null, 2));
