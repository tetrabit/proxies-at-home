import { renderHook } from "@testing-library/react";
import { act } from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { useImageCache } from "./useImageCache";
import type { Image } from "../db";
import type { CardOption } from "../../../shared/types";

// Mock URL.createObjectURL and revokeObjectURL
const mockObjectUrls = new Map<Blob, string>();
let urlCounter = 0;

beforeEach(() => {
    mockObjectUrls.clear();
    urlCounter = 0;
    vi.useFakeTimers();

    global.URL.createObjectURL = vi.fn((blob: Blob) => {
        const url = `blob:test-${urlCounter++}`;
        mockObjectUrls.set(blob, url);
        return url;
    });

    global.URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
    vi.useRealTimers();
});

describe("useImageCache", () => {
    const createMockImage = (id: string, blobSize: number = 100): Image => ({
        id,
        displayBlob: new Blob([new Array(blobSize).fill('a').join('')]),
        displayBlobDarkened: new Blob([new Array(blobSize).fill('b').join('')]),
        refCount: 1,
    });

    describe("rendition freshness", () => {
        it("replaces the URL when a same-size display blob is replaced", () => {
            const image = createMockImage("img1", 100);
            const { result, rerender } = renderHook(
                ({ imgs, mode }) => useImageCache(imgs, mode),
                { initialProps: { imgs: [image], mode: 'none' as const } }
            );

            const firstUrl = result.current.processedImageUrls["img1"];
            const replacement: Image = {
                ...image,
                displayBlob: new Blob([new Array(100).fill('replacement').join('').slice(0, 100)]),
            };

            rerender({ imgs: [replacement], mode: 'none' as const });

            expect(result.current.processedImageUrls["img1"]).toBe("blob:test-1");
            expect(result.current.processedImageUrls["img1"]).not.toBe(firstUrl);
            expect(global.URL.createObjectURL).toHaveBeenCalledTimes(2);
        });

        it("should create new URL when blob size changes", () => {
            const image1 = createMockImage("img1", 100);
            const images: Image[] = [image1];

            const { result, rerender } = renderHook(
                ({ imgs, mode }) => useImageCache(imgs, mode),
                { initialProps: { imgs: images, mode: 'none' as const } }
            );

            const firstUrl = result.current.processedImageUrls["img1"];
            expect(global.URL.createObjectURL).toHaveBeenCalledTimes(1);

            // Change blob size - this should trigger new URL
            const changedImage: Image = {
                ...image1,
                displayBlob: new Blob([new Array(200).fill('a').join('')]), // Different size
            };

            rerender({ imgs: [changedImage], mode: 'none' as const });

            const secondUrl = result.current.processedImageUrls["img1"];

            expect(secondUrl).not.toBe(firstUrl);
            expect(global.URL.createObjectURL).toHaveBeenCalledTimes(2);
        });
    });

    describe("image deduplication", () => {
        it("keeps separate card renditions for different overrides of one image", () => {
            const image: Image = {
                id: "shared-image",
                displayBlob: new Blob(["normal"]),
                displayBlobDarkenAll: new Blob(["darkened"]),
                refCount: 2,
            };
            const cards: CardOption[] = [
                {
                    uuid: "normal-card",
                    name: "Shared image",
                    order: 1,
                    imageId: "shared-image",
                    isUserUpload: false,
                    overrides: { darkenMode: "none" },
                },
                {
                    uuid: "darkened-card",
                    name: "Shared image",
                    order: 2,
                    imageId: "shared-image",
                    isUserUpload: false,
                    overrides: { darkenMode: "darken-all" },
                },
            ];

            const { result } = renderHook(() => useImageCache([image], "none", cards));

            expect(result.current.processedImageUrls["normal-card"]).toBe("blob:test-0");
            expect(result.current.processedImageUrls["darkened-card"]).toBe("blob:test-1");
            expect(global.URL.createObjectURL).toHaveBeenCalledTimes(2);
        });

        it("should handle multiple images with same size blobs independently", () => {
            const image1 = createMockImage("img1", 100);
            const image2 = createMockImage("img2", 100);
            const images: Image[] = [image1, image2];

            const { result } = renderHook(
                ({ imgs, mode }) => useImageCache(imgs, mode),
                { initialProps: { imgs: images, mode: 'none' as const } }
            );

            expect(Object.keys(result.current.processedImageUrls)).toHaveLength(2);
            expect(result.current.processedImageUrls["img1"]).toBeDefined();
            expect(result.current.processedImageUrls["img2"]).toBeDefined();
            // Each should have unique URL even with same size
            expect(result.current.processedImageUrls["img1"]).not.toBe(
                result.current.processedImageUrls["img2"]
            );
        });
    });

    describe("darkenMode toggle", () => {
        it("should use correct blob based on darkenMode", () => {
            const image: Image = {
                id: "img1",
                displayBlob: new Blob([new Array(100).fill('a').join('')]),
                displayBlobContrastEdges: new Blob([new Array(150).fill('b').join('')]), // Different size
                refCount: 1,
            };

            type Props = { imgs: Image[]; mode: 'none' | 'darken-all' | 'contrast-edges' | 'contrast-full' };
            const { result, rerender } = renderHook(
                ({ imgs, mode }: Props) => useImageCache(imgs, mode),
                { initialProps: { imgs: [image], mode: 'none' } as Props }
            );

            const normalUrl = result.current.processedImageUrls["img1"];

            rerender({ imgs: [image], mode: 'contrast-edges' });

            const darkenedUrl = result.current.processedImageUrls["img1"];

            // Should be different URLs since different blobs are used
            expect(darkenedUrl).not.toBe(normalUrl);
        });
    });

    describe("cleanup", () => {
        it("revokes every owned URL when unmounted after a rendition replacement", async () => {
            const image = createMockImage("img1", 100);
            const { rerender, unmount } = renderHook(
                ({ imgs, mode }) => useImageCache(imgs, mode),
                { initialProps: { imgs: [image], mode: 'none' as const } }
            );

            rerender({
                imgs: [{
                    ...image,
                    displayBlob: new Blob([new Array(100).fill('replacement').join('').slice(0, 100)]),
                }],
                mode: 'none' as const,
            });
            unmount();

            await act(async () => {
                await vi.advanceTimersByTimeAsync(5000);
            });

            expect(global.URL.revokeObjectURL).toHaveBeenCalledTimes(2);
            expect(global.URL.revokeObjectURL).toHaveBeenCalledWith("blob:test-0");
            expect(global.URL.revokeObjectURL).toHaveBeenCalledWith("blob:test-1");
        });

        it("revokes a replaced URL once when its timer fires before rerender and unmount", async () => {
            const image = createMockImage("img1", 100);
            const replacement: Image = {
                ...image,
                displayBlob: new Blob(["replacement"]),
            };
            const { result, rerender, unmount } = renderHook(
                ({ imgs }) => useImageCache(imgs, "none"),
                { initialProps: { imgs: [image] } }
            );

            rerender({ imgs: [replacement] });
            const currentUrl = result.current.processedImageUrls["img1"];

            await act(async () => {
                await vi.advanceTimersByTimeAsync(2000);
            });
            expect(global.URL.revokeObjectURL).toHaveBeenCalledTimes(1);
            expect(global.URL.revokeObjectURL).toHaveBeenCalledWith("blob:test-0");
            expect(result.current.processedImageUrls["img1"]).toBe(currentUrl);

            rerender({ imgs: [...[replacement]] });
            expect(result.current.processedImageUrls["img1"]).toBe(currentUrl);

            unmount();
            await act(async () => {
                await vi.advanceTimersByTimeAsync(5000);
            });

            expect(global.URL.revokeObjectURL).toHaveBeenCalledTimes(2);
            expect(global.URL.revokeObjectURL).toHaveBeenNthCalledWith(1, "blob:test-0");
            expect(global.URL.revokeObjectURL).toHaveBeenNthCalledWith(2, currentUrl);
            expect(vi.getTimerCount()).toBe(0);
        });

        it("revokes a removed URL once when its timer fires before unmount", async () => {
            const image = createMockImage("img1", 100);
            const { rerender, unmount } = renderHook(
                ({ imgs }) => useImageCache(imgs, "none"),
                { initialProps: { imgs: [image] } }
            );

            rerender({ imgs: [] });
            await act(async () => {
                await vi.advanceTimersByTimeAsync(2000);
            });
            expect(global.URL.revokeObjectURL).toHaveBeenCalledTimes(1);
            expect(global.URL.revokeObjectURL).toHaveBeenCalledWith("blob:test-0");

            unmount();
            await act(async () => {
                await vi.advanceTimersByTimeAsync(5000);
            });

            expect(global.URL.revokeObjectURL).toHaveBeenCalledTimes(1);
            expect(vi.getTimerCount()).toBe(0);
        });
    });
});
