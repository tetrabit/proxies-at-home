import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';

// Mock dependencies before importing router
vi.mock('../db/db.js', () => ({
    getDatabase: vi.fn(() => ({
        prepare: vi.fn((sql: string) => ({
            get: vi.fn((name?: string) =>
                sql.includes('token_names') && ['treasure', 'treasure chest', 'human soldier'].includes(String(name))
                    ? { 1: 1 }
                    : undefined
            ),
            run: vi.fn(),
        })),
    })),
}));

vi.mock('../utils/debug.js', () => ({
    debugLog: vi.fn(),
}));

vi.mock('axios', () => {
    const mockAxios = {
        create: vi.fn(() => mockAxios),
        get: vi.fn(),
        isAxiosError: vi.fn((err) => err?.isAxiosError === true),
    };
    return { default: mockAxios };
});

// Mock microservice client (always unavailable in tests, so we test fallback behavior)
vi.mock('../services/scryfallMicroserviceClient.js', () => ({
    getScryfallClient: vi.fn(),
    isMicroserviceAvailable: vi.fn(() => Promise.resolve(false)),
}));

import { scryfallRouter } from './scryfallRouter.js';
import axios from 'axios';
import { getDatabase } from '../db/db.js';
import { getScryfallClient, isMicroserviceAvailable } from '../services/scryfallMicroserviceClient.js';
import { initCatalogs } from '../utils/scryfallCatalog.js';

