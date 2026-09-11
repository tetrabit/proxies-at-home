#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const METADATA_FILENAME = 'calibration-data.json';
const MAX_METADATA_BYTES = 32 * 1024 * 1024;
const MAX_ASSET_BYTES = 32 * 1024 * 1024;
const SHA256 = /^[0-9a-f]{64}$/;

function fail(message) {
  throw new Error(message);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function realDirectory(directory, label) {
  if (typeof directory !== 'string' || directory.length === 0) fail(`${label} must be a nonempty path`);
  const resolved = path.resolve(directory);
  const entry = fs.lstatSync(resolved);
  if (entry.isSymbolicLink() || !entry.isDirectory() || fs.realpathSync(resolved) !== resolved) {
    fail(`${label} must be a real non-symlink directory`);
  }
  return resolved;
}

function assertSafeExistingParent(filename, label) {
  const resolved = path.resolve(filename);
  const parent = path.dirname(resolved);
  const parsed = path.parse(parent);
  let cursor = parsed.root;
  for (const segment of parent.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    const entry = fs.lstatSync(cursor);
    if (entry.isSymbolicLink() || !entry.isDirectory()) fail(`${label} has an unsafe ancestor`);
  }
  return resolved;
}

function captureTargetParent(filename, label) {
  const target = assertSafeExistingParent(filename, label);
  const parent = fs.lstatSync(path.dirname(target));
  return { target, parentDev: parent.dev, parentIno: parent.ino, label };
}

function assertTargetParent(identity) {
  const target = assertSafeExistingParent(identity.target, identity.label);
  const parent = fs.lstatSync(path.dirname(target));
  if (parent.dev !== identity.parentDev || parent.ino !== identity.parentIno) fail(`${identity.label} parent identity changed`);
  return target;
}

function captureRegularFile(filename, label) {
  const entry = fs.lstatSync(filename);
  if (entry.isSymbolicLink() || !entry.isFile()) fail(`${label} must be an existing regular file`);
  return { filename, dev: entry.dev, ino: entry.ino, size: entry.size, label };
}

function assertRegularFileIdentity(identity, requireSameSize = false) {
  const entry = fs.lstatSync(identity.filename);
  if (entry.isSymbolicLink() || !entry.isFile() || entry.dev !== identity.dev || entry.ino !== identity.ino || (requireSameSize && entry.size !== identity.size)) {
    fail(`${identity.label} identity changed`);
  }
  return entry;
}

function assertAbsentRegularSidecars(filename) {
  for (const candidate of [filename, `${filename}-wal`, `${filename}-shm`, `${filename}-journal`]) {
    try {
      const entry = fs.lstatSync(candidate);
      if (!entry.isFile()) fail('SQLite target or sidecar is not a regular file');
      fail('SQLite target or sidecar already exists');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
}

function readBoundedFile(filename, maximum, label) {
  const entry = fs.lstatSync(filename);
  if (entry.isSymbolicLink() || !entry.isFile() || entry.size > maximum) fail(`${label} must be a bounded regular file`);
  const descriptor = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
  try {
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || opened.dev !== entry.dev || opened.ino !== entry.ino || opened.size !== entry.size) {
      fail(`${label} changed before reading`);
    }
    const output = Buffer.allocUnsafe(opened.size);
    let total = 0;
    while (total < output.byteLength) {
      const received = fs.readSync(descriptor, output, total, Math.min(1024 * 1024, output.byteLength - total), null);
      if (received === 0) break;
      total += received;
    }
    const after = fs.fstatSync(descriptor);
    if (total !== opened.size || after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size) {
      fail(`${label} changed while reading`);
    }
    return output;
  } finally {
    fs.closeSync(descriptor);
  }
}

function hashBoundedFile(filename, maximum, label) {
  const entry = fs.lstatSync(filename);
  if (entry.isSymbolicLink() || !entry.isFile() || entry.size > maximum) fail(`${label} must be a bounded regular file`);
  const descriptor = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
  try {
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || opened.dev !== entry.dev || opened.ino !== entry.ino || opened.size !== entry.size) {
      fail(`${label} changed before hashing`);
    }
    const hash = createHash('sha256');
    const chunk = Buffer.allocUnsafe(1024 * 1024);
    let total = 0;
    while (total < opened.size) {
      const received = fs.readSync(descriptor, chunk, 0, Math.min(chunk.byteLength, opened.size - total), null);
      if (received === 0) break;
      hash.update(chunk.subarray(0, received));
      total += received;
    }
    const after = fs.fstatSync(descriptor);
    if (total !== opened.size || after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size) {
      fail(`${label} changed while hashing`);
    }
    return { sha256: hash.digest('hex'), size: total };
  } finally {
    fs.closeSync(descriptor);
  }
}

function sourceFile(sourceDirectory, relative, maximum, label) {
  const root = realDirectory(sourceDirectory, 'sourceDirectory');
  if (path.isAbsolute(relative) || relative.split('/').some((part) => part === '' || part === '.' || part === '..')) {
    fail(`${label} is not a literal contained relative path`);
  }
  const filename = path.resolve(root, relative);
  const relation = path.relative(root, filename);
  if (relation === '' || relation === '..' || relation.startsWith(`..${path.sep}`) || path.isAbsolute(relation)) {
    fail(`${label} escapes sourceDirectory`);
  }
  let cursor = root;
  for (const part of relation.split(path.sep)) {
    cursor = path.join(cursor, part);
    const entry = fs.lstatSync(cursor);
    if (entry.isSymbolicLink() || (cursor !== filename && !entry.isDirectory())) fail(`${label} has an unsafe ancestor`);
  }
  return readBoundedFile(filename, maximum, label);
}

function parseMetadata(sourceDirectory, expectedMetadataSha256) {
  if (typeof expectedMetadataSha256 !== 'string' || !SHA256.test(expectedMetadataSha256)) {
    fail('expectedMetadataSha256 must be a lowercase SHA-256 digest');
  }
  const bytes = sourceFile(sourceDirectory, METADATA_FILENAME, MAX_METADATA_BYTES, 'metadata');
  if (sha256(bytes) !== expectedMetadataSha256) fail('metadata digest does not match the caller anchor');
  let metadata;
  try {
    metadata = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    fail('metadata must be valid UTF-8 JSON');
  }
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata) || !Array.isArray(metadata.assets)) {
    fail('metadata has an invalid export envelope');
  }
  return { metadata, bytes };
}

