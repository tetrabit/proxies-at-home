import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';

import { initializeCalibrationHarnessSchema } from '../db/calibrationHarnessSchema.js';
import { openNativeDatabase } from '../db/openNativeDatabase.js';
import { createCalibrationHarnessFixtureProvider } from '../testUtils/calibrationHarnessFixtures.js';
import { importCalibrationHarnessBundle } from './calibrationHarnessImport.js';

const fixtures = createCalibrationHarnessFixtureProvider();

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function createExclusiveDatabase(): Database.Database {
  const directory = fixtures.createInvocationRoot();
  const database = openNativeDatabase(path.join(directory, 'calibration-harness.db'));
  initializeCalibrationHarnessSchema(database);
  return database;
}

type SyntheticBundle = {
  directory: string;
  metadataSha256: string;
  assetBytes: Buffer[];
};

function createSyntheticBundle(assetPrefix?: string, suppliedAssetBytes?: Buffer[]): SyntheticBundle {
  const directory = fixtures.createInvocationRoot();
  const assetsDirectory = path.join(directory, 'assets');
  fs.mkdirSync(assetsDirectory, { mode: 0o700 });
  const assetBytes = suppliedAssetBytes ?? (assetPrefix === undefined
    ? [Buffer.from('source bytes', 'utf8'), Buffer.from('source bytes', 'utf8')]
    : [Buffer.from(`${assetPrefix} source bytes`, 'utf8'), Buffer.from(`${assetPrefix} art bytes`, 'utf8')]);
  const assetIds = ['asset-source', 'asset-art'];
  const roles = ['source', 'source-art'];
  const assets = assetBytes.map((bytes, index) => {
    const id = assetIds[index]!;
    const filename = `${sha256(Buffer.from(id, 'utf8'))}.blob`;
    fs.writeFileSync(path.join(assetsDirectory, filename), bytes, { flag: 'wx', mode: 0o600 });
    return {
      id,
      datasetId: 'dataset-a',
      caseId: 'case-a',
      role: roles[index]!,
      mimeType: 'image/png',
      createdAt: 1_700_000_000_000,
      hash: `legacy-${index}`,
      bytes: bytes.byteLength,
      file: `assets/${filename}`,
      sha256: sha256(bytes),
      retainedAssetMetadata: { exportOrdinal: index },
    };
  });
  const metadata = {
    schema: 'proxxied-mpc-calibration-backup/v1',
    databaseVersion: 7,
    datasets: [{
      id: 'dataset-a',
      name: 'Synthetic dataset',
      targetCaseCount: 1,
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_001,
      version: 3,
      retainedDatasetMetadata: { source: 'synthetic' },
    }],
    cases: [{
      id: 'case-a',
      datasetId: 'dataset-a',
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_001,
      source: { name: 'Synthetic source', retainedSourceMetadata: true },
      candidates: [{
        identifier: 'candidate-a',
        name: 'Candidate',
        rawName: 'Candidate',
        smallThumbnailUrl: 'https://example.invalid/small',
        mediumThumbnailUrl: 'https://example.invalid/medium',
        imageUrl: 'https://example.invalid/image',
        dpi: 300,
        tags: ['synthetic'],
        sourceName: 'Synthetic',
        source: 'synthetic',
        extension: 'png',
        size: 12,
        retainedCandidateMetadata: { raw: 'candidate' },
      }],
      expectedIdentifier: 'candidate-a',
      retainedCaseMetadata: ['order', 1],
    }],
    assets,
    runs: [{
      id: 'run-a',
      datasetId: 'dataset-a',
      algorithmId: 'synthetic-v1',
      createdAt: 1_700_000_000_002,
      summary: { totalCases: 1, matchedCases: 1, mismatchedCases: 0, accuracy: 1 },
      results: [{ caseId: 'case-a', matched: true, retainedResultMetadata: 'result' }],
      retainedRunMetadata: { imported: false },
    }],
    assetBytes: assetBytes.reduce((total, bytes) => total + bytes.byteLength, 0),
  };
  const metadataBytes = Buffer.from(JSON.stringify(metadata), 'utf8');
  fs.writeFileSync(path.join(directory, 'calibration-data.json'), metadataBytes, { flag: 'wx', mode: 0o600 });
  return { directory, metadataSha256: sha256(metadataBytes), assetBytes };
}

