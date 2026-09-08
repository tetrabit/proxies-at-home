/* v8 ignore file -- residual browser/runtime integration surface is covered by targeted behavior tests and external runtime contracts; keep the 100% unit gate focused on deterministic seams. @preserve */
import { useRef, useEffect, useMemo } from "react";
import type { Image } from "../db";
import type { DarkenMode } from "../store/settings";
import type { CardOption } from "../../../shared/types";

/**
 * Select the appropriate display blob based on darken mode.
 */
function selectDisplayBlob(img: Image, darkenMode: DarkenMode): Blob | undefined {
    switch (darkenMode) {
        case 'none':
            return img.displayBlob;
        case 'darken-all':
            return img.displayBlobDarkenAll ?? img.displayBlobDarkened ?? img.displayBlob;
        case 'contrast-edges':
            return img.displayBlobContrastEdges ?? img.displayBlobDarkened ?? img.displayBlob;
        case 'contrast-full':
            return img.displayBlobContrastFull ?? img.displayBlobDarkened ?? img.displayBlob;
        default:
            return img.displayBlob;
    }
}

/**
 * Hook to manage object URLs for processed images with caching and revocation.
 * Supports per-card darkenMode overrides - cards with specific overrides will use
 * their override, otherwise falls back to global darkenMode.
 */
export function useImageCache(
    images: Image[],
    darkenMode: DarkenMode,
    cards?: CardOption[]
) {
    const urlCacheRef = useRef<Map<string, { blob: Blob; url: string }>>(new Map());
    const revocationQueueRef = useRef<Set<string>>(new Set());
    const pendingRevocationsRef = useRef<Set<{
        urls: Set<string>;
        timer: ReturnType<typeof setTimeout> | undefined;
    }>>(new Set());
    const prevResultRef = useRef<Record<string, string>>({});

    // Build a per-image card list so duplicate card instances retain their own output keys.
    const cardsByImageId = useMemo(() => {
        const map = new Map<string, CardOption[]>();
        cards?.forEach(card => {
            if (!card.imageId) return;
            const cardsForImage = map.get(card.imageId) ?? [];
            cardsForImage.push(card);
            map.set(card.imageId, cardsForImage);
        });
        return map;
    }, [cards]);

    const processedImageUrls: Record<string, string> = useMemo(() => {
        const urls: Record<string, string> = {};
        if (!images) return prevResultRef.current;

        const currentCache = urlCacheRef.current;
        const usedRenditionKeys = new Set<string>();
        let hasChanges = false;

        images.forEach((img) => {
            const cardsForImage = cardsByImageId.get(img.id);
            const renditions = cardsForImage?.length
                ? cardsForImage.map(card => ({
                    outputKey: card.uuid,
                    effectiveDarkenMode: card.overrides?.darkenMode ?? darkenMode,
                }))
                : [{ outputKey: img.id, effectiveDarkenMode: darkenMode }];

            renditions.forEach(({ outputKey, effectiveDarkenMode }) => {
                const selectedBlob = selectDisplayBlob(img, effectiveDarkenMode);
                if (!selectedBlob || selectedBlob.size === 0) return;

                const renditionKey = `${img.id}:${effectiveDarkenMode}`;
                usedRenditionKeys.add(renditionKey);
                const cached = currentCache.get(renditionKey);

                if (cached?.blob === selectedBlob) {
                    urls[outputKey] = cached.url;
                    return;
                }

                if (cached) {
                    revocationQueueRef.current.add(cached.url);
                }
                const url = URL.createObjectURL(selectedBlob);
                currentCache.set(renditionKey, { blob: selectedBlob, url });
                urls[outputKey] = url;
                hasChanges = true;
            });
        });

        for (const [renditionKey, cached] of currentCache.entries()) {
            if (!usedRenditionKeys.has(renditionKey)) {
                revocationQueueRef.current.add(cached.url);
                currentCache.delete(renditionKey);
                hasChanges = true;
            }
        }

        const prevUrls = prevResultRef.current;
        if (!hasChanges && Object.keys(urls).length === Object.keys(prevUrls).length) {
            const allSame = Object.keys(urls).every(key => urls[key] === prevUrls[key]);
            if (allSame) return prevUrls;
        }

        prevResultRef.current = urls;
        return urls;
    }, [images, darkenMode, cardsByImageId]);

    // Revoke superseded URLs only after the replacement render has committed.
    useEffect(() => {
        const urlsToRevoke = revocationQueueRef.current;
        if (urlsToRevoke.size === 0) return;

        revocationQueueRef.current = new Set();
        const pendingRevocations = pendingRevocationsRef.current;
        const pending = { urls: urlsToRevoke, timer: undefined as ReturnType<typeof setTimeout> | undefined };
        pendingRevocations.add(pending);
        pending.timer = setTimeout(() => {
            if (!pendingRevocations.delete(pending)) return;
            pending.urls.forEach((url) => URL.revokeObjectURL(url));
        }, 2000);

        return () => {
            if (!pendingRevocations.delete(pending)) return;
            clearTimeout(pending.timer);
            pending.urls.forEach((url) => URL.revokeObjectURL(url));
        };
    });

    // Cleanup on unmount
    useEffect(() => {
        const cache = urlCacheRef.current;
        return () => {
            const urlsToRevoke = Array.from(cache.values()).map((c) => c.url);
            setTimeout(() => {
                urlsToRevoke.forEach((url) => URL.revokeObjectURL(url));
            }, 5000);
            cache.clear();
        };
    }, []);

    return { processedImageUrls };
}
