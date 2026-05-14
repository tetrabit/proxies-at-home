import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { archidektRouter } from './archidektRouter.js';

const app = express();
app.use('/api/archidekt', archidektRouter);

describe('archidektRouter', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.stubGlobal('fetch', vi.fn());
  });

  it('rejects non-numeric deck IDs', async () => {
    const response = await request(app).get('/api/archidekt/decks/not-a-number');
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'Invalid deck ID' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('fetches and caches a deck response', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: true, json: async () => ({ id: 123, name: 'deck' }) } as Response);

    const first = await request(app).get('/api/archidekt/decks/123');
    const second = await request(app).get('/api/archidekt/decks/123');

    expect(first.status).toBe(200);
    expect(first.body).toEqual({ id: 123, name: 'deck' });
    expect(second.body).toEqual(first.body);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith('https://www.archidekt.com/api/decks/123/', expect.objectContaining({
      headers: expect.objectContaining({ Accept: 'application/json' }),
    }));
  });

  it('refreshes expired cache entries', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ version: 1 }) } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ version: 2 }) } as Response);

    await request(app).get('/api/archidekt/decks/456');
    vi.setSystemTime(5 * 60 * 1000 + 1);
    const response = await request(app).get('/api/archidekt/decks/456');

    expect(response.body).toEqual({ version: 2 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('forwards 404 and non-404 upstream statuses', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: false, status: 404 } as Response)
      .mockResolvedValueOnce({ ok: false, status: 503 } as Response);

    const notFound = await request(app).get('/api/archidekt/decks/404');
    const unavailable = await request(app).get('/api/archidekt/decks/503');

    expect(notFound.status).toBe(404);
    expect(notFound.body.error).toBe('Deck not found. It may be private or deleted.');
    expect(unavailable.status).toBe(503);
    expect(unavailable.body.error).toBe('Archidekt API error: 503');
  });

  it('returns 500 when fetch throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(fetch).mockRejectedValueOnce(new Error('network'));

    const response = await request(app).get('/api/archidekt/decks/789');

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: 'Failed to fetch deck from Archidekt' });
  });
});
