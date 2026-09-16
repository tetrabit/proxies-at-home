import { createHash, randomBytes } from 'node:crypto';

import type Database from 'better-sqlite3';

export type CalibrationHarnessCapability = 'calibration:read' | 'calibration:write';

export type CalibrationHarnessIdentity = {
  ownerId: string;
  harnessId: string;
  capabilities: ReadonlySet<CalibrationHarnessCapability>;
  transport: 'server';
};

type ProvisionInput = {
  ownerId: string;
  harnessId: string;
  expiresAt: number;
  noExpiry?: undefined;
} | {
  ownerId: string;
  harnessId: string;
  noExpiry: true;
  expiresAt?: undefined;
};

type CredentialStoreOptions = {
  now?: () => number;
};

const TOKEN_PREFIX = 'calibration_pair_';
const TOKEN_PATTERN = /^calibration_pair_[A-Za-z0-9_-]{43}$/;
const MAX_ID_LENGTH = 128;
export const CALIBRATION_HARNESS_NO_EXPIRY = -1;

function immutableCalibrationCapabilities(): ReadonlySet<CalibrationHarnessCapability> {
  const capabilities = new Set<CalibrationHarnessCapability>([
    'calibration:read',
    'calibration:write',
  ]);
  const immutable = new Proxy(Object.create(Set.prototype), {
    get(target, property, receiver) {
      if (property === 'add' || property === 'delete' || property === 'clear') {
        return () => { throw new TypeError('Calibration harness capabilities are immutable'); };
      }
      if (property === 'size') return capabilities.size;
      if (property === 'has') return capabilities.has.bind(capabilities);
      if (property === 'entries') return capabilities.entries.bind(capabilities);
      if (property === 'keys') return capabilities.keys.bind(capabilities);
      if (property === 'values' || property === Symbol.iterator) {
        return capabilities.values.bind(capabilities);
      }
      if (property === 'forEach') {
        return (callback: (value: CalibrationHarnessCapability, key: CalibrationHarnessCapability, set: ReadonlySet<CalibrationHarnessCapability>) => void, thisArg?: unknown) => {
          capabilities.forEach((value) => callback.call(thisArg, value, value, immutable));
        };
      }
      return Reflect.get(target, property, receiver);
    },
  }) as ReadonlySet<CalibrationHarnessCapability>;
  return Object.freeze(immutable);
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

function assertBoundedIdentity(value: unknown, name: string): asserts value is string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > MAX_ID_LENGTH
    || hasControlCharacter(value)
  ) {
    throw new TypeError(`${name} must be a bounded non-control string`);
  }
}

function isBoundedIdentity(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_ID_LENGTH
    && !hasControlCharacter(value);
}

function assertSafeTimestamp(value: unknown, name: string): asserts value is number {
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(`${name} must be a safe integer timestamp`);
  }
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function createCredential(): string {
  return `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
}

/** Creates a validated, server-owned calibration-only identity projection. */
export function createCalibrationHarnessIdentity(
  ownerId: string,
  harnessId: string,
): CalibrationHarnessIdentity {
  assertBoundedIdentity(ownerId, 'ownerId');
  assertBoundedIdentity(harnessId, 'harnessId');
  return Object.freeze({
    ownerId,
    harnessId,
    capabilities: immutableCalibrationCapabilities(),
    transport: 'server' as const,
  });
}

/**
 * Provisions and verifies server-operator calibration harness credentials.
 * The database stores only a SHA-256 digest of each credential.
 */
export function createCalibrationHarnessCredentialStore(
  database: Database.Database,
  options: CredentialStoreOptions = {},
): {
  provision(input: ProvisionInput): string;
  verifyBearer(token: string): CalibrationHarnessIdentity | null;
  ownerForHarness(harnessId: string): string | null;
} {
  const now = options.now ?? Date.now;
  const insertSession = database.prepare(`
    INSERT INTO mpc_harness_sessions (token_hash, owner_id, harness_id, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  const findSession = database.prepare(`
    SELECT owner_id, harness_id, created_at, expires_at
    FROM mpc_harness_sessions
    WHERE token_hash = ?
  `);

  const findHarnessOwner = database.prepare(`
    SELECT owner_id FROM mpc_harnesses WHERE harness_id = ? LIMIT 1
  `);

  return {
    /**
     * Reports the owner that already owns the configured harness in this
     * database, so operator re-provisioning can preserve the existing
     * identity instead of minting a foreign one. Returns null when the
     * harness is unknown or the row is malformed.
     */
    ownerForHarness(harnessId: string): string | null {
      if (!isBoundedIdentity(harnessId)) return null;
      let row: { owner_id: unknown } | undefined;
      try {
        row = findHarnessOwner.get(harnessId) as typeof row;
      } catch {
        return null;
      }
      return row !== undefined && isBoundedIdentity(row.owner_id) ? row.owner_id : null;
    },

    provision(input: ProvisionInput): string {
      const { ownerId, harnessId } = input;
      assertBoundedIdentity(ownerId, 'ownerId');
      assertBoundedIdentity(harnessId, 'harnessId');
      const createdAt = now();
      assertSafeTimestamp(createdAt, 'now');
      let expiresAt: number;
      if (input.noExpiry === true && input.expiresAt === undefined) {
        expiresAt = CALIBRATION_HARNESS_NO_EXPIRY;
      } else {
        if (input.noExpiry !== undefined) {
          throw new TypeError('noExpiry must be explicitly true without expiresAt');
        }
        assertSafeTimestamp(input.expiresAt, 'expiresAt');
        if (input.expiresAt <= createdAt) {
          throw new RangeError('expiresAt must be in the future');
        }
        expiresAt = input.expiresAt;
      }

      const credential = createCredential();
      insertSession.run(tokenHash(credential), ownerId, harnessId, createdAt, expiresAt);
      return credential;
    },

    verifyBearer(token: string): CalibrationHarnessIdentity | null {
      if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) {
        return null;
      }

      let row: {
        owner_id: unknown;
        harness_id: unknown;
        created_at: unknown;
        expires_at: unknown;
      } | undefined;
      try {
        row = findSession.get(tokenHash(token)) as typeof row;
      } catch {
        return null;
      }
      if (
        row === undefined
        || !isBoundedIdentity(row.owner_id)
        || !isBoundedIdentity(row.harness_id)
        || !Number.isSafeInteger(row.created_at)
        || !Number.isSafeInteger(row.expires_at)
      ) {
        return null;
      }

      const ownerId = row.owner_id;
      const harnessId = row.harness_id;
      const createdAt = row.created_at;
      const expiresAt = row.expires_at;
      if (
        !isBoundedIdentity(ownerId)
        || !isBoundedIdentity(harnessId)
        || !Number.isSafeInteger(createdAt)
        || !Number.isSafeInteger(expiresAt)
      ) {
        return null;
      }

      let currentTime: number;
      try {
        currentTime = now();
      } catch {
        return null;
      }
      const storedCreatedAt = createdAt as number;
      const storedExpiresAt = expiresAt as number;
      if (
        !Number.isSafeInteger(currentTime)
        || (
          storedExpiresAt !== CALIBRATION_HARNESS_NO_EXPIRY
          && (storedExpiresAt <= currentTime || storedExpiresAt <= storedCreatedAt)
        )
      ) {
        return null;
      }

      return createCalibrationHarnessIdentity(ownerId, harnessId);
    },
  };
}
