import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { initializeCalibrationHarnessSchema } from '../db/calibrationHarnessSchema.js';
import { openNativeDatabase } from '../db/openNativeDatabase.js';
import {
  createCalibrationHarnessCredentialStore,
  type CalibrationHarnessCapability,
} from './calibrationHarnessIdentity.js';

const fixtureRoot = path.join(
  fileURLToPath(new URL('../../../', import.meta.url)),
  '.review-artifacts',
  'calibration-harness-identity-01',
);

function createExclusiveDatabase(): Database.Database {
  fs.mkdirSync(fixtureRoot, { recursive: true });
  const directory = path.join(fixtureRoot, randomUUID());
  fs.mkdirSync(directory);
  const database = openNativeDatabase(path.join(directory, 'calibration-harness.db'));
  initializeCalibrationHarnessSchema(database);
  return database;
}

function sessionCount(database: Database.Database): number {
  return (database.prepare('SELECT COUNT(*) AS count FROM mpc_harness_sessions').get() as { count: number }).count;
}

describe('createCalibrationHarnessCredentialStore', () => {
  it('provisions a digest-only owner and harness-bound credential with only calibration authority', () => {
    const database = createExclusiveDatabase();
    const now = 1_700_000_000_000;
    try {
      const store = createCalibrationHarnessCredentialStore(database, { now: () => now });
      const credential = store.provision({
        ownerId: 'owner-synthetic',
        harnessId: 'harness-synthetic',
        expiresAt: now + 60_000,
      });

      expect(credential).toMatch(/^calibration_pair_[A-Za-z0-9_-]{43}$/);
      const row = database.prepare(`
        SELECT token_hash, owner_id, harness_id, created_at, expires_at
        FROM mpc_harness_sessions
      `).get() as {
        token_hash: string;
        owner_id: string;
        harness_id: string;
        created_at: number;
        expires_at: number;
      };
      expect(row).toEqual({
        token_hash: createHash('sha256').update(credential).digest('hex'),
        owner_id: 'owner-synthetic',
        harness_id: 'harness-synthetic',
        created_at: now,
        expires_at: now + 60_000,
      });
      expect(JSON.stringify(row)).not.toContain(credential);

      const identity = store.verifyBearer(credential);
      expect(identity).not.toBeNull();
      expect(identity).toMatchObject({
        ownerId: 'owner-synthetic',
        harnessId: 'harness-synthetic',
        transport: 'server',
      });
      expect([...identity!.capabilities]).toEqual(['calibration:read', 'calibration:write']);
      expect(identity!.capabilities.size).toBe(2);
      expect([...identity!.capabilities.entries()]).toEqual([
        ['calibration:read', 'calibration:read'],
        ['calibration:write', 'calibration:write'],
      ]);
      expect(identity!.capabilities.has('preferences:read' as never)).toBe(false);
      expect(() => (identity!.capabilities as Set<string>).add('preferences:read')).toThrow();
      expect(() => (identity!.capabilities as Set<string>).delete('calibration:read')).toThrow();
      expect(() => (identity!.capabilities as Set<string>).clear()).toThrow();
      expect(() => Set.prototype.add.call(identity!.capabilities, 'preferences:read' as never)).toThrow();
      expect(store.verifyBearer(credential)!.capabilities.has('preferences:read' as never)).toBe(false);
    } finally {
      database.close();
    }
  });

  it('does not expose mutable authority through the capabilities forEach callback Set', () => {
    const database = createExclusiveDatabase();
    const now = 1_700_000_000_000;
    try {
      const store = createCalibrationHarnessCredentialStore(database, { now: () => now });
      const credential = store.provision({
        ownerId: 'owner-foreach',
        harnessId: 'harness-foreach',
        expiresAt: now + 60_000,
      });
      const identity = store.verifyBearer(credential)!;
      let callbackSet: ReadonlySet<CalibrationHarnessCapability> | undefined;
      identity.capabilities.forEach((_value, _sameValue, set) => {
        callbackSet = set;
      });

      expect(callbackSet).toBe(identity.capabilities);
      expect(() => (callbackSet as Set<string>).add('backup:write')).toThrow();
      expect(store.verifyBearer(credential)!.capabilities.has('backup:write' as never)).toBe(false);
    } finally {
      database.close();
    }
  });

  it('does not expose mutable authority through capabilities valueOf', () => {
    const database = createExclusiveDatabase();
    const now = 1_700_000_000_000;
    try {
      const store = createCalibrationHarnessCredentialStore(database, { now: () => now });
      const credential = store.provision({
        ownerId: 'owner-valueof',
        harnessId: 'harness-valueof',
        expiresAt: now + 60_000,
      });
      const identity = store.verifyBearer(credential)!;
      const value = identity.capabilities.valueOf();

      expect(value).toBe(identity.capabilities);
      expect(() => (value as Set<string>).add('metrics:write')).toThrow();
      expect(store.verifyBearer(credential)!.capabilities.has('metrics:write' as never)).toBe(false);
    } finally {
      database.close();
    }
  });

  it('fails closed for expired, malformed, and browser-session credentials', () => {
    const database = createExclusiveDatabase();
    let now = 1_700_000_000_000;
    try {
      const store = createCalibrationHarnessCredentialStore(database, { now: () => now });
      const credential = store.provision({ ownerId: 'owner-a', harnessId: 'harness-a', expiresAt: now + 1 });
      now += 1;

      expect(store.verifyBearer(credential)).toBeNull();
      expect(store.verifyBearer('browser_session_' + 'a'.repeat(43))).toBeNull();
      expect(store.verifyBearer('calibration_pair_not-a-valid-length')).toBeNull();
      expect(sessionCount(database)).toBe(1);
    } finally {
      database.close();
    }
  });

  it('survives reopen while rejecting invalid provisioning input without database side effects', () => {
    const database = createExclusiveDatabase();
    const filename = database.name;
    const now = 1_700_000_000_000;
    let credential: string;
    try {
      const store = createCalibrationHarnessCredentialStore(database, { now: () => now });
      credential = store.provision({ ownerId: 'owner-reopen', harnessId: 'harness-reopen', expiresAt: now + 60_000 });
      expect(sessionCount(database)).toBe(1);

      expect(() => store.provision({ ownerId: 'owner\ninvalid', harnessId: 'harness-valid', expiresAt: now + 60_000 })).toThrow();
      expect(() => store.provision({ ownerId: 'owner-valid', harnessId: 'x'.repeat(129), expiresAt: now + 60_000 })).toThrow();
      expect(() => store.provision({ ownerId: 'owner-valid', harnessId: 'harness-valid', expiresAt: now })).toThrow();
      expect(() => store.provision({ ownerId: 'owner-valid', harnessId: 'harness-valid', expiresAt: Number.MAX_SAFE_INTEGER + 1 })).toThrow();
      expect(sessionCount(database)).toBe(1);
    } finally {
      database.close();
    }

    const reopened = openNativeDatabase(filename);
    try {
      initializeCalibrationHarnessSchema(reopened);
      const store = createCalibrationHarnessCredentialStore(reopened, { now: () => now });
      expect(store.verifyBearer(credential!)).toMatchObject({
        ownerId: 'owner-reopen',
        harnessId: 'harness-reopen',
        transport: 'server',
      });
    } finally {
      reopened.close();
    }
  });
});
