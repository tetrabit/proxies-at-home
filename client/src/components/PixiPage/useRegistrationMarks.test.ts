import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  graphicsInstances: [] as Array<{
    parent?: { removeChild: ReturnType<typeof vi.fn> };
    rect: ReturnType<typeof vi.fn>;
    fill: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
  }>,
}));

vi.mock('pixi.js', () => ({
  Graphics: vi.fn(function Graphics(this: { parent?: { removeChild: ReturnType<typeof vi.fn> }; rect: ReturnType<typeof vi.fn>; fill: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> }) {
    this.rect = vi.fn();
    this.fill = vi.fn();
    this.destroy = vi.fn();
    mocks.graphicsInstances.push(this);
  }),
}));

import { useRegistrationMarks } from './useRegistrationMarks';

const pages = [{ pageYOffset: 0, pageWidthPx: 400, pageHeightPx: 500 }];

function makeContainer() {
  const container = {
    addChild: vi.fn((g: { parent?: { removeChild: ReturnType<typeof vi.fn> } }) => {
      g.parent = container;
    }),
    removeChild: vi.fn(),
  };
  return container;
}

function makeApp() {
  return { render: vi.fn() };
}

describe('useRegistrationMarks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.graphicsInstances.length = 0;
  });

  it('does nothing until ready with a container', () => {
    const container = makeContainer();
    const app = makeApp();

    renderHook(() => useRegistrationMarks({
      isReady: false,
      container: container as never,
      app: app as never,
      pages: pages as never,
      registrationMarks: '3',
      registrationMarksPortrait: false,
    }));

    expect(container.addChild).not.toHaveBeenCalled();
    expect(app.render).not.toHaveBeenCalled();
  });

  it('renders landscape and portrait registration mark variants with cleanup', () => {
    const container = makeContainer();
    const app = makeApp();

    const { rerender, unmount } = renderHook(
      ({ registrationMarks, registrationMarksPortrait }) => useRegistrationMarks({
        isReady: true,
        container: container as never,
        app: app as never,
        pages: pages as never,
        registrationMarks: registrationMarks as '3' | '4' | 'none',
        registrationMarksPortrait,
      }),
      { initialProps: { registrationMarks: '3', registrationMarksPortrait: false } }
    );

    expect(container.addChild).toHaveBeenCalledTimes(1);
    expect(mocks.graphicsInstances[0].rect).toHaveBeenCalled();
    expect(mocks.graphicsInstances[0].fill).toHaveBeenCalledWith({ color: 0x000000 });

    rerender({ registrationMarks: '4', registrationMarksPortrait: false });
    expect(container.removeChild).toHaveBeenCalledWith(mocks.graphicsInstances[0]);
    expect(mocks.graphicsInstances[0].destroy).toHaveBeenCalled();
    expect(mocks.graphicsInstances[1].rect).toHaveBeenCalled();

    rerender({ registrationMarks: '3', registrationMarksPortrait: true });
    expect(mocks.graphicsInstances[2].rect).toHaveBeenCalled();

    rerender({ registrationMarks: '4', registrationMarksPortrait: true });
    expect(mocks.graphicsInstances[3].rect).toHaveBeenCalled();

    rerender({ registrationMarks: 'none', registrationMarksPortrait: true });
    expect(container.addChild).toHaveBeenCalledTimes(4);
    expect(app.render).toHaveBeenCalled();

    unmount();
  });
});
