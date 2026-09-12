import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const requireFromServer = createRequire(new URL('../server/package.json', import.meta.url));
const Database = requireFromServer('better-sqlite3');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtureRoot = path.join(root, '.review-artifacts', 'provision-calibration-harness-01');
const script = path.join(root, 'scripts', 'provision-calibration-harness.mjs');

function fixtureDirectory() {
  mkdirSync(fixtureRoot, { recursive: true });
  const directory = path.join(fixtureRoot, randomUUID());
  mkdirSync(directory);
  return directory;
}

function writeNetworkGuard(directory) {
  const filename = path.join(directory, 'network-guard.cjs');
  writeFileSync(filename, `
    const block = () => { throw new Error('network access is prohibited in this test'); };
    const net = require('node:net');
    const http = require('node:http');
    const https = require('node:https');
    net.connect = block;
    net.createConnection = block;
    http.request = block;
    http.get = block;
    https.request = block;
    https.get = block;
  `, { flag: 'wx', mode: 0o600 });
  return filename;
}

function invoke(directory, argumentsList) {
  const guard = writeNetworkGuard(directory);
  return spawnSync(process.execPath, [script, ...argumentsList], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, NODE_OPTIONS: `--require ${guard}` },
  });
}

test('provisions a mode-0600 config through the TypeScript credential store without network or credential output', () => {
  const directory = fixtureDirectory();
  const databasePath = path.join(directory, 'calibration-harness.db');
  const configPath = path.join(directory, 'harness-config.json');
  const ownerId = 'owner-cli-synthetic';
  const harnessId = 'harness-cli-synthetic';
  const result = invoke(directory, [
    '--database', databasePath,
    '--owner-id', ownerId,
    '--harness-id', harnessId,
    '--backend-origin', 'https://calibration.example.test',
    '--output', configPath,
    '--lifetime-ms', '60000',
  ]);

  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /harness-config\.json/);
  assert.match(result.stdout, /owner-cli-synthetic/);
  assert.match(result.stdout, /harness-cli-synthetic/);
  assert.doesNotMatch(result.stdout, /calibration_pair_/);
  assert.doesNotMatch(result.stderr, /calibration_pair_/);

  assert.equal(statSync(configPath).mode & 0o777, 0o600);
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  assert.deepEqual(Object.keys(config).sort(), ['backendOrigin', 'credential', 'harnessId', 'version']);
  assert.deepEqual({
    version: config.version,
    backendOrigin: config.backendOrigin,
    harnessId: config.harnessId,
  }, {
    version: 1,
    backendOrigin: 'https://calibration.example.test',
    harnessId,
  });
  assert.match(config.credential, /^calibration_pair_[A-Za-z0-9_-]{43}$/);

  const database = new Database(databasePath, { readonly: true });
  try {
    const row = database.prepare('SELECT token_hash, owner_id, harness_id FROM mpc_harness_sessions').get();
    assert.deepEqual(row, {
      token_hash: createHash('sha256').update(config.credential).digest('hex'),
      owner_id: ownerId,
      harness_id: harnessId,
    });
    assert.doesNotMatch(JSON.stringify(row), /calibration_pair_/);
  } finally {
    database.close();
  }
});

test('provisions an explicit non-expiring config without exposing its credential', () => {
  const directory = fixtureDirectory();
  const databasePath = path.join(directory, 'calibration-harness.db');
  const configPath = path.join(directory, 'harness-config.json');
  const result = invoke(directory, [
    '--database', databasePath,
    '--owner-id', 'owner-cli-permanent',
    '--harness-id', 'harness-cli-permanent',
    '--backend-origin', 'https://calibration.example.test',
    '--output', configPath,
    '--no-expiry',
  ]);

  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(statSync(configPath).mode & 0o777, 0o600);
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  assert.match(config.credential, /^calibration_pair_[A-Za-z0-9_-]{43}$/);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /calibration_pair_/);

  const database = new Database(databasePath, { readonly: true });
  try {
    assert.deepEqual(database.prepare('SELECT owner_id, harness_id, expires_at FROM mpc_harness_sessions').get(), {
      owner_id: 'owner-cli-permanent',
      harness_id: 'harness-cli-permanent',
      expires_at: -1,
    });
  } finally {
    database.close();
  }
});

