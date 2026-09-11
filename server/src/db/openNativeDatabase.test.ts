import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { openNativeDatabase } from './openNativeDatabase.js';

const currentNodeBinding = fileURLToPath(
  new URL('../../node_modules/better-sqlite3/build/Release/better_sqlite3.node', import.meta.url),
);

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('openNativeDatabase', () => {
  it('opens an in-memory database using an explicit absolute native binding', () => {
    vi.stubEnv('PROXXIED_SQLITE_NATIVE_BINDING', currentNodeBinding);

    const database = openNativeDatabase(':memory:');
    try {
      expect(database.prepare('SELECT 42 AS value').get()).toEqual({ value: 42 });
    } finally {
      database.close();
    }
  });

  it('rejects an invalid configured native binding instead of falling back to the default driver', () => {
    vi.stubEnv('PROXXIED_SQLITE_NATIVE_BINDING', `${currentNodeBinding}.missing`);

    expect(() => openNativeDatabase(':memory:')).toThrow();
  });
});
