import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { scoreCardMatch } from './cardScoring.js';
import { LRUCache } from './lruCache.js';
import { DEBUG, debugLog } from './debug.js';
import { hotCardCache, getPreparedStatement, clearPreparedStatements } from './sqliteCache.js';

const mockPrepare = vi.fn();
vi.mock('../db/db.js', () => ({
  getDatabase: () => ({ prepare: mockPrepare }),
}));

describe('cache/scoring/debug utilities', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearPreparedStatements();
    hotCardCache.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('scores exact, front-face, art-series, and collector-number variants', () => {
    expect(scoreCardMatch({ name: 'Lightning Bolt' }, 'Lightning Bolt')).toBe(100);
    expect(scoreCardMatch({ name: 'Delver of Secrets // Insectile Aberration' }, 'Delver of Secrets')).toBe(90);
    expect(scoreCardMatch({ name: 'Lightning Bolt', layout: 'art_series' }, 'Lightning Bolt')).toBe(50);
    expect(scoreCardMatch({ name: 'Other Card' }, 'Lightning Bolt', '7')).toBeCloseTo(0.0993);
    expect(scoreCardMatch({ name: undefined }, 'Lightning Bolt', 'not-a-number')).toBe(0);
  });

  it('wraps lru-cache get/set/has/clear/capacity behavior', () => {
    const cache = new LRUCache<string, { value: number }>(2);
    cache.set('a', { value: 1 });
    cache.set('b', { value: 2 });

    expect(cache.get('a')).toEqual({ value: 1 });
    expect(cache.has('b')).toBe(true);
    expect(cache.size).toBe(2);
    expect(cache.capacity).toBe(2);

    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.get('a')).toBeUndefined();
  });

  it('caches prepared statements and clears the prepared cache', () => {
    const stmt = { get: vi.fn() };
    mockPrepare.mockReturnValue(stmt);

    expect(getPreparedStatement('SELECT 1')).toBe(stmt);
    expect(getPreparedStatement('SELECT 1')).toBe(stmt);
    expect(mockPrepare).toHaveBeenCalledTimes(1);

    clearPreparedStatements();
    expect(getPreparedStatement('SELECT 1')).toBe(stmt);
    expect(mockPrepare).toHaveBeenCalledTimes(2);
  });

  it('stores small hot-card entries and skips oversized values', () => {
    hotCardCache.set('small', { name: 'Small Card' });
    expect(hotCardCache.has('small')).toBe(true);
    expect(hotCardCache.get('small')).toEqual({ name: 'Small Card' });

    hotCardCache.set('huge', { name: 'Huge', oracle_text: 'x'.repeat(60 * 1024) });
    expect(hotCardCache.has('huge')).toBe(false);
  });

  it('only emits debug logs when the module-level DEBUG flag is enabled', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    debugLog('message');

    if (DEBUG) {
      expect(logSpy).toHaveBeenCalledWith('message');
    } else {
      expect(logSpy).not.toHaveBeenCalled();
    }
  });
});
