import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import {
  CALIBRATION_HARNESS_SCHEMA_VERSION,
  initializeCalibrationHarnessSchema,
} from './calibrationHarnessSchema.js';
import { openNativeDatabase } from './openNativeDatabase.js';

const fixtureRoot = path.join(
  fileURLToPath(new URL('../../../', import.meta.url)),
  '.review-artifacts',
  'calibration-harness-schema-01',
);
const ownedTableNames = [
  'mpc_harnesses',
  'mpc_harness_revisions',
  'mpc_harness_blobs',
  'mpc_harness_sessions',
] as const;

function createExclusiveDatabase(): Database.Database {
  fs.mkdirSync(fixtureRoot, { recursive: true });
  const directory = path.join(fixtureRoot, randomUUID());
  fs.mkdirSync(directory);
  return openNativeDatabase(path.join(directory, 'calibration-harness.db'));
}

function ownedTables(database: Database.Database): string[] {
  return (database.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table' AND name IN (${ownedTableNames.map(() => '?').join(', ')})
    ORDER BY name
  `).all(...ownedTableNames) as Array<{ name: string }>).map(({ name }) => name);
}

function tableColumns(database: Database.Database, tableName: string): Array<{ name: string; type: string; notnull: number; pk: number }> {
  return (database.prepare(`PRAGMA table_info('${tableName}')`).all() as Array<{
    name: string;
    type: string;
    notnull: number;
    pk: number;
  }>).map(({ name, type, notnull, pk }) => ({ name, type, notnull, pk }));
}

describe('initializeCalibrationHarnessSchema', () => {
  it('creates the dedicated v1 schema with owner-scoped keys and SQLite checks', () => {
    const database = createExclusiveDatabase();
    try {
      initializeCalibrationHarnessSchema(database);

      expect(CALIBRATION_HARNESS_SCHEMA_VERSION).toBe(1);
      expect(database.pragma('user_version', { simple: true })).toBe(1);
      expect(ownedTables(database)).toEqual([...ownedTableNames].sort());
      expect(tableColumns(database, 'mpc_harnesses')).toEqual([
        { name: 'owner_id', type: 'TEXT', notnull: 1, pk: 1 },
        { name: 'harness_id', type: 'TEXT', notnull: 1, pk: 2 },
        { name: 'revision', type: 'INTEGER', notnull: 1, pk: 0 },
        { name: 'snapshot_json', type: 'TEXT', notnull: 1, pk: 0 },
        { name: 'updated_at', type: 'INTEGER', notnull: 1, pk: 0 },
      ]);
      expect(tableColumns(database, 'mpc_harness_revisions')).toEqual([
        { name: 'owner_id', type: 'TEXT', notnull: 1, pk: 1 },
        { name: 'harness_id', type: 'TEXT', notnull: 1, pk: 2 },
        { name: 'revision', type: 'INTEGER', notnull: 1, pk: 3 },
        { name: 'snapshot_json', type: 'TEXT', notnull: 1, pk: 0 },
        { name: 'digest', type: 'TEXT', notnull: 1, pk: 0 },
        { name: 'created_at', type: 'INTEGER', notnull: 1, pk: 0 },
      ]);
      expect(tableColumns(database, 'mpc_harness_blobs')).toEqual([
        { name: 'owner_id', type: 'TEXT', notnull: 1, pk: 1 },
        { name: 'sha256', type: 'TEXT', notnull: 1, pk: 2 },
        { name: 'data', type: 'BLOB', notnull: 1, pk: 0 },
        { name: 'byte_length', type: 'INTEGER', notnull: 1, pk: 0 },
        { name: 'created_at', type: 'INTEGER', notnull: 1, pk: 0 },
      ]);
      expect(tableColumns(database, 'mpc_harness_sessions')).toEqual([
        { name: 'token_hash', type: 'TEXT', notnull: 1, pk: 1 },
        { name: 'owner_id', type: 'TEXT', notnull: 1, pk: 0 },
        { name: 'harness_id', type: 'TEXT', notnull: 1, pk: 0 },
        { name: 'created_at', type: 'INTEGER', notnull: 1, pk: 0 },
        { name: 'expires_at', type: 'INTEGER', notnull: 1, pk: 0 },
      ]);

      database.prepare(
        'INSERT INTO mpc_harnesses (owner_id, harness_id, revision, snapshot_json, updated_at) VALUES (?, ?, ?, ?, ?)',
      ).run('owner-a', 'harness-a', 1, '{}', 1);
      database.prepare(
        'INSERT INTO mpc_harness_revisions (owner_id, harness_id, revision, snapshot_json, digest, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run('owner-a', 'harness-a', 1, '{}', 'digest', 1);

      expect(() => database.prepare(
        'INSERT INTO mpc_harnesses (owner_id, harness_id, revision, snapshot_json, updated_at) VALUES (?, ?, ?, ?, ?)',
      ).run('owner-a', 'invalid-revision', 0, '{}', 1)).toThrow();
      expect(() => database.prepare(
        'INSERT INTO mpc_harness_revisions (owner_id, harness_id, revision, snapshot_json, digest, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run('owner-a', 'missing-harness', 1, '{}', 'digest', 1)).toThrow();
      expect(() => database.prepare(
        'INSERT INTO mpc_harness_blobs (owner_id, sha256, data, byte_length, created_at) VALUES (?, ?, ?, ?, ?)',
      ).run('owner-a', 'A'.repeat(64), Buffer.from('x'), 1, 1)).toThrow();
      expect(() => database.prepare(
        'INSERT INTO mpc_harness_blobs (owner_id, sha256, data, byte_length, created_at) VALUES (?, ?, ?, ?, ?)',
      ).run('owner-a', 'a'.repeat(64), Buffer.from('x'), 2, 1)).toThrow();
      expect(() => database.prepare(
        'INSERT INTO mpc_harness_blobs (owner_id, sha256, data, byte_length, created_at) VALUES (?, ?, ?, ?, ?)',
      ).run('owner-a', 'a'.repeat(63), Buffer.alloc(0), 0, 1)).toThrow();
      expect(database.prepare(
        'INSERT INTO mpc_harness_blobs (owner_id, sha256, data, byte_length, created_at) VALUES (?, ?, ?, ?, ?)',
      ).run('owner-a', 'b'.repeat(64), Buffer.from('ok'), 2, 1).changes).toBe(1);
    } finally {
      database.close();
    }
  });

  it('reopens a file-backed v1 database and verifies owned tables instead of trusting user_version alone', () => {
    const database = createExclusiveDatabase();
    const filename = database.name;
    initializeCalibrationHarnessSchema(database);
    database.close();

    const reopened = openNativeDatabase(filename);
    try {
      expect(() => initializeCalibrationHarnessSchema(reopened)).not.toThrow();
      expect(reopened.pragma('user_version', { simple: true })).toBe(1);
      expect(ownedTables(reopened)).toEqual([...ownedTableNames].sort());
    } finally {
      reopened.close();
    }

    const missingOwnedTables = createExclusiveDatabase();
    try {
      missingOwnedTables.pragma('user_version = 1');
      expect(() => initializeCalibrationHarnessSchema(missingOwnedTables)).toThrow(/missing required table/i);
      expect(missingOwnedTables.pragma('user_version', { simple: true })).toBe(1);
    } finally {
      missingOwnedTables.close();
    }
  });

  it('rolls back a forced DDL failure without advancing the marker or losing unrelated data', () => {
    const database = createExclusiveDatabase();
    try {
      database.exec(`
        CREATE TABLE sentinel (id TEXT PRIMARY KEY, value TEXT NOT NULL);
        INSERT INTO sentinel (id, value) VALUES ('sentinel', 'preserve-me');
        CREATE VIEW mpc_harness_sessions AS SELECT 'collision' AS token_hash;
      `);

      expect(() => initializeCalibrationHarnessSchema(database)).toThrow();
      expect(database.pragma('user_version', { simple: true })).toBe(0);
      expect(ownedTables(database)).toEqual([]);
      expect(database.prepare('SELECT value FROM sentinel WHERE id = ?').get('sentinel')).toEqual({ value: 'preserve-me' });
      expect(database.prepare("SELECT type FROM sqlite_master WHERE name = 'mpc_harness_sessions'").get()).toEqual({ type: 'view' });
    } finally {
      database.close();
    }
  });

  it('refuses a newer database version without mutation', () => {
    const database = createExclusiveDatabase();
    try {
      database.exec(`
        CREATE TABLE sentinel (id TEXT PRIMARY KEY, value TEXT NOT NULL);
        INSERT INTO sentinel (id, value) VALUES ('sentinel', 'preserve-me');
      `);
      database.pragma('user_version = 2');

      expect(() => initializeCalibrationHarnessSchema(database)).toThrow(/newer than supported/i);
      expect(database.pragma('user_version', { simple: true })).toBe(2);
      expect(ownedTables(database)).toEqual([]);
      expect(database.prepare('SELECT value FROM sentinel WHERE id = ?').get('sentinel')).toEqual({ value: 'preserve-me' });
    } finally {
      database.close();
    }
  });

  it('preserves unrelated tables, rows, and the existing journal mode', () => {
    const database = createExclusiveDatabase();
    try {
      database.pragma('journal_mode = DELETE');
      const journalModeBefore = database.pragma('journal_mode', { simple: true });
      database.exec(`
        CREATE TABLE sentinel (id TEXT PRIMARY KEY, value TEXT NOT NULL);
        INSERT INTO sentinel (id, value) VALUES ('sentinel', 'preserve-me');
      `);

      initializeCalibrationHarnessSchema(database);

      expect(database.pragma('journal_mode', { simple: true })).toBe(journalModeBefore);
      expect(database.prepare('SELECT value FROM sentinel WHERE id = ?').get('sentinel')).toEqual({ value: 'preserve-me' });
      expect(ownedTables(database)).toEqual([...ownedTableNames].sort());
    } finally {
      database.close();
    }
  });
});
