import { createHash, randomBytes } from 'node:crypto';

import type Database from 'better-sqlite3';
import type { Request, RequestHandler, Response } from 'express';

import {
  createCalibrationHarnessCredentialStore,
  createCalibrationHarnessIdentity,
  type CalibrationHarnessIdentity,
} from './calibrationHarnessIdentity.js';

export type CalibrationHarnessSessionAuthOptions = {
  allowedWebOrigins: string[];
  now?: () => number;
  maxAgeMs?: number;
};

export type CalibrationHarnessSessionAuth = {
  pair: RequestHandler;
  unpair: RequestHandler;
  authenticate: RequestHandler;
};

declare module 'express-serve-static-core' {
  interface Request {
    calibrationHarnessIdentity?: CalibrationHarnessIdentity;
  }
}

const COOKIE_NAME = 'proxxied_calibration_session';
const COOKIE_PATH = '/api/calibration-harness';
const PAIR_TOKEN_PATTERN = /^calibration_pair_[A-Za-z0-9_-]{43}$/;
const SESSION_TOKEN_PATTERN = /^calibration_session_[A-Za-z0-9_-]{43}$/;
const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

type AllowedOrigin = {
  origin: string;
  host: string;
  secure: boolean;
};

type SessionCredential = {
  token: string;
  identity: CalibrationHarnessIdentity;
  secure: boolean;
};

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function readHeaderValues(request: Request, headerName: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === headerName) {
      values.push(request.rawHeaders[index + 1] ?? '');
    }
  }
  return values;
}

function parsePairBearer(request: Request): string | null {
  const values = readHeaderValues(request, 'authorization');
  if (values.length !== 1) return null;
  const match = /^Bearer (calibration_pair_[A-Za-z0-9_-]{43})$/.exec(values[0]!);
  return match?.[1] ?? null;
}

function hasAuthorizationHeader(request: Request): boolean {
  return readHeaderValues(request, 'authorization').length > 0;
}

function parseSessionCookie(request: Request): { token: string | null; invalid: boolean } {
  const values = readHeaderValues(request, 'cookie');
  const matches: string[] = [];
  for (const value of values) {
    for (const segment of value.split(';')) {
      const separator = segment.indexOf('=');
      if (separator < 0) continue;
      const name = segment.slice(0, separator).trim();
      if (name === COOKIE_NAME) matches.push(segment.slice(separator + 1).trim());
    }
  }
  if (matches.length === 0) return { token: null, invalid: false };
  if (matches.length !== 1 || !SESSION_TOKEN_PATTERN.test(matches[0]!)) {
    return { token: null, invalid: true };
  }
  return { token: matches[0]!, invalid: false };
}

function readAllowedOrigins(allowedWebOrigins: string[]): Map<string, AllowedOrigin> {
  if (!Array.isArray(allowedWebOrigins)) {
    throw new TypeError('allowedWebOrigins must be an array');
  }
  const origins = new Map<string, AllowedOrigin>();
  for (const value of allowedWebOrigins) {
    if (typeof value !== 'string') {
      throw new TypeError('allowedWebOrigins must contain canonical origins');
    }
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new TypeError('allowedWebOrigins must contain canonical origins');
    }
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.origin !== value || url.username || url.password) {
      throw new TypeError('allowedWebOrigins must contain canonical http(s) origins');
    }
    const isLoopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
    if (url.protocol === 'http:' && !isLoopback) {
      throw new TypeError('http allowedWebOrigins must be canonical loopback origins');
    }
    origins.set(value, { origin: value, host: url.host, secure: url.protocol === 'https:' });
  }
  return origins;
}

function safeNow(now: () => number): number | null {
  try {
    const currentTime = now();
    return Number.isSafeInteger(currentTime) ? currentTime : null;
  } catch {
    return null;
  }
}

function isSafeTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value);
}

function denyUnauthorized(response: Response): void {
  response.status(401).json({ error: 'unauthorized' });
}


function requestOrigin(request: Request, origins: Map<string, AllowedOrigin>): AllowedOrigin | null {
  const values = readHeaderValues(request, 'origin');
  if (values.length !== 1) return null;
  return origins.get(values[0]!) ?? null;
}

function allowsCookieRequest(request: Request, origins: Map<string, AllowedOrigin>): AllowedOrigin | null {
  const originValues = readHeaderValues(request, 'origin');
  if (originValues.length > 0) {
    return originValues.length === 1 ? origins.get(originValues[0]!) ?? null : null;
  }

  if (request.method !== 'GET' && request.method !== 'HEAD') return null;
  if (request.headers['sec-fetch-site'] !== 'same-origin') return null;
  const hostValues = readHeaderValues(request, 'host');
  if (hostValues.length !== 1) return null;
  for (const allowedOrigin of origins.values()) {
    if (hostValues[0] === allowedOrigin.host) return allowedOrigin;
  }
  return null;
}

function cookieOptions(expiresAt: number, currentTime: number, secure: boolean): {
  httpOnly: true;
  sameSite: 'strict';
  path: string;
  secure: boolean;
  maxAge: number;
  expires: Date;
} {
  const maxAge = expiresAt - currentTime;
  return {
    httpOnly: true,
    sameSite: 'strict',
    path: COOKIE_PATH,
    secure,
    maxAge: Math.max(0, maxAge),
    expires: new Date(expiresAt),
  };
}

function clearsCookie(response: Response, secure: boolean): void {
  response.clearCookie(COOKIE_NAME, {
    httpOnly: true,
    sameSite: 'strict',
    path: COOKIE_PATH,
    secure,
  });
}

