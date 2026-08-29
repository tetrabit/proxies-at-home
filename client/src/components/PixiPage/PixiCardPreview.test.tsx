import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";

const pixiState = vi.hoisted(() => ({
    app: null as null | {
        renderer: {
            render: ReturnType<typeof vi.fn>;
            extract: { pixels: ReturnType<typeof vi.fn> };
        };
    },
    containers: [] as Array<{ addChild: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn>; children: unknown[] }>,
    sprites: [] as Array<Record<string, unknown>>,
    renderTextures: [] as Array<{ width: number; height: number; destroy: ReturnType<typeof vi.fn> }>,
    textures: [] as Array<{ width: number; height: number; destroy: ReturnType<typeof vi.fn> }>,
    darkenFilters: [] as Array<Record<string, unknown>>,
    adjustmentFilters: [] as Array<Record<string, unknown>>,
}));

vi.mock("pixi.js", () => {
    class Container {
        label = "";
        children: unknown[] = [];
        addChild = vi.fn((child: unknown) => this.children.push(child));
        destroy = vi.fn();

        constructor() {
            pixiState.containers.push(this);
        }
    }

    class Sprite {
        label = "";
        width = 0;
        height = 0;
        x = 0;
        y = 0;
        texture: unknown = null;
        filters: unknown = null;

        constructor() {
            pixiState.sprites.push(this);
        }
    }

    const Texture = {
        from: vi.fn(() => {
            const texture = { width: 200, height: 100, destroy: vi.fn() };
            pixiState.textures.push(texture);
            return texture;
        }),
    };

    const RenderTexture = {
        create: vi.fn(({ width, height }: { width: number; height: number }) => {
            const renderTexture = { width, height, destroy: vi.fn() };
            pixiState.renderTextures.push(renderTexture);
            return renderTexture;
        }),
    };

    return { Container, Sprite, Texture, RenderTexture };
});

vi.mock("./filters", () => {
    class DarkenFilter {
        destroy = vi.fn();

        constructor() {
            pixiState.darkenFilters.push(this);
        }
    }

    class AdjustmentFilter {
        destroy = vi.fn();

        constructor() {
            pixiState.adjustmentFilters.push(this);
        }
    }

    return { DarkenFilter, AdjustmentFilter };
});

vi.mock("./pixiSingleton", () => ({
    getPixiApp: () => pixiState.app,
}));

vi.mock("./holoAnimation", () => ({
    calculateHoloAnimation: vi.fn(() => ({ angle: 90, strength: 75 })),
}));

const globalSettings = vi.hoisted(() => ({
    darkenMode: "contrast-full",
    darkenAutoDetect: true,
    darkenEdgeWidth: 0.2,
    darkenAmount: 0.8,
    darkenContrast: 1.5,
    darkenBrightness: -20,
}));

vi.mock("@/store/settings", () => {
    const useSettingsStore = Object.assign(
        (selector: (state: typeof globalSettings) => unknown) => selector(globalSettings),
        { getState: () => globalSettings },
    );
    return { useSettingsStore };
});

import { PixiCardPreview } from "./PixiCardPreview";
import { DEFAULT_RENDER_PARAMS, type RenderParams } from "../CardCanvas/types";

class MockImage {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    private source = "";

    set src(value: string) {
        this.source = value;
        queueMicrotask(() => this.onload?.());
    }

    get src() {
        return this.source;
    }
}

const baseParams: RenderParams = {
    ...DEFAULT_RENDER_PARAMS,
    darkenMode: "contrast-full",
    darkenUseGlobalSettings: false,
    darkenAutoDetect: true,
    brightness: 10,
    contrast: 1.2,
    saturation: 1.1,
    tintAmount: 0.25,
    holoEffect: "rainbow",
};

function installPixiApp() {
    pixiState.app = {
        renderer: {
            render: vi.fn(),
            extract: {
                pixels: vi.fn((target: { width: number; height: number }) => ({
                    pixels: new Uint8Array(target.width * target.height * 4),
                })),
            },
        },
    };
}

