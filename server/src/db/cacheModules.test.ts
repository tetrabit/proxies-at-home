import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let tempDir: string;

async function loadDbModules() {
  vi.resetModules();
  process.env.SERVER_DATA_DIR = tempDir;
  const dbModule = await import('./db.js');
  const lookupModule = await import('./proxxiedCardLookup.js');
  const cacheModule = await import('./mpcSearchCache.js');
  const sqliteCache = await import('../utils/sqliteCache.js');
  dbModule.initDatabase();
  return { dbModule, lookupModule, cacheModule, sqliteCache };
}

function sampleCard(overrides = {}) {
  return {
    id: 'card-1',
    name: 'Lightning Bolt',
    set: 'lea',
    collector_number: '161',
    lang: 'en',
    colors: ['R'],
    mana_cost: '{R}',
    cmc: 1,
    type_line: 'Instant',
    rarity: 'common',
    layout: 'normal',
    image_uris: { png: 'https://example.test/bolt.png' },
    card_faces: undefined,
    all_parts: [],
    ...overrides,
  };
}

describe('database-backed cache modules', () => {
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'server-db-test-'));
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });

  afterEach(async () => {
    const { closeDatabase } = await import('./db.js').catch(() => ({ closeDatabase: () => undefined }));
    closeDatabase();
    delete process.env.SERVER_DATA_DIR;
    vi.useRealTimers();
    vi.resetModules();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('initializes, reuses, closes, clears cards, and rejects get before init', async () => {
    vi.resetModules();
    process.env.SERVER_DATA_DIR = tempDir;
    const dbModule = await import('./db.js');
    expect(() => dbModule.getDatabase()).toThrow('Database not initialized');

    const db = dbModule.initDatabase();
    expect(dbModule.initDatabase()).toBe(db);
    db.prepare('INSERT INTO cards (id, name, all_parts) VALUES (?, ?, ?)').run('x', 'Test', '[]');
    expect(dbModule.clearCardsCache()).toBe(1);
    dbModule.closeDatabase();
    dbModule.closeDatabase();
  });

  it('inserts cards, looks up by set/number and name, uses caches, and formats database size', async () => {
    const { lookupModule, sqliteCache } = await loadDbModules();
    lookupModule.insertOrUpdateCard(sampleCard());
    lookupModule.insertOrUpdateCard(sampleCard({ id: 'card-2', collector_number: '160', image_uris: { png: 'https://example.test/bolt2.png' } }));

    const bySet = lookupModule.lookupCardBySetNumber('LEA', '161', 'EN');
    expect(bySet?.name).toBe('Lightning Bolt');
    expect(sqliteCache.hotCardCache.has('lea:161:en')).toBe(true);
    expect(lookupModule.lookupCardBySetNumber('LEA', '161', 'EN')).toEqual(bySet);
    expect(lookupModule.lookupCardBySetNumber('missing', '404')).toBeNull();

    const byName = lookupModule.lookupCardByName('lightning bolt', 'EN');
    expect(byName?.image_uris?.png).toContain('bolt.png');
    expect(lookupModule.lookupCardByName('lightning bolt', 'EN')).toEqual(byName);

    expect(lookupModule.batchInsertCards([sampleCard({ id: 'batch-card', name: 'Batch Card', collector_number: '162' })])).toEqual({ inserted: 1, updated: 0 });
    lookupModule.insertOrUpdateCard({ name: 'Minimal Card' });
    lookupModule.insertOrUpdateCard({});
    const minimal = lookupModule.lookupCardByName('Minimal Card');
    expect(minimal).toMatchObject({ name: 'Minimal Card', lang: 'en' });
    expect(minimal?.set).toBeUndefined();
    expect(minimal?.all_parts).toEqual([]);

    expect(lookupModule.getCardCount()).toBe(5);
    expect(lookupModule.getDbSizeBytes()).toBeGreaterThan(0);
    expect(lookupModule.formatBytes(0)).toBe('0 B');
    expect(lookupModule.formatBytes(1024)).toBe('1.0 KB');
    lookupModule.clearScoringCache();
    lookupModule.clearPreparedStatements();
  });

  it('handles DFC name lookup, generated ids, missing all_parts misses, and catch paths', async () => {
    const { dbModule, lookupModule } = await loadDbModules();
    lookupModule.insertOrUpdateCard(sampleCard({ id: undefined, name: 'Bala Ged Recovery // Bala Ged Sanctuary', set: 'znr', collector_number: '180' }));
    expect(lookupModule.lookupCardByName('Bala Ged Recovery')?.name).toContain('//');

    const db = dbModule.getDatabase();
    db.prepare('INSERT OR REPLACE INTO cards (id, name, set_code, collector_number, lang, all_parts) VALUES (?, ?, ?, ?, ?, NULL)').run('old', 'Old Card', 'old', '1', 'en');
    expect(lookupModule.lookupCardBySetNumber('old', '1')).toBeNull();
    expect(lookupModule.lookupCardByName('Old Card')).toBeNull();

    dbModule.closeDatabase();
    expect(lookupModule.lookupCardBySetNumber('x', '1')).toBeNull();
    expect(lookupModule.lookupCardByName('x')).toBeNull();
    expect(lookupModule.getCardCount()).toBe(0);
    expect(lookupModule.getDbSizeBytes()).toBe(0);
    expect(() => lookupModule.batchInsertCards([sampleCard()])).toThrow();
    expect(() => lookupModule.insertOrUpdateCard(sampleCard())).not.toThrow();
  });

  it('caches MPC search results, expires stale entries, trims over limit, and handles DB errors', async () => {
    const { dbModule, cacheModule } = await loadDbModules();
    const cards = [{ identifier: 'id', name: 'Card', smallThumbnailUrl: '', mediumThumbnailUrl: '', dpi: 800, tags: [], sourceName: 's', source: 'src', extension: 'jpg', size: 1 }];

    expect(cacheModule.getCachedMpcSearch(' Bolt ', 'CARD')).toBeNull();
    cacheModule.cacheMpcSearch(' Bolt ', 'CARD', cards);
    expect(cacheModule.getCachedMpcSearch('bolt', 'CARD')).toEqual(cards);
    expect(cacheModule.getMpcCacheStats()).toMatchObject({ count: 1, oldestTimestamp: Date.now() });

    vi.setSystemTime(Date.now() + 25 * 60 * 60 * 1000);
    expect(cacheModule.getCachedMpcSearch('bolt', 'CARD')).toBeNull();

    cacheModule.cacheMpcSearch('expired', 'CARD', cards);
    vi.setSystemTime(Date.now() + 25 * 60 * 60 * 1000);
    expect(cacheModule.clearExpiredMpcCache()).toBe(1);

    vi.setSystemTime(new Date('2026-01-02T00:00:00Z'));
    for (let i = 0; i < 10200; i++) {
      cacheModule.cacheMpcSearch(`q${i}`, 'CARD', cards);
    }
    expect(cacheModule.getMpcCacheStats().count).toBeLessThan(10200);

    const db = dbModule.getDatabase();
    const originalPrepare = db.prepare.bind(db);
    vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
      if (sql.includes('SELECT COUNT(*) as count FROM mpc_search_cache')) {
        throw new Error('count unavailable');
      }
      return originalPrepare(sql);
    });
    for (let i = 0; i < 100; i++) {
      cacheModule.cacheMpcSearch(`trim-error-${i}`, 'CARD', cards);
    }
    vi.mocked(db.prepare).mockRestore();

    dbModule.closeDatabase();
    expect(cacheModule.getCachedMpcSearch('x', 'CARD')).toBeNull();
    expect(() => cacheModule.cacheMpcSearch('x', 'CARD', cards)).not.toThrow();
    expect(cacheModule.getMpcCacheStats()).toEqual({ count: 0, oldestTimestamp: null });
    expect(cacheModule.clearExpiredMpcCache()).toBe(0);
  });
});
