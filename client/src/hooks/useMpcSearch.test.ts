import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useMpcSearch } from './useMpcSearch';
import type { MpcAutofillCard } from '@/helpers/mpcAutofillApi';

// Mock dependencies
vi.mock('@/helpers/mpcAutofillApi', () => ({
    searchMpcAutofill: vi.fn(),
}));

vi.mock('@/store', () => ({
    useSettingsStore: vi.fn((selector) => {
        const state = {
            mpcFuzzySearch: true,
        };
        return selector(state);
    }),
    useUserPreferencesStore: vi.fn((selector) => {
        const state = {
            preferences: {
                favoriteMpcSources: [],
                favoriteMpcTags: [],
                favoriteMpcDpi: 800,
                favoriteMpcSort: 'dpi',
            },
        };
        return selector(state);
    }),
}));

import { searchMpcAutofill } from '@/helpers/mpcAutofillApi';

function createDeferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

function createCard(name: string): MpcAutofillCard {
    return {
        identifier: name,
        name,
        rawName: name,
        smallThumbnailUrl: '',
        mediumThumbnailUrl: '',
        dpi: 1200,
        tags: [],
        sourceName: 'Test Source',
        source: 'test',
        extension: 'jpg',
        size: 1,
    };
}

async function advanceSearchDebounce() {
    await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
    });
}

