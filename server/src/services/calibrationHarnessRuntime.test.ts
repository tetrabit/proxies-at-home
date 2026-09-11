import fs from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { initializeCalibrationHarnessSchema } from '../db/calibrationHarnessSchema.js';
import { openNativeDatabase } from '../db/openNativeDatabase.js';
import { createCalibrationHarnessFixtureProvider } from '../testUtils/calibrationHarnessFixtures.js';
import {
  createCalibrationHarnessRuntime,
  resolveCalibrationHarnessServiceOptions,
  validateCalibrationHarnessAllowedWebOrigins,
} from './calibrationHarnessRuntime.js';

const fixtures = createCalibrationHarnessFixtureProvider({ parentName: 'td-b1b266-h3-runtime' });
const originalHarnessOrigins = process.env.CALIBRATION_HARNESS_ALLOWED_WEB_ORIGINS;
const originalAllowedOrigins = process.env.ALLOWED_ORIGINS;

afterEach(() => {
  if (originalHarnessOrigins === undefined) delete process.env.CALIBRATION_HARNESS_ALLOWED_WEB_ORIGINS;
  else process.env.CALIBRATION_HARNESS_ALLOWED_WEB_ORIGINS = originalHarnessOrigins;
  if (originalAllowedOrigins === undefined) delete process.env.ALLOWED_ORIGINS;
  else process.env.ALLOWED_ORIGINS = originalAllowedOrigins;
});

describe('calibration harness runtime configuration and ownership', () => {
  it('disables absent configuration without borrowing generic allowed origins', () => {
    delete process.env.CALIBRATION_HARNESS_ALLOWED_WEB_ORIGINS;
    process.env.ALLOWED_ORIGINS = 'https://unrelated.example';

    expect(resolveCalibrationHarnessServiceOptions(undefined)).toBeUndefined();
    expect(resolveCalibrationHarnessServiceOptions(false)).toBeUndefined();
  });

  it('rejects invalid explicit origins before creating the dedicated data directory', () => {
    const fixtureRoot = fixtures.createInvocationRoot();
    const dataDirectory = path.join(fixtureRoot, 'not-created-for-invalid-config');

    expect(() => createCalibrationHarnessRuntime({
      dataDirectory,
      allowedWebOrigins: ['https://allowed.example', 'https://allowed.example'],
    })).toThrow(/unique canonical/i);
    expect(fs.existsSync(dataDirectory)).toBe(false);
    expect(() => validateCalibrationHarnessAllowedWebOrigins(['http://example.test']))
      .toThrow(/unique canonical/i);
  });

  it('rejects a symlink ancestor before attempting a missing descendant write', () => {
    const fixtureRoot = fixtures.createInvocationRoot();
    const target = fixtures.createExclusiveDirectory(fixtureRoot);
    fs.mkdirSync(path.join(target, 'existing'), { mode: 0o700 });
    const alias = path.join(fixtureRoot, 'alias');
    fs.symlinkSync(target, alias, 'dir');
    const dataDirectory = path.join(alias, 'existing', 'must-not-create');
    const original = fs.mkdirSync;
    let attempts = 0;
    let failure: unknown;
    const spy = vi.spyOn(fs, 'mkdirSync').mockImplementation(((pathname: fs.PathLike, ...args: unknown[]) => {
      if (String(pathname) === dataDirectory) {
        attempts += 1;
        throw new Error('intercepted unsafe pre-validation mkdir');
      }
      return Reflect.apply(original, fs, [pathname, ...args]);
    }) as typeof fs.mkdirSync);
    try {
      try {
        createCalibrationHarnessRuntime({ dataDirectory, allowedWebOrigins: ['https://allowed.example'] });
      } catch (error) {
        failure = error;
      }
      expect(attempts).toBe(0);
      expect(String(failure)).toMatch(/real directory ancestors/);
      expect(fs.existsSync(path.join(target, 'existing', 'must-not-create'))).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it('creates an owned missing directory and closes its actual database', () => {
    const parent = fixtures.createExclusiveDirectory(fixtures.createInvocationRoot());
    const runtime = createCalibrationHarnessRuntime({
      dataDirectory: path.join(parent, 'fresh'),
      allowedWebOrigins: ['https://allowed.example'],
    });
    try {
      expect(runtime.database.open).toBe(true);
    } finally {
      runtime.close();
    }
    expect(runtime.database.open).toBe(false);
  });

  it('closes an initialization-failed database handle before exposing no runtime', () => {
    const fixtureRoot = fixtures.createInvocationRoot();
    const dataDirectory = fixtures.createExclusiveDirectory(fixtureRoot);
    const filename = path.join(dataDirectory, 'calibration-harness.db');
    const setup = openNativeDatabase(filename);
    try {
      initializeCalibrationHarnessSchema(setup);
      setup.pragma('user_version = 2');
    } finally {
      setup.close();
    }

    expect(() => createCalibrationHarnessRuntime({
      dataDirectory,
      allowedWebOrigins: ['https://allowed.example'],
    })).toThrow(/newer than supported/i);

    const reopened = openNativeDatabase(filename);
    try {
      expect(reopened.pragma('user_version', { simple: true })).toBe(2);
    } finally {
      reopened.close();
    }
  });
});
