import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { db } from '@/db';
import { getAllCardbacks, BUILTIN_CARDBACKS, isCardbackId, invalidateCardbackUrl, revokeAllCardbackUrls, _resetCardbackState, type CardbackOption } from './cardbackLibrary';

describe('Cardback Library', () => {
    beforeEach(async () => {
        await db.cardbacks.clear();
    

    describe('URL cache and mapping residual branches', () => {
        beforeEach(() => {
            vi.stubGlobal('URL', {
                createObjectURL: vi.fn((blob: Blob) => `blob:${blob.size}:${blob.type || 'none'}`),
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

            expect(first.map((cardback) => cardback.id).slice(0, 3)).toEqual([
                BUILTIN_CARDBACKS[0].id,
                'a-upload',
                'z-upload',
            ]);
            expect(first.find((cardback) => cardback.id === BUILTIN_CARDBACKS[0].id)).toMatchObject({
                name: BUILTIN_CARDBACKS[0].name,
                source: 'builtin',
                imageUrl: 'blob:50001:image/png',
                hasBuiltInBleed: BUILTIN_CARDBACKS[0].hasBuiltInBleed,
            });
            expect(first.find((cardback) => cardback.id === 'a-upload')).toMatchObject({
                name: 'custom.png',
                imageUrl: 'blob:1:image/png',
                source: 'uploaded',
                hasBuiltInBleed: true,
            });
            expect(first.find((cardback) => cardback.id === 'z-upload')).toMatchObject({
                name: 'Uploaded Cardback',
                imageUrl: 'blob:1:image/png',
                source: 'uploaded',
                hasBuiltInBleed: false,
            });
            expect(second.find((cardback) => cardback.id === 'a-upload')?.imageUrl).toBe('blob:1:image/png');
            expect(URL.createObjectURL).toHaveBeenCalledTimes(3);
        });

        it('invalidates one cached URL or revokes all cached URLs', async () => {
            await db.cardbacks.bulkAdd([
                { id: 'a-upload', sourceUrl: '', displayBlob: new Blob(['a'], { type: 'image/png' }) },
                { id: 'b-upload', sourceUrl: '', displayBlob: new Blob(['b'], { type: 'image/png' }) },
            ]);

            await getAllCardbacks();
            invalidateCardbackUrl('a-upload');
            invalidateCardbackUrl('missing');
            expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:1:image/png');

            revokeAllCardbackUrls();
            expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
        });
    });
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
});