function normalizedSnapshot(metadata) {
  return {
    ...metadata,
    version: 1,
    datasets: metadata.datasets,
    cases: metadata.cases,
    assets: metadata.assets.map((asset) => ({ ...asset, byteLength: asset.bytes })),
    runs: metadata.runs,
  };
}

function assetReferences(metadata) {
  const result = [];
  for (const asset of metadata.assets) {
    if (asset === null || typeof asset !== 'object' || typeof asset.id !== 'string' || typeof asset.file !== 'string'
      || typeof asset.sha256 !== 'string' || !SHA256.test(asset.sha256) || !Number.isSafeInteger(asset.bytes)
      || asset.bytes < 0 || asset.bytes > MAX_ASSET_BYTES) {
      fail('metadata has an invalid asset reference');
    }
    const expected = `assets/${sha256(Buffer.from(asset.id))}.blob`;
    if (asset.file !== expected) fail('metadata asset file is not its literal id-derived path');
    result.push(asset);
  }
  return result;
}

async function runtimeModules(runtimeDirectory) {
  const runtime = realDirectory(runtimeDirectory, 'runtimeDirectory');
  const importModule = (relative) => import(pathToFileURL(path.join(runtime, relative)).href);
  return Promise.all([
    importModule('server/src/db/openNativeDatabase.js'),
    importModule('server/src/db/calibrationHarnessSchema.js'),
    importModule('server/src/services/calibrationHarnessImport.js'),
    importModule('shared/calibrationHarness.js'),
  ]).then(([native, schema, importer, shared]) => ({ native, schema, importer, shared, runtime }));
}

async function seedAsync(request) {
  const { sourceDirectory, databasePath, ownerId, harnessId, expectedMetadataSha256, runtimeDirectory } = request ?? {};
  const targetParent = captureTargetParent(databasePath, 'databasePath');
  const target = targetParent.target;
  assertAbsentRegularSidecars(target);
  const { metadata } = parseMetadata(sourceDirectory, expectedMetadataSha256);
  const modules = await runtimeModules(runtimeDirectory);
  assertTargetParent(targetParent);
  assertAbsentRegularSidecars(target);
  const expected = normalizedSnapshot(metadata);
  modules.shared.validateCalibrationHarnessSnapshot(expected);
  const descriptor = fs.openSync(target, 'wx', 0o600);
  let targetIdentity;
  try {
    const created = fs.fstatSync(descriptor);
    if (!created.isFile()) fail('databasePath was not created as a regular file');
    targetIdentity = { filename: target, dev: created.dev, ino: created.ino, size: created.size, label: 'databasePath' };
  } finally {
    fs.closeSync(descriptor);
  }
  let database;
  try {
    assertTargetParent(targetParent);
    assertRegularFileIdentity(targetIdentity);
    database = modules.native.openNativeDatabase(target);
    database.pragma('journal_mode = DELETE');
    modules.schema.initializeCalibrationHarnessSchema(database);
    const result = modules.importer.importCalibrationHarnessBundle({
      database,
      sourceDirectory,
      ownerId,
      harnessId,
      expectedRevision: null,
      expectedMetadataSha256,
    });
    database.pragma('wal_checkpoint(TRUNCATE)');
    database.close();
    database = undefined;
    assertTargetParent(targetParent);
    assertRegularFileIdentity(targetIdentity);
    assertNoSidecars(target);
    return {
      databasePath: target,
      revision: result.revision,
      metadataSha256: expectedMetadataSha256,
      counts: countSnapshot(expected),
    };
  } finally {
    try { database?.close(); } catch { /* Preserve the original seed/close failure. */ }
  }
}

