import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';

vi.mock('../PageView/ZoomControls', () => ({
  ZoomControls: ({ zoom, onZoomChange, minZoom, maxZoom }: { zoom: number; onZoomChange: (zoom: number) => void; minZoom: number; maxZoom: number }) => (
    <button data-testid="zoom-controls" data-min={minZoom} data-max={maxZoom} onClick={() => onZoomChange(zoom + 0.1)}>
      controls {zoom.toFixed(1)}
    </button>
  ),
}));

vi.mock('@/hooks/useOnClickOutside', () => ({
  useOnClickOutside: (_ref: unknown, handler: () => void) => {
    (window as unknown as { __outsideHandler?: () => void }).__outsideHandler = handler;
  },
}));

import { FloatingZoomPanel } from './FloatingZoomPanel';

describe('FloatingZoomPanel', () => {
  it.each([
    ['bottom-right', 'bottom-4 right-4'],
    ['bottom-left', 'bottom-4 left-4'],
    ['top-right', 'top-4 right-4'],
    ['top-left', 'top-4 left-4'],
  ] as const)('renders %s positioning and forwards zoom changes', (position, expectedClasses) => {
    const onZoomChange = vi.fn();
    const { container } = render(
      <FloatingZoomPanel zoom={1.25} onZoomChange={onZoomChange} minZoom={0.25} maxZoom={3} position={position} className="extra" style={{ color: 'red' }} />
    );

    const root = container.firstElementChild as HTMLElement;
    for (const cls of expectedClasses.split(' ')) expect(root.className).toContain(cls);
    expect(root.className).toContain('extra');
    expect(root.style.color).toBe('red');
    expect(screen.getByText('1.3x')).toBeDefined();

    fireEvent.click(screen.getByTestId('zoom-controls'));
    expect(onZoomChange).toHaveBeenCalledWith(1.35);
  });

  it('expands on compact click and collapses on outside click or Escape', () => {
    const { container } = render(<FloatingZoomPanel zoom={1} onZoomChange={vi.fn()} />);
    const collapsed = screen.getByText('1.0x').parentElement!;
    const expanded = screen.getByTestId('zoom-controls').parentElement!;

    expect(collapsed.className).toContain('opacity-70');
    expect(expanded.className).toContain('opacity-0');

    fireEvent.click(collapsed);
    expect(collapsed.className).toContain('opacity-0');
    expect(expanded.className).toContain('opacity-100');

    act(() => (window as unknown as { __outsideHandler: () => void }).__outsideHandler());
    expect((container.querySelector('[data-testid="zoom-controls"]')!.parentElement as HTMLElement).className).toContain('opacity-0');

    fireEvent.click(screen.getByText('1.0x').parentElement!);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect((container.querySelector('[data-testid="zoom-controls"]')!.parentElement as HTMLElement).className).toContain('opacity-0');
  });

  it('ignores Escape while collapsed', () => {
    const { container } = render(<FloatingZoomPanel zoom={1} onZoomChange={vi.fn()} />);

    fireEvent.keyDown(window, { key: 'Escape' });

    expect((container.querySelector('[data-testid="zoom-controls"]')!.parentElement as HTMLElement).className).toContain('opacity-0');
  });
});
