import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

const settingsState = vi.hoisted(() => ({
  pageWidth: 8.5,
  pageHeight: 11,
  pageSizeUnit: 'in',
  dpi: 600,
  setDpi: vi.fn(),
  decklistSortAlpha: false,
  setDecklistSortAlpha: vi.fn(),
  columns: 3,
  rows: 3,
  bleedEdge: false,
  bleedEdgeWidth: 0,
  bleedEdgeUnit: 'mm',
  cardSpacingMm: 0,
  cardPositionX: 0,
  cardPositionY: 0,
  registrationMarksPortrait: false,
}));

const templateMocks = vi.hoisted(() => ({
  settingsToCuttingTemplate: vi.fn(() => ({ template: true })),
  downloadCuttingTemplate: vi.fn(),
}));

vi.mock('@/store/settings', () => ({
  useSettingsStore: (selector: (state: typeof settingsState) => unknown) => selector(settingsState),
}));

vi.mock('../../LayoutSettings/ExportActions', () => ({
  ExportActions: ({ cards }: { cards: unknown[] }) => <div data-testid="export-actions">{cards.length} cards</div>,
}));

vi.mock('../../common', () => ({
  AutoTooltip: ({ content }: { content: string }) => <span data-testid="tooltip">{content}</span>,
  ToggleButtonGroup: ({ value, onChange }: { value: string; onChange: (value: 'displayed' | 'alpha') => void }) => (
    <div data-testid="decklist-order" data-value={value}>
      <button onClick={() => onChange('displayed')}>As Displayed</button>
      <button onClick={() => onChange('alpha')}>Alphabetical</button>
    </div>
  ),
}));

vi.mock('flowbite-react', () => ({
  Label: ({ children }: { children: React.ReactNode }) => <label>{children}</label>,
  Select: ({ children, value, onChange }: { children: React.ReactNode; value: number; onChange: React.ChangeEventHandler<HTMLSelectElement> }) => <select value={value} onChange={onChange}>{children}</select>,
  Button: ({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) => <button onClick={onClick}>{children}</button>,
}));

vi.mock('@/helpers/exportCuttingTemplate', () => ({
  settingsToCuttingTemplate: (...args: unknown[]) => templateMocks.settingsToCuttingTemplate(...args),
  downloadCuttingTemplate: (...args: unknown[]) => templateMocks.downloadCuttingTemplate(...args),
}));

import { ExportSection } from './ExportSection';

describe('ExportSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(settingsState, {
      pageWidth: 8.5,
      pageHeight: 11,
      pageSizeUnit: 'in',
      dpi: 600,
      decklistSortAlpha: false,
    });
  });

  it('renders export actions, DPI options, decklist order, and cutting template export', () => {
    render(<ExportSection cards={[{ uuid: 'c1' }] as never} />);

    expect(screen.getByTestId('export-actions').textContent).toContain('1 cards');
    expect(screen.getByText('PDF Export DPI')).toBeDefined();
    expect(screen.getByTestId('decklist-order').getAttribute('data-value')).toBe('displayed');

    fireEvent.change(screen.getByRole('combobox'), { target: { value: '900' } });
    expect(settingsState.setDpi).toHaveBeenCalledWith(900);

    fireEvent.click(screen.getByText('Alphabetical'));
    expect(settingsState.setDecklistSortAlpha).toHaveBeenCalledWith(true);

    fireEvent.click(screen.getByText(/Cutting Template/));
    expect(templateMocks.settingsToCuttingTemplate).toHaveBeenCalledWith(
      8.5,
      11,
      'in',
      3,
      3,
      false,
      0,
      'mm',
      0,
      0,
      0,
      false
    );
    expect(templateMocks.downloadCuttingTemplate).toHaveBeenCalledWith({ template: true });
    expect(screen.getByTestId('tooltip').textContent).toContain('Export an SVG cutting template');
  });

  it('clamps DPI when page dimensions make current DPI unsafe and supports metric pages', () => {
    settingsState.pageSizeUnit = 'mm';
    settingsState.pageWidth = 210;
    settingsState.pageHeight = 297;
    settingsState.dpi = 3000;

    render(<ExportSection cards={[] as never} />);

    expect(settingsState.setDpi).toHaveBeenCalled();
    const clamped = settingsState.setDpi.mock.calls.at(-1)?.[0];
    expect(clamped).toBeLessThan(3000);
  });

  it('ignores invalid DPI select values and reflects alpha order state', () => {
    settingsState.decklistSortAlpha = true;
    render(<ExportSection cards={[] as never} />);

    expect(screen.getByTestId('decklist-order').getAttribute('data-value')).toBe('alpha');
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'not-a-number' } });
    expect(settingsState.setDpi).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('As Displayed'));
    expect(settingsState.setDecklistSortAlpha).toHaveBeenCalledWith(false);
  });
});
