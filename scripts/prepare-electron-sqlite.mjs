import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Keep Electron's ABI-specific addon separate from the ordinary Node server. */
export function prepareElectronSqlite(root = projectRoot) {
  const addonRoot = path.join(root, 'server/node_modules/better-sqlite3');
  const electronRoot = path.join(root, 'node_modules/electron');
  const electronVersion = JSON.parse(readFileSync(path.join(electronRoot, 'package.json'), 'utf8')).version;
  const addonVersion = JSON.parse(readFileSync(path.join(addonRoot, 'package.json'), 'utf8')).version;
  const key = createHash('sha256').update(JSON.stringify({ electronVersion, addonVersion, platform: process.platform, arch: process.arch })).digest('hex');
  const cacheRoot = path.join(root, 'electron/.native-cache');
  const destination = path.join(cacheRoot, key);
  const binaryRelative = 'build/Release/better_sqlite3.node';
  const binary = path.join(destination, binaryRelative);
  const electron = path.join(electronRoot, 'dist/electron');

  function verify(binding) {
    const result = spawnSync(electron, ['-e', `
      const Database = require(process.argv[1]);
      const db = new Database(':memory:', { nativeBinding: process.argv[2] });
      try { if (db.prepare('SELECT 1 AS ok').get().ok !== 1) process.exitCode = 1; }
      finally { db.close(); }
    `, addonRoot, binding], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000,
    });
    if (result.status !== 0) {
      throw new Error(`Electron SQLite verification failed for ${binding}. ${result.error?.message ?? result.stderr?.toString().trim() ?? ''}`);
    }
  }

  if (existsSync(binary)) {
    verify(binary);
    return binary;
  }

  mkdirSync(cacheRoot, { recursive: true });
  const staging = mkdtempSync(path.join(cacheRoot, '.prepare-'));
  copyFileSync(path.join(addonRoot, 'package.json'), path.join(staging, 'package.json'));
  console.error(`Preparing better-sqlite3 ${addonVersion} for Electron ${electronVersion} (first run only)...`);
  const install = spawnSync(process.execPath, [
    path.join(root, 'server/node_modules/prebuild-install/bin.js'),
    '--runtime', 'electron', '--target', electronVersion,
    '--platform', process.platform, '--arch', process.arch,
  ], {
    cwd: staging,
    env: { ...process.env, npm_config_cache: path.join(cacheRoot, 'downloads') },
    stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000,
  });
  if (install.status !== 0) {
    throw new Error(`Could not prepare the Electron SQLite addon. ${install.error?.message ?? install.stderr?.toString().trim() ?? ''}`);
  }
  verify(path.join(staging, binaryRelative));
  try {
    renameSync(staging, destination);
  } catch (error) {
    // Another launcher may have published this same verified version first.
    if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error;
    verify(binary);
  }
  return binary;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(prepareElectronSqlite()); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
