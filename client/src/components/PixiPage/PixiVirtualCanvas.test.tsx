import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import type { CardOption } from "../../../../shared/types";
import type { CardWithGlobalLayout, PageLayoutInfo } from "./PixiVirtualCanvas";

const pixi = vi.hoisted(() => {
  const state = {
    apps: [] as Array<Record<string, unknown>>,
    containers: [] as Array<Record<string, unknown>>,
    graphics: [] as Array<Record<string, unknown>>,
    sprites: [] as Array<Record<string, unknown>>,
    textures: [] as Array<{ id: string; destroy: ReturnType<typeof vi.fn> }>,
    initShouldFail: false,
  };

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
      state.containers.push(this);
    }
  }

  class Graphics extends Container {
    clear = vi.fn();
    rect = vi.fn();
    fill = vi.fn();

    constructor() {
      super();
      state.graphics.push(this);
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
      state.sprites.push(this);
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
      state.apps.push(this);
    }
  }

  return { ...state, Application, Container, Graphics, Sprite };
});

vi.mock("pixi.js", () => ({
  Application: pixi.Application,
  Container: pixi.Container,
  Graphics: pixi.Graphics,
  Sprite: pixi.Sprite,
  Texture: {
    WHITE: { id: "white", destroy: vi.fn() },
    from: vi.fn(() => {
      const texture = { id: `texture-${pixi.textures.length}`, destroy: vi.fn() };
      pixi.textures.push(texture);
      return texture;
    }),
  },
}));

const filterState = vi.hoisted(() => {
  class Filter {
    [key: string]: unknown;
    destroy = vi.fn();
  }
  return { darken: [] as Filter[], adjustment: [] as Filter[], Filter };
});

vi.mock("./filters", () => ({
  DarkenFilter: class DarkenFilter extends filterState.Filter {
    constructor() {
      super();
      filterState.darken.push(this);
    }
  },
  AdjustmentFilter: class AdjustmentFilter extends filterState.Filter {
    constructor() {
      super();
      filterState.adjustment.push(this);
    }
  },
}));

const guideHooks = vi.hoisted(() => ({
  page: vi.fn(),
  perCard: vi.fn(),
  registration: vi.fn(),
}));
vi.mock("./usePageGuides", () => ({ usePageGuides: guideHooks.page }));
vi.mock("./usePerCardGuides", () => ({ usePerCardGuides: guideHooks.perCard }));
vi.mock("./useRegistrationMarks", () => ({ useRegistrationMarks: guideHooks.registration }));

const settings = vi.hoisted(() => ({
  darkenContrast: 1.2,
  darkenEdgeWidth: 0.2,
  darkenAmount: 0.8,
  darkenBrightness: -10,
  darkenAutoDetect: true,
}));
vi.mock("../../store/settings", () => ({
  useSettingsStore: (selector: (state: typeof settings) => unknown) => selector(settings),
}));

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
    pixi.apps = [];
    pixi.containers = [];
    pixi.graphics = [];
    pixi.sprites = [];
    pixi.textures = [];
    pixi.initShouldFail = false;
    filterState.darken = [];
    filterState.adjustment = [];
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

    await waitFor(() => expect(pixi.apps[0]?.init).toHaveBeenCalled());
    await waitFor(() => expect(pixi.graphics.length).toBeGreaterThanOrEqual(2));
    await waitFor(() => expect(pixi.sprites.length).toBe(1));
    await waitFor(() => expect(onRenderedCardsChange).toHaveBeenCalledWith(new Set(["card-1"])));

    expect(pixi.apps[0].ticker.stop).toHaveBeenCalled();
    expect(pixi.apps[0].renderer.resize).toHaveBeenCalledWith(320, 240);
    expect(pixiSingleton.app).toBe(pixi.apps[0]);
    expect(guideHooks.page).toHaveBeenLastCalledWith(expect.objectContaining({ cutLineStyle: "full" }));
    expect(guideHooks.perCard).toHaveBeenLastCalledWith(expect.objectContaining({ guideStyle: "solid-rounded-rect" }));
    expect(guideHooks.registration).toHaveBeenLastCalledWith(expect.objectContaining({ registrationMarks: "4" }));

    scrollHost.dispatchEvent(new Event("scroll"));
    expect(pixi.apps[0].render).toHaveBeenCalled();

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

    await waitFor(() => expect(pixi.apps[0].renderer.resize).toHaveBeenCalledWith(400, 260));
    await waitFor(() => expect(pixi.sprites.length).toBeGreaterThanOrEqual(2));
    expect(URL.revokeObjectURL).toHaveBeenCalled();

    unmount();
    expect(pixi.apps[0].destroy).toHaveBeenCalled();
    expect(pixiSingleton.app).toBeNull();
  });

  it("covers placeholders, blank backs, active-card hiding, failed texture loads, and empty-guide fallbacks", async () => {
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

    await waitFor(() => expect(pixi.apps[0]?.init).toHaveBeenCalled());
    await waitFor(() => expect(pixi.sprites.length).toBeGreaterThanOrEqual(1));
    await waitFor(() => expect(warn).toHaveBeenCalledWith("[PixiVirtualCanvas] Failed to create texture:", expect.any(Error)));
    expect(guideHooks.page).toHaveBeenLastCalledWith(expect.objectContaining({ cutLineStyle: "full" }));

    cleanup();
    resetPixiSingleton();
    renderCanvas({ cards: [], showGuideLinesOnBackCards: false });
    await waitFor(() => expect(guideHooks.page).toHaveBeenLastCalledWith(expect.objectContaining({ cutLineStyle: "none" })));
    expect(guideHooks.perCard).toHaveBeenLastCalledWith(expect.objectContaining({ guideStyle: "none" }));
    expect(guideHooks.registration).toHaveBeenLastCalledWith(expect.objectContaining({ registrationMarks: "none" }));
  });

  it("reuses in-flight and existing singleton apps and reports init failures", async () => {
    const existing = new pixi.Application();
    const world = new pixi.Container();
    pixiSingleton.app = existing as never;
    pixiSingleton.worldContainer = world as never;
    pixiSingleton.pagesContainer = new pixi.Container() as never;
    pixiSingleton.cardsContainer = new pixi.Container() as never;
    pixiSingleton.guidesContainer = new pixi.Container() as never;

    const { unmount } = renderCanvas({ zoom: 1.5 });
    await waitFor(() => expect(world.scale.set).toHaveBeenCalledWith(1.5));
    expect(pixi.apps.filter((app) => app !== existing).length).toBe(0);
    unmount();

    cleanup();
    resetPixiSingleton();
    const pending = new pixi.Application();
    pixiSingleton.isInitializing = true;
    pixiSingleton.initPromise = Promise.resolve();
    pixiSingleton.app = pending as never;
    pixiSingleton.worldContainer = new pixi.Container() as never;
    pixiSingleton.pagesContainer = new pixi.Container() as never;
    pixiSingleton.cardsContainer = new pixi.Container() as never;
    pixiSingleton.guidesContainer = new pixi.Container() as never;
    renderCanvas({ zoom: 1.25 });
    await waitFor(() => expect(pixiSingleton.worldContainer?.scale.set).toHaveBeenCalledWith(1.25));

    cleanup();
    resetPixiSingleton();
    pixi.initShouldFail = true;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    renderCanvas();
    await waitFor(() => expect(warn).toHaveBeenCalledWith("[PixiVirtualCanvas] Init failed:", expect.any(Error)));
  });
});
