import { createHash } from 'node:crypto';

import type Database from 'better-sqlite3';

export const CALIBRATION_HARNESS_MAX_BLOB_BYTES = 32 * 1024 * 1024;

interface BlobMetadata {
  byte_length: number;
  stored_length: number;
}

interface BlobData {
  data: Buffer;
}

export interface CalibrationHarnessBlobStore {
  put(ownerId: string, sha256: string, data: Uint8Array): {
    sha256: string;
    byteLength: number;
    inserted: boolean;
  };
  get(ownerId: string, sha256: string): Buffer | null;
  has(ownerId: string, sha256: string, byteLength?: number): boolean;
}

function assertOwnerId(ownerId: string): void {
  if (
    typeof ownerId !== 'string'
    || ownerId.length === 0
    || ownerId.length > 256
    || /\p{Cc}/u.test(ownerId)
  ) {
    throw new Error('Calibration harness blob owner ID must be a nonempty control-free string no longer than 256 characters');
  }
}

function assertSha256(sha256: string): void {
  if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) {
    throw new Error('Calibration harness blob SHA-256 must be exactly 64 lowercase hexadecimal characters');
  }
}

function assertData(data: Uint8Array): void {
  if (!(data instanceof Uint8Array)) {
    throw new Error('Calibration harness blob data must be a Uint8Array');
  }
  if (data.byteLength > CALIBRATION_HARNESS_MAX_BLOB_BYTES) {
    throw new Error(`Calibration harness blob data exceeds ${CALIBRATION_HARNESS_MAX_BLOB_BYTES} bytes`);
  }
}

function assertRequestedByteLength(byteLength: number | undefined): void {
  if (
    byteLength !== undefined
    && (!Number.isSafeInteger(byteLength) || byteLength < 0 || byteLength > CALIBRATION_HARNESS_MAX_BLOB_BYTES)
  ) {
    throw new Error(`Calibration harness blob byte length must be an integer between 0 and ${CALIBRATION_HARNESS_MAX_BLOB_BYTES}`);
  }
}

function digest(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

function hasValidMetadata(metadata: BlobMetadata): boolean {
  return Number.isSafeInteger(metadata.byte_length)
    && Number.isSafeInteger(metadata.stored_length)
    && metadata.byte_length >= 0
    && metadata.byte_length <= CALIBRATION_HARNESS_MAX_BLOB_BYTES
    && metadata.byte_length === metadata.stored_length;
}

/**
 * Opens an owner-scoped content-addressed blob store over an initialized
 * calibration harness database. It deliberately exposes no deletion or GC API.
 */
export function createCalibrationHarnessBlobStore(database: Database.Database): CalibrationHarnessBlobStore {
  const selectMetadata = database.prepare(`
    SELECT byte_length, length(data) AS stored_length
    FROM mpc_harness_blobs
    WHERE owner_id = ? AND sha256 = ?
  `);
  const selectData = database.prepare(`
    SELECT data
    FROM mpc_harness_blobs
    WHERE owner_id = ? AND sha256 = ?
  `);
  const insertBlob = database.prepare(`
    INSERT INTO mpc_harness_blobs (owner_id, sha256, data, byte_length, created_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(owner_id, sha256) DO NOTHING
  `);

  function readVerified(ownerId: string, sha256: string): Buffer | null {
    const metadata = selectMetadata.get(ownerId, sha256) as BlobMetadata | undefined;
    if (metadata === undefined || !hasValidMetadata(metadata)) {
      return null;
    }

    const row = selectData.get(ownerId, sha256) as BlobData | undefined;
    if (row === undefined || !Buffer.isBuffer(row.data) || row.data.byteLength !== metadata.byte_length) {
      return null;
    }
    if (digest(row.data) !== sha256) {
      return null;
    }
    return row.data;
  }

  return {
    put(ownerId, sha256, data) {
      assertOwnerId(ownerId);
      assertSha256(sha256);
      assertData(data);
      if (digest(data) !== sha256) {
        throw new Error('Calibration harness blob SHA-256 does not match its data');
      }

      const result = insertBlob.run(
        ownerId,
        sha256,
        Buffer.from(data.buffer, data.byteOffset, data.byteLength),
        data.byteLength,
        Date.now(),
      );
      if (result.changes === 1) {
        return { sha256, byteLength: data.byteLength, inserted: true };
      }

      const stored = readVerified(ownerId, sha256);
      if (stored === null || !stored.equals(Buffer.from(data.buffer, data.byteOffset, data.byteLength))) {
        throw new Error('Calibration harness blob has a corrupt immutable existing value');
      }
      return { sha256, byteLength: data.byteLength, inserted: false };
    },

    get(ownerId, sha256) {
      assertOwnerId(ownerId);
      assertSha256(sha256);
      return readVerified(ownerId, sha256);
    },

    has(ownerId, sha256, byteLength) {
      assertOwnerId(ownerId);
      assertSha256(sha256);
      assertRequestedByteLength(byteLength);

      const stored = readVerified(ownerId, sha256);
      return stored !== null && (byteLength === undefined || stored.byteLength === byteLength);
    },
  };
}
