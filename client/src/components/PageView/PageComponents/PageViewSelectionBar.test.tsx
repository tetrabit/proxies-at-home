import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

const selectionState = vi.hoisted(() => ({
  selectedCards: new Set<string>(),
  selectAll: vi.fn(),
  clearSelection: vi.fn(),
}));

const pageViewSettings = vi.hoisted(() => ({
  settingsPanelWidth: 320,
  isSettingsPanelCollapsed: false,
  uploadPanelWidth: 240,
  isUploadPanelCollapsed: false,
}));

vi.mock('@/store/selection', () => ({
  useSelectionStore: (selector: (state: typeof selectionState) => unknown) => selector(selectionState),
}));

vi.mock('@/hooks/usePageViewSettings', () => ({
  usePageViewSettings: () => pageViewSettings,
}));

import { PageViewSelectionBar } from './PageViewSelectionBar';

const cards = [
  { uuid: 'card-1', name: 'One' },
  { uuid: 'card-2', name: 'Two' },
] as never;

describe('PageViewSelectionBar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selectionState.selectedCards = new Set<string>();
    Object.assign(pageViewSettings, {
      settingsPanelWidth: 320,
      isSettingsPanelCollapsed: false,
      uploadPanelWidth: 240,
      isUploadPanelCollapsed: false,
    });
  });

  it('hides when there is no active selection or no cards', () => {
    const { container, rerender } = render(<PageViewSelectionBar cards={cards} />);
    expect(container.textContent).toBe('');

    selectionState.selectedCards = new Set(['card-1']);
    rerender(<PageViewSelectionBar cards={[]} />);
    expect(container.textContent).toBe('');
  });

  it('selects all card uuids and clears the current selection on desktop', () => {
    selectionState.selectedCards = new Set(['card-1']);
    const { container } = render(<PageViewSelectionBar cards={cards} />);

    expect(screen.getByText('1 selected')).toBeDefined();
    const root = container.firstElementChild as HTMLElement;
    expect(root.className).toContain('bottom-6');
    expect(root.style.left).toBe('calc(50% - 40px)');

    fireEvent.click(screen.getByTitle('Select All'));
    expect(selectionState.selectAll).toHaveBeenCalledWith(['card-1', 'card-2']);

    fireEvent.click(screen.getByTitle('Deselect All'));
    expect(selectionState.clearSelection).toHaveBeenCalled();
  });

  it('uses collapsed panel widths for desktop centering and omits inline centering on mobile', () => {
    selectionState.selectedCards = new Set(['card-1', 'card-2']);
    pageViewSettings.isUploadPanelCollapsed = true;
    pageViewSettings.isSettingsPanelCollapsed = true;

    const { container, rerender } = render(<PageViewSelectionBar cards={cards} />);
    expect((container.firstElementChild as HTMLElement).style.left).toBe('calc(50% + 0px)');

    rerender(<PageViewSelectionBar cards={cards} mobile />);
    const root = container.firstElementChild as HTMLElement;
    expect(root.className).toContain('bottom-20');
    expect(root.getAttribute('style')).toBe('');
  });
});
