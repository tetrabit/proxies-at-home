import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    fetchCardWithPrints,
    searchCards,
    getImages,
    autocomplete,
    getCardByName,
    fetchCardsMetadataBatch,
    mapResponseToCards,
} from './scryfallApi';
import axios from 'axios';
import { API_BASE } from '@/constants';

// Mock axios
const { mockGet, mockPost } = vi.hoisted(() => {
    return {
        mockGet: vi.fn(),
        mockPost: vi.fn(),
    };
});

const microserviceState = vi.hoisted(() => ({
    client: null as null | {
        searchCards: ReturnType<typeof vi.fn>;
        autocomplete: ReturnType<typeof vi.fn>;
        getCardByName: ReturnType<typeof vi.fn>;
    },
}));

vi.mock('axios', () => {
    return {
        default: {
            create: vi.fn(() => ({
                get: mockGet,
                post: mockPost,
            })),
            isCancel: vi.fn(() => false),
            isAxiosError: vi.fn(() => false),
            post: vi.fn(), // For the direct axios.post call in fetchCardWithPrints
        },
    };
});

vi.mock('@/services/scryfallMicroservice', () => ({
    getScryfallClient: vi.fn(async () => microserviceState.client),
}));

describe('scryfallApi', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        microserviceState.client = null;
        (window as typeof window & { electronAPI?: unknown }).electronAPI = undefined;
        global.fetch = vi.fn();
        // Reset the mock implementations
        mockGet.mockResolvedValue({ data: { data: [] } });
        (axios.post as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ data: [] });
    });

    afterEach(() => {
        delete (window as typeof window & { electronAPI?: unknown }).electronAPI;
    });

    describe('getImages', () => {
        it('should extract large image_uris if available', () => {
            const card = { image_uris: { large: 'http://large.jpg', normal: 'http://normal.jpg' } };
            expect(getImages(card as never)).toEqual(['http://large.jpg']);
        });

        it('should fallback to normal if large is not available', () => {
            const card = { image_uris: { normal: 'http://normal.jpg' } };
            expect(getImages(card as never)).toEqual(['http://normal.jpg']);
        });

        it('should extract images from card_faces for DFCs', () => {
            const card = {
                card_faces: [
                    { image_uris: { large: 'http://front.jpg' } },
                    { image_uris: { normal: 'http://back.jpg' } },
                ],
            };
            expect(getImages(card as never)).toEqual(['http://front.jpg', 'http://back.jpg']);
        });

        it('should return empty array if no images found', () => {
            const card = {} as never;
            expect(getImages(card)).toEqual([]);
        });
    });

    describe('mapResponseToCards', () => {
        it('should return an empty array when the response has no data', () => {
            expect(mapResponseToCards({})).toEqual([]);
        });

        it('should map raw and card-face metadata from microservice-style responses', () => {
            const cards = mapResponseToCards({
                data: [
                    {
                        name: 'Split Card // Split Back',
                        set: 'sp1',
                        collector_number: '7',
                        lang: 'en',
                        image_uris: { png: 'http://example.com/split.png' },
                        card_faces: [
                            { name: 'Split Front', image_uris: { large: 'http://example.com/front-large.jpg' } },
                            { image_uris: { normal: 'http://example.com/back-normal.jpg' } },
                        ],
                        all_parts: [
                            { object: 'related_card', id: 'tok-1', component: 'token', name: 'Split Token', type_line: 'Token', uri: 'https://example.com/tok-1' },
                        ],
                    },
                    {
                        name: 'Fallback Card',
                        set: 'sp2',
                        collector_number: '8',
                        lang: 'en',
                        card_faces: [
                            { image_uris: { normal: 'http://example.com/fallback-front.jpg' } },
                            { image_uris: { large: 'http://example.com/fallback-back.jpg' } },
                        ],
                    },
                ],
            });

            expect(cards[0]).toMatchObject({
                name: 'Split Card // Split Back',
                imageUrls: ['http://example.com/split.png'],
                card_faces: [
                    { name: 'Split Front', imageUrl: 'http://example.com/front-large.jpg' },
                    { name: 'Split Back', imageUrl: 'http://example.com/back-normal.jpg' },
                ],
                token_parts: [{ name: 'Split Token', id: 'tok-1', uri: 'https://example.com/tok-1' }],
                needs_token: true,
            });
            expect(cards[1]).toMatchObject({
                name: 'Fallback Card',
                imageUrls: ['http://example.com/fallback-front.jpg', 'http://example.com/fallback-back.jpg'],
                card_faces: [
                    { name: 'Fallback Card', imageUrl: 'http://example.com/fallback-front.jpg' },
                    { name: '', imageUrl: 'http://example.com/fallback-back.jpg' },
                ],
            });
        });
    });

    describe('searchCards', () => {
        it('should use the microservice when available', async () => {
            const searchCardsMock = vi.fn().mockResolvedValue({
                success: true,
                data: {
                    data: [
                        {
                            id: 'micro-1',
                            name: 'Micro Ring',
                            set_code: 'mcr',
                            collector_number: '7',
                            raw_json: {
                                id: 'micro-1',
                                name: 'Micro Ring',
                                set: 'mcr',
                                collector_number: '7',
                                lang: 'en',
                                image_uris: { normal: 'http://example.com/micro-ring.jpg' },
                            },
                        },
                    ],
                },
            });
            microserviceState.client = {
                searchCards: searchCardsMock,
                autocomplete: vi.fn(),
                getCardByName: vi.fn(),
            };
            (window as typeof window & { electronAPI?: { getMicroserviceUrl: () => string } }).electronAPI = {
                getMicroserviceUrl: () => 'http://microservice.test',
            };

            const result = await searchCards('Micro Ring');

            expect(searchCardsMock).toHaveBeenCalledWith({ q: 'Micro Ring', page_size: 100 }, { signal: undefined });
            expect(result).toHaveLength(1);
            expect(result[0]).toMatchObject({
                name: 'Micro Ring',
                set: 'mcr',
                number: '7',
                imageUrls: ['http://example.com/micro-ring.jpg'],
            });
        });

        it('should fall back to server search when the microservice returns an unsuccessful response', async () => {
            const searchCardsMock = vi.fn().mockResolvedValue({ success: false, data: null });
            microserviceState.client = {
                searchCards: searchCardsMock,
                autocomplete: vi.fn(),
                getCardByName: vi.fn(),
            };
            (window as typeof window & { electronAPI?: { getMicroserviceUrl: () => string } }).electronAPI = {
                getMicroserviceUrl: () => 'http://microservice.test',
            };
            mockGet.mockResolvedValue({
                data: {
                    data: [
                        {
                            name: 'Server Ring',
                            set: 'srv',
                            collector_number: '9',
                            image_uris: { normal: 'http://example.com/server-ring.jpg' },
                            lang: 'en',
                        },
                    ],
                },
            });

            const result = await searchCards('Server Ring');

            expect(searchCardsMock).toHaveBeenCalled();
            expect(result[0]).toMatchObject({ name: 'Server Ring', set: 'srv' });
        });

        it('should fall back to server search when the microservice fails', async () => {
            const searchCardsMock = vi.fn().mockRejectedValue(new Error('microservice down'));
            microserviceState.client = {
                searchCards: searchCardsMock,
                autocomplete: vi.fn(),
                getCardByName: vi.fn(),
            };
            (window as typeof window & { electronAPI?: { getMicroserviceUrl: () => string } }).electronAPI = {
                getMicroserviceUrl: () => 'http://microservice.test',
            };
            mockGet.mockResolvedValue({
                data: {
                    data: [
                        {
                            name: 'Fallback Ring',
                            set: 'fbk',
                            collector_number: '1',
                            image_uris: { normal: 'http://example.com/fallback-ring.jpg' },
                            lang: 'en',
                        },
                    ],
                },
            });

            const result = await searchCards('Fallback Ring');

            expect(searchCardsMock).toHaveBeenCalled();
            expect(mockGet).toHaveBeenCalledWith('/search', expect.objectContaining({
                params: { q: 'Fallback Ring' },
            }));
            expect(result[0]).toMatchObject({ name: 'Fallback Ring' });
        });

        it('should return mapped cards on success', async () => {
            const mockScryfallResponse = {
                data: {
                    data: [
                        {
                            name: 'Sol Ring',
                            set: 'cmd',
                            collector_number: '1',
                            image_uris: { normal: 'http://example.com/sol-ring.jpg' },
                            lang: 'en',
                            cmc: 1,
                            type_line: 'Artifact',
                            rarity: 'uncommon',
                        },
                    ],
                },
            };
            mockGet.mockResolvedValue(mockScryfallResponse);

            const result = await searchCards('Sol Ring');
            expect(result).toHaveLength(1);
            expect(result[0].name).toBe('Sol Ring');
            expect(result[0].imageUrls).toEqual(['http://example.com/sol-ring.jpg']);
        });

        it('should return empty array on failure', async () => {
            mockGet.mockRejectedValue(new Error('Network Error'));
            await expect(searchCards('Fail')).rejects.toThrow('An unexpected error occurred. Please try again.');
        });

        it('should throw friendly error for 404', async () => {
            const axiosError = { response: { status: 404 }, isAxiosError: true };
            mockGet.mockRejectedValue(axiosError);
            (axios.isAxiosError as unknown as ReturnType<typeof vi.fn>).mockReturnValue(true);

            await expect(searchCards('Unknown')).rejects.toThrow('No cards found for your search.');
        });

        it('should throw friendly error for 500', async () => {
            const axiosError = { response: { status: 500 }, isAxiosError: true };
            mockGet.mockRejectedValue(axiosError);
            (axios.isAxiosError as unknown as ReturnType<typeof vi.fn>).mockReturnValue(true);

            await expect(searchCards('ServerError')).rejects.toThrow('There was a problem with the server. Please try again later.');
        });

        it('should throw network error for request timeout', async () => {
            const axiosError = { request: {}, isAxiosError: true };
            mockGet.mockRejectedValue(axiosError);
            (axios.isAxiosError as unknown as ReturnType<typeof vi.fn>).mockReturnValue(true);

            await expect(searchCards('NetworkError')).rejects.toThrow('Could not connect to the server. Please check your internet connection.');
        });

        it('should rethrow cancel errors', async () => {
            const cancelError = new Error('Cancelled');
            mockGet.mockRejectedValue(cancelError);
            (axios.isCancel as unknown as ReturnType<typeof vi.fn>).mockReturnValue(true);

            await expect(searchCards('Cancelled')).rejects.toThrow('Cancelled');
        });
    });

    describe('autocomplete', () => {
        it('should use the microservice when available', async () => {
            const autocompleteMock = vi.fn().mockResolvedValue({ data: ['Micro Ring', 'Micro Bolt'] });
            microserviceState.client = {
                searchCards: vi.fn(),
                autocomplete: autocompleteMock,
                getCardByName: vi.fn(),
            };
            (window as typeof window & { electronAPI?: { getMicroserviceUrl: () => string } }).electronAPI = {
                getMicroserviceUrl: () => 'http://microservice.test',
            };

            await expect(autocomplete('mic')).resolves.toEqual(['Micro Ring', 'Micro Bolt']);
            expect(autocompleteMock).toHaveBeenCalledWith({ q: 'mic' }, { signal: undefined });
        });

        it('should return autocomplete suggestions', async () => {
            mockGet.mockResolvedValue({ data: { data: ['Sol Ring', 'Solo Ring'] } });
            const result = await autocomplete('sol');
            expect(result).toEqual(['Sol Ring', 'Solo Ring']);
        });
    });

    describe('getCardByName', () => {
        it('should use the microservice when available', async () => {
            const getCardByNameMock = vi.fn().mockResolvedValue({
                success: true,
                data: {
                    id: 'micro-card',
                    name: 'Micro Bolt',
                    set_code: 'mbt',
                    collector_number: '12',
                    image_uris: { png: 'http://example.com/micro-bolt.png' },
                    raw_json: {
                        id: 'micro-card',
                        name: 'Micro Bolt',
                        set: 'mbt',
                        collector_number: '12',
                        lang: 'en',
                        image_uris: { png: 'http://example.com/micro-bolt.png' },
                    },
                },
            });
            microserviceState.client = {
                searchCards: vi.fn(),
                autocomplete: vi.fn(),
                getCardByName: getCardByNameMock,
            };
            (window as typeof window & { electronAPI?: { getMicroserviceUrl: () => string } }).electronAPI = {
                getMicroserviceUrl: () => 'http://microservice.test',
            };

            const result = await getCardByName('Micro Bolt');

            expect(getCardByNameMock).toHaveBeenCalledWith({ exact: 'Micro Bolt' }, { signal: undefined });
            expect(result).toMatchObject({
                name: 'Micro Bolt',
                set: 'mbt',
                number: '12',
                imageUrls: ['http://example.com/micro-bolt.png'],
            });
        });

        it('should return exact card by name', async () => {
            mockGet.mockResolvedValue({
                data: {
                    name: 'Lightning Bolt',
                    set: 'sta',
                    collector_number: '57',
                    image_uris: { large: 'http://bolt.jpg' },
                    lang: 'en',
                },
            });
            const result = await getCardByName('Lightning Bolt');
            expect(result.name).toBe('Lightning Bolt');
            expect(result.imageUrls).toEqual(['http://bolt.jpg']);
        });
    });

    describe('fetchCardWithPrints', () => {
        beforeEach(() => {
            // Mock global fetch for this suite
            global.fetch = vi.fn();
        });

        it('should return null if search returns no cards', async () => {
            mockGet.mockResolvedValue({ data: { data: [] } }); // Search returns empty
            const result = await fetchCardWithPrints('Unknown Card');
            expect(result).toBeNull();
        });

        it('should return card without fetching prints when includePrints is false', async () => {
            const mockSearchResponse = {
                data: {
                    data: [
                        {
                            name: 'Sol Ring',
                            set: 'cmd',
                            collector_number: '1',
                            image_uris: { normal: 'http://example.com/sol-ring.jpg' },
                        },
                    ],
                },
            };
            mockGet.mockResolvedValue(mockSearchResponse);

            const result = await fetchCardWithPrints('Sol Ring', false, false);

            expect(result).not.toBeNull();
            expect(result?.name).toBe('Sol Ring');
            expect(global.fetch).not.toHaveBeenCalled();
        });

        it('should preserve original images when the print stream has no body', async () => {
            mockGet.mockResolvedValue({
                data: {
                    data: [
                        {
                            name: 'Sol Ring',
                            set: 'cmd',
                            collector_number: '1',
                            image_uris: { normal: 'http://example.com/sol-ring.jpg' },
                        },
                    ],
                },
            });
            (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
                ok: true,
                body: null,
            });

            const result = await fetchCardWithPrints('Sol Ring');

            expect(result?.imageUrls).toEqual(['http://example.com/sol-ring.jpg']);
        });

        it('should collect fallback print data from imageUrls and ignore malformed lines', async () => {
            mockGet.mockResolvedValue({
                data: {
                    data: [
                        {
                            name: 'Sol Ring',
                            set: 'cmd',
                            collector_number: '1',
                            image_uris: { normal: 'http://example.com/sol-ring.jpg' },
                        },
                    ],
                },
            });
            const streamData = [
                'data: not-json\n',
                'data: {"imageUrls":["http://example.com/fallback-print.jpg"],"set":"cmd","number":"1"}\n\n',
            ].join('');
            const mockRead = vi.fn()
                .mockResolvedValueOnce({ done: false, value: new TextEncoder().encode(streamData) })
                .mockResolvedValueOnce({ done: true });
            (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
                ok: true,
                body: {
                    getReader: () => ({
                        read: mockRead,
                        releaseLock: vi.fn(),
                    }),
                },
            });

            const result = await fetchCardWithPrints('Sol Ring');

            expect(result?.imageUrls).toContain('http://example.com/fallback-print.jpg');
            expect(result?.prints?.[0]).toMatchObject({
                imageUrl: 'http://example.com/fallback-print.jpg',
                set: 'cmd',
                number: '1',
            });
        });

        it('should use exact search when exact is true', async () => {
            mockGet.mockResolvedValue({
                data: {
                    name: 'Sol Ring',
                    set: 'cmd',
                    collector_number: '1',
                    image_uris: { normal: 'http://example.com/sol-ring.jpg' },
                },
            });

            (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
                ok: false,
            });

            const result = await fetchCardWithPrints('Sol Ring', true, true);

            expect(result?.name).toBe('Sol Ring');
            expect(mockGet).toHaveBeenCalledWith('/named', expect.anything());
        });

        it('should return card with prints if search and print fetch succeed', async () => {
            // 1. Mock Search Response
            const mockSearchResponse = {
                data: {
                    data: [
                        {
                            name: 'Sol Ring',
                            set: 'cmd',
                            collector_number: '1',
                            image_uris: { normal: 'http://example.com/sol-ring.jpg' },
                        },
                    ],
                },
            };
            mockGet.mockResolvedValue(mockSearchResponse);

            // 2. Mock Print Fetch Stream (SSE) - with prints array
            const streamData = [
                'event: print-found\n',
                'data: {"imageUrls":["http://example.com/print1.jpg"],"prints":[{"imageUrl":"http://example.com/print1.jpg","set":"cmd","number":"1","rarity":"uncommon"}]}\n\n',
                'event: print-found\n',
                'data: {"imageUrls":["http://example.com/print2.jpg"],"prints":[{"imageUrl":"http://example.com/print2.jpg","set":"2xm","number":"274","rarity":"rare"}]}\n\n'
            ].join("");

            const mockRead = vi.fn()
                .mockResolvedValueOnce({ done: false, value: new TextEncoder().encode(streamData) })
                .mockResolvedValueOnce({ done: true });

            (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
                ok: true,
                body: {
                    getReader: () => ({
                        read: mockRead,
                        releaseLock: vi.fn(),
                    }),
                },
            });

            const result = await fetchCardWithPrints('Sol Ring');

            expect(result).not.toBeNull();
            expect(result?.name).toBe('Sol Ring');
            // The implementation collects all print URLs
            expect(result?.imageUrls).toContain('http://example.com/print1.jpg');
            expect(result?.imageUrls).toContain('http://example.com/print2.jpg');
            // Also verify prints array is populated
            expect(result?.prints).toBeDefined();
            expect(result?.prints).toHaveLength(2);
            expect(result?.prints?.[0]).toMatchObject({ imageUrl: 'http://example.com/print1.jpg', set: 'cmd', number: '1' });
            expect(result?.prints?.[1]).toMatchObject({ imageUrl: 'http://example.com/print2.jpg', set: '2xm', number: '274' });

            expect(global.fetch).toHaveBeenCalledWith(
                `${API_BASE}/api/stream/cards`,
                expect.objectContaining({
                    method: "POST",
                    body: expect.stringContaining('"cardArt":"prints"')
                })
            );
        });

        it('should return card with original images if print fetch fails', async () => {
            // 1. Mock Search Response
            const mockSearchResponse = {
                data: {
                    data: [
                        {
                            name: 'Sol Ring',
                            image_uris: { normal: 'http://example.com/sol-ring.jpg' },
                        },
                    ],
                },
            };
            mockGet.mockResolvedValue(mockSearchResponse);

            // 2. Mock Print Fetch Failure
            (global.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Print fetch failed'));

            const result = await fetchCardWithPrints('Sol Ring');

            expect(result).not.toBeNull();
            expect(result?.name).toBe('Sol Ring');
            expect(result?.imageUrls).toEqual(['http://example.com/sol-ring.jpg']); // Fallback to original
        });

        it('should return card with original images if response is not ok', async () => {
            const mockSearchResponse = {
                data: {
                    data: [
                        {
                            name: 'Sol Ring',
                            image_uris: { normal: 'http://example.com/sol-ring.jpg' },
                        },
                    ],
                },
            };
            mockGet.mockResolvedValue(mockSearchResponse);

            (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
                ok: false,
            });

            const result = await fetchCardWithPrints('Sol Ring');

            expect(result?.imageUrls).toEqual(['http://example.com/sol-ring.jpg']);
        });
    });

    describe('fetchCardsMetadataBatch', () => {
        it('should return an empty map for an empty query list', async () => {
            await expect(fetchCardsMetadataBatch([])).resolves.toEqual(new Map());
        });

        it('should collect results by query, set/number, and card name', async () => {
            (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
                ok: true,
                json: vi.fn().mockResolvedValue({
                    results: [
                        {
                            query: { name: 'Sol Ring', set: 'cmd', number: '1' },
                            card: {
                                name: 'Sol Ring',
                                set: 'cmd',
                                collector_number: '1',
                                lang: 'en',
                                image_uris: { normal: 'http://example.com/sol-ring.jpg' },
                            },
                        },
                    ],
                }),
            });

            const result = await fetchCardsMetadataBatch([{ name: 'Sol Ring', set: 'cmd', number: '1' }]);

            expect(result.get('sol ring')).toMatchObject({ name: 'Sol Ring' });
            expect(result.get('cmd|1')).toMatchObject({ name: 'Sol Ring' });
        });

        it('should return an empty map when the metadata response is not ok', async () => {
            const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
            (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
                ok: false,
                status: 500,
            });

            const result = await fetchCardsMetadataBatch([{ name: 'Sol Ring' }]);

            expect(result.size).toBe(0);
            expect(consoleSpy).toHaveBeenCalled();
            consoleSpy.mockRestore();
        });
    });
});