function createMetadataOnlyBundle(metadata: unknown): SyntheticBundle {
  const directory = fixtures.createInvocationRoot();
  const metadataBytes = Buffer.from(JSON.stringify(metadata), 'utf8');
  fs.writeFileSync(path.join(directory, 'calibration-data.json'), metadataBytes, { flag: 'wx', mode: 0o600 });
  return { directory, metadataSha256: sha256(metadataBytes), assetBytes: [] };
}

function metadataFromBundle(bundle: SyntheticBundle): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(bundle.directory, 'calibration-data.json'), 'utf8')) as Record<string, unknown>;
}

type RetainedRows = {
  current: unknown[];
  history: unknown[];
  blobs: unknown[];
};

function retainedRows(database: Database.Database): RetainedRows {
  return {
    current: database.prepare(`
      SELECT owner_id, harness_id, revision, snapshot_json, updated_at
      FROM mpc_harnesses ORDER BY owner_id, harness_id
    `).all(),
    history: database.prepare(`
      SELECT owner_id, harness_id, revision, snapshot_json, digest, created_at
      FROM mpc_harness_revisions ORDER BY owner_id, harness_id, revision
    `).all(),
    blobs: database.prepare(`
      SELECT owner_id, sha256, data, byte_length, created_at
      FROM mpc_harness_blobs ORDER BY owner_id, sha256
    `).all(),
  };
}

function seedPopulatedDestination(database: Database.Database): RetainedRows {
  const existing = createSyntheticBundle('existing');
  expect(importCalibrationHarnessBundle({
    database,
    ownerId: 'owner-a',
    harnessId: 'harness-a',
    expectedRevision: null,
    sourceDirectory: existing.directory,
    expectedMetadataSha256: existing.metadataSha256,
  }).revision).toBe(1);
  return retainedRows(database);
}

function assertRowsPersistAfterReopen(filename: string, expected: RetainedRows): void {
  const reopened = openNativeDatabase(filename);
  try {
    initializeCalibrationHarnessSchema(reopened);
    expect(retainedRows(reopened)).toEqual(expected);
  } finally {
    reopened.close();
  }
}

