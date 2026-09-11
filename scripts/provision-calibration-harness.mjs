#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tsxLoader = path.join(root, 'node_modules', 'tsx', 'dist', 'loader.mjs');
const optionNames = new Set([
  '--database',
  '--owner-id',
  '--harness-id',
  '--backend-origin',
  '--output',
  '--expires-at',
  '--lifetime-ms',
]);

const usage = [
  'Usage:',
  '  node scripts/provision-calibration-harness.mjs \\',
  '    --database /absolute/path/calibration-harness.db \\',
  '    --owner-id OWNER --harness-id HARNESS \\',
  '    --backend-origin https://backend.example \\',
  '    --output /absolute/path/harness-config.json \\',
  '    (--expires-at UNIX_MILLISECONDS | --lifetime-ms MILLISECONDS)',
].join('\n');

function fail(message) {
  throw new Error(message);
}

function parseArguments(argv) {
  if (argv.length === 1 && argv[0] === '--help') {
    process.stdout.write(`${usage}\n`);
    process.exit(0);
  }

  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const option = argv[index];
    const value = argv[index + 1];
    if (!optionNames.has(option) || typeof value !== 'string' || values.has(option)) {
      fail('Invalid provisioning arguments');
    }
    values.set(option, value);
  }

  for (const option of ['--database', '--owner-id', '--harness-id', '--backend-origin', '--output']) {
    if (!values.has(option)) fail('Missing required provisioning argument');
  }
  const hasExpiry = values.has('--expires-at');
  const hasLifetime = values.has('--lifetime-ms');
  if (hasExpiry === hasLifetime) fail('Specify exactly one credential expiry argument');

  return {
    databasePath: path.resolve(values.get('--database')),
    ownerId: values.get('--owner-id'),
    harnessId: values.get('--harness-id'),
    backendOrigin: values.get('--backend-origin'),
    outputPath: path.resolve(values.get('--output')),
    expiresAt: values.get('--expires-at'),
    lifetimeMs: values.get('--lifetime-ms'),
  };
}