describe("PixiCardPreview", () => {
    beforeEach(() => {
        vi.useRealTimers();
        vi.clearAllMocks();
        cleanup();
        pixiState.app = null;
        pixiState.containers = [];
        pixiState.sprites = [];
        pixiState.renderTextures = [];
        pixiState.textures = [];
        pixiState.darkenFilters = [];
        pixiState.adjustmentFilters = [];
        globalSettings.darkenMode = "contrast-full";
        globalSettings.darkenAutoDetect = true;
        globalSettings.darkenEdgeWidth = 0.2;
        globalSettings.darkenAmount = 0.8;
        globalSettings.darkenContrast = 1.5;
        globalSettings.darkenBrightness = -20;

        vi.stubGlobal("Image", MockImage);
        vi.stubGlobal(
            "ImageData",
            class ImageData {
                data: Uint8ClampedArray;
                width: number;
                height: number;

                constructor(data: Uint8ClampedArray, width: number, height: number) {
                    this.data = data;
                    this.width = width;
                    this.height = height;
                }
            },
        );
        vi.stubGlobal("URL", {
            createObjectURL: vi.fn(() => "blob:preview"),
            revokeObjectURL: vi.fn(),
        });
        vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
            putImageData: vi.fn(),
        } as never);
    });

    afterEach(() => {
        cleanup();
        vi.useRealTimers();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it("renders a canvas and warns when the Pixi app is unavailable", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

        const { container } = render(
            <PixiCardPreview
                imageBlob={null}
                params={DEFAULT_RENDER_PARAMS}
                darknessFactor={0}
                width={90}
                height={120}
                className="preview-canvas"
                style={{ opacity: 0.5 }}
            />,
        );

        const canvas = container.querySelector("canvas") as HTMLCanvasElement;
        expect(canvas.width).toBe(90);
        expect(canvas.height).toBe(120);
        expect(canvas.className).toContain("preview-canvas");
        await waitFor(() => expect(warn).toHaveBeenCalledWith("[PixiCardPreview] PixiJS app not available"));
    });

    it("keeps repeated StrictMode dimensions stable without an image", async () => {
        installPixiApp();
        const { unmount } = render(
            <StrictMode>
                <PixiCardPreview
                    imageBlob={null}
                    params={DEFAULT_RENDER_PARAMS}
                    darknessFactor={0}
                    width={90}
                    height={120}
                />
            </StrictMode>,
        );

        await waitFor(() => expect(pixiState.renderTextures.length).toBeGreaterThan(0));
        unmount();
        expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    });

    it("loads a blob texture, applies filters, renders pixels, resizes, and cleans up", async () => {
        installPixiApp();

        const { rerender, unmount } = render(
            <PixiCardPreview
                imageBlob={new Blob(["front"])}
                params={baseParams}
                darknessFactor={0.4}
                width={100}
                height={100}
            />,
        );

        await waitFor(() => expect(pixiState.app?.renderer.render).toHaveBeenCalled());

        const sprite = pixiState.sprites[0];
        expect(pixiState.containers[0].addChild).toHaveBeenCalledWith(sprite);
        expect(sprite.width).toBe(100);
        expect(sprite.height).toBe(50);
        expect(sprite.x).toBe(0);
        expect(sprite.y).toBe(25);
        expect(sprite.filters).toHaveLength(2);
        expect(pixiState.darkenFilters[0]).toMatchObject({
            darkenMode: "contrast-full",
            darknessFactor: 0.4,
            darkenContrast: 2,
            darkenBrightness: -50,
        });
        expect(pixiState.adjustmentFilters[0]).toMatchObject({
            brightness: 10,
            contrast: 1.2,
            saturation: 1.1,
            tintAmount: 0.25,
            holoEffect: "rainbow",
        });

        rerender(
            <PixiCardPreview
                imageBlob={new Blob(["front"])}
                params={{ ...baseParams, darkenMode: "none", brightness: 0, contrast: 1, saturation: 1, tintAmount: 0, holoEffect: "none" }}
                darknessFactor={0.1}
                width={120}
                height={80}
            />,
        );

        await waitFor(() => expect(pixiState.renderTextures).toHaveLength(2));
        expect(pixiState.renderTextures[0].destroy).toHaveBeenCalled();

        unmount();
        expect(pixiState.textures.at(-1)?.destroy).toHaveBeenCalled();
        expect(pixiState.renderTextures.at(-1)?.destroy).toHaveBeenCalled();
        expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:preview");
        expect(pixiState.containers[0].destroy).toHaveBeenCalledWith({ children: true });
        expect(pixiState.darkenFilters[0].destroy).toHaveBeenCalled();
        expect(pixiState.adjustmentFilters[0].destroy).toHaveBeenCalled();
    });

    it("uses global darken values and handles missing apps, contexts, and render failures", async () => {
        installPixiApp();
        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
        const getContext = vi.spyOn(HTMLCanvasElement.prototype, "getContext");
        const globalParams = {
            ...baseParams,
            darkenUseGlobalSettings: true,
            holoEffect: "none" as const,
        };
        const blob = new Blob(["global"]);
        const { rerender } = render(
            <PixiCardPreview
                imageBlob={blob}
                params={globalParams}
                darknessFactor={0.3}
                width={100}
                height={100}
            />,
        );

        await waitFor(() => expect(pixiState.app?.renderer.render).toHaveBeenCalled());
        expect(pixiState.darkenFilters[0]).toMatchObject({
            darkenMode: "contrast-full",
            darkenContrast: 2,
            darkenBrightness: -50,
        });

        globalSettings.darkenAutoDetect = false;
        rerender(
            <PixiCardPreview
                imageBlob={blob}
                params={{ ...globalParams, gamma: 1.1 }}
                darknessFactor={0.3}
                width={100}
                height={100}
            />,
        );
        await waitFor(() => expect(pixiState.darkenFilters[0]).toMatchObject({
            darkenContrast: 1.5,
            darkenBrightness: -20,
        }));

        getContext.mockReturnValue(null);
        rerender(
            <PixiCardPreview
                imageBlob={blob}
                params={{ ...globalParams, gamma: 1.2 }}
                darknessFactor={0.3}
                width={100}
                height={100}
            />,
        );
        await act(async () => undefined);

        pixiState.app!.renderer.render.mockImplementationOnce(() => {
            throw new Error("render failed");
        });
        rerender(
            <PixiCardPreview
                imageBlob={blob}
                params={{ ...globalParams, gamma: 1.3 }}
                darknessFactor={0.3}
                width={100}
                height={100}
            />,
        );
        await waitFor(() => expect(warn).toHaveBeenCalledWith(
            "[PixiCardPreview] Render failed:",
            expect.any(Error),
        ));

        pixiState.app = null;
        rerender(
            <PixiCardPreview
                imageBlob={blob}
                params={globalParams}
                darknessFactor={0.3}
                width={101}
                height={100}
            />,
        );
        await act(async () => undefined);
    });

    it("advances and stops holographic preview animation", async () => {
        vi.useFakeTimers();
        installPixiApp();
        const { unmount } = render(
            <PixiCardPreview
                imageBlob={new Blob(["animated"])}
                params={{
                    ...baseParams,
                    holoAnimation: "wave",
                    holoSpeed: 4,
                    holoStrength: 60,
                }}
                darknessFactor={0.2}
                width={100}
                height={100}
            />,
        );

        await act(async () => {
            await Promise.resolve();
            await Promise.resolve();
        });
        act(() => vi.advanceTimersByTime(50));
        await act(async () => undefined);

        expect(pixiState.adjustmentFilters[0]).toMatchObject({
            holoAngle: 90,
            holoStrength: 75,
        });
        unmount();
    });

    it("reports image errors and ignores an image that loads after unmount", async () => {
        installPixiApp();
        const images: Array<{
            onload: (() => void) | null;
            onerror: (() => void) | null;
        }> = [];
        class ControlledImage {
            onload: (() => void) | null = null;
            onerror: (() => void) | null = null;
            set src(_value: string) {
                images.push(this);
            }
        }
        vi.stubGlobal("Image", ControlledImage);
        const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

        const first = render(
            <PixiCardPreview
                imageBlob={new Blob(["error"])}
                params={DEFAULT_RENDER_PARAMS}
                darknessFactor={0}
                width={90}
                height={120}
            />,
        );
        await waitFor(() => expect(images).toHaveLength(1));
        act(() => images[0].onerror?.());
        expect(error).toHaveBeenCalledWith("[PixiCardPreview] Failed to load image");
        first.unmount();

        const second = render(
            <PixiCardPreview
                imageBlob={new Blob(["late"])}
                params={DEFAULT_RENDER_PARAMS}
                darknessFactor={0}
                width={90}
                height={120}
            />,
        );
        await waitFor(() => expect(images).toHaveLength(2));
        second.unmount();
        act(() => images[1].onload?.());
        expect(pixiState.textures).toHaveLength(0);
    });
});
