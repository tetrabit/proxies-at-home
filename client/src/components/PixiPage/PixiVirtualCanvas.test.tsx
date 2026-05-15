import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
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

function guideHookState(): GuideHookState {
  const global = globalThis as typeof globalThis & { __pixiVirtualCanvasGuideHooks?: GuideHookState };
  global.__pixiVirtualCanvasGuideHooks ??= { page: [], perCard: [], registration: [] };
  return global.__pixiVirtualCanvasGuideHooks;
}

function pixiState(): PixiTestState {
  const global = globalThis as typeof globalThis & { __pixiVirtualCanvasState?: PixiTestState };
  global.__pixiVirtualCanvasState ??= {
    apps: [],
    containers: [],
    graphics: [],
    sprites: [],
    textures: [],
    initShouldFail: false,
  };
  return global.__pixiVirtualCanvasState;
}

function filterState(): FilterTestState {
  const global = globalThis as typeof globalThis & { __pixiVirtualCanvasFilterState?: FilterTestState };
  global.__pixiVirtualCanvasFilterState ??= { darken: [], adjustment: [] };
  return global.__pixiVirtualCanvasFilterState;
}

vi.mock("pixi.js", () => {
  const state = pixiState();

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
        const texture = { id: `texture-${state.textures.length}`, destroy: vi.fn() };
        state.textures.push(texture);
        return texture;
      }),
    },
  };
});

vi.mock("./filters", () => {
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

vi.mock("./usePageGuides", () => ({ usePageGuides: (args: unknown) => guideHookState().page.push(args) }));
vi.mock("./usePerCardGuides", () => ({ usePerCardGuides: (args: unknown) => guideHookState().perCard.push(args) }));
vi.mock("./useRegistrationMarks", () => ({ useRegistrationMarks: (args: unknown) => guideHookState().registration.push(args) }));

vi.mock("../../store/settings", () => {
  const settings = {
    darkenContrast: 1.2,
    darkenEdgeWidth: 0.2,
    darkenAmount: 0.8,
    darkenBrightness: -10,
    darkenAutoDetect: true,
  };
  return { useSettingsStore: (selector: (state: typeof settings) => unknown) => selector(settings) };
});

import PixiVirtualCanvas from "./PixiVirtualCanvas";
import { pixiSingleton, resetPixiSingleton } from "./pixiSingleton";

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

function renderCanvas(overrides: Partial<React.ComponentProps<typeof PixiVirtualCanvas>> = {}) {
  const scrollHost = document.createElement("div");
  scrollHost.scrollTop = 17;
  const scrollRef = { current: scrollHost };

  return render(
    <PixiVirtualCanvas
      cards={[card()]}
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
      showGuideLinesOnBackCards={false}
      cutGuideLengthMm={3}
      registrationMarks="4"
      registrationMarksPortrait
      isDarkMode={false}
      onRenderedCardsChange={vi.fn()}
      className="pixi-test"
      style={{ opacity: 0.5 }}
      {...overrides}
    />,
  );
}

describe("PixiVirtualCanvas", () => {
  beforeEach(() => {
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
    resetPixiSingleton();
    vi.unstubAllGlobals();
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
    expect(state.apps[0].renderer.resize).toHaveBeenCalledWith(320, 240);
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
    expect(state.apps[0].destroy).toHaveBeenCalled();
    expect(pixiSingleton.app).toBeNull();
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

  it("reuses in-flight and existing singleton apps and reports init failures", async () => {
    const state = pixiState();
    const existing = new state.Application!();
    const world = new state.Container!();
    pixiSingleton.app = existing as never;
    pixiSingleton.worldContainer = world as never;
    pixiSingleton.pagesContainer = new state.Container!() as never;
    pixiSingleton.cardsContainer = new state.Container!() as never;
    pixiSingleton.guidesContainer = new state.Container!() as never;

    const { unmount } = renderCanvas({ zoom: 1.5 });
    await waitFor(() => expect(world.scale.set).toHaveBeenCalledWith(1.5));
    expect(state.apps.filter((app) => app !== existing).length).toBe(0);
    unmount();

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
});
