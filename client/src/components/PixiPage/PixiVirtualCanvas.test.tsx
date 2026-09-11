import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StrictMode } from "react";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import type { CardOption } from "../../../../shared/types";
import type { CardWithGlobalLayout, PageLayoutInfo } from "./PixiVirtualCanvas";

type PixiTestState = {
  apps: Array<Record<string, unknown>>;
  containers: Array<Record<string, unknown>>;
  graphics: Array<Record<string, unknown>>;
  sprites: Array<Record<string, unknown>>;
  textures: Array<{ id: string; destroy: unknown }>;
  initShouldFail: boolean;
  Application?: new () => Record<string, unknown>;
  Container?: new () => Record<string, unknown>;
};

type FilterTestState = {
  darken: Array<Record<string, unknown>>;
  adjustment: Array<Record<string, unknown>>;
};

type GuideHookState = {
  page: unknown[];
  perCard: unknown[];
  registration: unknown[];
};

const mockState = {
  pixi: {
    apps: [],
    containers: [],
    graphics: [],
    sprites: [],
    textures: [],
    initShouldFail: false,
  } as PixiTestState,
  filters: { darken: [], adjustment: [] } as FilterTestState,
  guides: { page: [], perCard: [], registration: [] } as GuideHookState,
};

function guideHookState(): GuideHookState {
  return mockState.guides;
}

function pixiState(): PixiTestState {
  return mockState.pixi;
}

function filterState(): FilterTestState {
  return mockState.filters;
}

vi.doMock("pixi.js", () => {
  const state = mockState.pixi;

  class Container {
    label = "";
    children: unknown[] = [];
    y = 0;
    scale = { set: vi.fn() };
    addChild = vi.fn((child: unknown) => this.children.push(child));
    removeChild = vi.fn((child: unknown) => {
      this.children = this.children.filter((existing) => existing !== child);
    });
    destroy = vi.fn();

    constructor() {
      state.containers.push(this as unknown as Record<string, unknown>);
    }
  }

  class Graphics extends Container {
    clear = vi.fn();
    rect = vi.fn();
    fill = vi.fn();

    constructor() {
      super();
      state.graphics.push(this as unknown as Record<string, unknown>);
    }
  }

  class Sprite {
    x = 0;
    y = 0;
    width = 0;
    height = 0;
    visible = true;
    tint = 0;
    filters: unknown = null;
    texture: unknown;
    destroy = vi.fn();

    constructor(texture: unknown) {
      this.texture = texture;
      state.sprites.push(this as unknown as Record<string, unknown>);
    }
  }

  class Application {
    stage = new Container();
    ticker = { stop: vi.fn() };
    renderer = { resize: vi.fn() };
    render = vi.fn();
    destroy = vi.fn();
    init = vi.fn(async () => {
      if (state.initShouldFail) throw new Error("no webgl");
    });

    constructor() {
      state.apps.push(this as unknown as Record<string, unknown>);
    }
  }

  state.Application = Application as unknown as new () => Record<string, unknown>;
  state.Container = Container as unknown as new () => Record<string, unknown>;

  return {
    Application,
    Container,
    Graphics,
    Sprite,
    Texture: {
      WHITE: { id: "white", destroy: vi.fn() },
      from: vi.fn(() => {
        const texture = {
          id: `texture-${state.textures.length}`,
          destroy: vi.fn(),
        };
        state.textures.push(texture);
        return texture;
      }),
    },
  };
});

vi.doMock("./filters", () => {
  class Filter {
    [key: string]: unknown;
    destroy = vi.fn();
  }
  return {
    DarkenFilter: class DarkenFilter extends Filter {
      constructor() {
        super();
        filterState().darken.push(this as unknown as Record<string, unknown>);
      }
    },
    AdjustmentFilter: class AdjustmentFilter extends Filter {
      constructor() {
        super();
        filterState().adjustment.push(this as unknown as Record<string, unknown>);
      }
    },
  };
});

vi.doMock("./usePageGuides", () => ({
  usePageGuides: (args: unknown) => mockState.guides.page.push(args),
}));
vi.doMock("./usePerCardGuides", () => ({
  usePerCardGuides: (args: unknown) => mockState.guides.perCard.push(args),
}));
vi.doMock("./useRegistrationMarks", () => ({
  useRegistrationMarks: (args: unknown) => mockState.guides.registration.push(args),
}));