function hasMatchingHarnessParam(request: Request, identity: CalibrationHarnessIdentity): boolean {
  if (!Object.prototype.hasOwnProperty.call(request.params, 'harnessId')) return true;
  const harnessId = request.params.harnessId;
  return typeof harnessId === 'string' && harnessId === identity.harnessId;
}

/**
 * Creates owner-scoped browser pairing, session authentication, and logout handlers.
 * Pair credentials and browser sessions are stored as independent SHA-256 digests.
 */
export function createCalibrationHarnessSessionAuth(
  database: Database.Database,
  options: CalibrationHarnessSessionAuthOptions,
): CalibrationHarnessSessionAuth {
  const origins = readAllowedOrigins(options.allowedWebOrigins);
  const now = options.now ?? Date.now;
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs <= 0) {
    throw new RangeError('maxAgeMs must be a positive safe integer');
  }

  const credentialStore = createCalibrationHarnessCredentialStore(database, { now });
  const findGrantExpiry = database.prepare(`
    SELECT expires_at FROM mpc_harness_sessions WHERE token_hash = ?
  `);
  const insertSession = database.prepare(`
    INSERT INTO mpc_harness_sessions (token_hash, owner_id, harness_id, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  const findSession = database.prepare(`
    SELECT owner_id, harness_id, created_at, expires_at
    FROM mpc_harness_sessions WHERE token_hash = ?
  `);
  const revokeSession = database.prepare('DELETE FROM mpc_harness_sessions WHERE token_hash = ?');

  function authenticateSession(request: Request): SessionCredential | null {
    const parsedCookie = parseSessionCookie(request);
    if (parsedCookie.invalid || parsedCookie.token === null || origins.size === 0) return null;
    const allowedOrigin = allowsCookieRequest(request, origins);
    if (allowedOrigin === null) return null;

    let row: {
      owner_id: unknown;
      harness_id: unknown;
      created_at: unknown;
      expires_at: unknown;
    } | undefined;
    try {
      row = findSession.get(tokenHash(parsedCookie.token)) as typeof row;
    } catch {
      return null;
    }
    const currentTime = safeNow(now);
    const createdAt = row?.created_at;
    const expiresAt = row?.expires_at;
    if (
      row === undefined
      || currentTime === null
      || !isSafeTimestamp(createdAt)
      || !isSafeTimestamp(expiresAt)
      || expiresAt <= createdAt
      || expiresAt <= currentTime
    ) {
      return null;
    }
    try {
      return {
        token: parsedCookie.token,
        identity: createCalibrationHarnessIdentity(row.owner_id as string, row.harness_id as string),
        secure: allowedOrigin.secure,
      };
    } catch {
      return null;
    }
  }

  function authenticatePairBearer(request: Request): CalibrationHarnessIdentity | null {
    const token = parsePairBearer(request);
    if (token === null || !PAIR_TOKEN_PATTERN.test(token)) return null;
    try {
      return credentialStore.verifyBearer(token);
    } catch {
      return null;
    }
  }

  return {
    pair: (request, response) => {
      const allowedOrigin = requestOrigin(request, origins);
      const bearer = parsePairBearer(request);
      if (allowedOrigin === null || bearer === null) {
        denyUnauthorized(response);
        return;
      }
      const currentTime = safeNow(now);
      if (currentTime === null || currentTime > Number.MAX_SAFE_INTEGER - maxAgeMs) {
        denyUnauthorized(response);
        return;
      }
      const identity = authenticatePairBearer(request);
      if (identity === null) {
        denyUnauthorized(response);
        return;
      }
      let row: { expires_at: unknown } | undefined;
      try {
        row = findGrantExpiry.get(tokenHash(bearer)) as typeof row;
      } catch {
        denyUnauthorized(response);
        return;
      }
      const grantExpiresAt = row?.expires_at;
      if (!isSafeTimestamp(grantExpiresAt) || grantExpiresAt <= currentTime) {
        denyUnauthorized(response);
        return;
      }
      const expiresAt = Math.min(grantExpiresAt, currentTime + maxAgeMs);
      const sessionToken = `calibration_session_${randomBytes(32).toString('base64url')}`;
      try {
        insertSession.run(tokenHash(sessionToken), identity.ownerId, identity.harnessId, currentTime, expiresAt);
      } catch {
        denyUnauthorized(response);
        return;
      }
      response.cookie(COOKIE_NAME, sessionToken, cookieOptions(expiresAt, currentTime, allowedOrigin.secure));
      response.status(200).json({ ownerId: identity.ownerId, harnessId: identity.harnessId });
    },

    authenticate: (request, response, next) => {
      const parsedCookie = parseSessionCookie(request);
      const authorizationPresent = hasAuthorizationHeader(request);
      if (authorizationPresent && (parsedCookie.invalid || parsedCookie.token !== null)) {
        denyUnauthorized(response);
        return;
      }

      const identity = authorizationPresent
        ? authenticatePairBearer(request)
        : authenticateSession(request)?.identity ?? null;
      if (identity === null || !hasMatchingHarnessParam(request, identity)) {
        denyUnauthorized(response);
        return;
      }
      request.calibrationHarnessIdentity = identity;
      next();
    },

    unpair: (request, response) => {
      if (hasAuthorizationHeader(request)) {
        denyUnauthorized(response);
        return;
      }
      const session = authenticateSession(request);
      if (session === null) {
        denyUnauthorized(response);
        return;
      }
      try {
        revokeSession.run(tokenHash(session.token));
      } catch {
        denyUnauthorized(response);
        return;
      }
      clearsCookie(response, session.secure);
      response.status(204).end();
    },
  };
}
