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

  it('provisions an explicit non-expiring credential that survives far time advance and database reopen', () => {
    const database = createExclusiveDatabase();
    const filename = database.name;
    const initialNow = 1_700_000_000_000;
    const farFutureNow = initialNow + 100 * 365 * 24 * 60 * 60 * 1000;
    let credential: string;
    try {
      const store = createCalibrationHarnessCredentialStore(database, { now: () => initialNow });
      credential = store.provision({
        ownerId: 'owner-non-expiring',
        harnessId: 'harness-non-expiring',
        noExpiry: true,
      } as never);
      expect(database.prepare('SELECT expires_at FROM mpc_harness_sessions').get()).toEqual({ expires_at: -1 });
      expect(store.verifyBearer(credential)).toMatchObject({
        ownerId: 'owner-non-expiring',
        harnessId: 'harness-non-expiring',
      });
    } finally {
      database.close();
    }

    const reopened = openNativeDatabase(filename);
    try {
      initializeCalibrationHarnessSchema(reopened);
      const store = createCalibrationHarnessCredentialStore(reopened, { now: () => farFutureNow });
      expect(store.verifyBearer(credential!)).toMatchObject({
        ownerId: 'owner-non-expiring',
        harnessId: 'harness-non-expiring',
        transport: 'server',
      });
      reopened.prepare('DELETE FROM mpc_harness_sessions').run();
      expect(store.verifyBearer(credential!)).toBeNull();
    } finally {
      reopened.close();
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
      expect(() => store.provision({ ownerId: 'owner-valid', harnessId: 'harness-valid', expiresAt: -1 })).toThrow();
      expect(() => store.provision({ ownerId: 'owner-valid', harnessId: 'harness-valid' } as never)).toThrow();
      expect(() => store.provision({ ownerId: 'owner-valid', harnessId: 'harness-valid', noExpiry: false } as never)).toThrow();
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

  it('reports the existing owner for a configured harness and null otherwise', () => {
    const database = createExclusiveDatabase();
    const now = 1_700_000_000_000;
    try {
      const store = createCalibrationHarnessCredentialStore(database, { now: () => now });
      expect(store.ownerForHarness('harness-missing')).toBeNull();
      expect(store.ownerForHarness('x'.repeat(129))).toBeNull();
      expect(store.ownerForHarness('has\ncontrol')).toBeNull();

      database.prepare(`
        INSERT INTO mpc_harnesses (owner_id, harness_id, revision, snapshot_json, updated_at)
        VALUES (?, ?, 1, '{}', ?)
      `).run('owner-existing', 'harness-existing', now);
      database.prepare(`
        INSERT INTO mpc_harnesses (owner_id, harness_id, revision, snapshot_json, updated_at)
        VALUES (?, ?, 1, '{}', ?)
      `).run('owner-other', 'harness-other', now);

      expect(store.ownerForHarness('harness-existing')).toBe('owner-existing');
      expect(store.ownerForHarness('harness-other')).toBe('owner-other');
      expect(store.ownerForHarness('harness-missing')).toBeNull();
    } finally {
      database.close();
    }
  });
});
