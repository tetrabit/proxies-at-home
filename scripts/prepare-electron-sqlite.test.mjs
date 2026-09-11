import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function fixture({ invalidPrebuild = false } = {}) {
  const parent = path.join(root, '.review-artifacts', 'electron-sqlite-preparation-tests');
  await mkdir(parent, { recursive: true });
  const dir = await mkdtemp(path.join(parent, 'case-'));
  async function file(relative, contents) {
    const target = path.join(dir, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents);
  }
  await file('node_modules/electron/package.json', JSON.stringify({ version: '39.2.7' }));
  await file('server/node_modules/better-sqlite3/package.json', JSON.stringify({ version: '12.10.0', name: 'better-sqlite3' }));
  await file('server/node_modules/better-sqlite3/build/Release/better_sqlite3.node', 'original Node binding');
  await file('node_modules/electron/dist/electron', `#!/usr/bin/env node
    const fs = require('node:fs');
    require('node:assert/strict').equal(process.env.ELECTRON_RUN_AS_NODE, '1');
    process.exit(fs.readFileSync(process.argv.at(-1), 'utf8') === 'Electron binding' ? 0 : 1);
  `);
  await chmod(path.join(dir, 'node_modules/electron/dist/electron'), 0o755);
  await file('server/node_modules/prebuild-install/bin.js', `
    const fs = require('node:fs');
    fs.appendFileSync(${JSON.stringify(path.join(dir, 'installs.txt'))}, 'installed\n');
    fs.mkdirSync('build/Release', { recursive: true });
    fs.writeFileSync('build/Release/better_sqlite3.node', ${JSON.stringify(invalidPrebuild ? 'wrong ABI' : 'Electron binding')});
  `.replace("'installed\n'", "'installed\\n'"));
  return dir;
}

test('prepares and reuses a verified separate Electron addon without changing the Node addon', async () => {
  const { prepareElectronSqlite } = await import('./prepare-electron-sqlite.mjs');
  const dir = await fixture();
  const binding = prepareElectronSqlite(dir);
  assert.equal(prepareElectronSqlite(dir), binding);
  assert.equal(await readFile(binding, 'utf8'), 'Electron binding');
  assert.equal(await readFile(path.join(dir, 'installs.txt'), 'utf8'), 'installed\n');
  assert.equal(await readFile(path.join(dir, 'server/node_modules/better-sqlite3/build/Release/better_sqlite3.node'), 'utf8'), 'original Node binding');
  assert.ok(binding.startsWith(path.join(dir, 'electron', '.native-cache')));
});

test('rejects an incompatible download instead of using it or replacing the Node addon', async () => {
  const { prepareElectronSqlite } = await import('./prepare-electron-sqlite.mjs');
  const dir = await fixture({ invalidPrebuild: true });
  assert.throws(() => prepareElectronSqlite(dir), /Electron SQLite verification failed/);
  assert.equal(await readFile(path.join(dir, 'server/node_modules/better-sqlite3/build/Release/better_sqlite3.node'), 'utf8'), 'original Node binding');
});