test('requires exactly one explicit expiry mode without creating credentials', () => {
  for (const expiryArguments of [
    [],
    ['--no-expiry', '--lifetime-ms', '60000'],
    ['--no-expiry', '--expires-at', '1700000060000'],
    ['--expires-at', '-1'],
  ]) {
    const directory = fixtureDirectory();
    const databasePath = path.join(directory, 'calibration-harness.db');
    const configPath = path.join(directory, 'harness-config.json');
    const result = invoke(directory, [
      '--database', databasePath,
      '--owner-id', 'owner-cli-invalid-expiry',
      '--harness-id', 'harness-cli-invalid-expiry',
      '--backend-origin', 'https://calibration.example.test',
      '--output', configPath,
      ...expiryArguments,
    ]);

    assert.notEqual(result.status, 0);
    assert.throws(() => statSync(configPath));
    if (existsSync(databasePath)) {
      const database = new Database(databasePath, { readonly: true });
      try {
        assert.deepEqual(database.prepare('SELECT COUNT(*) AS count FROM mpc_harness_sessions').get(), { count: 0 });
      } finally {
        database.close();
      }
    }
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /calibration_pair_/);
  }
});

test('refuses a database path with a symlink ancestor before mutating either destination', () => {
  const directory = fixtureDirectory();
  const databaseDestination = path.join(directory, 'database-destination');
  const databaseLink = path.join(directory, 'database-link');
  const databasePath = path.join(databaseLink, 'calibration-harness.db');
  const configPath = path.join(directory, 'harness-config.json');
  mkdirSync(databaseDestination);
  writeFileSync(path.join(databaseDestination, 'database-sentinel.txt'), 'database-sentinel\n', { flag: 'wx', mode: 0o600 });
  symlinkSync(databaseDestination, databaseLink, 'dir');

  const result = invoke(directory, [
    '--database', databasePath,
    '--owner-id', 'owner-cli-synthetic',
    '--harness-id', 'harness-cli-synthetic',
    '--backend-origin', 'https://calibration.example.test',
    '--output', configPath,
    '--lifetime-ms', '60000',
  ]);

  assert.notEqual(result.status, 0);
  assert.equal(readFileSync(path.join(databaseDestination, 'database-sentinel.txt'), 'utf8'), 'database-sentinel\n');
  assert.throws(() => statSync(path.join(databaseDestination, 'calibration-harness.db')));
  assert.throws(() => statSync(configPath));
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /calibration_pair_/);
});

test('refuses an output path with a symlink ancestor before mutating either destination', () => {
  const directory = fixtureDirectory();
  const databasePath = path.join(directory, 'calibration-harness.db');
  const configDestination = path.join(directory, 'config-destination');
  const configLink = path.join(directory, 'config-link');
  const configPath = path.join(configLink, 'harness-config.json');
  mkdirSync(configDestination);
  writeFileSync(path.join(configDestination, 'config-sentinel.txt'), 'config-sentinel\n', { flag: 'wx', mode: 0o600 });
  symlinkSync(configDestination, configLink, 'dir');

  const result = invoke(directory, [
    '--database', databasePath,
    '--owner-id', 'owner-cli-synthetic',
    '--harness-id', 'harness-cli-synthetic',
    '--backend-origin', 'https://calibration.example.test',
    '--output', configPath,
    '--lifetime-ms', '60000',
  ]);

  assert.notEqual(result.status, 0);
  assert.equal(readFileSync(path.join(configDestination, 'config-sentinel.txt'), 'utf8'), 'config-sentinel\n');
  assert.throws(() => statSync(databasePath));
  assert.throws(() => statSync(path.join(configDestination, 'harness-config.json')));
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /calibration_pair_/);
});

