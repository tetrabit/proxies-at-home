import { Readable } from 'node:stream';
import axios from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const dbGet = vi.fn();
const dbRun = vi.fn();
const batchInsertCards = vi.fn();
const batchInsertCardTypes = vi.fn();
const batchInsertTokenNames = vi.fn();
const getCardCount = vi.fn();

vi.mock('axios', () => ({
  default: {
    get: vi.fn(),
  },
}));

vi.mock('../db/db.js', () => ({
  getDatabase: () => ({
    prepare: vi.fn((sql: string) => ({
      get: dbGet,
      run: (...args: unknown[]) => dbRun(sql, ...args),
    })),
  }),
}));

vi.mock('../db/proxxiedCardLookup.js', () => ({
  batchInsertCards: (...args: unknown[]) => batchInsertCards(...args),
  getCardCount: () => getCardCount(),
}));

vi.mock('../utils/scryfallCatalog.js', () => ({
  parseTypeLine: (line: string) => line.toLowerCase().split(/\W+/).filter(Boolean),
  batchInsertCardTypes: (...args: unknown[]) => batchInsertCardTypes(...args),
  batchInsertTokenNames: (...args: unknown[]) => batchInsertTokenNames(...args),
}));

describe('bulk data service', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-10T00:00:00Z'));
    vi.mocked(axios.get).mockReset();
    dbGet.mockReset();
    dbRun.mockReset();
    batchInsertCards.mockReset().mockReturnValue({ inserted: 0, updated: 0 });
    batchInsertCardTypes.mockReset();
    batchInsertTokenNames.mockReset();
    getCardCount.mockReset().mockReturnValue(42);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('fetches bulk metadata with the expected Scryfall endpoint and user agent', async () => {
    const { getBulkDataInfo } = await import('./bulkDataService.js');
    vi.mocked(axios.get).mockResolvedValueOnce({ data: { download_uri: 'https://bulk.test/all.json', size: 1234 } });

    await expect(getBulkDataInfo()).resolves.toEqual({ download_uri: 'https://bulk.test/all.json', size: 1234 });
    expect(axios.get).toHaveBeenCalledWith('https://api.scryfall.com/bulk-data/all-cards', {
      headers: { 'User-Agent': 'Proxxied/1.0' },
    });
  });

  it('reports last import and import staleness decisions', async () => {
    const { getLastImportTime, shouldImport } = await import('./bulkDataService.js');

    dbGet.mockReturnValueOnce(undefined);
    expect(getLastImportTime()).toBeNull();
    dbGet.mockReturnValueOnce(undefined);
    expect(shouldImport()).toBe(true);

    dbGet.mockReturnValueOnce({ value: '2026-01-09T00:00:00.000Z' });
    expect(shouldImport()).toBe(false);

    dbGet.mockReturnValueOnce({ value: '2026-01-01T00:00:00.000Z' });
    expect(shouldImport()).toBe(true);

    dbGet.mockImplementationOnce(() => { throw new Error('db closed'); });
    expect(getLastImportTime()).toBeNull();
  });

  it('streams bulk cards, indexes token metadata, persists last import time, and returns counts', async () => {
    const { downloadAndImportBulkData } = await import('./bulkDataService.js');
    const cards = [
      {
        id: 'c1',
        oracle_id: 'o1',
        name: 'Raise the Alarm',
        set: 'm20',
        collector_number: '34',
        lang: 'en',
        colors: ['W'],
        mana_cost: '{1}{W}',
        cmc: 2,
        type_line: 'Instant',
        rarity: 'common',
        layout: 'normal',
        image_uris: { png: 'https://img.test/card.png' },
        all_parts: [{ id: 't1', component: 'token', name: 'Soldier Token', type_line: 'Token Creature — Soldier', uri: 'https://api.test/t1' }],
      },
      {
        id: 't1',
        name: 'Soldier Token',
        set: 'tm20',
        collector_number: '1',
        lang: 'en',
        type_line: 'Token Creature — Soldier',
      },
    ];

    vi.mocked(axios.get)
      .mockResolvedValueOnce({ data: { download_uri: 'https://bulk.test/all.json', size: 5 * 1024 * 1024 } })
      .mockResolvedValueOnce({ data: Readable.from([JSON.stringify(cards)]) });
    batchInsertCards.mockReturnValueOnce({ inserted: 2, updated: 1 });

    const result = await downloadAndImportBulkData();

    expect(result).toEqual({ cardsImported: 2, cardsNew: 2, cardsUpdated: 1, durationMs: 0 });
    expect(axios.get).toHaveBeenLastCalledWith('https://bulk.test/all.json', {
      responseType: 'stream',
      headers: { 'User-Agent': 'Proxxied/1.0' },
    });
    expect(batchInsertCards).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({ id: 'c1', set: 'm20', collector_number: '34', image_uris: { png: 'https://img.test/card.png' } }),
      expect.objectContaining({ id: 't1', name: 'Soldier Token' }),
    ]));
    expect(batchInsertCardTypes).toHaveBeenCalledWith(expect.arrayContaining([
      { cardId: 't1', type: 'token', isToken: true },
      { cardId: 't1', type: 'creature', isToken: true },
    ]));
    expect(batchInsertTokenNames).toHaveBeenCalledWith(['Soldier Token']);
    expect(dbRun).toHaveBeenCalledWith(expect.stringContaining('INSERT OR REPLACE INTO metadata'), 'last_import', '2026-01-10T00:00:00.000Z');
    expect(getCardCount).toHaveBeenCalled();
  });

  it('flushes full import batches before stream completion', async () => {
    const { downloadAndImportBulkData } = await import('./bulkDataService.js');
    const cards = Array.from({ length: 10_000 }, (_, index) => ({
      id: `bulk-${index}`,
      name: `Bulk Card ${index}`,
      set: 'tst',
      collector_number: String(index),
      lang: 'en',
      type_line: index % 2 === 0 ? 'Creature — Human' : undefined,
    }));

    vi.mocked(axios.get)
      .mockResolvedValueOnce({ data: { download_uri: 'https://bulk.test/large.json', size: 50 * 1024 * 1024 } })
      .mockResolvedValueOnce({ data: Readable.from([JSON.stringify(cards)]) });
    batchInsertCards.mockImplementationOnce((batch: unknown[]) => ({ inserted: batch.length, updated: 3 }));

    const result = await downloadAndImportBulkData();

    expect(result).toEqual({ cardsImported: 10_000, cardsNew: 10_000, cardsUpdated: 3, durationMs: 0 });
    expect(batchInsertCards).toHaveBeenCalledTimes(1);
    expect(batchInsertCards.mock.calls[0]?.[0]).toHaveLength(10_000);
    expect(batchInsertCardTypes).toHaveBeenCalledWith(
      expect.arrayContaining([{ cardId: 'bulk-0', type: 'creature', isToken: false }])
    );
    expect(batchInsertTokenNames).toHaveBeenCalledWith([]);
  });

  it('throws stream parse errors and skips metadata update on invalid JSON', async () => {
    const { downloadAndImportBulkData } = await import('./bulkDataService.js');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(axios.get)
      .mockResolvedValueOnce({ data: { download_uri: 'https://bulk.test/bad.json', size: 100 } })
      .mockResolvedValueOnce({ data: Readable.from(['[{bad json]']) });

    await expect(downloadAndImportBulkData()).rejects.toThrow();
    expect(dbRun).not.toHaveBeenCalled();
  });
});
