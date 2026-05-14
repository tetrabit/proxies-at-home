import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const mocks = vi.hoisted(() => ({
  axiosPost: vi.fn(),
  isAxiosError: vi.fn(),
  getCachedMpcSearch: vi.fn(),
  cacheMpcSearch: vi.fn(),
  debugLog: vi.fn(),
}));

vi.mock('axios', () => ({
  default: {
    post: mocks.axiosPost,
    isAxiosError: mocks.isAxiosError,
  },
}));

vi.mock('../db/mpcSearchCache.js', () => ({
  getCachedMpcSearch: mocks.getCachedMpcSearch,
  cacheMpcSearch: mocks.cacheMpcSearch,
}));

vi.mock('../utils/debug.js', () => ({ debugLog: mocks.debugLog }));

const { mpcAutofillRouter } = await import('./mpcAutofillRouter.js');

const app = express();
app.use(express.json());
app.use('/api/mpc', mpcAutofillRouter);

const cardPayload = (identifier: string, name = identifier) => ({
  identifier,
  name,
  smallThumbnailUrl: `${identifier}-small`,
  mediumThumbnailUrl: `${identifier}-medium`,
  dpi: 800,
  tags: ['tag'],
  sourceName: 'source-name',
  source: 'source',
  extension: 'jpg',
  size: 42,
});

