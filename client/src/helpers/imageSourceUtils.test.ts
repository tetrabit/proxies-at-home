import { beforeEach, describe, it, expect, vi } from 'vitest';
import { inferImageSource, inferSourceFromUrl, getImageSource, getImageSourceSync, isMpcSource, isScryfallSource, isCustomSource } from './imageSourceUtils';

const { imagesGet, imagesUpdate } = vi.hoisted(() => ({
    imagesGet: vi.fn(),
    imagesUpdate: vi.fn(),
}));

vi.mock('../db', () => ({
    db: {
        images: {
            get: imagesGet,
            update: imagesUpdate,
        },
    },
}));

// Mock the mpcAutofillApi
vi.mock('./mpcAutofillApi', () => ({
    extractMpcIdentifierFromImageId: vi.fn((imageId: string) => {
        if (!imageId) return null;
        // Match URLs with MPC path
        if (imageId.includes('/api/cards/images/mpc')) {
            const match = imageId.match(/id=([^&]+)/);
            return match ? match[1] : null;
        }
        // Match bare MPC Drive IDs (15+ chars, alphanumeric with dashes/underscores)
        if (/^[a-zA-Z0-9_-]{15,}$/.test(imageId) && !/^[a-f0-9]{64}(-[a-z]+)?$/i.test(imageId)) {
            return imageId;
        }
        return null;
    }),
}));

describe('imageSourceUtils', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    describe('inferImageSource', () => {
        it('should return null for undefined/empty', () => {
            expect(inferImageSource(undefined)).toBeNull();
            expect(inferImageSource('')).toBeNull();
        });

        it('should detect cardback prefix', () => {
            expect(inferImageSource('cardback_123456')).toBe('cardback');
        });

        it('should detect scryfall prefix', () => {
            expect(inferImageSource('scryfall_abc123')).toBe('scryfall');
            expect(inferImageSource('local_something')).toBe('scryfall');
        });

        it('should detect custom upload SHA-256 hash', () => {
            const hash = 'a'.repeat(64);
            expect(inferImageSource(hash)).toBe('custom');
        });

        it('should detect custom upload hash with -mpc suffix', () => {
            const hashWithSuffix = 'a'.repeat(64) + '-mpc';
            expect(inferImageSource(hashWithSuffix)).toBe('custom');
        });

        it('should detect custom upload hash with -std suffix', () => {
            const hashWithSuffix = 'a'.repeat(64) + '-std';
            expect(inferImageSource(hashWithSuffix)).toBe('custom');
        });

        it('should detect scryfall URL', () => {
            expect(inferImageSource('https://cards.scryfall.io/png/front/a/1/abc.png')).toBe('scryfall');
        });

        it('should detect UUID as scryfall', () => {
            expect(inferImageSource('c83ed3e0-82d0-4410-a6ca-b0f923eadf83')).toBe('scryfall');
        });

        it('should detect MPC URL', () => {
            expect(inferImageSource('/api/cards/images/mpc?id=abc123')).toBe('mpc');
        });

        it('should detect bare MPC Drive ID', () => {
            // 33-char alphanumeric (typical Drive ID)
            const driveId = '1abc2DEF_-GhIjKlMnOpQrStUvWxYz123';
            expect(inferImageSource(driveId)).toBe('mpc');
        });

        it('should return null when no source pattern matches', () => {
            expect(inferImageSource('unknown')).toBeNull();
        });
    });

    describe('inferSourceFromUrl', () => {
        it('should return null for undefined/empty', () => {
            expect(inferSourceFromUrl(undefined)).toBeNull();
            expect(inferSourceFromUrl('')).toBeNull();
        });

        it('should detect scryfall URL', () => {
            expect(inferSourceFromUrl('https://cards.scryfall.io/png/front/a/1/abc.png')).toBe('scryfall');
        });

        it('should detect MPC URL', () => {
            expect(inferSourceFromUrl('/api/cards/images/mpc?id=abc123')).toBe('mpc');
        });

        it('should return null for unknown URLs', () => {
            expect(inferSourceFromUrl('https://example.com/image.png')).toBeNull();
        });
    });

    describe('getImageSource', () => {
        it('should return null when the image record does not exist', async () => {
            imagesGet.mockResolvedValue(undefined);

            await expect(getImageSource('missing')).resolves.toBeNull();

            expect(imagesUpdate).not.toHaveBeenCalled();
        });

        it('should return the explicit source without updating the image', async () => {
            imagesGet.mockResolvedValue({ id: 'img-explicit', source: 'custom' });

            await expect(getImageSource('img-explicit')).resolves.toBe('custom');

            expect(imagesUpdate).not.toHaveBeenCalled();
        });

        it('should infer and persist a missing source when possible', async () => {
            imagesGet.mockResolvedValue({ id: 'cardback_front' });

            await expect(getImageSource('cardback_front')).resolves.toBe('cardback');

            expect(imagesUpdate).toHaveBeenCalledWith('cardback_front', { source: 'cardback' });
        });

        it('should not update when a source cannot be inferred', async () => {
            imagesGet.mockResolvedValue({ id: 'unknown' });

            await expect(getImageSource('unknown')).resolves.toBeNull();

            expect(imagesUpdate).not.toHaveBeenCalled();
        });
    });

    describe('getImageSourceSync', () => {
        it('should return existing source if provided', () => {
            expect(getImageSourceSync('anything', 'mpc')).toBe('mpc');
            expect(getImageSourceSync('anything', 'scryfall')).toBe('scryfall');
        });

        it('should infer source if not provided', () => {
            const hash = 'a'.repeat(64);
            expect(getImageSourceSync(hash, undefined)).toBe('custom');
        });
    });

    describe('helper functions', () => {
        it('isMpcSource should return true only for mpc', () => {
            expect(isMpcSource('mpc')).toBe(true);
            expect(isMpcSource('scryfall')).toBe(false);
            expect(isMpcSource(null)).toBe(false);
        });

        it('isScryfallSource should return true only for scryfall', () => {
            expect(isScryfallSource('scryfall')).toBe(true);
            expect(isScryfallSource('mpc')).toBe(false);
            expect(isScryfallSource(null)).toBe(false);
        });

        it('isCustomSource should return true only for custom', () => {
            expect(isCustomSource('custom')).toBe(true);
            expect(isCustomSource('mpc')).toBe(false);
            expect(isCustomSource(null)).toBe(false);
        });
    });
});
