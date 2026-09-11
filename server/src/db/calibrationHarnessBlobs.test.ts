import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import {
  CALIBRATION_HARNESS_MAX_BLOB_BYTES,
  createCalibrationHarnessBlobStore,
} from './calibrationHarnessBlobs.js';
import { initializeCalibrationHarnessSchema } from './calibrationHarnessSchema.js';
import { openNativeDatabase } from './openNativeDatabase.js';

const fixtureRoot = path.join(
  fileURLToPath(new URL('../../../', import.meta.url)),
  '.review-artifacts',
  'calibration-harness-blobs-21aa8b',
);

function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

function createExclusiveDatabase(): Database.Database {
  fs.mkdirSync(fixtureRoot, { recursive: true });
  const directory = path.join(fixtureRoot, randomUUID());
  fs.mkdirSync(directory);
  const database = openNativeDatabase(path.join(directory, 'calibration-harness.db'));
  initializeCalibrationHarnessSchema(database);
  return database;
}

describe('createCalibrationHarnessBlobStore', () => {
  it('stores exact binary content idempotently with owner isolation', () => {
    const database = createExclusiveDatabase();
    try {
      const store = createCalibrationHarnessBlobStore(database);
      const data = new Uint8Array([0, 255, 1, 128, 64, 0]);
      const digest = sha256(data);

      expect(store.put('owner/a?literal', digest, data)).toEqual({
        sha256: digest,
        byteLength: data.byteLength,
        inserted: true,
      });
      expect(store.put('owner/a?literal', digest, data)).toEqual({
        sha256: digest,
        byteLength: data.byteLength,
        inserted: false,
      });
      expect(store.put('owner-b', digest, data)).toEqual({
        sha256: digest,
        byteLength: data.byteLength,
        inserted: true,
      });
      expect(store.get('owner/a?literal', digest)).toEqual(Buffer.from(data));
      expect(store.get('owner-b', digest)).toEqual(Buffer.from(data));
      expect(store.get('owner-c', digest)).toBeNull();
      expect(store.has('owner/a?literal', digest)).toBe(true);
      expect(store.has('owner/a?literal', digest, data.byteLength)).toBe(true);
      expect(store.has('owner/a?literal', digest, data.byteLength + 1)).toBe(false);
    } finally {
      database.close();
    }
  });

  it('rejects malformed writes without changing existing blobs for either owner', () => {
    const database = createExclusiveDatabase();
    try {
      const store = createCalibrationHarnessBlobStore(database);
      const ownerAData = Buffer.from([0, 1, 2, 255]);
      const ownerBData = Buffer.from([9, 8, 7]);
      const ownerADigest = sha256(ownerAData);
      const ownerBDigest = sha256(ownerBData);
      store.put('owner-a', ownerADigest, ownerAData);
      store.put('owner-b', ownerBDigest, ownerBData);

      const rejectedWrites: Array<() => unknown> = [
        () => store.put('owner-a', ownerADigest, Buffer.from([0, 1, 2, 254])),
        () => store.put('owner-a', ownerADigest.toUpperCase(), ownerAData),
        () => store.put('', ownerADigest, ownerAData),
        () => store.put('owner\u0000a', ownerADigest, ownerAData),
        () => store.put('x'.repeat(257), ownerADigest, ownerAData),
        () => store.put('owner-a', ownerADigest, new Uint16Array([1]) as unknown as Uint8Array),
        () => store.put(
          'owner-a',
          ownerADigest,
          new Uint8Array(CALIBRATION_HARNESS_MAX_BLOB_BYTES + 1),
        ),
      ];

      for (const rejectedWrite of rejectedWrites) {
        expect(rejectedWrite).toThrow();
        expect(store.get('owner-a', ownerADigest)).toEqual(ownerAData);
        expect(store.get('owner-b', ownerBDigest)).toEqual(ownerBData);
      }
    } finally {
      database.close();
    }
  });

  it('fails closed for a corrupt existing key without replacing it', () => {
    const database = createExclusiveDatabase();
    try {
      const store = createCalibrationHarnessBlobStore(database);
      const data = Buffer.from('canonical-image');
      const digest = sha256(data);
      const corrupt = Buffer.from('not-the-canonical-image');
      database.prepare(`
        INSERT INTO mpc_harness_blobs (owner_id, sha256, data, byte_length, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run('owner-a', digest, corrupt, corrupt.byteLength, 1);

      expect(store.get('owner-a', digest)).toBeNull();
      expect(store.has('owner-a', digest)).toBe(false);
      expect(() => store.put('owner-a', digest, data)).toThrow(/corrupt immutable existing/i);
      expect(database.prepare(`
        SELECT data, byte_length
        FROM mpc_harness_blobs
        WHERE owner_id = ? AND sha256 = ?
      `).get('owner-a', digest)).toEqual({ data: corrupt, byte_length: corrupt.byteLength });
    } finally {
      database.close();
    }
  });

  it('refuses corrupt oversized rows before reading their blob data', () => {
    const database = createExclusiveDatabase();
    try {
      const store = createCalibrationHarnessBlobStore(database);
      const digest = 'f'.repeat(64);
      database.pragma('ignore_check_constraints = ON');
      database.prepare(`
        INSERT INTO mpc_harness_blobs (owner_id, sha256, data, byte_length, created_at)
        VALUES (?, ?, zeroblob(?), ?, ?)
      `).run(
        'owner-a',
        digest,
        CALIBRATION_HARNESS_MAX_BLOB_BYTES + 1,
        CALIBRATION_HARNESS_MAX_BLOB_BYTES + 1,
        1,
      );
      database.pragma('ignore_check_constraints = OFF');

      expect(store.get('owner-a', digest)).toBeNull();
      expect(store.has('owner-a', digest)).toBe(false);
    } finally {
      database.close();
    }
  });

  it('preserves a file-backed blob across a close and reopen', () => {
    const database = createExclusiveDatabase();
    const filename = database.name;
    const data = new Uint8Array([0, 255, 2, 0, 252, 3]);
    const digest = sha256(data);
    createCalibrationHarnessBlobStore(database).put('owner-a', digest, data);
    database.close();

    const reopened = openNativeDatabase(filename);
    try {
      initializeCalibrationHarnessSchema(reopened);
      const store = createCalibrationHarnessBlobStore(reopened);
      expect(store.get('owner-a', digest)).toEqual(Buffer.from(data));
      expect(store.has('owner-a', digest, data.byteLength)).toBe(true);
    } finally {
      reopened.close();
    }
  });
});
