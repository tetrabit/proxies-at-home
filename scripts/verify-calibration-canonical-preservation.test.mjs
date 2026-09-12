import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

import { canonicalPreservationSnapshotJson, verifyCanonicalFramedDatabase } from './verify-calibration-canonical-preservation.mjs';

const requireFromServer = createRequire(new URL('../server/package.json', import.meta.url));
const Database = requireFromServer('better-sqlite3');
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const fixtureParent = path.join(root, '.review-artifacts', 'td-80f260', 'preservation-fixtures');

class Frames {
  constructor(frames) {
    this.bytes = Buffer.concat(frames.flatMap((frame) => [Buffer.from(Uint8Array.of(...new Array(8)).buffer), frame]));
    let offset = 0;
    for (const frame of frames) {
      this.bytes.writeBigUInt64BE(BigInt(frame.length), offset);
      offset += 8 + frame.length;
    }
    this.offset = 0;
  }

  readExact(length) {
    assert.ok(Number.isSafeInteger(length) && length >= 0);
    assert.ok(this.offset + length <= this.bytes.length, 'fixture frame exhausted');
    const output = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return output;
  }

  readU64() {
    return Number(this.readExact(8).readBigUInt64BE());
  }

  assertExhausted() {
    assert.equal(this.offset, this.bytes.length, 'unexpected fixture frame data');
  }
}

function fixture() {
  mkdirSync(fixtureParent, { recursive: true, mode: 0o700 });
  const directory = mkdtempSync(path.join(fixtureParent, 'fixture-'));
  const databasePath = path.join(directory, 'calibration-harness.db');
  const first = Buffer.from('immutable asset bytes');
  const second = Buffer.from('second immutable asset bytes');
  const firstHash = sha256(first);
  const secondHash = sha256(second);
  const ownerId = 'owner-fixture';
  const harnessId = 'harness-fixture';
  const metadata = {
    datasets: [{ id: 'dataset-1' }],
    cases: [{ id: 'case-1', datasetId: 'dataset-1' }],
    assets: [
      { id: 'asset-1', file: `assets/${sha256('asset-1')}.blob`, sha256: firstHash, bytes: first.length },
      { id: 'asset-2', file: `assets/${sha256('asset-2')}.blob`, sha256: secondHash, bytes: second.length },
    ],
    runs: [{ id: 'run-1' }],
  };
  const metadataBytes = Buffer.from(JSON.stringify(metadata));
  const snapshot = canonicalPreservationSnapshotJson(metadata);
  const writable = new Database(databasePath);
  writable.exec(`
    CREATE TABLE mpc_harnesses (owner_id TEXT NOT NULL, harness_id TEXT NOT NULL, revision INTEGER NOT NULL, snapshot_json TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (owner_id, harness_id));
    CREATE TABLE mpc_harness_revisions (owner_id TEXT NOT NULL, harness_id TEXT NOT NULL, revision INTEGER NOT NULL, snapshot_json TEXT NOT NULL, digest TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (owner_id, harness_id, revision));
    CREATE TABLE mpc_harness_blobs (owner_id TEXT NOT NULL, sha256 TEXT NOT NULL, data BLOB NOT NULL, byte_length INTEGER NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (owner_id, sha256));
    CREATE TABLE mpc_harness_sessions (token_hash TEXT NOT NULL PRIMARY KEY, owner_id TEXT NOT NULL, harness_id TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
    PRAGMA user_version = 1;
  `);
  writable.prepare('INSERT INTO mpc_harnesses VALUES (?, ?, 1, ?, 1)').run(ownerId, harnessId, snapshot);
  writable.prepare('INSERT INTO mpc_harness_revisions VALUES (?, ?, 1, ?, ?, 1)').run(ownerId, harnessId, snapshot, sha256(snapshot));
  writable.prepare('INSERT INTO mpc_harness_blobs VALUES (?, ?, ?, ?, 1)').run(ownerId, firstHash, first, first.length);
  writable.prepare('INSERT INTO mpc_harness_blobs VALUES (?, ?, ?, ?, 1)').run(ownerId, secondHash, second, second.length);
  writable.prepare('INSERT INTO mpc_harness_sessions VALUES (?, ?, ?, ?, ?)').run('a'.repeat(64), ownerId, harnessId, 100, -1);
  writable.prepare('INSERT INTO mpc_harness_sessions VALUES (?, ?, ?, ?, ?)').run('b'.repeat(64), ownerId, harnessId, 100, 200);
  const catalog = writable.prepare('SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name, tbl_name').all();
  writable.close();
  return {
    databasePath,
    metadata,
    assetFrames: [metadataBytes, first, second],
    expected: {
      ownerId,
      harnessId,
      metadataSha256: sha256(metadataBytes),
      snapshotSha256: sha256(snapshot),
      schemaSha256: sha256(JSON.stringify(catalog)),
      logicalCounts: { datasets: 1, cases: 1, assets: 2, runs: 1 },
      counts: { datasets: 1, cases: 1, assets: 2, runs: 1, blobs: 2 },
      requiredPermanentCredentials: 1,
    },
  };
}

function verify(bundle) {
  const database = new Database(bundle.databasePath, { readonly: true, fileMustExist: true });
  try {
    return verifyCanonicalFramedDatabase(database, bundle.expected, new Frames(bundle.assetFrames));
  } finally {
    database.close();
  }
}

test('accepts the immutable export with one permanent credential and finite browser sessions', () => {
  const bundle = fixture();
  const result = verify(bundle);
  assert.deepEqual(result.counts, bundle.expected.counts);
  assert.deepEqual(result.sessions, { total: 2, permanentCredentials: 1, finiteBrowserSessions: 1 });
  assert.equal(result.logicalAssetsVerified, 2);
  assert.equal(result.uniqueBlobsVerified, 2);
  assert.doesNotMatch(JSON.stringify(result), /token_hash|aaaaaaaa|bbbbbbbb/);
});

test('rejects a corrupt preserved-export metadata frame', () => {
  const bundle = fixture();
  bundle.assetFrames[0] = Buffer.from(JSON.stringify({ ...bundle.metadata, runs: [] }));
  assert.throws(() => verify(bundle), /metadata SHA-256/);
});

test('rejects a corrupt immutable history snapshot', () => {
  const bundle = fixture();
  const writable = new Database(bundle.databasePath);
  writable.prepare('UPDATE mpc_harness_revisions SET snapshot_json = ?').run('{"corrupt":true}');
  writable.close();
  assert.throws(() => verify(bundle), /history snapshot/);
});

test('rejects a corrupt immutable BLOB even when its length remains unchanged', () => {
  const bundle = fixture();
  const writable = new Database(bundle.databasePath);
  writable.prepare('UPDATE mpc_harness_blobs SET data = ? WHERE sha256 = ?').run(Buffer.from('Xmmutable asset bytes'), bundle.metadata.assets[0].sha256);
  writable.close();
  assert.throws(() => verify(bundle), /BLOB differs from preserved export/);
});

test('rejects an extra permanent credential', () => {
  const bundle = fixture();
  const writable = new Database(bundle.databasePath);
  writable.prepare('INSERT INTO mpc_harness_sessions VALUES (?, ?, ?, ?, ?)').run('c'.repeat(64), bundle.expected.ownerId, bundle.expected.harnessId, 100, -1);
  writable.close();
  assert.throws(() => verify(bundle), /permanent credential count/);
});