describe('mpcAutofillRouter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    mocks.getCachedMpcSearch.mockReturnValue(null);
    mocks.isAxiosError.mockReturnValue(false);
  });

  it('rejects invalid single search queries', async () => {
    const missing = await request(app).post('/api/mpc/search').send({});
    const wrongType = await request(app).post('/api/mpc/search').send({ query: 1 });
    expect(missing.status).toBe(400);
    expect(wrongType.status).toBe(400);
    expect(missing.body.error).toBe('Missing or invalid query');
  });

  it('returns cached single-search cards', async () => {
    mocks.getCachedMpcSearch.mockReturnValueOnce([cardPayload('cached')]);
    const response = await request(app).post('/api/mpc/search').send({ query: 'Sol Ring', fuzzySearch: false });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ cards: [cardPayload('cached')], fromCache: true });
    expect(mocks.getCachedMpcSearch).toHaveBeenCalledWith('sol ring:exact', 'CARD');
    expect(mocks.axiosPost).not.toHaveBeenCalled();
  });

  it('searches by exact lower-case key and caches transformed cards', async () => {
    mocks.axiosPost
      .mockResolvedValueOnce({ data: { results: { 'sol ring': { CARD: ['id1'] } } } })
      .mockResolvedValueOnce({ data: { results: { id1: cardPayload('id1', 'Sol Ring') } } });

    const response = await request(app).post('/api/mpc/search').send({ query: 'Sol Ring' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ cards: [cardPayload('id1', 'Sol Ring')], fromCache: false });
    expect(mocks.axiosPost).toHaveBeenNthCalledWith(1, 'https://mpcfill.com/2/editorSearch/', expect.objectContaining({
      queries: [{ query: 'sol ring', cardType: 'CARD' }],
    }), expect.objectContaining({ timeout: 15000 }));
    expect(mocks.cacheMpcSearch).toHaveBeenCalledWith('sol ring:fuzzy', 'CARD', [cardPayload('id1', 'Sol Ring')]);
  });

  it('searches by original key, fallback key, and empty results', async () => {
    mocks.axiosPost
      .mockResolvedValueOnce({ data: { results: { 'Sol Ring': { CARD: ['id2'] } } } })
      .mockResolvedValueOnce({ data: { results: { id2: cardPayload('id2') } } })
      .mockResolvedValueOnce({ data: { results: { other: { CARD: ['id3'] } } } })
      .mockResolvedValueOnce({ data: { results: { id3: cardPayload('id3') } } })
      .mockResolvedValueOnce({ data: { results: {} } });

    expect((await request(app).post('/api/mpc/search').send({ query: 'Sol Ring' })).body.cards[0].identifier).toBe('id2');
    expect((await request(app).post('/api/mpc/search').send({ query: 'No Match' })).body.cards[0].identifier).toBe('id3');
    expect((await request(app).post('/api/mpc/search').send({ query: 'Nothing' })).body).toEqual({ cards: [] });
  });

  it('surfaces axios and non-axios single-search failures', async () => {
    mocks.isAxiosError.mockReturnValueOnce(true);
    mocks.axiosPost.mockRejectedValueOnce({ response: { status: 503, statusText: 'bad', data: {} }, message: 'unavailable', config: { url: '/u' } });
    const axiosFailure = await request(app).post('/api/mpc/search').send({ query: 'Sol Ring' });
    expect(axiosFailure.status).toBe(502);
    expect(axiosFailure.body).toEqual({ error: 'Failed to search MPC Autofill', details: '503: unavailable' });

    mocks.isAxiosError.mockReturnValueOnce(false);
    mocks.axiosPost.mockRejectedValueOnce(new Error('plain failure'));
    const plainFailure = await request(app).post('/api/mpc/search').send({ query: 'Sol Ring' });
    expect(plainFailure.status).toBe(502);
    expect(plainFailure.body).toEqual({ error: 'Failed to search MPC Autofill', details: 'plain failure' });
  });

  it('rejects invalid batch queries', async () => {
    const response = await request(app).post('/api/mpc/batch-search').send({ queries: [] });
    expect(response.status).toBe(400);
    expect(response.body.error).toBe('Missing or invalid queries array');
  });

  it('returns all-cached batch results without upstream calls', async () => {
    mocks.getCachedMpcSearch.mockReturnValue([cardPayload('cached')]);
    const response = await request(app).post('/api/mpc/batch-search').send({ queries: ['A', 'B'], cardType: 'TOKEN' });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ results: { A: [cardPayload('cached')], B: [cardPayload('cached')] } });
    expect(mocks.axiosPost).not.toHaveBeenCalled();
  });

  it('batch searches uncached queries, fetches cards with retry, and caches non-empty results', async () => {
    mocks.getCachedMpcSearch.mockImplementation((key: string) => key.startsWith('cached') ? [cardPayload('cached-id')] : null);
    mocks.axiosPost
      .mockResolvedValueOnce({ data: { results: { miss: { CARD: ['id1', 'id2'] } } } })
      .mockRejectedValueOnce({ response: { status: 500 } })
      .mockResolvedValueOnce({ data: { results: { id1: cardPayload('id1'), id2: cardPayload('id2') } } });

    vi.stubGlobal('setTimeout', ((callback: () => void) => {
      callback();
      return 0;
    }) as unknown as typeof setTimeout);

    const response = await request(app).post('/api/mpc/batch-search').send({ queries: ['Cached', 'Miss'] });

    expect(response.status).toBe(200);
    expect(response.body.results.Cached[0].identifier).toBe('cached-id');
    expect(response.body.results.Miss).toHaveLength(2);
    expect(mocks.axiosPost).toHaveBeenCalledTimes(3);
    expect(mocks.cacheMpcSearch).toHaveBeenCalledWith('miss:fuzzy', 'CARD', [cardPayload('id1'), cardPayload('id2')]);
  });

  it('returns existing cached batch results when no uncached IDs are matched', async () => {
    mocks.getCachedMpcSearch.mockImplementation((key: string) => key === 'cached:fuzzy' ? [cardPayload('cached-id')] : null);
    mocks.axiosPost.mockResolvedValueOnce({ data: { results: {} } });
    const response = await request(app).post('/api/mpc/batch-search').send({ queries: ['Cached', 'Missing'] });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ results: { Cached: [cardPayload('cached-id')] } });
  });

  it('surfaces axios and non-axios batch failures', async () => {
    mocks.isAxiosError.mockReturnValueOnce(true);
    mocks.axiosPost.mockRejectedValueOnce({ response: { status: 502 }, message: 'bad gateway' });
    const axiosFailure = await request(app).post('/api/mpc/batch-search').send({ queries: ['A'] });
    expect(axiosFailure.status).toBe(502);
    expect(axiosFailure.body).toEqual({ error: 'Failed to batch search MPC Autofill', details: '502: bad gateway' });

    mocks.isAxiosError.mockReturnValueOnce(false);
    mocks.axiosPost.mockRejectedValueOnce('plain');
    const plainFailure = await request(app).post('/api/mpc/batch-search').send({ queries: ['A'] });
    expect(plainFailure.status).toBe(502);
    expect(plainFailure.body).toEqual({ error: 'Failed to batch search MPC Autofill', details: 'plain' });
  });
});
