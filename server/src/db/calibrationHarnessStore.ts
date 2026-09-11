import { createHash } from 'node:crypto';

import type Database from 'better-sqlite3';

import {
  CALIBRATION_HARNESS_LIMITS,
  canonicalHarnessJson,
  type CalibrationHarnessRevision,
  type CalibrationHarnessSnapshot,
  validateCalibrationHarnessSnapshot,
} from '../../../shared/calibrationHarness.js';

export interface CalibrationHarnessStore {
  publish(
    ownerId: string,
    harnessId: string,
    expectedRevision: number | null,
    snapshot: CalibrationHarnessSnapshot,
  ): CalibrationHarnessRevision;
  getCurrent(ownerId: string, harnessId: string): CalibrationHarnessRevision | null;
  getRevision(ownerId: string, harnessId: string, revision: number): CalibrationHarnessRevision | null;
}

export const CALIBRATION_HARNESS_REVISION_PRECONDITION_CODE = 'CALIBRATION_HARNESS_REVISION_PRECONDITION';

/** A caller-supplied create/CAS revision did not match the persisted current revision. */
export class CalibrationHarnessRevisionPreconditionError extends Error {
  readonly code = CALIBRATION_HARNESS_REVISION_PRECONDITION_CODE;
  readonly expectedRevision: number | null;
  readonly currentRevision: number | null;

  constructor(expectedRevision: number | null, currentRevision: number | null) {
    super(
      `Calibration harness revision precondition failed: expected ${expectedRevision ?? 'absence'}, current ${currentRevision ?? 'absence'}`,
    );
    this.name = 'CalibrationHarnessRevisionPreconditionError';
    this.expectedRevision = expectedRevision;
    this.currentRevision = currentRevision;
  }
}

type PublishProgress = 'before-write-authority' | 'after-write-authority' | 'after-current-read';

interface CalibrationHarnessStoreOptions {
  /** Narrow test instrumentation; production callers must not rely on progress notifications. */
  onPublishProgress?: (progress: PublishProgress) => void;
}

interface CurrentRow {
  revision: unknown;
  snapshot_json: unknown;
  revision_snapshot_json: unknown;
  revision_digest: unknown;
}

interface RevisionRow {
  revision: unknown;
  snapshot_json: unknown;
  digest: unknown;
}

function assertScopedIdentifier(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > 256
    || /\p{Cc}/u.test(value)
  ) {
    throw new Error(`Calibration harness ${label} must be a nonempty control-free string no longer than 256 characters`);
  }
}

function assertRevision(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`Calibration harness ${label} must be a positive safe integer`);
  }
}

function assertExpectedRevision(expectedRevision: unknown): asserts expectedRevision is number | null {
  if (expectedRevision !== null) {
    assertRevision(expectedRevision, 'expected revision');
  }
}

function digest(snapshotJson: string): string {
  return createHash('sha256').update(snapshotJson, 'utf8').digest('hex');
}

function revisionPrecondition(
  expectedRevision: number | null,
  currentRevision: number | null,
): CalibrationHarnessRevisionPreconditionError {
  return new CalibrationHarnessRevisionPreconditionError(expectedRevision, currentRevision);
}

