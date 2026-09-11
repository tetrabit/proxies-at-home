import fs from 'node:fs';
import path from 'node:path';

import type Database from 'better-sqlite3';
import type express from 'express';

import { initializeCalibrationHarnessSchema } from '../db/calibrationHarnessSchema.js';
import { openNativeDatabase } from '../db/openNativeDatabase.js';
import { createCalibrationHarnessRouter } from '../routes/calibrationHarnessRouter.js';

export interface CalibrationHarnessServiceOptions {
  /** Explicit test/deployment directory; defaults to the existing server data root. */
  dataDirectory?: string;
  /** Explicit canonical browser origins. Never inferred from other server settings. */
  allowedWebOrigins: readonly string[];
}

export interface CalibrationHarnessRuntime {
  readonly database: Database.Database;
  readonly filename: string;
  readonly allowedWebOrigins: readonly string[];
  readonly router: express.Router;
  close(): void;
}

function serverDataDirectory(): string {
  return path.resolve(process.env.SERVER_DATA_DIR ?? path.join(process.cwd(), 'data'));
}

function isCanonicalAllowedOrigin(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.origin !== value || parsed.username || parsed.password) return false;
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  const loopback = parsed.hostname === 'localhost'
    || parsed.hostname === '127.0.0.1'
    || parsed.hostname === '[::1]';
  return parsed.protocol !== 'http:' || loopback;
}

export function validateCalibrationHarnessAllowedWebOrigins(origins: readonly string[]): string[] {
  if (!Array.isArray(origins) || origins.length === 0) {
    throw new TypeError('Calibration harness requires one or more explicit allowed web origins');
  }
  const canonical: string[] = [];
  const seen = new Set<string>();
  for (const origin of origins) {
    if (typeof origin !== 'string' || !isCanonicalAllowedOrigin(origin) || seen.has(origin)) {
      throw new TypeError('Calibration harness allowed web origins must be unique canonical http(s) origins');
    }
    seen.add(origin);
    canonical.push(origin);
  }
  return canonical;
}

function parseEnvironmentOrigins(value: string): string[] {
  const origins = value.split(',');
  if (origins.some((origin) => origin.length === 0 || origin.trim() !== origin)) {
    throw new TypeError('CALIBRATION_HARNESS_ALLOWED_WEB_ORIGINS must be a nonempty comma-separated origin list');
  }
  return validateCalibrationHarnessAllowedWebOrigins(origins);
}

/**
 * Resolves only the calibration-harness authority. Its absence deliberately
 * disables the namespace; ALLOWED_ORIGINS and private-route credentials never
 * grant this service access.
 */
export function resolveCalibrationHarnessServiceOptions(
  explicit: CalibrationHarnessServiceOptions | false | undefined,
): CalibrationHarnessServiceOptions | undefined {
  if (explicit === false) return undefined;

  const allowedWebOrigins = explicit === undefined
    ? (process.env.CALIBRATION_HARNESS_ALLOWED_WEB_ORIGINS === undefined
      ? undefined
      : parseEnvironmentOrigins(process.env.CALIBRATION_HARNESS_ALLOWED_WEB_ORIGINS))
    : validateCalibrationHarnessAllowedWebOrigins(explicit.allowedWebOrigins);

  if (allowedWebOrigins === undefined) return undefined;
  const dataDirectory = explicit?.dataDirectory ?? serverDataDirectory();
  if (typeof dataDirectory !== 'string' || dataDirectory.length === 0) {
    throw new TypeError('Calibration harness data directory must be a nonempty path');
  }
  return {
    dataDirectory: path.resolve(dataDirectory),
    allowedWebOrigins,
  };
}

function assertRealDirectoryAncestors(directory: string): void {
  let cursor = directory;
  while (true) {
    const entry = fs.lstatSync(cursor);
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new TypeError(`Calibration harness data path must use real directory ancestors: ${cursor}`);
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) return;
    cursor = parent;
  }
}

function ensureControlledDataDirectory(directory: string): void {
  let existing = directory;
  while (true) {
    try {
      const entry = fs.lstatSync(existing);
      if (entry.isSymbolicLink() || !entry.isDirectory()) {
        throw new TypeError(`Calibration harness data path must use real directory ancestors: ${existing}`);
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = path.dirname(existing);
      if (parent === existing) throw error;
      existing = parent;
    }
  }
  assertRealDirectoryAncestors(existing);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  assertRealDirectoryAncestors(directory);
}

function assertDedicatedDatabaseFile(filename: string): void {
  try {
    const entry = fs.lstatSync(filename);
    if (entry.isSymbolicLink() || !entry.isFile()) {
      throw new TypeError('Calibration harness database path must be an absent or regular non-symlink file');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
}

/** Opens, initializes, and owns only calibration-harness.db, never the cards singleton. */
export function createCalibrationHarnessRuntime(options: CalibrationHarnessServiceOptions): CalibrationHarnessRuntime {
  const allowedWebOrigins = validateCalibrationHarnessAllowedWebOrigins(options.allowedWebOrigins);
  if (typeof options.dataDirectory !== 'string' || options.dataDirectory.length === 0) {
    throw new TypeError('Calibration harness data directory must be a nonempty path');
  }
  const dataDirectory = path.resolve(options.dataDirectory);
  const filename = path.join(dataDirectory, 'calibration-harness.db');
  let database: Database.Database | undefined;
  let closed = false;
  try {
    ensureControlledDataDirectory(dataDirectory);
    assertDedicatedDatabaseFile(filename);
    database = openNativeDatabase(filename);
    initializeCalibrationHarnessSchema(database);
    const router = createCalibrationHarnessRouter({ database, allowedWebOrigins });
    return {
      database,
      filename,
      allowedWebOrigins: Object.freeze([...allowedWebOrigins]),
      router,
      close(): void {
        if (closed) return;
        if (!database!.open) {
          closed = true;
          return;
        }
        try {
          database!.close();
        } catch (error) {
          if (!database!.open) {
            closed = true;
            return;
          }
          throw error;
        }
        closed = true;
      },
    };
  } catch (error) {
    if (database !== undefined && !closed) {
      try {
        database.close();
      } catch {
        // Preserve the initialization error; there is no usable runtime to retain.
      }
    }
    throw error;
  }
}
