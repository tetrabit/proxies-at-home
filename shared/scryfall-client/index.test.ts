import { afterEach, describe, expect, it, vi } from 'vitest';
import { ScryfallCacheClient } from './index';

const jsonPayload = { object: 'list', data: [] };

function mockFetch(response: Partial<Response>) {
  const fetchMock = vi.fn(async () => response as Response);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('ScryfallCacheClient', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('merges JSON headers with caller headers and parses successful responses', async () => {
    const fetchMock = mockFetch({
      ok: true,
      json: vi.fn(async () => jsonPayload),
    });
    const client = new ScryfallCacheClient({ baseUrl: 'http://cache.test' });

    await expect(
      client.searchCards({ q: 'name:sol', page: 2 } as never, {
        headers: { Authorization: 'Bearer token' },
      })
    ).resolves.toEqual(jsonPayload);

    expect(fetchMock).toHaveBeenCalledWith(
      'http://cache.test/cards/search?q=name%3Asol&page=2',
      expect.objectContaining({
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer token',
        },
      })
    );
  });

  it('routes named, id, autocomplete, stats, and health requests to their API paths', async () => {
    const fetchMock = mockFetch({
      ok: true,
      json: vi.fn(async () => ({ ok: true })),
    });
    const client = new ScryfallCacheClient({ baseUrl: 'http://cache.test' });

    await client.getCardByName({ exact: 'Black Lotus' } as never);
    await client.getCard('card-1');
    await client.autocomplete({ q: 'ligh' });
    await client.getStats();
    await client.health();

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'http://cache.test/cards/named?exact=Black+Lotus',
      'http://cache.test/cards/card-1',
      'http://cache.test/cards/autocomplete?q=ligh',
      'http://cache.test/stats',
      'http://cache.test/health',
    ]);
  });

  it('throws an API error when the response is not ok', async () => {
    mockFetch({
      ok: false,
      statusText: 'Bad Gateway',
      json: vi.fn(),
    });
    const client = new ScryfallCacheClient({ baseUrl: 'http://cache.test' });

    await expect(client.getCard('missing')).rejects.toThrow(
      'API request failed: Bad Gateway'
    );
  });
});
