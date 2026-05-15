import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  graphicsInstances: [] as Array<{
    x: number;
    y: number;
    destroy: ReturnType<typeof vi.fn>;
  }>,
  contextInstances: [] as Array<{
    rect: ReturnType<typeof vi.fn>;
    roundRect: ReturnType<typeof vi.fn>;
    stroke: ReturnType<typeof vi.fn>;
  }>,
  generatePerCardGuide: vi.fn(),
  executePathCommands: vi.fn(),
  groupPathCommandsIntoSegments: vi.fn(),
}));

vi.mock('pixi.js', () => ({
  Graphics: vi.fn(function Graphics(this: { x: number; y: number; destroy: ReturnType<typeof vi.fn> }) {
    this.x = 0;
    this.y = 0;
    this.destroy = vi.fn();
    mocks.graphicsInstances.push(this);
  }),
  GraphicsContext: vi.fn(function GraphicsContext(this: { rect: ReturnType<typeof vi.fn>; roundRect: ReturnType<typeof vi.fn>; stroke: ReturnType<typeof vi.fn> }) {
    this.rect = vi.fn();
    this.roundRect = vi.fn();
    this.stroke = vi.fn();
    mocks.contextInstances.push(this);
  }),
}));

vi.mock('../../helpers/cutGuideUtils', () => ({
  generatePerCardGuide: (...args: unknown[]) => mocks.generatePerCardGuide(...args),
  executePathCommands: (...args: unknown[]) => mocks.executePathCommands(...args),
  groupPathCommandsIntoSegments: (...args: unknown[]) => mocks.groupPathCommandsIntoSegments(...args),
}));

import { usePerCardGuides } from './usePerCardGuides';

const cardA = {
  card: { uuid: 'card-a' },
  globalX: 10,
  globalY: 20,
  bleedMm: 1,
  baseCardWidthMm: 63,
  baseCardHeightMm: 88,
};

const cardB = {
  ...cardA,
  card: { uuid: 'card-b' },
  globalX: 100,
  globalY: 120,
};

function makeContainer() {
  return { addChild: vi.fn(), removeChild: vi.fn() };
}

function makeApp() {
  return { render: vi.fn() };
}

