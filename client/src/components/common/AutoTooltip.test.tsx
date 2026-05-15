import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';

vi.mock('flowbite-react', () => ({
  Tooltip: ({ children, content, className }: { children: React.ReactNode; content?: React.ReactNode; className?: string }) => (
    <div data-testid="desktop-tooltip" className={className} data-content={String(content)}>{children}</div>
  ),
}));

import { AutoTooltip } from './AutoTooltip';

describe('AutoTooltip', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('delegates desktop rendering to Flowbite Tooltip with default icon content', () => {
    render(<AutoTooltip content="Helpful" tooltipClassName="tip" />);

    const tooltip = screen.getByTestId('desktop-tooltip');
    expect(tooltip.getAttribute('data-content')).toBe('Helpful');
    expect(tooltip.className).toContain('tip');
    expect(tooltip.querySelector('svg')).toBeTruthy();
  });

  it.each([
    ['left', 'right-full'],
    ['right', 'left-full'],
    ['bottom', 'top-full'],
    ['bottom-end', 'right-0'],
    ['top', 'bottom-full'],
  ] as const)('shows and auto-hides mobile tooltip for %s placement', (placement, expectedClass) => {
    render(
      <AutoTooltip mobile timeout={100} content="Tap help" placement={placement}>
        <button>?</button>
      </AutoTooltip>
    );

    fireEvent.click(screen.getByText('?'));
    const tooltip = screen.getByRole('tooltip');
    expect(tooltip.textContent).toContain('Tap help');
    expect(tooltip.className).toContain(expectedClass);

    act(() => vi.advanceTimersByTime(100));
    expect(screen.getByRole('tooltip').className).toContain('opacity-0');
    act(() => vi.advanceTimersByTime(300));
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('cleans up pending timers on unmount', () => {
    const { unmount } = render(
      <AutoTooltip mobile timeout={100} content="Tap help">
        <button>?</button>
      </AutoTooltip>
    );

    fireEvent.click(screen.getByText('?'));
    expect(screen.getByRole('tooltip')).toBeDefined();

    unmount();
    act(() => vi.advanceTimersByTime(1000));

    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('clears existing timeouts on repeated clicks', () => {
    render(
      <AutoTooltip mobile timeout={100} content="Tap help">
        <button>?</button>
      </AutoTooltip>
    );

    const trigger = screen.getByText('?');
    fireEvent.click(trigger);
    fireEvent.click(trigger);

    act(() => vi.advanceTimersByTime(100));
    expect(screen.getByRole('tooltip')).toBeDefined();
  });
});
