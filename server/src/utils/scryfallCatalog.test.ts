import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    initCatalogs,
    isValidScryfallType,
    isKnownToken,
    parseTypeLine,
    insertTokenName,
    insertCardType,
} from './scryfallCatalog';

// Mock fetch for catalog initialization
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Mock the database module
vi.mock('../db/db.js', () => ({
    getDatabase: vi.fn(() => ({
        prepare: vi.fn(() => ({
            run: vi.fn(),
            get: vi.fn(),
        })),
    })),
}));

describe('scryfallCatalog', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe('parseTypeLine', () => {
        it('should parse a simple creature type', () => {
            const types = parseTypeLine('Creature — Human Soldier');
            expect(types).toContain('creature');
            expect(types).toContain('human');
            expect(types).toContain('soldier');
        });

        it('should parse legendary artifact creature', () => {
            const types = parseTypeLine('Legendary Artifact Creature — Construct');
            expect(types).toContain('legendary');
            expect(types).toContain('artifact');
            expect(types).toContain('creature');
            expect(types).toContain('construct');
        });

        it('should parse token type_line', () => {
            const types = parseTypeLine('Token Creature — Treasure');
            expect(types).toContain('token');
            expect(types).toContain('creature');
            expect(types).toContain('treasure');
        });

        it('should parse land types', () => {
            const types = parseTypeLine('Basic Land — Forest');
            expect(types).toContain('basic');
            expect(types).toContain('land');
            expect(types).toContain('forest');
        });

        it('should handle empty string', () => {
            const types = parseTypeLine('');
            expect(types).toEqual([]);
        });

        it('should normalize to lowercase', () => {
            const types = parseTypeLine('LEGENDARY CREATURE — DRAGON');
            expect(types).toContain('legendary');
            expect(types).toContain('creature');
            expect(types).toContain('dragon');
        });

        it('should handle DFC type lines', () => {
            const types = parseTypeLine('Creature — Human // Creature — Werewolf');
            expect(types).toContain('creature');
            expect(types).toContain('human');
            expect(types).toContain('werewolf');
        });
    });

    describe('initCatalogs', () => {
        it('should fetch all 9 type catalogs from Scryfall', async () => {
            mockFetch.mockResolvedValue({
                json: () => Promise.resolve({ data: ['artifact', 'creature'] }),
            });

            await initCatalogs();

            // Should have called fetch for each of the 9 catalogs
            expect(mockFetch).toHaveBeenCalledWith('https://api.scryfall.com/catalog/supertypes');
            expect(mockFetch).toHaveBeenCalledWith('https://api.scryfall.com/catalog/card-types');
            expect(mockFetch).toHaveBeenCalledWith('https://api.scryfall.com/catalog/artifact-types');
            expect(mockFetch).toHaveBeenCalledWith('https://api.scryfall.com/catalog/creature-types');
            expect(mockFetch).toHaveBeenCalledWith('https://api.scryfall.com/catalog/land-types');
            expect(mockFetch).toHaveBeenCalledTimes(9);
        });

        it('should handle fetch errors gracefully with fallback types', async () => {
            mockFetch.mockRejectedValue(new Error('Network error'));

            // Should not throw
            await expect(initCatalogs()).resolves.not.toThrow();

            // After fallback, common types should still be valid
            expect(isValidScryfallType('artifact')).toBe(true);
            expect(isValidScryfallType('creature')).toBe(true);
        });

        it('uses fallback types when catalog construction fails synchronously', async () => {
            const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => { });
            const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => { });
            mockFetch.mockImplementation(() => {
                throw new Error('fetch unavailable');
            });

            await expect(initCatalogs()).resolves.not.toThrow();

            expect(consoleErrorSpy).toHaveBeenCalledWith(
                '[Catalog] Failed to load catalogs from Scryfall:',
                expect.any(Error)
            );
            expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('[Catalog] Using'));
            expect(isValidScryfallType('kindred')).toBe(true);
        });
    });

    describe('isValidScryfallType', () => {
        beforeEach(async () => {
            // Initialize with mock data
            mockFetch.mockResolvedValue({
                json: () => Promise.resolve({ data: ['creature', 'artifact', 'human', 'treasure'] }),
            });
            await initCatalogs();
        });

        it('should return true for known types', () => {
            expect(isValidScryfallType('creature')).toBe(true);
            expect(isValidScryfallType('artifact')).toBe(true);
        });

        it('should be case-insensitive', () => {
            expect(isValidScryfallType('CREATURE')).toBe(true);
            expect(isValidScryfallType('Artifact')).toBe(true);
        });

        it('should return false for unknown types', () => {
            expect(isValidScryfallType('notarealtype')).toBe(false);
        });
    });

    describe('isKnownToken', () => {
        it('should return false when token not in database', () => {
            // With default mock returning undefined, should be false
            expect(isKnownToken('treasure')).toBe(false);
        });
    });

    describe('insertTokenName', () => {
        it('should not throw when inserting token name', () => {
            expect(() => insertTokenName('Treasure')).not.toThrow();
        });
    });

    describe('insertCardType', () => {
        it('should not throw when inserting card type', () => {
            expect(() => insertCardType('card-id-123', 'creature', false)).not.toThrow();
        });

        it('should not throw when inserting token type', () => {
            expect(() => insertCardType('card-id-456', 'token', true)).not.toThrow();
        });
    });
});

describe('scryfallCatalog database write branches', () => {
    it('returns true for known token rows and lowercases writes/batches', async () => {
        const dbModule = await import('../db/db.js');
        const run = vi.fn();
        const get = vi.fn(() => ({ 1: 1 }));
        const transaction = vi.fn((fn: (items: unknown[]) => unknown) => (items: unknown[]) => fn(items));
        vi.mocked(dbModule.getDatabase).mockReturnValue({
            prepare: vi.fn(() => ({ run, get })),
            transaction,
        } as never);

        expect(isKnownToken('Treasure')).toBe(true);
        insertTokenName('Treasure');
        expect(run).toHaveBeenCalledWith('treasure');
        insertCardType('card', 'Creature', true);
        expect(run).toHaveBeenCalledWith('card', 'creature', 1);

        const { batchInsertCardTypes, batchInsertTokenNames } = await import('./scryfallCatalog.js');
        batchInsertCardTypes([
            { cardId: 'c1', type: 'Goblin', isToken: false },
            { cardId: 'c2', type: 'Treasure', isToken: true },
        ]);
        batchInsertTokenNames(['Gold']);
        expect(transaction).toHaveBeenCalled();
        expect(run).toHaveBeenCalledWith('c1', 'goblin', 0);
        expect(run).toHaveBeenCalledWith('c2', 'treasure', 1);
        expect(run).toHaveBeenCalledWith('gold');
    });

    it('ignores database errors and empty batch inputs', async () => {
        const dbModule = await import('../db/db.js');
        vi.mocked(dbModule.getDatabase).mockImplementation(() => { throw new Error('missing table'); });
        const { batchInsertCardTypes, batchInsertTokenNames } = await import('./scryfallCatalog.js');

        expect(isKnownToken('Treasure')).toBe(false);
        expect(() => insertTokenName('Treasure')).not.toThrow();
        expect(() => insertCardType('card', 'Creature', false)).not.toThrow();
        expect(() => batchInsertCardTypes([{ cardId: 'c1', type: 'Goblin', isToken: true }])).not.toThrow();
        expect(() => batchInsertTokenNames(['Gold'])).not.toThrow();
        expect(() => batchInsertCardTypes([])).not.toThrow();
        expect(() => batchInsertTokenNames([])).not.toThrow();
    });
});
