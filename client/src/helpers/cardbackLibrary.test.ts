import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { db } from '@/db';
import {
    getAllCardbacks,
    ensureBuiltinCardbacksInDb,
    BUILTIN_CARDBACKS,
    isCardbackId,
    invalidateCardbackUrl,
    revokeAllCardbackUrls,
    _resetCardbackState,
    type CardbackOption,
} from './cardbackLibrary';

describe('Cardback Library', () => {
    beforeEach(async () => {
        await db.cardbacks.clear();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        _resetCardbackState();
    });

    describe('BUILTIN_CARDBACKS', () => {
        it('should have at least one built-in cardback', () => {
            expect(BUILTIN_CARDBACKS.length).toBeGreaterThanOrEqual(1);
        });

        it('should have valid structure for each built-in cardback', () => {
            for (const cb of BUILTIN_CARDBACKS) {
                expect(cb.id).toBeDefined();
                expect(cb.name).toBeDefined();
                expect(cb.imageUrl).toBeDefined();
                expect(cb.source).toBe('builtin');
            }
        });

        it('should have IDs starting with cardback_builtin_', () => {
            for (const cb of BUILTIN_CARDBACKS) {
                expect(cb.id.startsWith('cardback_builtin_')).toBe(true);
            }
        });
    });

    describe('getAllCardbacks', () => {
        it('should include built-in cardbacks', async () => {
            // Pre-add builtin cardbacks to database
            for (const cardback of BUILTIN_CARDBACKS) {
                await db.cardbacks.add({
                    id: cardback.id,
                    sourceUrl: cardback.imageUrl,
                    hasBuiltInBleed: cardback.hasBuiltInBleed,
                });
            }

            const cardbacks = await getAllCardbacks();
            const builtinCardbacks = cardbacks.filter((c: CardbackOption) => c.source === 'builtin');
            expect(builtinCardbacks.length).toBeGreaterThanOrEqual(1);
        });

        it('should include uploaded cardbacks', async () => {
            // Add an uploaded cardback to the database (using cardback_ prefix)
            await db.cardbacks.add({
                id: 'cardback_uploaded_test1',
                sourceUrl: 'uploaded://cardback1.png',
            });

            const cardbacks = await getAllCardbacks();
            const uploadedCardback = cardbacks.find((c: CardbackOption) => c.id === 'cardback_uploaded_test1');

            expect(uploadedCardback).toBeDefined();
            expect(uploadedCardback?.source).toBe('uploaded');
        });

        it('should include MPC-imported cardbacks', async () => {
            // Add an MPC cardback (using cardback_ prefix)
            await db.cardbacks.add({
                id: 'cardback_mpc_abc123',
                sourceUrl: 'mpc://abc123',
                hasBuiltInBleed: true,
            });

            const cardbacks = await getAllCardbacks();
            const mpcCardback = cardbacks.find((c: CardbackOption) => c.id === 'cardback_mpc_abc123');

            expect(mpcCardback).toBeDefined();
            expect(mpcCardback?.source).toBe('uploaded'); // MPC cardbacks stored as uploaded
        });
    });

    describe('URL cache and mapping residual branches', () => {
        let objectUrlCounter = 0;

        beforeEach(() => {
            objectUrlCounter = 0;
            vi.stubGlobal('URL', {
                createObjectURL: vi.fn(() => `blob:${++objectUrlCounter}`),
                revokeObjectURL: vi.fn(),
            });
        });

        it('detects cardback ids by prefix', () => {
            expect(isCardbackId('cardback_uploaded_1')).toBe(true);
            expect(isCardbackId('image_1')).toBe(false);
        });

        it('maps blobs, cached URLs, fallback names, and sort order deterministically', async () => {
            const largeBuiltinBlob = new Blob([new Uint8Array(50_001)], { type: 'image/png' });
            await db.cardbacks.bulkAdd([
                { id: 'z-upload', sourceUrl: '', originalBlob: new Blob(['z'], { type: 'image/png' }) },
                { id: 'a-upload', sourceUrl: 'https://example.test/path/custom.png', displayBlob: new Blob(['a'], { type: 'image/png' }), hasBuiltInBleed: true },
                { id: BUILTIN_CARDBACKS[0].id, sourceUrl: BUILTIN_CARDBACKS[0].imageUrl, originalBlob: largeBuiltinBlob },
            ]);

            const first = await getAllCardbacks();
            const second = await getAllCardbacks();

            const ids = first.map((cardback) => cardback.id);
            expect(ids.indexOf(BUILTIN_CARDBACKS[0].id)).toBeLessThan(ids.indexOf('a-upload'));
            expect(ids.indexOf('a-upload')).toBeLessThan(ids.indexOf('z-upload'));
            expect(first.find((cardback) => cardback.id === BUILTIN_CARDBACKS[0].id)).toMatchObject({
                name: BUILTIN_CARDBACKS[0].name,
                source: 'builtin',
                imageUrl: expect.stringMatching(/^blob:/),
                hasBuiltInBleed: BUILTIN_CARDBACKS[0].hasBuiltInBleed,
            });
            expect(first.find((cardback) => cardback.id === 'a-upload')).toMatchObject({
                name: 'custom.png',
                imageUrl: expect.stringMatching(/^blob:/),
                source: 'uploaded',
                hasBuiltInBleed: true,
            });
            expect(first.find((cardback) => cardback.id === 'z-upload')).toMatchObject({
                name: 'Uploaded Cardback',
                imageUrl: expect.stringMatching(/^blob:/),
                source: 'uploaded',
                hasBuiltInBleed: false,
            });
            expect(second.find((cardback) => cardback.id === 'a-upload')?.imageUrl).toBe(first.find((cardback) => cardback.id === 'a-upload')?.imageUrl);
            expect(URL.createObjectURL).toHaveBeenCalledTimes(3);
        });

        it('fetches and stores valid builtin cardback blobs when missing', async () => {
            const largeBlob = new Blob([new Uint8Array(50_001)], { type: 'image/png' });
            vi.stubGlobal('fetch', vi.fn(async () => ({
                ok: true,
                blob: async () => largeBlob,
            })));

            await ensureBuiltinCardbacksInDb();

            expect(fetch).toHaveBeenCalledTimes(BUILTIN_CARDBACKS.filter((cardback) => cardback.id !== 'cardback_builtin_blank').length);
            const stored = await db.cardbacks.toArray();
            expect(stored).toHaveLength(BUILTIN_CARDBACKS.length);
            expect(stored.find((cardback) => cardback.id === 'cardback_builtin_blank')).toMatchObject({
                sourceUrl: '',
                hasBuiltInBleed: true,
            });
            expect(stored.find((cardback) => cardback.id === BUILTIN_CARDBACKS[0].id)).toMatchObject({
                originalBlob: largeBlob,
                displayBlob: undefined,
                exportBlob: undefined,
            });
        });

        it('invalidates one cached URL or revokes all cached URLs', async () => {
            await db.cardbacks.bulkAdd([
                { id: 'a-upload', sourceUrl: '', displayBlob: new Blob(['a'], { type: 'image/png' }) },
                { id: 'b-upload', sourceUrl: '', displayBlob: new Blob(['b'], { type: 'image/png' }) },
            ]);

            await getAllCardbacks();
            invalidateCardbackUrl('a-upload');
            invalidateCardbackUrl('missing');
            expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:1');

            revokeAllCardbackUrls();
            expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
        });
    });


    describe('builtin validation residual branches', () => {
        beforeEach(() => {
            vi.stubGlobal('URL', {
                createObjectURL: vi.fn(() => 'blob:test'),
                revokeObjectURL: vi.fn(),
            });
        });

        it('skips builtin cardbacks that already have valid original blobs', async () => {
            vi.spyOn(db.cardbacks, 'get').mockImplementation(async (id: string) => (
                id === BUILTIN_CARDBACKS[0].id
                    ? { id, originalBlob: { type: 'image/png', size: 50_001 } } as never
                    : undefined
            ));
            vi.stubGlobal('fetch', vi.fn(async () => ({
                ok: true,
                blob: async () => new Blob([new Uint8Array(50_001)], { type: 'image/png' }),
            })));

            await ensureBuiltinCardbacksInDb();

            expect(fetch).toHaveBeenCalledTimes(BUILTIN_CARDBACKS.filter((cardback) => cardback.id !== BUILTIN_CARDBACKS[0].id && cardback.id !== 'cardback_builtin_blank').length);
        });

        it('logs failed builtin fetch responses without aborting the ensure pass', async () => {
            const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
            vi.stubGlobal('fetch', vi.fn(async () => ({
                ok: false,
                status: 503,
                statusText: 'Unavailable',
                text: async () => { throw new Error('body unavailable'); },
            })));

            await ensureBuiltinCardbacksInDb();

            expect(errorSpy).toHaveBeenCalledWith(
                expect.stringContaining('Failed to store builtin cardback'),
                expect.any(Error)
            );
        });

        it('logs invalid builtin image blobs without storing them', async () => {
            const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
            vi.stubGlobal('fetch', vi.fn(async () => ({
                ok: true,
                blob: async () => ({ type: 'text/html', size: 9, text: async () => { throw new Error('blob text unavailable'); } }) as Blob,
            })));

            await ensureBuiltinCardbacksInDb();

            expect(errorSpy).toHaveBeenCalledWith(
                expect.stringContaining('Failed to store builtin cardback'),
                expect.any(Error)
            );
        });
    });
});