describe('scryfallRouter', () => {
    let app: express.Application;

    beforeEach(() => {
        app = express();
        app.use('/api/scryfall', scryfallRouter);
        vi.clearAllMocks();
    });

    afterEach(() => {
        vi.mocked(getDatabase).mockReturnValue({
            prepare: vi.fn(() => ({
                get: vi.fn(() => undefined),
                run: vi.fn(),
            })),
        } as never);
        vi.resetAllMocks();
    });

    describe('GET /autocomplete', () => {
        it('should return empty array for short queries', async () => {
            const res = await request(app).get('/api/scryfall/autocomplete?q=s');
            expect(res.status).toBe(200);
            expect(res.body).toEqual({ object: 'catalog', data: [] });
        });

        it('should proxy to Scryfall for valid queries', async () => {
            const mockResponse = { data: ['Sol Ring', 'Soltari Crusader'] };
            vi.mocked(axios.get).mockResolvedValueOnce({ data: mockResponse });

            const res = await request(app).get('/api/scryfall/autocomplete?q=sol');
            expect(res.status).toBe(200);
            expect(res.body).toEqual(mockResponse);
        expect(axios.get).toHaveBeenCalledWith('/cards/autocomplete', { params: { q: 'sol' } });
    });

        it('uses microservice autocomplete when available', async () => {
            vi.mocked(isMicroserviceAvailable).mockResolvedValueOnce(true);
            vi.mocked(getScryfallClient).mockReturnValueOnce({
                autocomplete: vi.fn().mockResolvedValue({ object: 'catalog', data: ['Micro Ring'] }),
            } as never);

            const res = await request(app).get('/api/scryfall/autocomplete?q=micro');

            expect(res.status).toBe(200);
            expect(res.body).toEqual({ object: 'catalog', data: ['Micro Ring'] });
            expect(axios.get).not.toHaveBeenCalled();
        });

        it('returns cached autocomplete results without hitting upstream', async () => {
            const cached = { object: 'catalog', data: ['Cached Ring'] };
            vi.mocked(getDatabase).mockReturnValue({
                prepare: vi.fn(() => ({
                    get: vi.fn(() => ({ response: JSON.stringify(cached), expires_at: Date.now() + 1000 })),
                })),
            } as never);

            const res = await request(app).get('/api/scryfall/autocomplete?q=cache-me');
            expect(res.status).toBe(200);
            expect(res.body).toEqual(cached);
            expect(axios.get).not.toHaveBeenCalled();
        });

        it('returns cached search results without hitting upstream', async () => {
            const cached = { object: 'list', data: [{ name: 'Cached Search' }] };
            vi.mocked(getDatabase).mockReturnValue({
                prepare: vi.fn(() => ({
                    get: vi.fn(() => ({ response: JSON.stringify(cached), expires_at: Date.now() + 1000 })),
                })),
            } as never);

            const res = await request(app).get('/api/scryfall/search?q=cache-me');
            expect(res.status).toBe(200);
            expect(res.body).toEqual(cached);
            expect(axios.get).not.toHaveBeenCalled();
        });

        it('should return 500 on upstream error', async () => {
            vi.mocked(axios.get).mockRejectedValueOnce(new Error('Network error'));

            const res = await request(app).get('/api/scryfall/autocomplete?q=sol');
            expect(res.status).toBe(500);
            expect(res.body.error).toBe('Failed to fetch autocomplete');
        });

        it('uses autocomplete microservice, forwards upstream autocomplete errors, and tolerates cache failures', async () => {
            vi.mocked(isMicroserviceAvailable).mockResolvedValueOnce(true);
            vi.mocked(getScryfallClient).mockReturnValueOnce({
                autocomplete: vi.fn().mockResolvedValue({ object: 'catalog', data: ['Micro'] }),
            } as never);
            const micro = await request(app).get('/api/scryfall/autocomplete?q=micro');
            expect(micro.status).toBe(200);
            expect(micro.body).toEqual({ object: 'catalog', data: ['Micro'] });

            vi.mocked(axios.get).mockRejectedValueOnce({ isAxiosError: true, response: { status: 429, data: { error: 'rate' } } });
            vi.mocked(axios.isAxiosError).mockReturnValueOnce(true);
            const upstream = await request(app).get('/api/scryfall/autocomplete?q=limited');
            expect(upstream.status).toBe(429);
            expect(upstream.body).toEqual({ error: 'rate' });

            vi.mocked(getDatabase)
                .mockImplementationOnce(() => {
                    throw new Error('cache read failed');
                })
                .mockImplementationOnce(() => {
                    throw new Error('cache write failed');
                });
            vi.mocked(axios.get).mockResolvedValueOnce({ data: { object: 'catalog', data: ['No Cache'] } });
            const cacheFailure = await request(app).get('/api/scryfall/autocomplete?q=no-cache');
            expect(cacheFailure.status).toBe(200);
            expect(cacheFailure.body).toEqual({ object: 'catalog', data: ['No Cache'] });
        });

        it('forwards autocomplete axios response errors', async () => {
            vi.mocked(axios.get).mockRejectedValueOnce({ isAxiosError: true, response: { status: 503, data: { error: 'busy' } } });
            vi.mocked(axios.isAxiosError).mockReturnValueOnce(true);

            const res = await request(app).get('/api/scryfall/autocomplete?q=busy');

            expect(res.status).toBe(503);
            expect(res.body).toEqual({ error: 'busy' });
        });
    });

    describe('GET /named', () => {
        it('should return 400 when no exact or fuzzy param', async () => {
            const res = await request(app).get('/api/scryfall/named');
            expect(res.status).toBe(400);
            expect(res.body.error).toBe('Missing exact or fuzzy parameter');
        });

        it('should proxy exact query to Scryfall', async () => {
            const mockCard = { name: 'Sol Ring', set: 'cmd' };
            vi.mocked(axios.get).mockResolvedValueOnce({ data: mockCard });

            const res = await request(app).get('/api/scryfall/named?exact=Sol%20Ring');
            expect(res.status).toBe(200);
            expect(res.body).toEqual(mockCard);
            expect(axios.get).toHaveBeenCalledWith('/cards/named', { params: { exact: 'Sol Ring' } });
        });

        it('should proxy fuzzy query to Scryfall', async () => {
            const mockCard = { name: 'Sol Ring', set: 'cmd' };
            vi.mocked(axios.get).mockResolvedValueOnce({ data: mockCard });

            const res = await request(app).get('/api/scryfall/named?fuzzy=sol%20rng');
            expect(res.status).toBe(200);
            expect(res.body).toEqual(mockCard);
            expect(axios.get).toHaveBeenCalledWith('/cards/named', { params: { fuzzy: 'sol rng' } });
        });

        it('passes set params through named lookups and reports plain named failures', async () => {
            vi.mocked(isMicroserviceAvailable).mockResolvedValueOnce(true);
            vi.mocked(axios.get).mockResolvedValueOnce({ data: { name: 'Set Named' } });
            const setResponse = await request(app).get('/api/scryfall/named?exact=Set%20Named&set=abc');
            expect(setResponse.status).toBe(200);
            expect(axios.get).toHaveBeenCalledWith('/cards/named', { params: { exact: 'Set Named', set: 'abc' } });

            vi.mocked(axios.get).mockRejectedValueOnce(new Error('plain named failure'));
            const failed = await request(app).get('/api/scryfall/named?exact=Plain%20Named%20Failure');
            expect(failed.status).toBe(500);
            expect(failed.body.error).toBe('Failed to fetch card');
        });

        it('returns cached named results without hitting upstream', async () => {
            const cached = { name: 'Cached Named', set: 'cmd' };
            vi.mocked(getDatabase).mockImplementation(() => ({
                prepare: vi.fn(() => ({
                    get: vi.fn(() => ({ response: JSON.stringify(cached), expires_at: Date.now() + 1000 })),
                })),
            }) as never);

            const res = await request(app).get('/api/scryfall/named?exact=Cached%20Named');
            expect(res.status).toBe(200);
            expect(res.body).toEqual(cached);
            expect(axios.get).not.toHaveBeenCalled();
        });

        it('should forward Scryfall 404 errors', async () => {
            const axiosError = {
                isAxiosError: true,
                response: { status: 404, data: { error: 'Card not found' } },
            };
            vi.mocked(axios.get).mockRejectedValueOnce(axiosError);
            vi.mocked(axios.isAxiosError).mockReturnValueOnce(true);

            const res = await request(app).get('/api/scryfall/named?exact=NotACard');
            expect(res.status).toBe(404);
        });
    });
    describe('named extras', () => {
        it('redirects image format named requests directly to Scryfall', async () => {
            const res = await request(app).get('/api/scryfall/named?exact=Sol%20Ring&format=image&version=normal');
            expect(res.status).toBe(302);
            expect(res.header.location).toBe('https://api.scryfall.com/cards/named?exact=Sol+Ring&format=image&version=normal');
        });

        it('uses microservice for named requests when available', async () => {
            vi.mocked(isMicroserviceAvailable).mockResolvedValueOnce(true);
            vi.mocked(getScryfallClient).mockReturnValueOnce({
                getCardByName: vi.fn().mockResolvedValue({ success: true, data: { name: 'Micro Card' } }),
            } as never);

            const res = await request(app).get('/api/scryfall/named?exact=Micro%20Card');
            expect(res.status).toBe(200);
            expect(res.body).toEqual({ name: 'Micro Card' });
        });

        it('falls back when named microservice returns no data and forwards upstream errors', async () => {
            vi.mocked(isMicroserviceAvailable).mockResolvedValueOnce(true);
            vi.mocked(getScryfallClient).mockReturnValueOnce({
                getCardByName: vi.fn().mockResolvedValue({ success: false }),
            } as never);
            vi.mocked(axios.get).mockResolvedValueOnce({ data: { name: 'Fallback Named' } });
            const fallback = await request(app).get('/api/scryfall/named?fuzzy=Fallback%20Named');
            expect(fallback.status).toBe(200);
            expect(fallback.body).toEqual({ name: 'Fallback Named' });

            vi.mocked(axios.get).mockRejectedValueOnce({ isAxiosError: true, response: { status: 429, data: { error: 'rate' } } });
            vi.mocked(axios.isAxiosError).mockReturnValueOnce(true);
            const upstream = await request(app).get('/api/scryfall/named?exact=Rate%20Limited');
            expect(upstream.status).toBe(429);
            expect(upstream.body).toEqual({ error: 'rate' });
        });

        it('returns 500 for non-axios named failures', async () => {
            vi.mocked(axios.get).mockRejectedValueOnce(new Error('network'));

            const res = await request(app).get('/api/scryfall/named?exact=Plain%20Failure');

            expect(res.status).toBe(500);
            expect(res.body.error).toBe('Failed to fetch card');
        });
    });

    describe('GET /search', () => {
        it('should return 400 when no q param', async () => {
            const res = await request(app).get('/api/scryfall/search');
            expect(res.status).toBe(400);
            expect(res.body.error).toBe('Missing q parameter');
        });

        it('should proxy search query to Scryfall', async () => {
            const mockResponse = { data: [{ name: 'Sol Ring' }] };
            vi.mocked(axios.get).mockResolvedValueOnce({ data: mockResponse });

            const res = await request(app).get('/api/scryfall/search?q=set:cmd');
            expect(res.status).toBe(200);
            expect(res.body).toEqual(mockResponse);
            expect(axios.get).toHaveBeenCalledWith('/cards/search', { params: { q: 'set:cmd' } });
        });

        it('should pass through optional params', async () => {
            const mockResponse = { data: [] };
            vi.mocked(axios.get).mockResolvedValueOnce({ data: mockResponse });

            const res = await request(app).get('/api/scryfall/search?q=test&unique=prints&order=released');
            expect(res.status).toBe(200);
            expect(axios.get).toHaveBeenCalledWith('/cards/search', {
                params: { q: 'test', unique: 'prints', order: 'released' },
            });
        });

        it('should pass through is: syntax unchanged', async () => {
            const mockResponse = { data: [{ name: 'Krenko, Mob Boss' }] };
            vi.mocked(axios.get).mockResolvedValueOnce({ data: mockResponse });

            const res = await request(app).get('/api/scryfall/search?q=is:commander+c:r');
            expect(res.status).toBe(200);
            expect(axios.get).toHaveBeenCalledWith('/cards/search', { params: { q: 'is:commander c:r' } });
        });

        it('should pass through complex Scryfall syntax', async () => {
            const mockResponse = { data: [] };
            vi.mocked(axios.get).mockResolvedValueOnce({ data: mockResponse });

            // Test: is:fetchland, o: (oracle text), c: (colors)
            const res = await request(app).get('/api/scryfall/search?q=is:fetchland+o:search');
            expect(res.status).toBe(200);
            expect(axios.get).toHaveBeenCalledWith('/cards/search', { params: { q: 'is:fetchland o:search' } });
        });

        it('should pass through t:legend as type filter, not token search', async () => {
            const mockResponse = { data: [{ name: 'Krenko, Mob Boss' }] };
            vi.mocked(axios.get).mockResolvedValueOnce({ data: mockResponse });

            // t:legend should NOT become "legend type:token"
            // It should pass through as t:legend for Scryfall to interpret as type:legendary
            const res = await request(app).get('/api/scryfall/search?q=t:legend');
            expect(res.status).toBe(200);
            expect(axios.get).toHaveBeenCalledWith('/cards/search', { params: { q: 't:legend' } });
        });

        it('should convert known tokens into include:extras search syntax', async () => {
            const mockResponse = { data: [{ name: 'Treasure' }] };
            vi.mocked(axios.get).mockResolvedValueOnce({ data: mockResponse });

            const res = await request(app).get('/api/scryfall/search?q=treasure');
            expect(res.status).toBe(200);
            expect(axios.get).toHaveBeenCalledWith('/cards/search', { params: { q: 'treasure include:extras' } });
        });

        it('should treat known-token prefix phrases as token searches', async () => {
            const mockResponse = { data: [{ name: 'Treasure Chest' }] };
            vi.mocked(axios.get).mockResolvedValueOnce({ data: mockResponse });

            const res = await request(app).get('/api/scryfall/search?q=treasure%20chest');
            expect(res.status).toBe(200);
            expect(axios.get).toHaveBeenCalledWith('/cards/search', { params: { q: 'treasure chest include:extras' } });
        });

        it('converts token search syntax and page_size for direct Scryfall', async () => {
            vi.mocked(axios.get).mockResolvedValueOnce({ data: { data: [] } });
            const quoted = await request(app).get('/api/scryfall/search?q=t:%22human%20soldier%22&page_size=7');
            expect(quoted.status).toBe(200);
            expect(axios.get).toHaveBeenCalledWith('/cards/search', {
                params: { q: 'human soldier type:token', limit: '7' },
            });
        });

        it('covers token prefix parser variants and optional search params', async () => {
            vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: () => Promise.resolve({ data: ['Artifact'] }) }));
            await initCatalogs();

            vi.mocked(axios.get).mockResolvedValue({ data: { data: [] } });

            const quotedRest = await request(app).get('/api/scryfall/search?q=t:%22human%20soldier%22%20o:create&dir=auto&page=2');
            expect(quotedRest.status).toBe(200);
            expect(axios.get).toHaveBeenLastCalledWith('/cards/search', {
                params: { q: 'human soldier o:create type:token', dir: 'auto', page: '2' },
            });

            const underscore = await request(app).get('/api/scryfall/search?q=t:human_soldier%20o:create');
            expect(underscore.status).toBe(200);
            expect(axios.get).toHaveBeenLastCalledWith('/cards/search', {
                params: { q: 'human soldier o:create type:token' },
            });

            const tokenKeyword = await request(app).get('/api/scryfall/search?q=t:token%20treasure');
            expect(tokenKeyword.status).toBe(200);
            expect(axios.get).toHaveBeenLastCalledWith('/cards/search', {
                params: { q: 'treasure type:token' },
            });

            const fullKnownToken = await request(app).get('/api/scryfall/search?q=t:treasure%20chest');
            expect(fullKnownToken.status).toBe(200);
            expect(axios.get).toHaveBeenLastCalledWith('/cards/search', {
                params: { q: 'treasure chest include:extras' },
            });

            const knownFirstWord = await request(app).get('/api/scryfall/search?q=t:treasure%20weird');
            expect(knownFirstWord.status).toBe(200);
            expect(axios.get).toHaveBeenLastCalledWith('/cards/search', {
                params: { q: 'treasure weird type:token' },
            });

            vi.mocked(getDatabase).mockReturnValue({
                prepare: vi.fn((sql: string) => ({
                    get: vi.fn((name?: string) => sql.includes('token_names') && name === 'artifact treasure' ? { 1: 1 } : undefined),
                    run: vi.fn(),
                })),
            } as never);
            const validTypeKnownToken = await request(app).get('/api/scryfall/search?q=t:artifact%20treasure');
            expect(validTypeKnownToken.status).toBe(200);
            expect(axios.get).toHaveBeenLastCalledWith('/cards/search', {
                params: { q: 't:artifact treasure include:extras' },
            });

            const validType = await request(app).get('/api/scryfall/search?q=t:artifact');
            expect(validType.status).toBe(200);
            expect(axios.get).toHaveBeenLastCalledWith('/cards/search', {
                params: { q: 't:artifact' },
            });
        });

        it('converts underscore and explicit token search syntax', async () => {
            vi.mocked(axios.get)
                .mockResolvedValueOnce({ data: { data: [] } })
                .mockResolvedValueOnce({ data: { data: [] } });

            const underscore = await request(app).get('/api/scryfall/search?q=t:human_soldier');
            expect(underscore.status).toBe(200);
            expect(axios.get).toHaveBeenLastCalledWith('/cards/search', {
                params: { q: 'human soldier type:token' },
            });

            const explicit = await request(app).get('/api/scryfall/search?q=t:token%20treasure');
            expect(explicit.status).toBe(200);
            expect(axios.get).toHaveBeenLastCalledWith('/cards/search', {
                params: { q: 'treasure type:token' },
            });
        });

        it('uses microservice search pagination when available', async () => {
            vi.mocked(isMicroserviceAvailable).mockResolvedValueOnce(true);
            vi.mocked(getScryfallClient).mockReturnValueOnce({
                searchCards: vi.fn().mockResolvedValue({
                    success: true,
                    data: { has_more: false, data: [{ name: 'Micro Search' }], page: 2, page_size: 3, total: 1, total_pages: 1 },
                }),
            } as never);
            const res = await request(app).get('/api/scryfall/search?q=micro-search&page=2&page_size=3&limit=4');
            expect(res.status).toBe(200);
            expect(res.body).toMatchObject({ object: 'list', page: 2, page_size: 3, total: 1 });
        });

        it('falls back to direct search when the microservice returns no data', async () => {
            vi.mocked(isMicroserviceAvailable).mockResolvedValueOnce(true);
            vi.mocked(getScryfallClient).mockReturnValueOnce({
                searchCards: vi.fn().mockResolvedValue({ success: false }),
            } as never);
            vi.mocked(axios.get).mockResolvedValueOnce({ data: { data: [{ name: 'Direct Fallback' }] } });

            const res = await request(app).get('/api/scryfall/search?q=micro-fallback&limit=5');

            expect(res.status).toBe(200);
            expect(axios.get).toHaveBeenCalledWith('/cards/search', { params: { q: 'micro-fallback', limit: '5' } });
        });

        it('forwards search axios errors and plain failures', async () => {
            vi.mocked(axios.get).mockRejectedValueOnce({ isAxiosError: true, response: { status: 400, data: { error: 'bad query' } } });
            vi.mocked(axios.isAxiosError).mockReturnValueOnce(true);
            const upstream = await request(app).get('/api/scryfall/search?q=bad-query-unique');
            expect(upstream.status).toBe(400);
            expect(upstream.body).toEqual({ error: 'bad query' });

            vi.mocked(axios.get).mockRejectedValueOnce(new Error('network'));
            const plain = await request(app).get('/api/scryfall/search?q=plain-failure-unique');
            expect(plain.status).toBe(500);
            expect(plain.body.error).toBe('Failed to search cards');
        });
    });

    describe('GET /cards/:set/:number', () => {
        it('should proxy card lookup to Scryfall', async () => {
            const mockCard = { name: 'Sol Ring', set: 'cmd', collector_number: '235' };
            vi.mocked(axios.get).mockResolvedValueOnce({ data: mockCard });

            const res = await request(app).get('/api/scryfall/cards/cmd/235');
            expect(res.status).toBe(200);
            expect(res.body).toEqual(mockCard);
            expect(axios.get).toHaveBeenCalledWith('/cards/cmd/235');
        });

        it('should include language in path when provided', async () => {
            const mockCard = { name: 'Sol Ring', lang: 'ja' };
            vi.mocked(axios.get).mockResolvedValueOnce({ data: mockCard });

            const res = await request(app).get('/api/scryfall/cards/cmd/235?lang=ja');
            expect(res.status).toBe(200);
            expect(axios.get).toHaveBeenCalledWith('/cards/cmd/235/ja');
        });

        it('returns cached card results without hitting upstream', async () => {
            const cached = { name: 'Cached Card', set: 'cmd', collector_number: '235' };
            vi.mocked(getDatabase).mockImplementation(() => ({
                prepare: vi.fn(() => ({
                    get: vi.fn(() => ({ response: JSON.stringify(cached), expires_at: Date.now() + 1000 })),
                })),
            }) as never);

            const res = await request(app).get('/api/scryfall/cards/cmd/235');
            expect(res.status).toBe(200);
            expect(res.body).toEqual(cached);
            expect(axios.get).not.toHaveBeenCalled();
        });


        it('uses microservice for card lookup and handles upstream failures', async () => {
            vi.mocked(isMicroserviceAvailable).mockResolvedValueOnce(true);
            vi.mocked(getScryfallClient).mockReturnValueOnce({
                searchCards: vi.fn().mockResolvedValue({ success: true, data: { data: [{ name: 'Micro Set Card' }] } }),
            } as never);
            const micro = await request(app).get('/api/scryfall/cards/mic/42');
            expect(micro.status).toBe(200);
            expect(micro.body).toEqual({ name: 'Micro Set Card' });

            vi.mocked(isMicroserviceAvailable).mockResolvedValueOnce(true);
            vi.mocked(getScryfallClient).mockReturnValueOnce({
                searchCards: vi.fn().mockResolvedValue({ success: true, data: { data: [] } }),
            } as never);
            vi.mocked(axios.get).mockResolvedValueOnce({ data: { name: 'Direct Set Card' } });
            const microMiss = await request(app).get('/api/scryfall/cards/mis/43');
            expect(microMiss.status).toBe(200);
            expect(microMiss.body).toEqual({ name: 'Direct Set Card' });

            vi.mocked(axios.get).mockRejectedValueOnce({ isAxiosError: true, response: { status: 404, data: { error: 'missing' } } });
            vi.mocked(axios.isAxiosError).mockReturnValueOnce(true);
            const missing = await request(app).get('/api/scryfall/cards/zzz/999?lang=fr');
            expect(missing.status).toBe(404);
            expect(missing.body).toEqual({ error: 'missing' });

            vi.mocked(axios.get).mockRejectedValueOnce(new Error('network'));
            const failed = await request(app).get('/api/scryfall/cards/abc/123?lang=de');
            expect(failed.status).toBe(500);
            expect(failed.body.error).toBe('Failed to fetch card');
        });
    });
});