describe('useMpcSearch', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    describe('initial state', () => {
        it('should return empty results and not loading initially', () => {
            const { result } = renderHook(() => useMpcSearch(''));

            expect(result.current.cards).toEqual([]);
            expect(result.current.filteredCards).toEqual([]);
            expect(result.current.isLoading).toBe(false);
            expect(result.current.hasSearched).toBe(false);
            expect(result.current.hasResults).toBe(false);
        });

        it('should have default filter state', () => {
            const { result } = renderHook(() => useMpcSearch(''));

            expect(result.current.filters.minDpi).toBe(800);
            expect(result.current.filters.sourceFilters.size).toBe(0);
            expect(result.current.filters.tagFilters.size).toBe(0);
            expect(result.current.filters.sortBy).toBe('dpi');
            expect(result.current.filters.sortDir).toBe('desc');
        });
    });

    describe('search behavior', () => {
        it('should call searchMpcAutofill on query change', async () => {
            (searchMpcAutofill as ReturnType<typeof vi.fn>).mockResolvedValue([]);

            renderHook(() => useMpcSearch('Sol Ring'));

            await advanceSearchDebounce();

            expect(searchMpcAutofill).toHaveBeenCalled();
            expect(searchMpcAutofill).toHaveBeenCalledWith('Sol Ring', 'CARD', true, {}, expect.any(AbortSignal));
        });

        it('should update cards on successful search', async () => {
            const mockCards = [
                { id: '1', name: 'Sol Ring', dpi: 1200, sourceName: 'Source A' },
                { id: '2', name: 'Sol Ring Alt', dpi: 800, sourceName: 'Source B' },
            ];

            (searchMpcAutofill as ReturnType<typeof vi.fn>).mockResolvedValue(mockCards);

            const { result } = renderHook(() => useMpcSearch('Sol Ring'));

            await advanceSearchDebounce();

            expect(result.current.hasSearched).toBe(true);
            expect(result.current.cards.length).toBe(2);
            expect(result.current.hasResults).toBe(true);
        });
    });

    describe('autoSearch option', () => {
        it('should not search when autoSearch is false', async () => {
            renderHook(() => useMpcSearch('Sol Ring', { autoSearch: false }));

            await advanceSearchDebounce();

            expect(searchMpcAutofill).not.toHaveBeenCalled();
        });
    });

    describe('token collision dual-search', () => {
        it('should search both CARD and TOKEN for collision names like treasure', async () => {
            const mockCardResults = [{ id: '1', name: 'Treasure Nabber', dpi: 1200, sourceName: 'Source A' }];
            const mockTokenResults = [{ id: '2', name: 'Treasure', dpi: 1200, sourceName: 'Source B' }];

            (searchMpcAutofill as ReturnType<typeof vi.fn>)
                .mockResolvedValueOnce(mockCardResults)
                .mockResolvedValueOnce(mockTokenResults);

            const { result } = renderHook(() => useMpcSearch('treasure'));

            await advanceSearchDebounce();

            expect(result.current.hasSearched).toBe(true);
            // Should have called searchMpcAutofill twice - once for CARD, once for TOKEN
            expect(searchMpcAutofill).toHaveBeenCalledWith('treasure', 'CARD', true, {}, expect.any(AbortSignal));
            expect(searchMpcAutofill).toHaveBeenCalledWith('treasure', 'TOKEN', true, {}, expect.any(AbortSignal));
        });

        it('should merge token and card results for collision names', async () => {
            const mockCardResults = [{ id: '1', name: 'Treasure Nabber', dpi: 1200, sourceName: 'Source A' }];
            const mockTokenResults = [{ id: '2', name: 'Treasure Token', dpi: 1200, sourceName: 'Source B' }];

            (searchMpcAutofill as ReturnType<typeof vi.fn>)
                .mockResolvedValueOnce(mockCardResults)
                .mockResolvedValueOnce(mockTokenResults);

            const { result } = renderHook(() => useMpcSearch('blood'));

            await advanceSearchDebounce();

            // Should have both results
            expect(result.current.cards.length).toBe(2);
        });

        it('should not do dual-search for non-collision names', async () => {
            (searchMpcAutofill as ReturnType<typeof vi.fn>).mockResolvedValue([]);

            renderHook(() => useMpcSearch('Sol Ring'));

            await advanceSearchDebounce();

            expect(searchMpcAutofill).toHaveBeenCalled();
            // Should only call once with CARD type
            expect(searchMpcAutofill).toHaveBeenCalledTimes(1);
            expect(searchMpcAutofill).toHaveBeenCalledWith('Sol Ring', 'CARD', true, {}, expect.any(AbortSignal));
        });
    });

    describe('filtering', () => {
        const mockCards = [
            { id: '1', name: 'Card A', dpi: 1200, sourceName: 'Source A', tags: ['Tag1'] },
            { id: '2', name: 'Card B', dpi: 800, sourceName: 'Source B', tags: ['Tag2'] },
            { id: '3', name: 'Card C', dpi: 600, sourceName: 'Source A', tags: ['Tag1', 'Tag2'] },
        ];

        it('should filter by minimum DPI', async () => {
            (searchMpcAutofill as ReturnType<typeof vi.fn>).mockResolvedValue(mockCards);

            const { result } = renderHook(() => useMpcSearch('Sol Ring'));

            await advanceSearchDebounce();

            expect(result.current.hasSearched).toBe(true);
            // Default minDpi is 800, so Card C (600 dpi) should be filtered out
            expect(result.current.filteredCards.length).toBe(2);
            expect(result.current.filteredCards.map(c => c.name)).not.toContain('Card C');
        });

        it('should filter by source', async () => {
            (searchMpcAutofill as ReturnType<typeof vi.fn>).mockResolvedValue(mockCards);

            const { result } = renderHook(() => useMpcSearch('Sol Ring'));

            await advanceSearchDebounce();

            expect(result.current.hasSearched).toBe(true);
            // Toggle Source A filter
            act(() => {
                result.current.toggleSource('Source A');
            });

            // With minDpi 800 and Source A filter, only Card A should remain
            expect(result.current.filteredCards.length).toBe(1);
            expect(result.current.filteredCards[0].name).toBe('Card A');
        });

        it('should clear all filters', async () => {
            (searchMpcAutofill as ReturnType<typeof vi.fn>).mockResolvedValue(mockCards);

            const { result } = renderHook(() => useMpcSearch('Sol Ring'));

            await advanceSearchDebounce();

            expect(result.current.hasSearched).toBe(true);
            act(() => {
                result.current.setMinDpi(1200);
                result.current.toggleSource('Source A');
            });

            expect(result.current.filteredCards.length).toBe(1);

            act(() => {
                result.current.clearFilters();
            });

            // After clearing, all 3 cards should be visible (minDpi becomes 0)
            expect(result.current.filteredCards.length).toBe(3);
        });
    });

    describe('sorting', () => {
        const mockCards = [
            { id: '1', name: 'Zebra', dpi: 800, sourceName: 'C Source' },
            { id: '2', name: 'Alpha', dpi: 1200, sourceName: 'A Source' },
            { id: '3', name: 'Middle', dpi: 1000, sourceName: 'B Source' },
        ];

        it('should sort by DPI descending by default', async () => {
            (searchMpcAutofill as ReturnType<typeof vi.fn>).mockResolvedValue(mockCards);

            const { result } = renderHook(() => useMpcSearch('Test'));

            await advanceSearchDebounce();

            expect(result.current.hasSearched).toBe(true);
            // Clear DPI filter to see all cards
            act(() => {
                result.current.setMinDpi(0);
            });

            expect(result.current.filteredCards[0].dpi).toBe(1200);
            expect(result.current.filteredCards[1].dpi).toBe(1000);
            expect(result.current.filteredCards[2].dpi).toBe(800);
        });

        it('should sort by name when setSortBy is called', async () => {
            (searchMpcAutofill as ReturnType<typeof vi.fn>).mockResolvedValue(mockCards);

            const { result } = renderHook(() => useMpcSearch('Test'));

            await advanceSearchDebounce();

            expect(result.current.hasSearched).toBe(true);
            act(() => {
                result.current.setMinDpi(0);
                result.current.setSortBy('name');
                result.current.setSortDir('asc');
            });

            expect(result.current.filteredCards[0].name).toBe('Alpha');
            expect(result.current.filteredCards[1].name).toBe('Middle');
            expect(result.current.filteredCards[2].name).toBe('Zebra');
        });
    });

    describe('activeFilterCount', () => {
        it('should count active filters correctly', async () => {
            (searchMpcAutofill as ReturnType<typeof vi.fn>).mockResolvedValue([]);

            const { result } = renderHook(() => useMpcSearch('Test'));

            await advanceSearchDebounce();

            expect(result.current.hasSearched).toBe(true);
            expect(result.current.activeFilterCount).toBe(0);

            act(() => {
                result.current.setMinDpi(1200); // Different from default 800
                result.current.toggleSource('Source A');
                result.current.toggleTag('Tag1');
            });

            // 1 for DPI change + 1 for source + 1 for tag
            expect(result.current.activeFilterCount).toBe(3);
        });
    });

    describe('request generation fence', () => {
        it('keeps B results after B completes before the older A request', async () => {
            vi.useFakeTimers();
            const a = createDeferred<MpcAutofillCard[]>();
            const b = createDeferred<MpcAutofillCard[]>();
            const signals: (AbortSignal | undefined)[] = [];
            vi.mocked(searchMpcAutofill)
                .mockImplementationOnce((_query, _cardType, _fuzzy, _options, signal) => {
                    signals.push(signal);
                    return a.promise;
                })
                .mockImplementationOnce((_query, _cardType, _fuzzy, _options, signal) => {
                    signals.push(signal);
                    return b.promise;
                });

            const { result, rerender } = renderHook(({ query }) => useMpcSearch(query), {
                initialProps: { query: 'A' },
            });

            await act(async () => {
                await vi.advanceTimersByTimeAsync(500);
            });
            rerender({ query: 'B' });
            await act(async () => {
                await vi.advanceTimersByTimeAsync(500);
            });

            expect(signals[0]?.aborted).toBe(true);

            await act(async () => {
                b.resolve([createCard('B')]);
            });
            expect(result.current.cards.map(card => card.name)).toEqual(['B']);
            expect(result.current.isLoading).toBe(false);

            await act(async () => {
                a.resolve([createCard('A')]);
            });
            expect(result.current.cards.map(card => card.name)).toEqual(['B']);
            expect(result.current.isLoading).toBe(false);
        });

        it('does not let a stale success or finally clear B loading state', async () => {
            const a = createDeferred<MpcAutofillCard[]>();
            const b = createDeferred<MpcAutofillCard[]>();
            vi.mocked(searchMpcAutofill)
                .mockImplementationOnce(() => a.promise)
                .mockImplementationOnce(() => b.promise);

            const { result, rerender } = renderHook(({ query }) => useMpcSearch(query), {
                initialProps: { query: 'A' },
            });

            await act(async () => {
                await vi.advanceTimersByTimeAsync(500);
            });
            rerender({ query: 'B' });
            await act(async () => {
                await vi.advanceTimersByTimeAsync(500);
            });

            await act(async () => {
                a.resolve([createCard('A')]);
            });
            expect(result.current.cards).toEqual([]);
            expect(result.current.isLoading).toBe(true);

            await act(async () => {
                b.resolve([createCard('B')]);
            });
            expect(result.current.cards.map(card => card.name)).toEqual(['B']);
            expect(result.current.isLoading).toBe(false);
        });

        it('does not let a stale failure clear B results', async () => {
            const a = createDeferred<MpcAutofillCard[]>();
            const b = createDeferred<MpcAutofillCard[]>();
            vi.mocked(searchMpcAutofill)
                .mockImplementationOnce(() => a.promise)
                .mockImplementationOnce(() => b.promise);

            const { result, rerender } = renderHook(({ query }) => useMpcSearch(query), {
                initialProps: { query: 'A' },
            });

            await act(async () => {
                await vi.advanceTimersByTimeAsync(500);
            });
            rerender({ query: 'B' });
            await act(async () => {
                await vi.advanceTimersByTimeAsync(500);
            });
            await act(async () => {
                b.resolve([createCard('B')]);
            });

            await act(async () => {
                a.reject(new Error('A failed'));
            });
            expect(result.current.cards.map(card => card.name)).toEqual(['B']);
            expect(result.current.isLoading).toBe(false);
        });

        it('aborts the current request when unmounted', async () => {
            const pending = createDeferred<MpcAutofillCard[]>();
            let signal: AbortSignal | undefined;
            vi.mocked(searchMpcAutofill).mockImplementationOnce((_query, _cardType, _fuzzy, _options, requestSignal) => {
                signal = requestSignal;
                return pending.promise;
            });

            const { unmount } = renderHook(() => useMpcSearch('A'));
            await act(async () => {
                await vi.advanceTimersByTimeAsync(500);
            });

            expect(signal?.aborted).toBe(false);
            unmount();
            expect(signal?.aborted).toBe(true);

            await act(async () => {
                pending.resolve([createCard('A')]);
            });
            expect(signal?.aborted).toBe(true);
        });
    });
});