describe('usePerCardGuides', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.graphicsInstances.length = 0;
    mocks.contextInstances.length = 0;
    mocks.generatePerCardGuide.mockReturnValue([{ type: 'moveTo', args: [0, 0] }]);
    mocks.groupPathCommandsIntoSegments.mockReturnValue([[{ type: 'moveTo', args: [0, 0] }]]);
  });

  it('does nothing until ready with a container', () => {
    const container = makeContainer();
    const app = makeApp();

    renderHook(() => usePerCardGuides({
      isReady: false,
      container: container as never,
      app: app as never,
      cards: [cardA] as never,
      guideStyle: 'corners',
      guideColor: 0xff00ff,
      guidePlacement: 'outside',
      guideWidth: 1,
      cutGuideLengthMm: 3,
    }));

    expect(container.addChild).not.toHaveBeenCalled();
    expect(app.render).not.toHaveBeenCalled();
  });

  it('renders shared guide contexts, skips active card, and cleans up on rerender', () => {
    const container = makeContainer();
    const app = makeApp();

    const { rerender, unmount } = renderHook(
      ({ activeId }) => usePerCardGuides({
        isReady: true,
        container: container as never,
        app: app as never,
        cards: [cardA, cardB] as never,
        guideStyle: 'corners',
        guideColor: 0xff00ff,
        guidePlacement: 'outside',
        guideWidth: 1,
        cutGuideLengthMm: 3,
        activeId,
      }),
      { initialProps: { activeId: 'card-b' as string | null } }
    );

    expect(container.addChild).toHaveBeenCalledTimes(1);
    expect(mocks.contextInstances).toHaveLength(1);
    expect(mocks.contextInstances[0].stroke).toHaveBeenCalledWith({ color: 0xff00ff, width: 1 });
    expect(mocks.graphicsInstances[0].x).toBeGreaterThan(cardA.globalX);
    expect(mocks.graphicsInstances[0].y).toBeGreaterThan(cardA.globalY);
    expect(app.render).toHaveBeenCalled();

    rerender({ activeId: null });
    expect(container.removeChild).toHaveBeenCalledWith(mocks.graphicsInstances[0]);
    expect(mocks.graphicsInstances[0].destroy).toHaveBeenCalled();
    expect(container.addChild).toHaveBeenCalledTimes(3);

    unmount();
    expect(mocks.graphicsInstances.at(-1)?.destroy).toHaveBeenCalled();
  });

  it('renders rect fallback and empty states', () => {
    const container = makeContainer();
    const app = makeApp();
    mocks.generatePerCardGuide.mockReturnValue([]);

    const { rerender } = renderHook(
      ({ guideStyle, guideWidth, cards }) => usePerCardGuides({
        isReady: true,
        container: container as never,
        app: app as never,
        cards: cards as never,
        guideStyle: guideStyle as 'solid-rounded-rect' | 'solid-squared-rect' | 'none',
        guideColor: 0x000000,
        guidePlacement: 'inside',
        guideWidth,
        cutGuideLengthMm: 3,
      }),
      { initialProps: { guideStyle: 'solid-rounded-rect', guideWidth: 0.05, cards: [cardA] } }
    );

    expect(mocks.contextInstances[0].roundRect).toHaveBeenCalled();
    expect(mocks.contextInstances[0].stroke).toHaveBeenCalledWith({ color: 0x000000, width: 0.1 });

    rerender({ guideStyle: 'solid-squared-rect', guideWidth: 1, cards: [cardA] });
    expect(mocks.contextInstances.at(-1)?.rect).toHaveBeenCalled();

    rerender({ guideStyle: 'solid-squared-rect', guideWidth: 1, cards: [{ ...cardA, baseCardWidthMm: 64 }] });
    expect(mocks.generatePerCardGuide).toHaveBeenLastCalledWith(
      expect.any(Number),
      expect.any(Number),
      expect.any(Number),
      1,
      'solid-squared-rect',
      'inside',
      expect.any(Number)
    );

    rerender({ guideStyle: 'none', guideWidth: 1, cards: [cardA] });
    rerender({ guideStyle: 'solid-squared-rect', guideWidth: 0, cards: [cardA] });
    rerender({ guideStyle: 'solid-squared-rect', guideWidth: 1, cards: [] });
    renderHook(() => usePerCardGuides({
      isReady: true,
      container: container as never,
      app: null,
      cards: [] as never,
      guideStyle: 'none',
      guideColor: 0x000000,
      guidePlacement: 'inside',
      guideWidth: 1,
      cutGuideLengthMm: 3,
    }));
    expect(app.render).toHaveBeenCalled();
  });

  it('supports centered guide placement', () => {
    const container = makeContainer();
    const app = makeApp();
    mocks.generatePerCardGuide.mockReturnValue([]);

    renderHook(() => usePerCardGuides({
      isReady: true,
      container: container as never,
      app: app as never,
      cards: [cardA] as never,
      guideStyle: 'solid-squared-rect',
      guideColor: 0x000000,
      guidePlacement: 'center',
      guideWidth: 1,
      cutGuideLengthMm: 3,
    }));

    expect(mocks.contextInstances[0].rect.mock.calls[0][0]).toBe(0);
  });

  it('skips fallback drawing for non-rect empty command sets', () => {
    const container = makeContainer();
    const app = makeApp();
    mocks.generatePerCardGuide.mockReturnValue([]);

    renderHook(() => usePerCardGuides({
      isReady: true,
      container: container as never,
      app: app as never,
      cards: [cardA] as never,
      guideStyle: 'corners',
      guideColor: 0x000000,
      guidePlacement: 'outside',
      guideWidth: 1,
      cutGuideLengthMm: 3,
    }));

    expect(mocks.contextInstances[0].rect).not.toHaveBeenCalled();
    expect(mocks.contextInstances[0].roundRect).not.toHaveBeenCalled();
  });
});