function assertNoSidecars(filename) {
  for (const suffix of ['-wal', '-shm', '-journal']) {
    try {
      fs.lstatSync(`${filename}${suffix}`);
      fail(`SQLite sidecar remains after closure: ${suffix}`);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
}

function countSnapshot(snapshot) {
  return {
    datasets: snapshot.datasets.length,
    cases: snapshot.cases.length,
    assets: snapshot.assets.length,
    runs: snapshot.runs.length,
  };
}

function schemaCatalog(database) {
  return database.prepare('SELECT type, name, tbl_name, sql FROM main.sqlite_schema ORDER BY type, name, tbl_name, sql').all();
}

function freshSchemaCatalog(modules, Database, nativeBinding) {
  const fresh = new Database(':memory:', nativeBinding ? { nativeBinding } : undefined);
  try {
    modules.schema.initializeCalibrationHarnessSchema(fresh);
    return schemaCatalog(fresh);
  } finally {
    fresh.close();
  }
}

async function verifyAsync(request) {
  const { sourceDirectory, databasePath, ownerId, harnessId, expectedMetadataSha256, runtimeDirectory } = request ?? {};
  const targetParent = captureTargetParent(databasePath, 'databasePath');
  const target = targetParent.target;
  const targetIdentity = captureRegularFile(target, 'databasePath');
  assertNoSidecars(target);
  const { metadata } = parseMetadata(sourceDirectory, expectedMetadataSha256);
  const assets = assetReferences(metadata);
  const modules = await runtimeModules(runtimeDirectory);
  assertTargetParent(targetParent);
  assertRegularFileIdentity(targetIdentity, true);
  assertNoSidecars(target);
  const expected = normalizedSnapshot(metadata);
  modules.shared.validateCalibrationHarnessSnapshot(expected);
  const expectedJson = modules.shared.canonicalHarnessJson(expected);
  const require = createRequire(pathToFileURL(path.join(modules.runtime, 'server/src/db/openNativeDatabase.js')));
  const Database = require('better-sqlite3');
  const nativeBinding = process.env.PROXXIED_SQLITE_NATIVE_BINDING;
  const database = new Database(target, {
    readonly: true,
    fileMustExist: true,
    ...(nativeBinding ? { nativeBinding } : {}),
  });
  let verification;
  let committed = false;
  try {
    database.pragma('foreign_keys = ON');
    database.exec('BEGIN');
    assert.equal(database.pragma('user_version', { simple: true }), modules.schema.CALIBRATION_HARNESS_SCHEMA_VERSION, 'SQLite schema version mismatch');
    // At the exact current version this is read-only structural validation;
    // the native readonly handle also prevents any accidental migration write.
    modules.schema.initializeCalibrationHarnessSchema(database);
    const expectedCatalog = freshSchemaCatalog(modules, Database, nativeBinding);
    assert.deepEqual(schemaCatalog(database), expectedCatalog, 'SQLite schema catalog does not exactly match fresh initialized schema');
    assert.deepEqual(database.pragma('integrity_check', { simple: true }), 'ok', 'SQLite integrity check failed');
    assert.deepEqual(database.pragma('foreign_key_check'), [], 'SQLite foreign-key check failed');
    const current = database.prepare('SELECT revision, snapshot_json FROM mpc_harnesses WHERE owner_id = ? AND harness_id = ?').get(ownerId, harnessId);
    const history = database.prepare('SELECT revision, snapshot_json, digest FROM mpc_harness_revisions WHERE owner_id = ? AND harness_id = ? AND revision = 1').get(ownerId, harnessId);
    if (current === undefined || history === undefined || current.revision !== 1 || history.revision !== 1) fail('owner/harness revision 1 is absent');
    if (current.snapshot_json !== expectedJson || history.snapshot_json !== expectedJson) fail('SQLite snapshot does not exactly equal normalized source metadata');
    if (history.digest !== sha256(Buffer.from(expectedJson))) fail('immutable revision digest does not match normalized source metadata');
    const counts = {
      datasets: expected.datasets.length,
      cases: expected.cases.length,
      assets: expected.assets.length,
      runs: expected.runs.length,
      blobs: database.prepare('SELECT COUNT(*) AS count FROM mpc_harness_blobs WHERE owner_id = ?').get(ownerId).count,
      sessions: database.prepare('SELECT COUNT(*) AS count FROM mpc_harness_sessions').get().count,
    };
    assert.equal(counts.sessions, 0, 'fresh seed must not contain authentication sessions');
    if (database.prepare('SELECT COUNT(*) AS count FROM mpc_harnesses').get().count !== 1
      || database.prepare('SELECT COUNT(*) AS count FROM mpc_harness_revisions').get().count !== 1
      || database.prepare('SELECT COUNT(*) AS count FROM mpc_harness_blobs').get().count !== counts.blobs
      || database.prepare('SELECT COUNT(*) AS count FROM mpc_harness_blobs WHERE owner_id <> ?').get(ownerId).count !== 0
      || database.prepare('SELECT COUNT(*) AS count FROM mpc_harnesses WHERE owner_id <> ? OR harness_id <> ?').get(ownerId, harnessId).count !== 0
      || database.prepare('SELECT COUNT(*) AS count FROM mpc_harness_revisions WHERE owner_id <> ? OR harness_id <> ?').get(ownerId, harnessId).count !== 0) fail('unexpected owner-scoped rows');
    const unique = new Map();
    for (const asset of assets) {
      const sourceBytes = sourceFile(sourceDirectory, asset.file, MAX_ASSET_BYTES, `asset ${asset.id}`);
      if (sourceBytes.byteLength !== asset.bytes || sha256(sourceBytes) !== asset.sha256) fail(`source asset mismatch: ${asset.id}`);
      const stored = database.prepare('SELECT data, byte_length FROM mpc_harness_blobs WHERE owner_id = ? AND sha256 = ?').get(ownerId, asset.sha256);
      if (stored === undefined || stored.byte_length !== asset.bytes || !Buffer.from(stored.data).equals(sourceBytes)) {
        fail(`stored blob mismatch: ${asset.id}`);
      }
      unique.set(asset.sha256, { sha256: asset.sha256, byteLength: asset.bytes });
    }
    if (counts.blobs !== unique.size) fail('deduplicated blob count does not match referenced content hashes');
    verification = {
      databasePath: target,
      revision: 1,
      metadata: expected,
      counts,
      blobs: [...unique.values()],
    };
    database.exec('COMMIT');
    committed = true;
  } finally {
    if (!committed) {
      try { database.exec('ROLLBACK'); } catch { /* Preserve the original verification failure. */ }
    }
    database.close();
    assertTargetParent(targetParent);
    assertRegularFileIdentity(targetIdentity, true);
    assertNoSidecars(target);
  }
  return { ...verification, sealed: hashBoundedFile(target, Number.MAX_SAFE_INTEGER, 'sealed database') };
}

export async function seedCalibrationHarnessBundle(request) {
  return seedAsync(request);
}

export async function verifyCalibrationHarnessBundle(request) {
  return verifyAsync(request);
}

function parseArguments(argv) {
  const [operation, ...rest] = argv;
  if (operation !== 'seed' && operation !== 'verify') fail('usage: seed|verify --source DIR --database FILE --owner-id ID --harness-id ID --metadata-sha256 SHA256 --runtime-dir DIR');
  const names = new Map([['--source', 'sourceDirectory'], ['--database', 'databasePath'], ['--owner-id', 'ownerId'], ['--harness-id', 'harnessId'], ['--metadata-sha256', 'expectedMetadataSha256'], ['--runtime-dir', 'runtimeDirectory']]);
  const output = {};
  for (let index = 0; index < rest.length; index += 2) {
    const key = names.get(rest[index]);
    if (key === undefined || typeof rest[index + 1] !== 'string' || output[key] !== undefined) fail('invalid command arguments');
    output[key] = rest[index + 1];
  }
  if (Object.keys(output).length !== names.size) fail('missing command argument');
  return { operation, request: output };
}

async function main() {
  const { operation, request } = parseArguments(process.argv.slice(2));
  const result = operation === 'seed' ? await seedCalibrationHarnessBundle(request) : await verifyCalibrationHarnessBundle(request);
  process.stdout.write(`${JSON.stringify({ operation, databasePath: result.databasePath, revision: result.revision, metadataSha256: request.expectedMetadataSha256, counts: result.counts, sealed: result.sealed })}\n`);
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  main().catch(() => { process.stderr.write('calibration harness seed/verify failed\n'); process.exitCode = 1; });
}