function readSnapshot(snapshotJson: unknown, label: string): CalibrationHarnessSnapshot {
  if (typeof snapshotJson !== 'string') {
    throw new Error(`Calibration harness ${label} is corrupt`);
  }
  if (
    snapshotJson.length === 0
    || Buffer.byteLength(snapshotJson, 'utf8') > CALIBRATION_HARNESS_LIMITS.maxMetadataBytes
  ) {
    throw new Error(`Calibration harness ${label} metadata exceeds the configured limit or is corrupt`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(snapshotJson);
  } catch {
    throw new Error(`Calibration harness ${label} contains invalid JSON`);
  }
  const snapshot = validateCalibrationHarnessSnapshot(parsed);
  if (canonicalHarnessJson(snapshot) !== snapshotJson) {
    throw new Error(`Calibration harness ${label} is not canonical`);
  }
  return snapshot;
}

function readRevision(row: RevisionRow, label: string): CalibrationHarnessRevision {
  assertRevision(row.revision, `${label} revision`);
  if (typeof row.digest !== 'string' || !/^[0-9a-f]{64}$/.test(row.digest)) {
    throw new Error(`Calibration harness ${label} digest is corrupt`);
  }
  const snapshot = readSnapshot(row.snapshot_json, label);
  if (digest(canonicalHarnessJson(snapshot)) !== row.digest) {
    throw new Error(`Calibration harness ${label} digest does not match its snapshot`);
  }
  return { revision: row.revision, snapshot };
}

function readCurrent(row: CurrentRow): CalibrationHarnessRevision {
  assertRevision(row.revision, 'current revision');
  const snapshot = readSnapshot(row.snapshot_json, 'current snapshot');
  const immutable = readRevision({
    revision: row.revision,
    snapshot_json: row.revision_snapshot_json,
    digest: row.revision_digest,
  }, 'current immutable revision');
  if (canonicalHarnessJson(snapshot) !== canonicalHarnessJson(immutable.snapshot)) {
    throw new Error('Calibration harness current snapshot does not match immutable history');
  }
  return { revision: row.revision, snapshot };
}

/**
 * Opens an owner-scoped, append-only revision store over an initialized
 * calibration harness database. Callers must choose either create-only (null)
 * or an exact prior revision; this store never offers an unconditional write.
 * publish owns a top-level BEGIN IMMEDIATE transaction and refuses a
 * caller-owned transaction rather than silently using a savepoint that cannot
 * establish write authority. A future atomic importer must acquire IMMEDIATE
 * authority itself and use a deliberately supported batch primitive.
 */
export function createCalibrationHarnessStore(
  database: Database.Database,
  options: CalibrationHarnessStoreOptions = {},
): CalibrationHarnessStore {
  const selectCurrent = database.prepare(`
    SELECT
      current.revision,
      current.snapshot_json,
      history.snapshot_json AS revision_snapshot_json,
      history.digest AS revision_digest
    FROM mpc_harnesses AS current
    LEFT JOIN mpc_harness_revisions AS history
      ON history.owner_id = current.owner_id
      AND history.harness_id = current.harness_id
      AND history.revision = current.revision
    WHERE current.owner_id = ? AND current.harness_id = ?
  `);
  const selectRevision = database.prepare(`
    SELECT revision, snapshot_json, digest
    FROM mpc_harness_revisions
    WHERE owner_id = ? AND harness_id = ? AND revision = ?
  `);
  const insertCurrent = database.prepare(`
    INSERT INTO mpc_harnesses (owner_id, harness_id, revision, snapshot_json, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  const updateCurrent = database.prepare(`
    UPDATE mpc_harnesses
    SET revision = ?, snapshot_json = ?, updated_at = ?
    WHERE owner_id = ? AND harness_id = ? AND revision = ?
  `);
  const insertRevision = database.prepare(`
    INSERT INTO mpc_harness_revisions (owner_id, harness_id, revision, snapshot_json, digest, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const publish = database.transaction((
    ownerId: string,
    harnessId: string,
    expectedRevision: number | null,
    snapshotJson: string,
    snapshotDigest: string,
  ): CalibrationHarnessRevision => {
    options.onPublishProgress?.('after-write-authority');
    const currentRow = selectCurrent.get(ownerId, harnessId) as CurrentRow | undefined;
    options.onPublishProgress?.('after-current-read');
    const now = Date.now();

    if (currentRow === undefined) {
      if (expectedRevision !== null) {
        throw revisionPrecondition(expectedRevision, null);
      }
      insertCurrent.run(ownerId, harnessId, 1, snapshotJson, now);
      insertRevision.run(ownerId, harnessId, 1, snapshotJson, snapshotDigest, now);
      return { revision: 1, snapshot: readSnapshot(snapshotJson, 'published snapshot') };
    }

    const current = readCurrent(currentRow);
    if (expectedRevision === null || expectedRevision !== current.revision) {
      throw revisionPrecondition(expectedRevision, current.revision);
    }
    if (current.revision >= Number.MAX_SAFE_INTEGER) {
      throw new Error('Calibration harness revision cannot be incremented safely');
    }

    const revision = current.revision + 1;
    const result = updateCurrent.run(revision, snapshotJson, now, ownerId, harnessId, expectedRevision);
    if (result.changes !== 1) {
      throw revisionPrecondition(expectedRevision, current.revision);
    }
    insertRevision.run(ownerId, harnessId, revision, snapshotJson, snapshotDigest, now);
    return { revision, snapshot: readSnapshot(snapshotJson, 'published snapshot') };
  }).immediate;

  return {
    publish(ownerId, harnessId, expectedRevision, snapshot) {
      assertScopedIdentifier(ownerId, 'owner ID');
      assertScopedIdentifier(harnessId, 'ID');
      assertExpectedRevision(expectedRevision);
      const validated = validateCalibrationHarnessSnapshot(snapshot);
      const snapshotJson = canonicalHarnessJson(validated);
      if (database.inTransaction) {
        throw new Error('Calibration harness publish requires a top-level SQLite connection outside a caller transaction');
      }
      options.onPublishProgress?.('before-write-authority');
      return publish(ownerId, harnessId, expectedRevision, snapshotJson, digest(snapshotJson));
    },

    getCurrent(ownerId, harnessId) {
      assertScopedIdentifier(ownerId, 'owner ID');
      assertScopedIdentifier(harnessId, 'ID');
      const row = selectCurrent.get(ownerId, harnessId) as CurrentRow | undefined;
      return row === undefined ? null : readCurrent(row);
    },

    getRevision(ownerId, harnessId, revision) {
      assertScopedIdentifier(ownerId, 'owner ID');
      assertScopedIdentifier(harnessId, 'ID');
      assertRevision(revision, 'requested revision');
      const row = selectRevision.get(ownerId, harnessId, revision) as RevisionRow | undefined;
      return row === undefined ? null : readRevision(row, 'immutable revision');
    },
  };
}