describe('importCalibrationHarnessBundle', () => {
  it('imports a full exporter-shaped bundle into a real SQLite database without losing metadata or binary identity', () => {
    const database = createExclusiveDatabase();
    const bundle = createSyntheticBundle();
    try {
      const imported = importCalibrationHarnessBundle({
        database,
        ownerId: 'owner-a',
        harnessId: 'harness-a',
        expectedRevision: null,
        sourceDirectory: bundle.directory,
        expectedMetadataSha256: bundle.metadataSha256,
      });

      expect(imported.revision).toBe(1);
      expect(imported.snapshot).toMatchObject({
        version: 1,
        datasets: [{ retainedDatasetMetadata: { source: 'synthetic' } }],
        cases: [{
          retainedCaseMetadata: ['order', 1],
          candidates: [{ retainedCandidateMetadata: { raw: 'candidate' } }],
        }],
        assets: [
          { hash: 'legacy-0', byteLength: bundle.assetBytes[0]!.byteLength, retainedAssetMetadata: { exportOrdinal: 0 } },
          { hash: 'legacy-1', byteLength: bundle.assetBytes[1]!.byteLength, retainedAssetMetadata: { exportOrdinal: 1 } },
        ],
        runs: [{ retainedRunMetadata: { imported: false } }],
      });
      expect(imported.snapshot.assets.map((asset) => asset.id)).toEqual(['asset-source', 'asset-art']);
      expect(database.prepare('SELECT COUNT(*) AS count FROM mpc_harness_blobs WHERE owner_id = ?').get('owner-a')).toEqual({ count: 1 });
      expect(database.prepare('SELECT data FROM mpc_harness_blobs WHERE owner_id = ?').get('owner-a')).toEqual({ data: bundle.assetBytes[0] });
    } finally {
      database.close();
    }
  });

  it('rejects an anchored metadata file with malformed UTF-8 before JSON parsing', () => {
    const database = createExclusiveDatabase();
    const bundle = createSyntheticBundle();
    try {
      const filename = path.join(bundle.directory, 'calibration-data.json');
      const original = fs.readFileSync(filename);
      const marker = Buffer.from('Synthetic dataset', 'utf8');
      const offset = original.indexOf(marker);
      expect(offset).toBeGreaterThanOrEqual(0);
      const malformed = Buffer.concat([
        original.subarray(0, offset),
        Buffer.from([0xc3, 0x28]),
        original.subarray(offset + marker.byteLength),
      ]);
      fs.writeFileSync(filename, malformed);

      expect(() => importCalibrationHarnessBundle({
        database,
        ownerId: 'owner-a',
        harnessId: 'harness-a',
        expectedRevision: null,
        sourceDirectory: bundle.directory,
        expectedMetadataSha256: sha256(malformed),
      })).toThrow(/UTF-8|JSON/i);
      expect(database.prepare('SELECT COUNT(*) AS count FROM mpc_harnesses').get()).toEqual({ count: 0 });
      expect(database.prepare('SELECT COUNT(*) AS count FROM mpc_harness_blobs').get()).toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });

  it('leaves no new blob, current row, or history when a later asset fails verification', () => {
    const database = createExclusiveDatabase();
    const bundle = createSyntheticBundle();
    try {
      const secondAsset = sha256(Buffer.from('asset-art', 'utf8'));
      fs.writeFileSync(path.join(bundle.directory, 'assets', `${secondAsset}.blob`), Buffer.from('tampered', 'utf8'));

      expect(() => importCalibrationHarnessBundle({
        database,
        ownerId: 'owner-a',
        harnessId: 'harness-a',
        expectedRevision: null,
        sourceDirectory: bundle.directory,
        expectedMetadataSha256: bundle.metadataSha256,
      })).toThrow(/mismatched byte length or digest/i);
      expect(database.prepare('SELECT COUNT(*) AS count FROM mpc_harness_blobs').get()).toEqual({ count: 0 });
      expect(database.prepare('SELECT COUNT(*) AS count FROM mpc_harnesses').get()).toEqual({ count: 0 });
      expect(database.prepare('SELECT COUNT(*) AS count FROM mpc_harness_revisions').get()).toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });

  it('rolls back a real inserted blob when durable revision history rejects the import', () => {
    const database = createExclusiveDatabase();
    const bundle = createSyntheticBundle();
    try {
      database.exec(`
        CREATE TRIGGER reject_import_history
        BEFORE INSERT ON mpc_harness_revisions
        WHEN NEW.owner_id = 'owner-a' AND NEW.harness_id = 'harness-a' AND NEW.revision = 1
        BEGIN
          SELECT RAISE(ABORT, 'forced import history failure');
        END;
      `);
      expect(() => importCalibrationHarnessBundle({
        database,
        ownerId: 'owner-a',
        harnessId: 'harness-a',
        expectedRevision: null,
        sourceDirectory: bundle.directory,
        expectedMetadataSha256: bundle.metadataSha256,
      })).toThrow(/forced import history failure/i);
      expect(database.prepare('SELECT COUNT(*) AS count FROM mpc_harness_blobs').get()).toEqual({ count: 0 });
      expect(database.prepare('SELECT COUNT(*) AS count FROM mpc_harnesses').get()).toEqual({ count: 0 });
      expect(database.prepare('SELECT COUNT(*) AS count FROM mpc_harness_revisions').get()).toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });

  it('keeps blobs owner-scoped and applies only an exact destination revision across reopen', () => {
    const database = createExclusiveDatabase();
    const bundle = createSyntheticBundle();
    const filename = database.name;
    try {
      expect(importCalibrationHarnessBundle({
        database,
        ownerId: 'owner-a',
        harnessId: 'harness-a',
        expectedRevision: null,
        sourceDirectory: bundle.directory,
        expectedMetadataSha256: bundle.metadataSha256,
      }).revision).toBe(1);
      expect(importCalibrationHarnessBundle({
        database,
        ownerId: 'owner-b',
        harnessId: 'harness-a',
        expectedRevision: null,
        sourceDirectory: bundle.directory,
        expectedMetadataSha256: bundle.metadataSha256,
      }).revision).toBe(1);
      expect(database.prepare('SELECT owner_id, COUNT(*) AS count FROM mpc_harness_blobs GROUP BY owner_id ORDER BY owner_id').all())
        .toEqual([{ owner_id: 'owner-a', count: 1 }, { owner_id: 'owner-b', count: 1 }]);
      expect(importCalibrationHarnessBundle({
        database,
        ownerId: 'owner-a',
        harnessId: 'harness-a',
        expectedRevision: 1,
        sourceDirectory: bundle.directory,
        expectedMetadataSha256: bundle.metadataSha256,
      }).revision).toBe(2);
      for (const expectedRevision of [null, 1]) {
        expect(() => importCalibrationHarnessBundle({
          database,
          ownerId: 'owner-a',
          harnessId: 'harness-a',
          expectedRevision,
          sourceDirectory: bundle.directory,
          expectedMetadataSha256: bundle.metadataSha256,
        })).toThrow(/precondition/i);
      }
      expect(database.prepare('SELECT revision FROM mpc_harnesses WHERE owner_id = ? AND harness_id = ?').get('owner-a', 'harness-a'))
        .toEqual({ revision: 2 });
    } finally {
      database.close();
    }

    const reopened = openNativeDatabase(filename);
    try {
      initializeCalibrationHarnessSchema(reopened);
      expect(reopened.prepare('SELECT revision FROM mpc_harnesses WHERE owner_id = ? AND harness_id = ?').get('owner-a', 'harness-a'))
        .toEqual({ revision: 2 });
      expect(reopened.prepare('SELECT COUNT(*) AS count FROM mpc_harness_revisions WHERE owner_id = ? AND harness_id = ?').get('owner-a', 'harness-a'))
        .toEqual({ count: 2 });
    } finally {
      reopened.close();
    }
  });

  it('rejects malformed, unanchored, missing, truncated, oversized, traversal, and symlinked exports before retaining data', () => {
    const valid = createSyntheticBundle();
    const validMetadata = metadataFromBundle(valid);
    const validMetadataBytes = fs.readFileSync(path.join(valid.directory, 'calibration-data.json'));
    const sourceAssetFilename = `${sha256(Buffer.from('asset-source', 'utf8'))}.blob`;

    const missing = createMetadataOnlyBundle(validMetadata);
    const truncatedDirectory = fixtures.createInvocationRoot();
    fs.mkdirSync(path.join(truncatedDirectory, 'assets'), { mode: 0o700 });
    fs.writeFileSync(path.join(truncatedDirectory, 'calibration-data.json'), validMetadataBytes, { flag: 'wx', mode: 0o600 });
    fs.writeFileSync(path.join(truncatedDirectory, 'assets', sourceAssetFilename), Buffer.from('x', 'utf8'), { flag: 'wx', mode: 0o600 });
    const truncated: SyntheticBundle = { directory: truncatedDirectory, metadataSha256: valid.metadataSha256, assetBytes: [] };

    const symlinkDirectory = fixtures.createInvocationRoot();
    fs.mkdirSync(path.join(symlinkDirectory, 'assets'), { mode: 0o700 });
    fs.writeFileSync(path.join(symlinkDirectory, 'calibration-data.json'), validMetadataBytes, { flag: 'wx', mode: 0o600 });
    fs.symlinkSync(path.join(valid.directory, 'assets', sourceAssetFilename), path.join(symlinkDirectory, 'assets', sourceAssetFilename));
    const symlinked: SyntheticBundle = { directory: symlinkDirectory, metadataSha256: valid.metadataSha256, assetBytes: [] };

    const traversalMetadata = structuredClone(validMetadata);
    (traversalMetadata.assets as Array<Record<string, unknown>>)[0]!.file = '../outside.blob';
    const traversal = createMetadataOnlyBundle(traversalMetadata);
    const oversizedMetadata = structuredClone(validMetadata);
    (oversizedMetadata.assets as Array<Record<string, unknown>>)[0]!.bytes = 32 * 1024 * 1024 + 1;
    oversizedMetadata.assetBytes = (oversizedMetadata.assets as Array<Record<string, number>>)
      .reduce((total, asset) => total + asset.bytes, 0);
    const oversized = createMetadataOnlyBundle(oversizedMetadata);
    const wrongSchema = createMetadataOnlyBundle({ schema: 'wrong-schema' });
    const incomplete = createMetadataOnlyBundle({ schema: 'proxxied-mpc-calibration-backup/v1', databaseVersion: 1 });

    const failures: Array<{ bundle: SyntheticBundle; expectedMetadataSha256: string; error: RegExp }> = [
      { bundle: valid, expectedMetadataSha256: '0'.repeat(64), error: /metadata digest/i },
      { bundle: wrongSchema, expectedMetadataSha256: wrongSchema.metadataSha256, error: /unsupported schema/i },
      { bundle: incomplete, expectedMetadataSha256: incomplete.metadataSha256, error: /datasets must be an array/i },
      { bundle: missing, expectedMetadataSha256: missing.metadataSha256, error: /ENOENT|no such file/i },
      { bundle: truncated, expectedMetadataSha256: truncated.metadataSha256, error: /mismatched byte length or digest/i },
      { bundle: oversized, expectedMetadataSha256: oversized.metadataSha256, error: /exceeds the asset limit/i },
      { bundle: traversal, expectedMetadataSha256: traversal.metadataSha256, error: /literal id-derived filename/i },
      { bundle: symlinked, expectedMetadataSha256: symlinked.metadataSha256, error: /symbolic links|ELOOP/i },
    ];
    for (const failure of failures) {
      const database = createExclusiveDatabase();
      try {
        expect(importCalibrationHarnessBundle({
          database,
          ownerId: 'owner-a',
          harnessId: 'harness-a',
          expectedRevision: null,
          sourceDirectory: valid.directory,
          expectedMetadataSha256: valid.metadataSha256,
        }).revision).toBe(1);
        const tableSnapshot = () => ({
          current: database.prepare('SELECT owner_id, harness_id, revision, snapshot_json, updated_at FROM mpc_harnesses ORDER BY owner_id, harness_id').all(),
          history: database.prepare('SELECT owner_id, harness_id, revision, snapshot_json, digest, created_at FROM mpc_harness_revisions ORDER BY owner_id, harness_id, revision').all(),
          blobs: database.prepare('SELECT owner_id, sha256, data, byte_length, created_at FROM mpc_harness_blobs ORDER BY owner_id, sha256').all(),
        });
        const before = tableSnapshot();
        expect(() => importCalibrationHarnessBundle({
          database,
          ownerId: 'owner-a',
          harnessId: 'harness-a',
          expectedRevision: 1,
          sourceDirectory: failure.bundle.directory,
          expectedMetadataSha256: failure.expectedMetadataSha256,
        })).toThrow(failure.error);
        expect(tableSnapshot()).toEqual(before);
      } finally {
        database.close();
      }
    }
  });

  it('preserves every populated current/history/blob row and timestamp for admitted source failures across reopen', () => {
    const sourceAssetFilename = `${sha256(Buffer.from('asset-source', 'utf8'))}.blob`;
    const cases: Array<{
      label: string;
      prepare: (bundle: SyntheticBundle) => { expectedMetadataSha256: string; error: RegExp };
    }> = [
      {
        label: 'bad metadata anchor',
        prepare: () => ({ expectedMetadataSha256: '0'.repeat(64), error: /metadata digest/i }),
      },
      {
        label: 'bad schema',
        prepare: (bundle) => {
          const metadata = metadataFromBundle(bundle);
          metadata.schema = 'unsupported';
          const bytes = Buffer.from(JSON.stringify(metadata), 'utf8');
          fs.writeFileSync(path.join(bundle.directory, 'calibration-data.json'), bytes);
          return { expectedMetadataSha256: sha256(bytes), error: /unsupported schema/i };
        },
      },
      {
        label: 'bad UTF-8',
        prepare: (bundle) => {
          const bytes = Buffer.from([0xc3, 0x28]);
          fs.writeFileSync(path.join(bundle.directory, 'calibration-data.json'), bytes);
          return { expectedMetadataSha256: sha256(bytes), error: /invalid UTF-8 or JSON/i };
        },
      },
      {
        label: 'missing asset',
        prepare: (bundle) => {
          fs.unlinkSync(path.join(bundle.directory, 'assets', sourceAssetFilename));
          return { expectedMetadataSha256: bundle.metadataSha256, error: /ENOENT|no such file/i };
        },
      },
      {
        label: 'truncated asset',
        prepare: (bundle) => {
          fs.writeFileSync(path.join(bundle.directory, 'assets', sourceAssetFilename), Buffer.from('x', 'utf8'));
          return { expectedMetadataSha256: bundle.metadataSha256, error: /mismatched byte length or digest/i };
        },
      },
      {
        label: 'physical oversized asset',
        prepare: (bundle) => {
          fs.truncateSync(
            path.join(bundle.directory, 'assets', sourceAssetFilename),
            32 * 1024 * 1024 + 1,
          );
          return { expectedMetadataSha256: bundle.metadataSha256, error: /regular file within its configured limit/i };
        },
      },
      {
        label: 'bad asset digest',
        prepare: (bundle) => {
          fs.writeFileSync(path.join(bundle.directory, 'assets', sourceAssetFilename), Buffer.from('wrong bytes', 'utf8'));
          return { expectedMetadataSha256: bundle.metadataSha256, error: /mismatched byte length or digest/i };
        },
      },
      {
        label: 'traversal asset path',
        prepare: (bundle) => {
          const metadata = metadataFromBundle(bundle);
          (metadata.assets as Array<Record<string, unknown>>)[0]!.file = '../outside.blob';
          const bytes = Buffer.from(JSON.stringify(metadata), 'utf8');
          fs.writeFileSync(path.join(bundle.directory, 'calibration-data.json'), bytes);
          return { expectedMetadataSha256: sha256(bytes), error: /literal id-derived filename/i };
        },
      },
      {
        label: 'final symlink',
        prepare: (bundle) => {
          const target = createSyntheticBundle('symlink-target');
          const filename = path.join(bundle.directory, 'assets', sourceAssetFilename);
          fs.unlinkSync(filename);
          fs.symlinkSync(path.join(target.directory, 'assets', sourceAssetFilename), filename);
          return { expectedMetadataSha256: bundle.metadataSha256, error: /symbolic links|ELOOP/i };
        },
      },
    ];

    for (const failureCase of cases) {
      const database = createExclusiveDatabase();
      const filename = database.name;
      let before: RetainedRows | undefined;
      try {
        before = seedPopulatedDestination(database);
        const incoming = createSyntheticBundle(`incoming-${failureCase.label}`);
        const prepared = failureCase.prepare(incoming);
        let failure: unknown;
        try {
          importCalibrationHarnessBundle({
            database,
            ownerId: 'owner-a',
            harnessId: 'harness-a',
            expectedRevision: 1,
            sourceDirectory: incoming.directory,
            expectedMetadataSha256: prepared.expectedMetadataSha256,
          });
        } catch (error) {
          failure = error;
        }
        expect(failure, failureCase.label).toBeInstanceOf(Error);
        expect((failure as Error).message, failureCase.label).toMatch(prepared.error);
        expect(retainedRows(database), failureCase.label).toEqual(before);
      } finally {
        database.close();
      }
      assertRowsPersistAfterReopen(filename, before!);
    }
  });

  it('keeps populated rows intact for null, stale, and missing CAS preconditions without opening assets', () => {
    const attempts: Array<{ label: string; ownerId: string; expectedRevision: number | null; error: RegExp }> = [
      { label: 'null', ownerId: 'owner-a', expectedRevision: null, error: /expected absence, current 1/i },
      { label: 'stale', ownerId: 'owner-a', expectedRevision: 2, error: /expected 2, current 1/i },
      { label: 'missing', ownerId: 'owner-b', expectedRevision: 1, error: /expected 1, current absence/i },
    ];
    for (const attempt of attempts) {
      const database = createExclusiveDatabase();
      const filename = database.name;
      const incoming = createSyntheticBundle(`incoming-${attempt.label}`);
      const originalOpen = fs.openSync;
      let assetOpenCalls = 0;
      const openSpy = vi.spyOn(fs, 'openSync').mockImplementation(((target: fs.PathLike, flags: string | number, mode?: fs.Mode) => {
        if (String(target).includes(`${path.sep}assets${path.sep}`)) assetOpenCalls += 1;
        return originalOpen(target, flags, mode);
      }) as never);
      let before: RetainedRows | undefined;
      try {
        before = seedPopulatedDestination(database);
        assetOpenCalls = 0;
        expect(() => importCalibrationHarnessBundle({
          database,
          ownerId: attempt.ownerId,
          harnessId: 'harness-a',
          expectedRevision: attempt.expectedRevision,
          sourceDirectory: incoming.directory,
          expectedMetadataSha256: incoming.metadataSha256,
        }), attempt.label).toThrow(attempt.error);
        expect(assetOpenCalls, attempt.label).toBe(0);
        expect(retainedRows(database), attempt.label).toEqual(before);
      } finally {
        openSpy.mockRestore();
        database.close();
      }
      assertRowsPersistAfterReopen(filename, before!);
    }
  });

  it('rolls back a real new blob on later storage and history failures in a populated destination', () => {
    for (const failurePoint of ['storage', 'history'] as const) {
      const database = createExclusiveDatabase();
      const filename = database.name;
      let before: RetainedRows | undefined;
      try {
        before = seedPopulatedDestination(database);
        const incoming = createSyntheticBundle(`incoming-${failurePoint}`);
        const firstSha = sha256(incoming.assetBytes[0]!);
        const secondSha = sha256(incoming.assetBytes[1]!);
        if (failurePoint === 'storage') {
          database.exec(`
            CREATE TRIGGER reject_second_import_blob
            BEFORE INSERT ON mpc_harness_blobs
            WHEN NEW.owner_id = 'owner-a' AND NEW.sha256 = '${secondSha}'
            BEGIN
              SELECT CASE WHEN NOT EXISTS (
                SELECT 1 FROM mpc_harness_blobs WHERE owner_id = 'owner-a' AND sha256 = '${firstSha}'
              ) THEN RAISE(ABORT, 'first new blob was not inserted') END;
              SELECT RAISE(ABORT, 'forced import storage failure');
            END;
          `);
        } else {
          database.exec(`
            CREATE TRIGGER reject_second_import_history
            BEFORE INSERT ON mpc_harness_revisions
            WHEN NEW.owner_id = 'owner-a' AND NEW.harness_id = 'harness-a' AND NEW.revision = 2
            BEGIN
              SELECT CASE WHEN NOT EXISTS (
                SELECT 1 FROM mpc_harness_blobs WHERE owner_id = 'owner-a' AND sha256 = '${firstSha}'
              ) THEN RAISE(ABORT, 'first new blob was not inserted') END;
              SELECT RAISE(ABORT, 'forced import history failure');
            END;
          `);
        }
        expect(() => importCalibrationHarnessBundle({
          database,
          ownerId: 'owner-a',
          harnessId: 'harness-a',
          expectedRevision: 1,
          sourceDirectory: incoming.directory,
          expectedMetadataSha256: incoming.metadataSha256,
        }), failurePoint).toThrow(new RegExp(`forced import ${failurePoint} failure`, 'i'));
        expect(database.prepare('SELECT COUNT(*) AS count FROM mpc_harness_blobs WHERE sha256 IN (?, ?)').get(firstSha, secondSha))
          .toEqual({ count: 0 });
        expect(retainedRows(database), failurePoint).toEqual(before);
      } finally {
        database.close();
      }
      assertRowsPersistAfterReopen(filename, before!);
    }
  });

  it('reads a successful asset larger than one MiB in bounded chunks and preserves its full bytes across reopen', () => {
    const database = createExclusiveDatabase();
    const filename = database.name;
    const large = Buffer.alloc(1024 * 1024 + 17, 0x61);
    const bundle = createSyntheticBundle('large', [large, Buffer.from('second distinct asset', 'utf8')]);
    const originalRead = fs.readSync;
    const requestedLengths: number[] = [];
    const readSpy = vi.spyOn(fs, 'readSync').mockImplementation(((
      descriptor: number,
      buffer: Uint8Array,
      offset: number,
      length: number,
      position: number | null,
    ) => {
      requestedLengths.push(length);
      return originalRead(descriptor, buffer, offset, length, position);
    }) as never);
    try {
      expect(importCalibrationHarnessBundle({
        database,
        ownerId: 'owner-a',
        harnessId: 'harness-a',
        expectedRevision: null,
        sourceDirectory: bundle.directory,
        expectedMetadataSha256: bundle.metadataSha256,
      }).snapshot.assets[0]!.sha256).toBe(sha256(large));
      expect(requestedLengths.filter((length) => length === 1024 * 1024 || length === 17)).toEqual([1024 * 1024, 17]);
      expect(requestedLengths.every((length) => length <= 1024 * 1024)).toBe(true);
      expect(database.prepare('SELECT data FROM mpc_harness_blobs WHERE owner_id = ? AND sha256 = ?').get('owner-a', sha256(large)))
        .toEqual({ data: large });
    } finally {
      readSpy.mockRestore();
      database.close();
    }
    const reopened = openNativeDatabase(filename);
    try {
      initializeCalibrationHarnessSchema(reopened);
      expect(reopened.prepare('SELECT data FROM mpc_harness_blobs WHERE owner_id = ? AND sha256 = ?').get('owner-a', sha256(large)))
        .toEqual({ data: large });
    } finally {
      reopened.close();
    }
  });

  it('rejects a real final symlink even when only the earlier lstat observation is stale', () => {
    const database = createExclusiveDatabase();
    const bundle = createSyntheticBundle('symlink-seam');
    const sourceAssetFilename = `${sha256(Buffer.from('asset-source', 'utf8'))}.blob`;
    const candidate = path.join(bundle.directory, 'assets', sourceAssetFilename);
    const target = createSyntheticBundle('symlink-seam-target');
    const targetFilename = path.join(target.directory, 'assets', sourceAssetFilename);
    fs.unlinkSync(candidate);
    fs.symlinkSync(targetFilename, candidate);
    const regularStats = fs.lstatSync(targetFilename);
    const originalLstat = fs.lstatSync;
    let staleObservation = true;
    const lstatSpy = vi.spyOn(fs, 'lstatSync').mockImplementation(((targetPath: fs.PathLike) => {
      if (path.resolve(String(targetPath)) === candidate && staleObservation) {
        staleObservation = false;
        return regularStats;
      }
      return originalLstat(targetPath);
    }) as never);
    try {
      expect(() => importCalibrationHarnessBundle({
        database,
        ownerId: 'owner-a',
        harnessId: 'harness-a',
        expectedRevision: null,
        sourceDirectory: bundle.directory,
        expectedMetadataSha256: bundle.metadataSha256,
      })).toThrow(/symbolic links|ELOOP/i);
      expect(retainedRows(database)).toEqual({ current: [], history: [], blobs: [] });
    } finally {
      lstatSpy.mockRestore();
      database.close();
    }
  });

  it('rejects an opened-file identity seam after a bounded asset read without changing populated rows', () => {
    const database = createExclusiveDatabase();
    const filename = database.name;
    const before = seedPopulatedDestination(database);
    const bundle = createSyntheticBundle('file-seam');
    const replacement = createSyntheticBundle('file-seam-replacement');
    const sourceAssetFilename = `${sha256(Buffer.from('asset-source', 'utf8'))}.blob`;
    const replacementStats = fs.statSync(path.join(replacement.directory, 'assets', sourceAssetFilename));
    const originalFstat = fs.fstatSync;
    let fstatCalls = 0;
    const fstatSpy = vi.spyOn(fs, 'fstatSync').mockImplementation(((descriptor: number) => {
      fstatCalls += 1;
      return fstatCalls === 4 ? replacementStats : originalFstat(descriptor);
    }) as never);
    try {
      expect(() => importCalibrationHarnessBundle({
        database,
        ownerId: 'owner-a',
        harnessId: 'harness-a',
        expectedRevision: 1,
        sourceDirectory: bundle.directory,
        expectedMetadataSha256: bundle.metadataSha256,
      })).toThrow(/file changed while being read/i);
      expect(retainedRows(database)).toEqual(before);
    } finally {
      fstatSpy.mockRestore();
      database.close();
    }
    assertRowsPersistAfterReopen(filename, before);
  });

  it('rejects a source-root realpath change observed after initial admission without changing populated rows', () => {
    const database = createExclusiveDatabase();
    const filename = database.name;
    const before = seedPopulatedDestination(database);
    const bundle = createSyntheticBundle('root-seam');
    const originalRealpath = fs.realpathSync;
    let rootChecks = 0;
    const realpathSpy = vi.spyOn(fs, 'realpathSync').mockImplementation(((target: fs.PathLike) => {
      const resolved = path.resolve(String(target));
      if (resolved === bundle.directory && ++rootChecks > 1) {
        return path.join(bundle.directory, 'replacement-observed-by-seam');
      }
      return originalRealpath(target);
    }) as never);
    try {
      expect(() => importCalibrationHarnessBundle({
        database,
        ownerId: 'owner-a',
        harnessId: 'harness-a',
        expectedRevision: 1,
        sourceDirectory: bundle.directory,
        expectedMetadataSha256: bundle.metadataSha256,
      })).toThrow(/sourceDirectory changed during access/i);
      expect(retainedRows(database)).toEqual(before);
    } finally {
      realpathSpy.mockRestore();
      database.close();
    }
    assertRowsPersistAfterReopen(filename, before);
  });

  it('rejects an ancestor identity change observed after an asset descriptor opens without changing populated rows', () => {
    const database = createExclusiveDatabase();
    const filename = database.name;
    const before = seedPopulatedDestination(database);
    const bundle = createSyntheticBundle('ancestor-seam');
    const assetsDirectory = path.join(bundle.directory, 'assets');
    const replacementDirectory = fixtures.createInvocationRoot();
    const replacementStats = fs.lstatSync(replacementDirectory);
    const originalLstat = fs.lstatSync;
    let assetsChecks = 0;
    const lstatSpy = vi.spyOn(fs, 'lstatSync').mockImplementation(((target: fs.PathLike) => {
      if (path.resolve(String(target)) === assetsDirectory && ++assetsChecks > 1) {
        return replacementStats;
      }
      return originalLstat(target);
    }) as never);
    try {
      expect(() => importCalibrationHarnessBundle({
        database,
        ownerId: 'owner-a',
        harnessId: 'harness-a',
        expectedRevision: 1,
        sourceDirectory: bundle.directory,
        expectedMetadataSha256: bundle.metadataSha256,
      })).toThrow(/path ancestor changed during access/i);
      expect(retainedRows(database)).toEqual(before);
    } finally {
      lstatSpy.mockRestore();
      database.close();
    }
    assertRowsPersistAfterReopen(filename, before);
  });
});
