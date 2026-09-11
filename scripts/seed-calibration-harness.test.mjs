import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import {
  existsSync,
  mkdirSync,
  renameSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import {
  createDataFixture,
  createExclusiveFixture,
  createFreshRuntimeFixture,
  ensureSafeDirectoryTree,
  evidenceRoot,
  repositoryRoot,
} from './fixtures/seed-calibration-harness-fixtures.mjs';

const root = repositoryRoot;
const { runtimeDirectory } = createFreshRuntimeFixture();

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function createTinyExport(directory) {
  const source = path.join(directory, 'source');
  mkdirSync(source, { mode: 0o700 });
  mkdirSync(path.join(source, 'assets'), { mode: 0o700 });
  const first = Buffer.from('first blob bytes\n');
  const second = Buffer.from('first blob bytes\n');
  const ids = ['asset-one', 'asset-two'];
  const sourceAssets = [first, second].map((bytes, index) => {
    const id = ids[index];
    const digest = sha256(bytes);
    const filename = `${sha256(Buffer.from(id))}.blob`;
    writeFileSync(path.join(source, 'assets', filename), bytes, { flag: 'wx', mode: 0o600 });
    return {
      id,
      datasetId: 'dataset-a',
      caseId: 'case-a',
      role: index === 0 ? 'source' : 'source-art',
      mimeType: 'application/octet-stream',
      createdAt: 1,
      sha256: digest,
      byteLength: bytes.byteLength,
      bytes: bytes.byteLength,
      file: `assets/${filename}`,
      unknownAssetField: { preserved: index },
    };
  });
  const metadata = {
    schema: 'proxxied-mpc-calibration-backup/v1',
    databaseVersion: 1,
    version: 1,
    assetBytes: first.byteLength + second.byteLength,
    datasets: [{ id: 'dataset-a', name: 'Dataset', targetCaseCount: 1, createdAt: 1, updatedAt: 2, version: 0, unknownDatasetField: true }],
    cases: [{
      id: 'case-a', datasetId: 'dataset-a', createdAt: 1, updatedAt: 2,
      source: { name: 'Case', unknownSourceField: 'preserve' },
      candidates: [{ identifier: 'candidate-a', name: 'Candidate', rawName: 'Candidate', smallThumbnailUrl: '', mediumThumbnailUrl: '', imageUrl: '', sourceName: '', source: '', extension: '', dpi: 0, size: 0, tags: [] }],
      unknownCaseField: ['preserve'],
    }],
    assets: sourceAssets,
    runs: [{ id: 'run-a', datasetId: 'dataset-a', algorithmId: 'algo', createdAt: 3, summary: { totalCases: 1, matchedCases: 1, mismatchedCases: 0, accuracy: 1 }, results: [{ caseId: 'case-a', matched: true }], unknownRunField: { preserve: true } }],
    unknownTopLevelField: { preserved: ['yes'] },
  };
  const metadataBytes = Buffer.from(JSON.stringify(metadata));
  writeFileSync(path.join(source, 'calibration-data.json'), metadataBytes, { flag: 'wx', mode: 0o600 });
  return { source, metadata, metadataSha256: sha256(metadataBytes), blobs: [first, second] };
}

test('generic fixture allocation validates all existing ancestors before mkdir and retains collision controls', () => {
  const fixture = createDataFixture();
  const actual = path.join(fixture, 'actual');
  const link = path.join(fixture, 'link');
  mkdirSync(actual, { mode: 0o700 });
  symlinkSync(actual, link, 'dir');
  assert.throws(() => ensureSafeDirectoryTree(path.join(link, 'must-not-be-created')), /unsafe ancestor/);
  assert.deepEqual(readdirSync(actual), []);

  const collision = randomUUID();
  createExclusiveFixture(path.join(evidenceRoot, 'test-fixtures'), collision);
  assert.throws(() => createExclusiveFixture(path.join(evidenceRoot, 'test-fixtures'), collision), /exclusive fixture collision/);
});

test('reusable fixture roots do not embed a historical task run', () => {
  assert.equal(evidenceRoot, path.join(root, '.review-artifacts', 'seed-calibration-harness'));
  assert.equal(path.dirname(path.dirname(runtimeDirectory)), path.join(root, 'server', '.review-artifacts', 'seed-calibration-harness', 'runtime-fixtures'));
});

for (const violation of ['schema-version', 'authentication-session']) {
  test(`fresh-seed verification rejects ${violation} without changing the fixture`, async () => {
    const fixture = createDataFixture();
    const { source, metadataSha256 } = createTinyExport(fixture);
    const databasePath = path.join(fixture, 'invalid-seed-state.db');
    const { seedCalibrationHarnessBundle, verifyCalibrationHarnessBundle } = await import('./seed-calibration-harness.mjs');
    const request = { sourceDirectory: source, databasePath, ownerId: 'owner-test', harnessId: 'harness-test', expectedMetadataSha256: metadataSha256, runtimeDirectory };
    await seedCalibrationHarnessBundle(request);
    const { openNativeDatabase } = await import(pathToFileURL(path.join(runtimeDirectory, 'server/src/db/openNativeDatabase.js')).href);
    const database = openNativeDatabase(databasePath);
    try {
      if (violation === 'schema-version') database.pragma('user_version = 2');
      else database.prepare('INSERT INTO mpc_harness_sessions (token_hash, owner_id, harness_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)').run('0'.repeat(64), 'owner-test', 'harness-test', 1, 2);
    } finally {
      database.close();
    }
    const before = sha256(readFileSync(databasePath));
    await assert.rejects(verifyCalibrationHarnessBundle(request), /schema version|authentication sessions/);
    assert.equal(sha256(readFileSync(databasePath)), before);
  });
}

test('seed initializes a new controlled SQLite with the accepted importer and verify proves source equality', async () => {
  const fixture = createDataFixture();
  const { source, metadata, metadataSha256, blobs } = createTinyExport(fixture);
  const databasePath = path.join(fixture, 'staging.db');
  const { seedCalibrationHarnessBundle, verifyCalibrationHarnessBundle } = await import('./seed-calibration-harness.mjs');

  const seeded = await seedCalibrationHarnessBundle({
    sourceDirectory: source,
    databasePath,
    ownerId: 'owner-test',
    harnessId: 'harness-test',
    expectedMetadataSha256: metadataSha256,
    runtimeDirectory,
  });
  assert.equal(seeded.revision, 1);
  assert.equal(seeded.counts.assets, 2);
  assert.equal(existsSync(databasePath), true);

  const verified = await verifyCalibrationHarnessBundle({
    sourceDirectory: source,
    databasePath,
    ownerId: 'owner-test',
    harnessId: 'harness-test',
    expectedMetadataSha256: metadataSha256,
    runtimeDirectory,
  });
  assert.equal(verified.revision, 1);
  assert.deepEqual(verified.counts, { datasets: 1, cases: 1, assets: 2, runs: 1, blobs: 1, sessions: 0 });
  assert.equal(verified.metadata.unknownTopLevelField.preserved[0], metadata.unknownTopLevelField.preserved[0]);
  assert.deepEqual(verified.blobs.map((blob) => blob.sha256), [sha256(blobs[0])]);
});

async function createSeededCatalogFixture() {
  const fixture = createDataFixture();
  const { source, metadataSha256 } = createTinyExport(fixture);
  const databasePath = path.join(fixture, 'catalog.db');
  const { seedCalibrationHarnessBundle, verifyCalibrationHarnessBundle } = await import('./seed-calibration-harness.mjs');
  const request = { sourceDirectory: source, databasePath, ownerId: 'owner-test', harnessId: 'harness-test', expectedMetadataSha256: metadataSha256, runtimeDirectory };
  await seedCalibrationHarnessBundle(request);
  return { databasePath, request, verifyCalibrationHarnessBundle };
}

for (const [label, mutate] of [
  ['extra trigger', (database) => database.exec('CREATE TRIGGER catalog_extra AFTER UPDATE ON mpc_harnesses BEGIN SELECT 1; END')],
  ['extra index', (database) => database.exec('CREATE INDEX catalog_extra ON mpc_harnesses(owner_id)')],
  ['extra view', (database) => database.exec('CREATE VIEW catalog_extra AS SELECT owner_id FROM mpc_harnesses')],
  ['extra table', (database) => database.exec('CREATE TABLE catalog_extra (value TEXT)')],
  ['removed revision CHECK', (database) => {
    const current = database.prepare('SELECT sql FROM sqlite_schema WHERE name = ?').get('mpc_harnesses').sql;
    const changed = current.replace(/CHECK\s*\(\s*revision\s*>=\s*1\s*\)/i, '');
    assert.notEqual(changed, current, 'fixture must remove a real revision CHECK');
    database.unsafeMode(true);
    const schemaVersion = database.pragma('schema_version', { simple: true });
    database.pragma('writable_schema = ON');
    database.prepare('UPDATE sqlite_schema SET sql = ? WHERE name = ?').run(changed, 'mpc_harnesses');
    database.pragma(`schema_version = ${schemaVersion + 1}`);
    database.pragma('writable_schema = OFF');
  }],
]) {
  test(`verify rejects a fresh seed catalog with ${label}`, async () => {
    const { databasePath, request, verifyCalibrationHarnessBundle } = await createSeededCatalogFixture();
    const { openNativeDatabase } = await import(pathToFileURL(path.join(runtimeDirectory, 'server/src/db/openNativeDatabase.js')).href);
    const database = openNativeDatabase(databasePath);
    try {
      mutate(database);
    } finally {
      database.close();
    }
    const before = sha256(readFileSync(databasePath));
    await assert.rejects(verifyCalibrationHarnessBundle(request), /schema catalog/);
    assert.equal(sha256(readFileSync(databasePath)), before);
  });
}

test('verify accepts the complete catalog produced by the fresh schema initializer', async () => {
  const { request, verifyCalibrationHarnessBundle } = await createSeededCatalogFixture();
  const verified = await verifyCalibrationHarnessBundle(request);
  assert.equal(verified.revision, 1);
  assert.equal(verified.counts.sessions, 0);
});

test('verify rejects foreign owner blobs instead of counting only the declared owner', async () => {
  const fixture = createDataFixture();
  const { source, metadataSha256 } = createTinyExport(fixture);
  const databasePath = path.join(fixture, 'foreign-owner.db');
  const { seedCalibrationHarnessBundle, verifyCalibrationHarnessBundle } = await import('./seed-calibration-harness.mjs');
  const request = { sourceDirectory: source, databasePath, ownerId: 'owner-test', harnessId: 'harness-test', expectedMetadataSha256: metadataSha256, runtimeDirectory };
  await seedCalibrationHarnessBundle(request);
  const require = createRequire(pathToFileURL(path.join(runtimeDirectory, 'server', 'src', 'db', 'openNativeDatabase.js')));
  const Database = require('better-sqlite3');
  const database = new Database(databasePath);
  try {
    const bytes = Buffer.from('foreign owner blob');
    database.prepare('INSERT INTO mpc_harness_blobs (owner_id, sha256, data, byte_length, created_at) VALUES (?, ?, ?, ?, ?)').run(
      'foreign-owner', sha256(bytes), bytes, bytes.byteLength, 1,
    );
  } finally {
    database.close();
  }
  await assert.rejects(verifyCalibrationHarnessBundle(request), /unexpected owner-scoped rows/);
});

test('seed source readers request nonblocking no-follow descriptor admission before reading', async () => {
  const fixture = createDataFixture();
  const { source, metadataSha256 } = createTinyExport(fixture);
  const { seedCalibrationHarnessBundle } = await import('./seed-calibration-harness.mjs');
  const originalOpen = fs.openSync;
  let flags;
  fs.openSync = (filename, requestedFlags, ...rest) => {
    if (filename === path.join(source, 'calibration-data.json')) {
      flags = requestedFlags;
      throw new Error('injected descriptor admission stop');
    }
    return originalOpen(filename, requestedFlags, ...rest);
  };
  try {
    await assert.rejects(seedCalibrationHarnessBundle({
      sourceDirectory: source,
      databasePath: path.join(fixture, 'nonblocking.db'),
      ownerId: 'owner-test',
      harnessId: 'harness-test',
      expectedMetadataSha256: metadataSha256,
      runtimeDirectory,
    }), /injected descriptor admission stop/);
  } finally {
    fs.openSync = originalOpen;
  }
  assert.ok(flags & fs.constants.O_NOFOLLOW, 'reader must request no-follow admission');
  assert.ok(flags & fs.constants.O_NONBLOCK, 'reader must request nonblocking admission before opening a race-replaced FIFO');
});

test('publisher streams an exact sealed input into a no-replace target and removes only its owned temp', async () => {
  const fixture = createDataFixture();
  const targetDirectory = path.join(fixture, 'target');
  mkdirSync(targetDirectory, { mode: 0o700 });
  const bytes = Buffer.from('sealed sqlite bytes\n');
  const { publishCalibrationHarnessDatabase } = await import('./publish-calibration-harness-db.mjs');
  const result = await publishCalibrationHarnessDatabase({
    targetDirectory,
    expectedBytes: bytes.byteLength,
    expectedSha256: sha256(bytes),
    input: [bytes.subarray(0, 5), bytes.subarray(5)],
  });
  assert.deepEqual(result, { status: 'published', targetPath: path.join(targetDirectory, 'calibration-harness.db'), byteLength: bytes.byteLength, sha256: sha256(bytes) });
  assert.deepEqual(readFileSync(result.targetPath), bytes);
  assert.deepEqual(readdirSync(targetDirectory).sort(), ['calibration-harness.db']);
});

test('publisher preserves a competing winner created at the hard-link boundary', async () => {
  const fixture = createDataFixture();
  const targetDirectory = path.join(fixture, 'target');
  mkdirSync(targetDirectory, { mode: 0o700 });
  const bytes = Buffer.from('losing publisher bytes\n');
  const winner = Buffer.from('competing winner bytes\n');
  const { publishCalibrationHarnessDatabase } = await import('./publish-calibration-harness-db.mjs');
  const originalLink = fs.linkSync;
  fs.linkSync = (existing, finalPath) => {
    writeFileSync(finalPath, winner, { flag: 'wx', mode: 0o600 });
    return originalLink(existing, finalPath);
  };
  try {
    await assert.rejects(publishCalibrationHarnessDatabase({
      targetDirectory,
      expectedBytes: bytes.byteLength,
      expectedSha256: sha256(bytes),
      input: [bytes],
    }), /winner preserved/);
  } finally {
    fs.linkSync = originalLink;
  }
  assert.deepEqual(readFileSync(path.join(targetDirectory, 'calibration-harness.db')), winner);
  assert.equal(readdirSync(targetDirectory).filter((entry) => entry.endsWith('.tmp')).length, 1);
});

test('publisher rejects a same-fixture regular-directory replacement after awaited input', async () => {
  const fixture = createDataFixture();
  const targetDirectory = path.join(fixture, 'target');
  const retained = path.join(fixture, 'retained');
  mkdirSync(targetDirectory, { mode: 0o700 });
  const bytes = Buffer.from('directory identity drift\n');
  const { publishCalibrationHarnessDatabase } = await import('./publish-calibration-harness-db.mjs');
  async function* input() {
    renameSync(targetDirectory, retained);
    mkdirSync(targetDirectory, { mode: 0o700 });
    yield bytes;
  }
  await assert.rejects(publishCalibrationHarnessDatabase({
    targetDirectory,
    expectedBytes: bytes.byteLength,
    expectedSha256: sha256(bytes),
    input: input(),
  }), /identity changed/);
  assert.equal(existsSync(path.join(retained, 'calibration-harness.db')), false);
  assert.deepEqual(readdirSync(targetDirectory), []);
});

test('publisher preserves populated destinations and rejects unsafe admission before a temporary write', async () => {
  const fixture = createDataFixture();
  const bytes = Buffer.from('preserve destination\n');
  const { publishCalibrationHarnessDatabase } = await import('./publish-calibration-harness-db.mjs');
  const populated = path.join(fixture, 'populated');
  mkdirSync(populated, { mode: 0o700 });
  const finalPath = path.join(populated, 'calibration-harness.db');
  writeFileSync(finalPath, 'winner bytes\n', { flag: 'wx', mode: 0o600 });
  await assert.rejects(
    publishCalibrationHarnessDatabase({ targetDirectory: populated, expectedBytes: bytes.byteLength, expectedSha256: sha256(bytes), input: [bytes] }),
    /already exists/,
  );
  assert.equal(readFileSync(finalPath, 'utf8'), 'winner bytes\n');

  const actual = path.join(fixture, 'actual');
  const link = path.join(fixture, 'link');
  mkdirSync(actual, { mode: 0o700 });
  symlinkSync(actual, link, 'dir');
  await assert.rejects(
    publishCalibrationHarnessDatabase({ targetDirectory: link, expectedBytes: bytes.byteLength, expectedSha256: sha256(bytes), input: [bytes] }),
    /unsafe ancestor/,
  );
  assert.deepEqual(readdirSync(actual), []);
});

test('publisher rejects truncated, extra, and mismatched stdin before publication while retaining failed inputs', async () => {
  const fixture = createDataFixture();
  const bytes = Buffer.from('bounded stdin\n');
  const { publishCalibrationHarnessDatabase } = await import('./publish-calibration-harness-db.mjs');
  for (const [name, expectedBytes, expectedSha256, input] of [
    ['truncated', bytes.byteLength, sha256(bytes), [bytes.subarray(0, 2)]],
    ['extra', bytes.byteLength - 1, sha256(bytes), [bytes]],
    ['digest', bytes.byteLength, sha256(Buffer.from('other')), [bytes]],
  ]) {
    const directory = path.join(fixture, name);
    mkdirSync(directory, { mode: 0o700 });
    await assert.rejects(
      publishCalibrationHarnessDatabase({ targetDirectory: directory, expectedBytes, expectedSha256, input }),
    );
    assert.equal(existsSync(path.join(directory, 'calibration-harness.db')), false);
    assert.equal(readdirSync(directory).filter((entry) => entry.endsWith('.tmp')).length, 1, `${name} must retain its failed owned temp`);
  }
});

test('publisher reports late hard-link uncertainty without deleting the now-visible target', async () => {
  const fixture = createDataFixture();
  const directory = path.join(fixture, 'target');
  mkdirSync(directory, { mode: 0o700 });
  const bytes = Buffer.from('late publication\n');
  const { PublicationUncertaintyError, publishCalibrationHarnessDatabase } = await import('./publish-calibration-harness-db.mjs');
  await assert.rejects(
    publishCalibrationHarnessDatabase({
      targetDirectory: directory,
      expectedBytes: bytes.byteLength,
      expectedSha256: sha256(bytes),
      input: [bytes],
      onAfterLink: () => { throw new Error('injected after-link fault'); },
    }),
    (error) => error instanceof PublicationUncertaintyError && error.publicationMayBeVisible === true,
  );
  assert.deepEqual(readFileSync(path.join(directory, 'calibration-harness.db')), bytes);
  assert.equal(readdirSync(directory).filter((entry) => entry.endsWith('.tmp')).length, 1);
});

test('seed refuses a wrong metadata anchor before target creation and verify rejects a changed referenced blob', async () => {
  const fixture = createDataFixture();
  const { source, metadata, metadataSha256 } = createTinyExport(fixture);
  const { seedCalibrationHarnessBundle, verifyCalibrationHarnessBundle } = await import('./seed-calibration-harness.mjs');
  const wrongAnchorTarget = path.join(fixture, 'wrong-anchor.db');
  await assert.rejects(
    seedCalibrationHarnessBundle({ sourceDirectory: source, databasePath: wrongAnchorTarget, ownerId: 'owner-test', harnessId: 'harness-test', expectedMetadataSha256: '0'.repeat(64), runtimeDirectory }),
    /digest/,
  );
  assert.equal(existsSync(wrongAnchorTarget), false);

  const databasePath = path.join(fixture, 'valid.db');
  await seedCalibrationHarnessBundle({ sourceDirectory: source, databasePath, ownerId: 'owner-test', harnessId: 'harness-test', expectedMetadataSha256: metadataSha256, runtimeDirectory });
  writeFileSync(path.join(source, metadata.assets[0].file), 'changed source bytes\n', { mode: 0o600 });
  await assert.rejects(
    verifyCalibrationHarnessBundle({ sourceDirectory: source, databasePath, ownerId: 'owner-test', harnessId: 'harness-test', expectedMetadataSha256: metadataSha256, runtimeDirectory }),
    /source asset mismatch/,
  );
});

test('seed and publisher command-line operations consume explicit arguments and stdin', () => {
  const fixture = createDataFixture();
  const { source, metadataSha256 } = createTinyExport(fixture);
  const staging = path.join(fixture, 'cli-staging.db');
  const seedResult = spawnSync(process.execPath, [
    path.join(root, 'scripts', 'seed-calibration-harness.mjs'), 'seed',
    '--source', source,
    '--database', staging,
    '--owner-id', 'owner-test',
    '--harness-id', 'harness-test',
    '--metadata-sha256', metadataSha256,
    '--runtime-dir', runtimeDirectory,
  ], { cwd: root, encoding: 'utf8' });
  assert.equal(seedResult.status, 0, seedResult.stderr);
  assert.equal(JSON.parse(seedResult.stdout).counts.assets, 2);

  const targetDirectory = path.join(fixture, 'cli-target');
  mkdirSync(targetDirectory, { mode: 0o700 });
  const bytes = Buffer.from('cli stdin bytes\n');
  const publishResult = spawnSync(process.execPath, [
    path.join(root, 'scripts', 'publish-calibration-harness-db.mjs'),
    '--target-directory', targetDirectory,
    '--expected-bytes', String(bytes.byteLength),
    '--expected-sha256', sha256(bytes),
  ], { cwd: root, encoding: 'utf8', input: bytes });
  assert.equal(publishResult.status, 0, publishResult.stderr);
  assert.deepEqual(readFileSync(path.join(targetDirectory, 'calibration-harness.db')), bytes);
});