vi.doMock("../../store/settings", () => {
  const settings = {
    darkenContrast: 1.2,
    darkenEdgeWidth: 0.2,
    darkenAmount: 0.8,
    darkenBrightness: -10,
    darkenAutoDetect: true,
  };
  return { useSettingsStore: (selector: (state: typeof settings) => unknown) => selector(settings) };
});

const { default: PixiVirtualCanvas } = await import("./PixiVirtualCanvas");
const { pixiSingleton, resetPixiSingleton, setPixiApp, getPixiApp } = await import("./pixiSingleton");
const { RENDITION_IDENTITY_CHUNK_BYTES } = await import("./renditionIdentity");

class MockImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  set src(_value: string) {
    queueMicrotask(() => this.onload?.());
  }
}

const pages: PageLayoutInfo[] = [
  { pageIndex: 0, pageWidthPx: 200, pageHeightPx: 300, pageYOffset: 10 },
  { pageIndex: 1, pageWidthPx: 200, pageHeightPx: 300, pageYOffset: 330 },
];

function card(overrides: Partial<CardWithGlobalLayout> = {}): CardWithGlobalLayout {
  const baseCard: CardOption = {
    uuid: "card-1",
    name: "Card 1",
    order: 10,
    imageId: "front-1",
    isUserUpload: false,
    overrides: { brightness: 5, darkenMode: "contrast-full", holoEffect: "rainbow" },
  };

  return {
    card: baseCard,
    imageBlob: new Blob(["front"]),
    backBlob: new Blob(["back"]),
    frontImageId: "front-1",
    backImageId: "back-1",
    backOverrides: { saturation: 1.5 },
    darknessFactor: 0.4,
    globalX: 12,
    globalY: 20,
    width: 63,
    height: 88,
    bleedMm: 1,
    baseCardWidthMm: 63,
    baseCardHeightMm: 88,
    overridesHash: "front-hash",
    backOverridesHash: "back-hash",
    ...overrides,
  };
}

function canvasElement(overrides: Partial<React.ComponentProps<typeof PixiVirtualCanvas>> = {}) {
  return (
    <PixiVirtualCanvas
      cards={[card()]}
      pages={pages}
      viewportWidth={320}
      viewportHeight={240}
      scrollTop={0}
      scrollContainerRef={{ current: null }}
      zoom={1}
      globalDarkenMode="none"
      flippedCards={new Set()}
      activeId={null}
      guideWidth={1}
      cutLineStyle="full"
      perCardGuideStyle="solid-rounded-rect"
      perCardGuideColor={0xff00ff}
      perCardGuidePlacement="inside"
      showGuideLinesOnBackCards={false}
      cutGuideLengthMm={3}
      registrationMarks="4"
      registrationMarksPortrait
      isDarkMode={false}
      onRenderedCardsChange={vi.fn()}
      className="pixi-test"
      style={{ opacity: 0.5 }}
      {...overrides}
    />
  );
}

function renderCanvas(overrides: Partial<React.ComponentProps<typeof PixiVirtualCanvas>> = {}) {
  const scrollHost = document.createElement("div");
  scrollHost.scrollTop = 17;
  const scrollRef = { current: scrollHost };

  return render(canvasElement({ scrollContainerRef: scrollRef, ...overrides }));
}