const producerSource = `
  import { closeSync, fchmodSync, fsyncSync, lstatSync, openSync, writeFileSync, chmodSync } from 'node:fs';
  import path from 'node:path';

  const input = JSON.parse(await new Promise((resolve, reject) => {
    let text = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { text += chunk; });
    process.stdin.on('end', () => resolve(text));
    process.stdin.on('error', reject);
  }));
  const { initializeCalibrationHarnessSchema } = await import(input.schemaModule);
  const { openNativeDatabase } = await import(input.databaseModule);
  const { createCalibrationHarnessCredentialStore } = await import(input.storeModule);

  function fail(message) {
    throw new Error(message);
  }

  function readInteger(value, name, { positive = false } = {}) {
    if (typeof value !== 'string' || !/^-?(?:0|[1-9][0-9]*)$/.test(value)) {
      fail(name + ' must be a decimal safe integer');
    }
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || (positive && parsed <= 0)) {
      fail(name + ' must be a positive safe integer');
    }
    return parsed;
  }

  function approvedOrigin(value) {
    if (typeof value !== 'string' || value.length === 0) fail('Invalid backend origin');
    let parsed;
    try {
      parsed = new URL(value);
    } catch {
      fail('Invalid backend origin');
    }
    const loopbackHttp = parsed.protocol === 'http:'
      && (parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]');
    if (
      (parsed.protocol !== 'https:' && !loopbackHttp)
      || parsed.username !== ''
      || parsed.password !== ''
      || parsed.pathname !== '/'
      || parsed.search !== ''
      || parsed.hash !== ''
      || parsed.origin !== value
    ) {
      fail('Backend origin must be canonical HTTPS or exact loopback HTTP');
    }
    return value;
  }

  function existingPathKind(filename) {
    const parsed = path.parse(filename);
    let current = parsed.root;
    let stat;
    for (const component of filename.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, component);
      try {
        stat = lstatSync(current);
      } catch (error) {
        if (error && error.code === 'ENOENT') return undefined;
        throw error;
      }
      if (stat.isSymbolicLink()) fail('Refusing symbolic link target');
    }
    return stat;
  }

  function prepareDatabase(existing) {
    if (path.basename(input.databasePath) !== 'calibration-harness.db') {
      fail('Database must use the dedicated calibration-harness.db filename');
    }
    if (existing && !existing.isFile()) fail('Database target must be a regular file');

    if (existing) {
      const database = openNativeDatabase(input.databasePath);
      const version = database.pragma('user_version', { simple: true });
      const sessionTable = database.prepare(
        "SELECT type FROM sqlite_master WHERE name = 'mpc_harness_sessions'",
      ).get();
      if (version !== 1 || !sessionTable || sessionTable.type !== 'table') {
        database.close();
        fail('Refusing unrelated existing database');
      }
      initializeCalibrationHarnessSchema(database);
      return database;
    }

    const descriptor = openSync(input.databasePath, 'wx', 0o600);
    closeSync(descriptor);
    chmodSync(input.databasePath, 0o600);
    const database = openNativeDatabase(input.databasePath);
    initializeCalibrationHarnessSchema(database);
    return database;
  }

  let database;
  try {
    if (input.databasePath === input.outputPath) fail('Database and output paths must differ');
    const existingDatabase = existingPathKind(input.databasePath);
    if (existingPathKind(input.outputPath) !== undefined) fail('Refusing to overwrite existing config');
    const backendOrigin = approvedOrigin(input.backendOrigin);
    const expiresAt = input.expiresAt === undefined
      ? Date.now() + readInteger(input.lifetimeMs, 'lifetime', { positive: true })
      : readInteger(input.expiresAt, 'expiry');
    if (!Number.isSafeInteger(expiresAt)) fail('Credential expiry must be a safe integer');

    database = prepareDatabase(existingDatabase);
    const store = createCalibrationHarnessCredentialStore(database);
    database.transaction(() => {
      const credential = store.provision({
        ownerId: input.ownerId,
        harnessId: input.harnessId,
        expiresAt,
      });
      const descriptor = openSync(input.outputPath, 'wx', 0o600);
      try {
        fchmodSync(descriptor, 0o600);
        writeFileSync(descriptor, JSON.stringify({
          version: 1,
          backendOrigin,
          harnessId: input.harnessId,
          credential,
        }) + '\\n', 'utf8');
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
    })();
    database.close();
    database = undefined;
    process.stdout.write('Calibration harness config: ' + input.outputPath + '\\n');
    process.stdout.write('Owner: ' + input.ownerId + '; harness: ' + input.harnessId + '\\n');
  } catch {
    try { database?.close(); } catch {}
    process.stderr.write('Calibration harness provisioning failed\\n');
    process.exitCode = 1;
  }
`;

function main() {
  const argumentsInput = parseArguments(process.argv.slice(2));
  if (!existsSync(tsxLoader)) fail('The installed tsx loader is required for provisioning');

  const childInput = {
    ...argumentsInput,
    schemaModule: pathToFileURL(path.join(root, 'server', 'src', 'db', 'calibrationHarnessSchema.ts')).href,
    databaseModule: pathToFileURL(path.join(root, 'server', 'src', 'db', 'openNativeDatabase.ts')).href,
    storeModule: pathToFileURL(path.join(root, 'server', 'src', 'auth', 'calibrationHarnessIdentity.ts')).href,
  };
  const result = spawnSync(process.execPath, [
    '--import',
    tsxLoader,
    '--input-type=module',
    '--eval',
    producerSource,
  ], {
    cwd: root,
    encoding: 'utf8',
    input: JSON.stringify(childInput),
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error || result.status !== 0) process.exitCode = 1;
}

try {
  main();
} catch {
  process.stderr.write('Calibration harness provisioning failed\n');
  process.exitCode = 1;
}
