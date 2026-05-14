import { afterEach, describe, expect, it, vi } from 'vitest';
import { scoreCardMatch } from './cardScoring.js';
import { LRUCache } from './lruCache.js';
import { hotCardCache } from './sqliteCache.js';

describe('cache and scoring utilities', () => {
  afterEach(() => {
    hotCardCache.clear();
    vi.restoreAllMocks();
  });

  it('scores exact, DFC, art-series, numeric, and non-numeric collector-number cases', () => {
    expect(scoreCardMatch({ name: 'Lightning Bolt', layout: 'normal' }, 'lightning bolt', '1')).toBeGreaterThan(100);
    expect(scoreCardMatch({ name: 'Bala Ged Recovery // Bala Ged Sanctuary' }, 'Bala Ged Recovery', '180')).toBeGreaterThan(90);
    expect(scoreCardMatch({ name: 'Lightning Bolt', layout: 'art_series' }, 'Lightning Bolt', 'abc')).toBe(50);
    expect(scoreCardMatch({ name: undefined }, 'Anything', undefined)).toBe(0);
  });

  it('wraps lru-cache operations and evicts least recently used values', () => {
    const cache = new LRUCache<string, string>(2);
    expect(cache.capacity).toBe(2);
    expect(cache.get('missing')).toBeUndefined();

    cache.set('a', 'A');
    cache.set('b', 'B');
    expect(cache.size).toBe(2);
    expect(cache.get('a')).toBe('A');
    cache.set('c', 'C');

    expect(cache.has('a')).toBe(true);
    expect(cache.has('b')).toBe(false);
    expect(cache.has('c')).toBe(true);

    cache.clear();
    expect(cache.size).toBe(0);
  });

  it('stores normal hot cards and skips oversized hot-card cache entries', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    hotCardCache.set('normal', { name: 'Sol Ring' });
    expect(hotCardCache.get('normal')).toEqual({ name: 'Sol Ring' });
    expect(hotCardCache.has('normal')).toBe(true);

    const hugeName = 'x'.repeat(51 * 1024);
    hotCardCache.set('huge', { name: hugeName });
    expect(hotCardCache.get('huge')).toBeUndefined();
    expect(hotCardCache._internal.capacity).toBe(500);
    expect(logSpy).not.toHaveBeenCalled();
  });
});