describe("PixiVirtualCanvas", () => {
  beforeEach(() => {
    vi.useRealTimers();
    cleanup();
    const state = pixiState();
    state.apps = [];
    state.containers = [];
    state.graphics = [];
    state.sprites = [];
    state.textures = [];
    state.initShouldFail = false;
    const filters = filterState();
    filters.darken = [];
    filters.adjustment = [];
    const hooks = guideHookState();
    hooks.page = [];
    hooks.perCard = [];
    hooks.registration = [];
    vi.clearAllMocks();
    vi.stubGlobal("Image", MockImage);
    vi.stubGlobal("URL", {
      createObjectURL: vi.fn((blob: Blob) => `blob:${blob.size}:${Math.random()}`),
      revokeObjectURL: vi.fn(),
    });
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false })));
    resetPixiSingleton();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    resetPixiSingleton();
    vi.unstubAllGlobals();
  });

  it("drops stale asynchronous texture passes and releases their blob URLs", async () => {
    const pendingImages: Array<{
      onload: (() => void) | null;
      onerror: (() => void) | null;
    }> = [];
    class ControlledImage {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_value: string) {
        pendingImages.push(this);
      }
    }
    vi.stubGlobal("Image", ControlledImage);
    const stable = card();
    stable.card = {
      ...stable.card,
      overrides: { ...stable.card.overrides, holoEffect: "none" },
    };
    const second = card({
      card: { ...stable.card, uuid: "card-2" },
      frontImageId: "front-2",
      backImageId: "back-2",
    });
    const { rerender } = renderCanvas({ cards: [stable, second] });
    await waitFor(() => expect(pendingImages.length).toBeGreaterThan(0));
    const initialCount = pendingImages.length;

    rerender(canvasElement({ cards: [{ ...stable, globalX: 13 }, second] }));
    await waitFor(() => expect(pendingImages.length).toBeGreaterThan(initialCount));
    const currentFrontIndex = pendingImages.length - 1;
    for (let index = 0; index < initialCount; index += 1) {
      await act(async () => pendingImages[index].onload?.());
    }
    await act(async () => pendingImages[currentFrontIndex].onload?.());
    await waitFor(() => expect(pendingImages.length).toBeGreaterThan(currentFrontIndex + 1));
    const staleBackIndex = pendingImages.length - 1;

    rerender(canvasElement({ cards: [{ ...stable, globalX: 14 }, second] }));
    await waitFor(() => expect(pendingImages.length).toBeGreaterThan(staleBackIndex + 1));
    await act(async () => pendingImages[staleBackIndex].onload?.());

    expect(URL.createObjectURL).toHaveBeenCalledTimes(4);
  });

  it("keeps equivalent re-deserialized blobs, but safely replaces same-size changed content", async () => {
    const pendingImages: Array<{
      onload: (() => void) | null;
      onerror: (() => void) | null;
    }> = [];
    class ControlledImage {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_value: string) {
        pendingImages.push(this);
      }
    }
    vi.stubGlobal("Image", ControlledImage);
    let urlIndex = 0;
    vi.stubGlobal("URL", {
      createObjectURL: vi.fn(() => `blob:rendition-${urlIndex++}`),
      revokeObjectURL: vi.fn(),
    });
    const edge = new Uint8Array(RENDITION_IDENTITY_CHUNK_BYTES).fill(7);
    const fullContentBlob = (middleByte: number) => new Blob([
      edge,
      new Uint8Array(RENDITION_IDENTITY_CHUNK_BYTES).fill(middleByte),
      edge,
    ]);
    const initial = card({
      imageBlob: fullContentBlob(11),
      backBlob: new Blob(["back-a"]),
      card: {
        ...card().card,
        overrides: { holoEffect: "none" },
      },
    });
    const { rerender } = renderCanvas({ cards: [initial] });

    await waitFor(() => expect(pendingImages.length).toBeGreaterThan(0));
    const initialFrontCount = pendingImages.length;
    for (let index = 0; index < initialFrontCount; index += 1) {
      await act(async () => pendingImages[index].onload?.());
    }
    await waitFor(() => expect(pendingImages.length).toBeGreaterThan(initialFrontCount));
    await act(async () => pendingImages.at(-1)?.onload?.());
    await waitFor(() => expect(pixiState().textures).toHaveLength(2));
    const oldFrontTexture = pixiState().textures[0];
    const oldFrontUrl = (URL.createObjectURL as ReturnType<typeof vi.fn>).mock.results[initialFrontCount - 1].value;
    const oldBackUrl = (URL.createObjectURL as ReturnType<typeof vi.fn>).mock.results.at(-1)!.value;

    rerender(canvasElement({
      cards: [{ ...initial, imageBlob: fullContentBlob(11), backBlob: new Blob(["back-a"]) }],
    }));
    await act(async () => undefined);
    expect(pixiState().textures).toHaveLength(2);

    const changedStart = pendingImages.length;
    rerender(canvasElement({
      cards: [{ ...initial, imageBlob: fullContentBlob(12), backBlob: new Blob(["back-a"]) }],
    }));
    await waitFor(() => expect(pendingImages.length).toBeGreaterThan(changedStart));
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith(oldFrontUrl);
    expect(oldFrontTexture.destroy).not.toHaveBeenCalled();

    await act(async () => pendingImages[changedStart].onload?.());
    await waitFor(() => expect(pendingImages.length).toBeGreaterThan(changedStart + 1));
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith(oldFrontUrl);

    await act(async () => pendingImages.at(-1)?.onload?.());
    await waitFor(() => expect(pixiState().textures).toHaveLength(4));
    expect(oldFrontTexture.destroy).toHaveBeenCalled();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(oldFrontUrl);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(oldBackUrl);
  });

  it("bounds offscreen sprite allocation and evicts existing offscreen cards", async () => {
    const state = pixiState();
    const makeVirtualCard = (index: number, globalY: number) => {
      const value = card({
        card: {
          ...card().card,
          uuid: `virtual-${index}`,
          overrides: undefined,
        },
        imageBlob: undefined,
        backBlob: undefined,
        frontImageId: `virtual-front-${index}`,
        backImageId: undefined,
        globalY,
      });
      return value;
    };
    const farCards = Array.from({ length: 38 }, (_, index) =>
      makeVirtualCard(index, 10_000),
    );
    const { rerender } = renderCanvas({ cards: farCards });

    await waitFor(() => expect(state.sprites).toHaveLength(36));

    const visibleCards = farCards.map((value, index) =>
      index >= 36 ? { ...value, globalY: 0 } : value,
    );
    rerender(canvasElement({ cards: visibleCards }));
    await waitFor(() => expect(state.sprites).toHaveLength(38));

    const cardsContainer = state.containers.find(
      (container) => container.label === "cards-container",
    )!;
    (cardsContainer.removeChild as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error("remove failed");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    rerender(canvasElement({ cards: visibleCards.slice(0, -1) }));

    await waitFor(() => expect(warn).toHaveBeenCalledWith(
      "[PixiVirtualCanvas] Error removing sprite:",
      expect.any(Error),
    ));
    rerender(canvasElement({ cards: farCards }));
    await act(async () => undefined);
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it("updates existing sprites across flip, drag, drop, clipping, and resize failures", async () => {
    const state = pixiState();
    const stableCard = card();
    stableCard.card = {
      ...stableCard.card,
      overrides: { ...stableCard.card.overrides, holoEffect: "none" },
    };
    const scrollHost = document.createElement("div");
    scrollHost.scrollTop = 0;
    const scrollRef = { current: scrollHost };
    const view = (overrides: Partial<React.ComponentProps<typeof PixiVirtualCanvas>> = {}) => (
      <PixiVirtualCanvas
        cards={[stableCard]}
        pages={pages}
        viewportWidth={320}
        viewportHeight={240}
        scrollTop={0}
        scrollContainerRef={scrollRef}
        zoom={1}
        globalDarkenMode="none"
        flippedCards={new Set()}
        activeId={null}
        guideWidth={1}
        cutLineStyle="full"
        perCardGuideStyle="solid-rounded-rect"
        perCardGuideColor={0xff00ff}
        perCardGuidePlacement="inside"
        showGuideLinesOnBackCards
        cutGuideLengthMm={3}
        registrationMarks="4"
        registrationMarksPortrait
        isDarkMode={false}
        onRenderedCardsChange={vi.fn()}
        {...overrides}
      />
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { rerender } = render(view());

    await waitFor(() => expect(state.sprites).toHaveLength(1));
    const sprite = state.sprites[0];
    rerender(view({ flippedCards: new Set(["card-1"]) }));
    await waitFor(() => expect(sprite.texture).toBe(state.textures[1]));

    rerender(view({ activeId: "card-1" }));
    await waitFor(() => expect(sprite.visible).toBe(false));
    rerender(view({ activeId: null }));
    await waitFor(() => expect(sprite.visible).toBe(false));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 220));
    });
    await waitFor(() => expect(sprite.visible).toBe(true));

    scrollHost.scrollTop = 50;
    rerender(view({ scrollTop: 50 }));
    await waitFor(() => expect(
      (filterState().adjustment[0].holoUvOffset as number[])[1],
    ).toBeGreaterThan(0));

    ((state.apps[0].renderer as { resize: ReturnType<typeof vi.fn> }).resize).mockImplementationOnce(() => {
      throw new Error("resize failed");
    });
    rerender(view({ viewportWidth: 321 }));
    await waitFor(() => expect(warn).toHaveBeenCalledWith(
      "[PixiVirtualCanvas] Resize failed:",
      expect.any(Error),
    ));

    (state.apps[0].render as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error("render failed");
    });
    rerender(view({ viewportWidth: 321, globalDarkenMode: "darken-all" }));
    await waitFor(() => expect(warn).toHaveBeenCalledWith(
      "[PixiVirtualCanvas] Render failed:",
      expect.any(Error),
    ));
  });

  it("animates holographic cards with default motion settings", async () => {
    const animated = card();
    animated.card = {
      ...animated.card,
      overrides: {
        holoEffect: "rainbow",
        holoAnimation: "wave",
      },
    };
    renderCanvas({ cards: [animated] });

    await waitFor(() => expect(filterState().adjustment[0]).toBeDefined());
    expect(pixiState().apps[0]?.render).toHaveBeenCalled();
  });

  it("ticks holographic cards that have no automatic animation", async () => {
    vi.useFakeTimers();
    renderCanvas({ cards: [card()] });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    act(() => vi.advanceTimersByTime(50));
    await act(async () => undefined);

    expect(pixiState().apps[0]?.render).toHaveBeenCalled();
  });

  it("initializes the singleton app, paints pages, syncs scroll, renders sprites, and cleans up resources", async () => {
    const state = pixiState();
    const onRenderedCardsChange = vi.fn();
    const scrollHost = document.createElement("div");
    scrollHost.scrollTop = 23;
    const { rerender, unmount, getByTestId } = renderCanvas({
      scrollContainerRef: { current: scrollHost },
      onRenderedCardsChange,
    });

    const canvas = getByTestId("pixi-virtual-canvas") as HTMLCanvasElement;
    expect(canvas.width).toBe(320);
    expect(canvas.height).toBe(240);
    expect(canvas.className).toContain("pixi-test");

    await waitFor(() => expect(state.apps[0]?.init).toHaveBeenCalled());
    await waitFor(() => expect(state.graphics.length).toBeGreaterThanOrEqual(2));
    await waitFor(() => expect(state.sprites.length).toBe(1));
    await waitFor(() => expect(onRenderedCardsChange).toHaveBeenCalledWith(new Set(["card-1"])));

    expect(state.apps[0].ticker.stop).toHaveBeenCalled();
    expect(pixiSingleton.app).toBe(state.apps[0]);
    expect(guideHookState().page.at(-1)).toEqual(expect.objectContaining({ cutLineStyle: "full" }));
    expect(guideHookState().perCard.at(-1)).toEqual(expect.objectContaining({ guideStyle: "solid-rounded-rect" }));
    expect(guideHookState().registration.at(-1)).toEqual(expect.objectContaining({ registrationMarks: "4" }));

    scrollHost.dispatchEvent(new Event("scroll"));
    expect(state.apps[0].render).toHaveBeenCalled();

    rerender(
      <PixiVirtualCanvas
        cards={[card({ frontImageId: "front-2", imageBlob: new Blob(["changed"]), overridesHash: "changed" })]}
        pages={[pages[0]]}
        viewportWidth={400}
        viewportHeight={260}
        scrollTop={10}
        scrollContainerRef={{ current: scrollHost }}
        zoom={2}
        globalDarkenMode="contrast-full"
        flippedCards={new Set(["card-1"])}
        activeId={null}
        guideWidth={2}
        cutLineStyle="edges"
        perCardGuideStyle="corners"
        perCardGuideColor={0x00ff00}
        perCardGuidePlacement="outside"
        showGuideLinesOnBackCards={false}
        cutGuideLengthMm={4}
        registrationMarks="3"
        registrationMarksPortrait={false}
        isDarkMode
        onRenderedCardsChange={onRenderedCardsChange}
      />,
    );

    await waitFor(() => expect(state.apps[0].renderer.resize).toHaveBeenCalledWith(400, 260));
    await waitFor(() => expect(state.sprites.length).toBeGreaterThanOrEqual(2));
    expect(URL.revokeObjectURL).toHaveBeenCalled();

    unmount();
    expect(state.sprites.at(-1)?.destroy).toHaveBeenCalled();
    expect(state.apps[0].destroy).not.toHaveBeenCalled();
    expect(pixiSingleton.app).toBe(state.apps[0]);
  });

  it("covers placeholders, blank backs, active-card hiding, failed texture loads, and empty-guide fallbacks", async () => {
    const state = pixiState();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    class ErrorImage {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_value: string) {
        queueMicrotask(() => this.onerror?.());
      }
    }
    vi.stubGlobal("Image", ErrorImage);

    const hiddenCard = card({ card: { ...card().card, uuid: "active-card" }, imageBlob: undefined, backBlob: undefined });
    const blankBackCard = card({
      card: { ...card().card, uuid: "blank-card" },
      backImageId: "cardback_builtin_blank",
      imageBlob: undefined,
      backBlob: undefined,
    });
    const failingCard = card({ card: { ...card().card, uuid: "failing-card" }, imageBlob: new Blob(["bad"]) });

    renderCanvas({
      cards: [hiddenCard, blankBackCard, failingCard],
      activeId: "active-card",
      flippedCards: new Set(["blank-card"]),
      showGuideLinesOnBackCards: false,
      onRenderedCardsChange: vi.fn(),
    });

    await waitFor(() => expect(state.apps[0]?.init).toHaveBeenCalled());
    await waitFor(() => expect(state.sprites.length).toBeGreaterThanOrEqual(1));
    await waitFor(() => expect(warn).toHaveBeenCalledWith("[PixiVirtualCanvas] Failed to create texture:", expect.any(Error)));
    expect(guideHookState().page.at(-1)).toEqual(expect.objectContaining({ cutLineStyle: "full" }));

    cleanup();
    resetPixiSingleton();
    renderCanvas({ cards: [], showGuideLinesOnBackCards: false });
    await waitFor(() => expect(guideHookState().page.at(-1)).toEqual(expect.objectContaining({ cutLineStyle: "none" })));
    expect(guideHookState().perCard.at(-1)).toEqual(expect.objectContaining({ guideStyle: "none" }));
    expect(guideHookState().registration.at(-1)).toEqual(expect.objectContaining({ registrationMarks: "none" }));
  });

  it("keeps a flipped card hidden when its back texture fails", async () => {
    const pendingImages: Array<{
      onload: (() => void) | null;
      onerror: (() => void) | null;
    }> = [];
    class FrontOnlyImage {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_value: string) {
        pendingImages.push(this);
      }
    }
    vi.stubGlobal("Image", FrontOnlyImage);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const onRenderedCardsChange = vi.fn();
    const flipped = card({ backOverrides: undefined });
    flipped.card = {
      ...flipped.card,
      overrides: { ...flipped.card.overrides, holoEffect: "none" },
    };
    renderCanvas({
      cards: [flipped],
      flippedCards: new Set(["card-1"]),
      onRenderedCardsChange,
    });

    await waitFor(() => expect(pendingImages.length).toBeGreaterThan(0));
    const currentFrontIndex = pendingImages.length - 1;
    for (let index = 0; index < currentFrontIndex; index += 1) {
      await act(async () => pendingImages[index].onload?.());
    }
    await act(async () => pendingImages[currentFrontIndex].onload?.());
    await waitFor(() => expect(pendingImages.length).toBeGreaterThan(currentFrontIndex + 1));
    await act(async () => pendingImages.at(-1)?.onerror?.());

    await waitFor(() => expect(warn).toHaveBeenCalledWith(
      "[PixiVirtualCanvas] Failed to create texture:",
      expect.any(Error),
    ));
    await waitFor(() => expect(pixiState().sprites).toHaveLength(1));
    expect(pixiState().sprites[0].visible).toBe(false);
    expect(onRenderedCardsChange).toHaveBeenCalledWith(new Set());
  });

  it("attaches after an in-flight singleton initialization completes", async () => {
    const state = pixiState();
    let resolveInit: () => void = () => undefined;
    pixiSingleton.isInitializing = true;
    pixiSingleton.initPromise = new Promise<void>((resolve) => {
      resolveInit = resolve;
    });
    const first = renderCanvas({ zoom: 1.75 });
    await act(async () => undefined);

    const app = new state.Application!();
    const world = new state.Container!();
    pixiSingleton.app = app as never;
    pixiSingleton.worldContainer = world as never;
    pixiSingleton.pagesContainer = new state.Container!() as never;
    pixiSingleton.cardsContainer = new state.Container!() as never;
    pixiSingleton.guidesContainer = new state.Container!() as never;
    await act(async () => resolveInit());
    await waitFor(() => expect(
      (world.scale as { set: ReturnType<typeof vi.fn> }).set,
    ).toHaveBeenCalledWith(1.75));
    first.unmount();

    cleanup();
    resetPixiSingleton();
    let resolveUnmountedInit: () => void = () => undefined;
    pixiSingleton.isInitializing = true;
    pixiSingleton.initPromise = new Promise<void>((resolve) => {
      resolveUnmountedInit = resolve;
    });
    const unmountedWaiter = renderCanvas({ zoom: 2 });
    unmountedWaiter.unmount();
    const unmountedApp = new state.Application!();
    const unmountedWorld = new state.Container!();
    pixiSingleton.app = unmountedApp as never;
    pixiSingleton.worldContainer = unmountedWorld as never;
    pixiSingleton.pagesContainer = new state.Container!() as never;
    pixiSingleton.cardsContainer = new state.Container!() as never;
    pixiSingleton.guidesContainer = new state.Container!() as never;
    await act(async () => resolveUnmountedInit());
    expect(
      (unmountedWorld.scale as { set: ReturnType<typeof vi.fn> }).set,
    ).not.toHaveBeenCalled();
    expect(unmountedApp.destroy).not.toHaveBeenCalled();
    expect(pixiSingleton.app).toBe(unmountedApp);
  });

  it("handles singleton states without a world, promise, or valid stage", async () => {
    const state = pixiState();
    const existing = new state.Application!();
    pixiSingleton.app = existing as never;
    pixiSingleton.worldContainer = null;
    const first = renderCanvas();
    await act(async () => undefined);
    expect(state.apps.filter((app) => app !== existing)).toHaveLength(0);
    first.unmount();

    cleanup();
    resetPixiSingleton();
    pixiSingleton.isInitializing = true;
    pixiSingleton.initPromise = null;
    pixiSingleton.app = null;
    const pending = renderCanvas();
    await act(async () => undefined);
    expect(pixiSingleton.app).toBeNull();
    pending.unmount();

    cleanup();
    resetPixiSingleton();
    pixiSingleton.app = {
      stage: null,
      ticker: { stop: vi.fn() },
      destroy: vi.fn(),
    } as never;
    Object.defineProperty(window, "devicePixelRatio", {
      configurable: true,
      value: 0,
    });
    renderCanvas({ viewportWidth: 0, viewportHeight: 0 });
    await waitFor(() => expect(state.apps.at(-1)?.init).toHaveBeenCalledWith(
      expect.objectContaining({ width: 816, height: 1056, resolution: 1 }),
    ));
  });

  it("recreates the rendition admission after Strict Mode cleanup so cached images render", async () => {
    const state = pixiState();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const cachedImportedImage = new Blob(["cached imported image"]);
    const cachedCard = card({
      imageBlob: cachedImportedImage,
      backBlob: undefined,
      backImageId: undefined,
      card: {
        ...card().card,
        overrides: { ...card().card.overrides, holoEffect: "none" },
      },
    });

    const { unmount } = render(
      <StrictMode>{canvasElement({ cards: [cachedCard] })}</StrictMode>,
    );

    await waitFor(() => expect(state.sprites).toHaveLength(1));
    await waitFor(() => expect(state.textures).toHaveLength(1));
    expect(warn).not.toHaveBeenCalledWith(
      "[PixiVirtualCanvas] Failed to identify rendition:",
      expect.objectContaining({ message: "Rendition identity admission is disposed" }),
    );

    const texture = state.textures[0];
    const objectUrl = (URL.createObjectURL as ReturnType<typeof vi.fn>).mock.results[0].value;
    unmount();

    expect(texture.destroy).toHaveBeenCalledTimes(1);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(objectUrl);
  });

  it("reuses singleton apps while canceling reattached identity and texture work", async () => {
    const state = pixiState();
    const pendingImages: Array<{
      onload: (() => void) | null;
      onerror: (() => void) | null;
    }> = [];
    class ControlledImage {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_value: string) {
        pendingImages.push(this);
      }
    }
    vi.stubGlobal("Image", ControlledImage);
    vi.stubGlobal("URL", {
      createObjectURL: vi.fn(() => "blob:reattached-provisional"),
      revokeObjectURL: vi.fn(),
    });
    const existing = new state.Application!();
    const world = new state.Container!();
    const cardsContainer = new state.Container!();
    pixiSingleton.app = existing as never;
    pixiSingleton.worldContainer = world as never;
    pixiSingleton.pagesContainer = new state.Container!() as never;
    pixiSingleton.cardsContainer = cardsContainer as never;
    pixiSingleton.guidesContainer = new state.Container!() as never;

    let resolveIdentity: (bytes: ArrayBuffer) => void = () => undefined;
    const deferredBlob = new Blob(["front"]);
    const deferredIdentity = new Promise<ArrayBuffer>((resolve) => {
      resolveIdentity = resolve;
    });
    vi.spyOn(deferredBlob, "slice").mockReturnValue({
      arrayBuffer: () => deferredIdentity,
    } as never);
    const withoutHoloAnimation = card({
      imageBlob: deferredBlob,
      backBlob: undefined,
      backImageId: undefined,
      card: {
        ...card().card,
        overrides: { ...card().card.overrides, holoEffect: "none" },
      },
    });
    const { unmount } = renderCanvas({ cards: [withoutHoloAnimation], zoom: 1.5 });
    await waitFor(() => expect(
      (world.scale as { set: ReturnType<typeof vi.fn> }).set,
    ).toHaveBeenCalledWith(1.5));
    await waitFor(() => expect(deferredBlob.slice).toHaveBeenCalled());
    expect(state.apps.filter((app) => app !== existing).length).toBe(0);
    unmount();
    await act(async () => resolveIdentity(new TextEncoder().encode("front").buffer));
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(state.sprites).toHaveLength(0);
    expect(cardsContainer.addChild).not.toHaveBeenCalled();
    expect(existing.destroy).not.toHaveBeenCalled();
    expect(pixiSingleton.app).toBe(existing);

    const provisional = renderCanvas({ cards: [withoutHoloAnimation] });
    await waitFor(() => expect(pendingImages).toHaveLength(1));
    provisional.unmount();
    await act(async () => pendingImages[0].onload?.());
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:reattached-provisional");
    expect(state.textures).toHaveLength(1);
    expect(state.textures[0].destroy).toHaveBeenCalledTimes(1);
    expect(state.sprites).toHaveLength(0);
    expect(cardsContainer.addChild).not.toHaveBeenCalled();
    expect(existing.destroy).not.toHaveBeenCalled();
    expect(pixiSingleton.app).toBe(existing);

    cleanup();
    resetPixiSingleton();
    const pending = new state.Application!();
    pixiSingleton.isInitializing = true;
    pixiSingleton.initPromise = Promise.resolve();
    pixiSingleton.app = pending as never;
    pixiSingleton.worldContainer = new state.Container!() as never;
    pixiSingleton.pagesContainer = new state.Container!() as never;
    pixiSingleton.cardsContainer = new state.Container!() as never;
    pixiSingleton.guidesContainer = new state.Container!() as never;
    renderCanvas({ zoom: 1.25 });
    await waitFor(() => expect(pixiSingleton.worldContainer?.scale.set).toHaveBeenCalledWith(1.25));

    cleanup();
    resetPixiSingleton();
    state.initShouldFail = true;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    renderCanvas();
    await waitFor(() => expect(warn).toHaveBeenCalledWith("[PixiVirtualCanvas] Init failed:", expect.any(Error)));
  });

  it("exposes the preview app and resets singleton state after cleanup errors", () => {
    const state = pixiState();
    const app = new state.Application!();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    (app.destroy as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error("destroy failed");
    });

    setPixiApp(app as never);
    expect(getPixiApp()).toBe(app);
    pixiSingleton.app = app as never;

    expect(() => resetPixiSingleton()).not.toThrow();
    expect(warn).toHaveBeenCalledWith(
      "[PixiSingleton] Error during cleanup:",
      expect.any(Error),
    );
    expect(pixiSingleton.app).toBeNull();

    setPixiApp(null);
    expect(getPixiApp()).toBeNull();
  });
});
