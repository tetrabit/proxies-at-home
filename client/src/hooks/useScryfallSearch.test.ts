import { renderHook } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useScryfallSearch } from './useScryfallSearch';

// Mock dependencies
vi.mock('@/helpers/cardInfoHelper', () => ({
    extractCardInfo: vi.fn((query: string) => {
        const match = query.match(/\[([A-Z0-9]+)-(\d+)\]/i);
        if (match) {
            return { name: query.replace(/\[[^\]]+\]/, '').trim(), set: match[1].toLowerCase(), number: match[2] };
        }
        const setMatch = query.match(/\[([A-Z0-9]+)\]/i);
        if (setMatch) {
            return { name: query.replace(/\[[^\]]+\]/, '').trim(), set: setMatch[1].toLowerCase(), number: null };
        }
        return { name: query.trim(), set: null, number: null };
    }),
    hasIncompleteTagSyntax: vi.fn((query: string) => {
        return query.includes('[') && !query.includes(']');
    }),
}));

const { mockSearchCards, mockFetchCardBySetAndNumber } = vi.hoisted(() => ({
    mockSearchCards: vi.fn(),
    mockFetchCardBySetAndNumber: vi.fn(),
}));

vi.mock('@/helpers/scryfallApi', () => ({
    searchCards: mockSearchCards,
    fetchCardBySetAndNumber: mockFetchCardBySetAndNumber,
}));

vi.mock('@/helpers/debug', () => ({
    debugLog: vi.fn(),
}));

vi.mock('@/helpers/scryfallSyntax', () => ({
    containsScryfallSyntax: vi.fn((query: string) => {
        // Return true for is: syntax to allow it to pass through
        return query.includes(':') && !query.includes('http');
    }),
}));

describe('useScryfallSearch', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockSearchCards.mockResolvedValue([]);
        mockFetchCardBySetAndNumber.mockResolvedValue({
            name: 'Sol Ring',
            set: 'cmd',
            number: '129',
            imageUrls: [],
            lang: 'en',
        });
    });

    describe('initial state', () => {
        it('should return empty results and not loading initially', () => {
            const { result } = renderHook(() => useScryfallSearch(''));

            expect(result.current.cards).toEqual([]);
            expect(result.current.isLoading).toBe(false);
            expect(result.current.hasSearched).toBe(false);
            expect(result.current.hasResults).toBe(false);
        });
    });

    describe('autoSearch option', () => {
        it('should not search when autoSearch is false', async () => {
            renderHook(() => useScryfallSearch('Sol Ring', { autoSearch: false }));

            // Wait for potential debounce
            await new Promise(r => setTimeout(r, 600));

            expect(mockSearchCards).not.toHaveBeenCalled();
            expect(mockFetchCardBySetAndNumber).not.toHaveBeenCalled();
        });
    });

    describe('search behavior (real timers)', () => {
        it('should debounce and call search API', async () => {
            mockSearchCards.mockResolvedValue([]);

            renderHook(() => useScryfallSearch('Lightning Bolt'));

            // Wait for debounce + API call
            await vi.waitFor(() => {
                expect(mockSearchCards).toHaveBeenCalled();
            }, { timeout: 3000 });

            expect(mockSearchCards).toHaveBeenCalledWith('Lightning Bolt', expect.anything());
        });

        it('should update cards on successful search', async () => {
            mockSearchCards.mockResolvedValue([
                {
                    name: 'Sol Ring',
                    set: 'cmd',
                    number: '129',
                    imageUrls: ['https://example.com/sol-ring.jpg'],
                    lang: 'en',
                },
            ]);

            const { result } = renderHook(() => useScryfallSearch('Sol Ring'));

            await vi.waitFor(() => {
                expect(result.current.hasSearched).toBe(true);
            }, { timeout: 1000 });

            expect(result.current.cards.length).toBe(1);
            expect(result.current.cards[0].name).toBe('Sol Ring');
            expect(result.current.hasResults).toBe(true);
        });
    });

    describe('set and number lookup', () => {
        it('should use card endpoint for set/number queries', async () => {
            mockFetchCardBySetAndNumber.mockResolvedValue({
                name: 'Sol Ring',
                set: 'cmd',
                number: '129',
                imageUrls: ['https://example.com/sol-ring.jpg'],
                lang: 'en',
            });

            renderHook(() => useScryfallSearch('[CMD-129]'));

            await vi.waitFor(() => {
                expect(mockFetchCardBySetAndNumber).toHaveBeenCalled();
            }, { timeout: 3000 });

            expect(mockFetchCardBySetAndNumber).toHaveBeenCalledWith('cmd', '129', expect.anything());
        });
    });

    describe('incomplete syntax', () => {
        it('should not search when query has incomplete tag syntax', async () => {
            renderHook(() => useScryfallSearch('Sol ['));

            // Wait for potential debounce
            await new Promise(r => setTimeout(r, 600));

            expect(mockSearchCards).not.toHaveBeenCalled();
        });
    });

    describe('error handling', () => {
        it('should handle API errors gracefully', async () => {
            mockSearchCards.mockRejectedValue(new Error('Network error'));

            const { result } = renderHook(() => useScryfallSearch('Error Test'));

            await vi.waitFor(() => {
                expect(result.current.isLoading).toBe(false);
            }, { timeout: 1000 });

            expect(result.current.cards).toEqual([]);
        });

        it('should handle non-ok responses', async () => {
            mockSearchCards.mockResolvedValue([]);

            const { result } = renderHook(() => useScryfallSearch('Unknown Card'));

            await vi.waitFor(() => {
                expect(result.current.isLoading).toBe(false);
            }, { timeout: 1000 });

            expect(result.current.cards).toEqual([]);
        });
    });

    describe('Scryfall syntax passthrough', () => {
        it('should pass through is: syntax unchanged', async () => {
            mockSearchCards.mockResolvedValue([]);

            renderHook(() => useScryfallSearch('is:mdfc'));

            await vi.waitFor(() => {
                expect(mockSearchCards).toHaveBeenCalled();
            }, { timeout: 3000 });

            // Should pass through as-is, not wrapped in quotes
            expect(mockSearchCards).toHaveBeenCalledWith('is:mdfc', expect.anything());
        });

        it('should pass through complex syntax like is:legend set:ecc unchanged', async () => {
            mockSearchCards.mockResolvedValue([]);

            renderHook(() => useScryfallSearch('is:legend set:ecc'));

            await vi.waitFor(() => {
                expect(mockSearchCards).toHaveBeenCalled();
            }, { timeout: 3000 });

            // Should pass through as-is, NOT become !"is:legend" set:ecc
            expect(mockSearchCards).toHaveBeenCalledWith('is:legend set:ecc', expect.anything());
        });

        it('should pass through c: color syntax unchanged', async () => {
            mockSearchCards.mockResolvedValue([]);

            renderHook(() => useScryfallSearch('c:r t:creature'));

            await vi.waitFor(() => {
                expect(mockSearchCards).toHaveBeenCalled();
            }, { timeout: 3000 });

            expect(mockSearchCards).toHaveBeenCalledWith('c:r t:creature', expect.anything());
        });
    });
});