test('refuses an existing config target before provisioning and preserves its bytes', () => {
  const directory = fixtureDirectory();
  const databasePath = path.join(directory, 'calibration-harness.db');
  const configPath = path.join(directory, 'existing-config.json');
  writeFileSync(configPath, 'stable-existing-file-sentinel\n', { flag: 'wx', mode: 0o600 });

  const result = invoke(directory, [
    '--database', databasePath,
    '--owner-id', 'owner-cli-synthetic',
    '--harness-id', 'harness-cli-synthetic',
    '--backend-origin', 'https://calibration.example.test',
    '--output', configPath,
    '--lifetime-ms', '60000',
  ]);

  assert.notEqual(result.status, 0);
  assert.equal(readFileSync(configPath, 'utf8'), 'stable-existing-file-sentinel\n');
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /calibration_pair_/);
  assert.throws(() => statSync(databasePath));
});

test('rejects an unrelated populated database even when it has the dedicated filename', () => {
  const directory = fixtureDirectory();
  const databasePath = path.join(directory, 'calibration-harness.db');
  const configPath = path.join(directory, 'harness-config.json');
  const database = new Database(databasePath);
  database.exec("CREATE TABLE sentinel (value TEXT NOT NULL); INSERT INTO sentinel (value) VALUES ('preserve-me');");
  database.close();

  const result = invoke(directory, [
    '--database', databasePath,
    '--owner-id', 'owner-cli-synthetic',
    '--harness-id', 'harness-cli-synthetic',
    '--backend-origin', 'https://calibration.example.test',
    '--output', configPath,
    '--lifetime-ms', '60000',
  ]);

  assert.notEqual(result.status, 0);
  const reopened = new Database(databasePath, { readonly: true });
  try {
    assert.deepEqual(reopened.prepare('SELECT value FROM sentinel').get(), { value: 'preserve-me' });
    assert.deepEqual(reopened.prepare("SELECT name FROM sqlite_master WHERE name = 'mpc_harness_sessions'").get(), undefined);
  } finally {
    reopened.close();
  }
  assert.throws(() => statSync(configPath));
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /calibration_pair_/);
});

test('rejects noncanonical backend origins before creating the dedicated database', () => {
  const directory = fixtureDirectory();
  const databasePath = path.join(directory, 'calibration-harness.db');
  const configPath = path.join(directory, 'harness-config.json');

  const result = invoke(directory, [
    '--database', databasePath,
    '--owner-id', 'owner-cli-synthetic',
    '--harness-id', 'harness-cli-synthetic',
    '--backend-origin', 'http://localhost:3001',
    '--output', configPath,
    '--lifetime-ms', '60000',
  ]);

  assert.notEqual(result.status, 0);
  assert.throws(() => statSync(databasePath));
  assert.throws(() => statSync(configPath));
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /calibration_pair_/);
});

test('rolls back the credential when exclusive config persistence fails', () => {
  const directory = fixtureDirectory();
  const databasePath = path.join(directory, 'calibration-harness.db');
  const configPath = path.join(directory, 'missing-parent', 'harness-config.json');

  const result = invoke(directory, [
    '--database', databasePath,
    '--owner-id', 'owner-cli-synthetic',
    '--harness-id', 'harness-cli-synthetic',
    '--backend-origin', 'https://calibration.example.test',
    '--output', configPath,
    '--lifetime-ms', '60000',
  ]);

  assert.notEqual(result.status, 0);
  const database = new Database(databasePath, { readonly: true });
  try {
    assert.deepEqual(database.prepare('SELECT COUNT(*) AS count FROM mpc_harness_sessions').get(), { count: 0 });
  } finally {
    database.close();
  }
  assert.throws(() => statSync(configPath));
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /calibration_pair_/);
});
