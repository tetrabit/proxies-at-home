import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  graphicsInstances: [] as Array<{
    clear: ReturnType<typeof vi.fn>;
    moveTo: ReturnType<typeof vi.fn>;
    lineTo: ReturnType<typeof vi.fn>;
    stroke: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
  }>,
}));

vi.mock('pixi.js', () => ({
  Graphics: vi.fn(function Graphics() {
    const g = {
      clear: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      stroke: vi.fn(),
      destroy: vi.fn(),
    };
    mocks.graphicsInstances.push(g);
    return g;
  }),
}));

import { usePageGuides } from './usePageGuides';

const page = { pageYOffset: 0, pageWidthPx: 400, pageHeightPx: 500 };
const baseCard = {
  card: { uuid: 'card-1' },
  globalX: 40,
  globalY: 60,
  bleedMm: 1,
  baseCardWidthMm: 63,
  baseCardHeightMm: 88,
};

function makeContainer() {
  return { addChild: vi.fn(), removeChild: vi.fn() };
}

function makeApp() {
  return { render: vi.fn() };
}

describe('usePageGuides', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.graphicsInstances.length = 0;
  });

  it('does nothing until ready with a container', () => {
    const container = makeContainer();
    const app = makeApp();

    renderHook(() => usePageGuides({
      isReady: false,
      container: container as never,
      app: app as never,
      pages: [page] as never,
      cards: [baseCard] as never,
      cutLineStyle: 'full',
      guideWidth: 1,
    }));

    expect(container.addChild).not.toHaveBeenCalled();
    expect(app.render).not.toHaveBeenCalled();

    renderHook(() => usePageGuides({
      isReady: true,
      container: null,
      app: app as never,
      pages: [page] as never,
      cards: [baseCard] as never,
      cutLineStyle: 'full',
      guideWidth: 1,
    }));

    expect(container.addChild).not.toHaveBeenCalled();
  });

  it('draws full-page guides for card cut positions and reuses graphics on rerender', () => {
    const container = makeContainer();
    const app = makeApp();

    const { rerender, unmount } = renderHook(
      ({ guideWidth }) => usePageGuides({
        isReady: true,
        container: container as never,
        app: app as never,
        pages: [page] as never,
        cards: [baseCard] as never,
        cutLineStyle: 'full',
        guideWidth,
      }),
      { initialProps: { guideWidth: 0.05 } }
    );

    const graphics = mocks.graphicsInstances[0];
    expect(container.addChild).toHaveBeenCalledTimes(1);
    expect(graphics.clear).toHaveBeenCalled();
    expect(graphics.moveTo).toHaveBeenCalled();
    expect(graphics.lineTo).toHaveBeenCalled();
    expect(graphics.stroke).toHaveBeenCalledWith({ color: 0x000000, width: 0.1 });
    expect(app.render).toHaveBeenCalled();

    rerender({ guideWidth: 2 });
    expect(container.addChild).toHaveBeenCalledTimes(1);
    expect(graphics.stroke).toHaveBeenLastCalledWith({ color: 0x000000, width: 2 });

    unmount();
    expect(graphics.destroy).toHaveBeenCalled();
  });

  it('draws edge-only guide segments and clears existing graphics when disabled', () => {
    const container = makeContainer();
    const app = makeApp();

    const { rerender } = renderHook(
      ({ cutLineStyle, cards, guideWidth }) => usePageGuides({
        isReady: true,
        container: container as never,
        app: app as never,
        pages: [page] as never,
        cards: cards as never,
        cutLineStyle: cutLineStyle as 'none' | 'full' | 'edges',
        guideWidth,
      }),
      { initialProps: { cutLineStyle: 'edges', cards: [baseCard], guideWidth: 1 } }
    );

    const graphics = mocks.graphicsInstances[0];
    expect(graphics.moveTo).toHaveBeenCalled();
    expect(graphics.lineTo).toHaveBeenCalled();

    rerender({ cutLineStyle: 'none', cards: [baseCard], guideWidth: 1 });
    expect(graphics.clear).toHaveBeenCalled();
    expect(app.render).toHaveBeenCalled();

    rerender({ cutLineStyle: 'edges', cards: [], guideWidth: 1 });
    expect(graphics.clear).toHaveBeenCalled();

    rerender({ cutLineStyle: 'edges', cards: [baseCard], guideWidth: 0 });
    expect(graphics.clear).toHaveBeenCalled();
  });

  it('returns from disabled states before graphics exist', () => {
    const container = makeContainer();
    const app = makeApp();

    renderHook(() => usePageGuides({
      isReady: true,
      container: container as never,
      app: app as never,
      pages: [page] as never,
      cards: [baseCard] as never,
      cutLineStyle: 'none',
      guideWidth: 1,
    }));

    renderHook(() => usePageGuides({
      isReady: true,
      container: container as never,
      app: null,
      pages: [page] as never,
      cards: [] as never,
      cutLineStyle: 'edges',
      guideWidth: 1,
    }));

    expect(container.addChild).not.toHaveBeenCalled();
    expect(app.render).toHaveBeenCalled();
  });

  it('skips pages without cards but still strokes and renders', () => {
    const container = makeContainer();
    const app = makeApp();

    renderHook(() => usePageGuides({
      isReady: true,
      container: container as never,
      app: app as never,
      pages: [{ pageYOffset: 1000, pageWidthPx: 400, pageHeightPx: 500 }] as never,
      cards: [baseCard] as never,
      cutLineStyle: 'full',
      guideWidth: 1,
    }));

    const graphics = mocks.graphicsInstances[0];
    expect(graphics.moveTo).not.toHaveBeenCalled();
    expect(graphics.stroke).toHaveBeenCalledWith({ color: 0x000000, width: 1 });
    expect(app.render).toHaveBeenCalled();
  });

  it('handles edge guides at page boundaries without outside segments', () => {
    const container = makeContainer();
    const app = makeApp();

    renderHook(() => usePageGuides({
      isReady: true,
      container: container as never,
      app: app as never,
      pages: [page] as never,
      cards: [{
        card: { uuid: 'full-page-card' },
        globalX: 0,
        globalY: 0,
        bleedMm: 0,
        baseCardWidthMm: page.pageWidthPx / (96 / 25.4),
        baseCardHeightMm: page.pageHeightPx / (96 / 25.4),
      }] as never,
      cutLineStyle: 'edges',
      guideWidth: 1,
    }));

    const graphics = mocks.graphicsInstances[0];
    expect(graphics.moveTo).not.toHaveBeenCalled();
    expect(graphics.stroke).toHaveBeenCalledWith({ color: 0x000000, width: 1 });
  });

  it('handles shared cut positions and optional app rendering', () => {
    const container = makeContainer();
    const cardWidthMm = 20;
    const cardHeightMm = 30;
    const cardWidthPx = cardWidthMm * (96 / 25.4);
    const cardHeightPx = cardHeightMm * (96 / 25.4);

    renderHook(() => usePageGuides({
      isReady: true,
      container: container as never,
      app: null,
      pages: [page] as never,
      cards: [
        {
          card: { uuid: 'left' },
          globalX: 0,
          globalY: 0,
          bleedMm: 0,
          baseCardWidthMm: cardWidthMm,
          baseCardHeightMm: cardHeightMm,
        },
        {
          card: { uuid: 'right' },
          globalX: cardWidthPx,
          globalY: cardHeightPx,
          bleedMm: 0,
          baseCardWidthMm: cardWidthMm,
          baseCardHeightMm: cardHeightMm,
        },
      ] as never,
      cutLineStyle: 'full',
      guideWidth: 1,
    }));

    expect(container.addChild).toHaveBeenCalledTimes(1);
    expect(mocks.graphicsInstances[0].stroke).toHaveBeenCalled();
  });

  it('handles reverse-ordered shared cut positions', () => {
    const container = makeContainer();
    const cardWidthMm = 20;
    const cardHeightMm = 30;
    const cardWidthPx = cardWidthMm * (96 / 25.4);
    const cardHeightPx = cardHeightMm * (96 / 25.4);

    renderHook(() => usePageGuides({
      isReady: true,
      container: container as never,
      app: null,
      pages: [page] as never,
      cards: [
        {
          card: { uuid: 'right-bottom' },
          globalX: cardWidthPx,
          globalY: cardHeightPx,
          bleedMm: 0,
          baseCardWidthMm: cardWidthMm,
          baseCardHeightMm: cardHeightMm,
        },
        {
          card: { uuid: 'left-top' },
          globalX: 0,
          globalY: 0,
          bleedMm: 0,
          baseCardWidthMm: cardWidthMm,
          baseCardHeightMm: cardHeightMm,
        },
      ] as never,
      cutLineStyle: 'full',
      guideWidth: 1,
    }));

    expect(container.addChild).toHaveBeenCalledTimes(1);
    expect(mocks.graphicsInstances[0].stroke).toHaveBeenCalled();
  });
});
