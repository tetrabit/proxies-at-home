import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

const prefState = vi.hoisted(() => ({
  preferences: {
    favoriteMpcSources: ['Favorite Source'],
    favoriteMpcTags: ['foil'],
    favoriteMpcDpi: 1000 as number | null,
    favoriteMpcSort: 'source' as 'name' | 'dpi' | 'source' | null,
  },
  toggleFavoriteMpcSource: vi.fn(),
  toggleFavoriteMpcTag: vi.fn(),
  setFavoriteMpcDpi: vi.fn(),
  setFavoriteMpcSort: vi.fn(),
}));

const settingsState = vi.hoisted(() => ({
  mpcFuzzySearch: false,
  setMpcFuzzySearch: vi.fn(),
}));

vi.mock('@/store', () => ({
  useUserPreferencesStore: (selector: (state: typeof prefState) => unknown) => selector(prefState),
  useSettingsStore: (selector: (state: typeof settingsState) => unknown) => selector(settingsState),
}));

vi.mock('./', () => ({
  SelectDropdown: ({ label, buttonText, isOpen, onToggle, onClose, children }: { label: string; buttonText: string; isOpen: boolean; onToggle: () => void; onClose: () => void; children: React.ReactNode }) => (
    <section>
      <button onClick={onToggle}>{label}: {buttonText}</button>
      {isOpen && <div data-testid={`${label}-menu`}><button onClick={onClose}>close {label}</button>{children}</div>}
    </section>
  ),
  MultiSelectDropdown: ({ label, selectedCount, isOpen, onToggle, onClose, children }: { label: string; selectedCount: number; isOpen: boolean; onToggle: () => void; onClose: () => void; children: React.ReactNode }) => (
    <section>
      <button onClick={onToggle}>{label}: {selectedCount}</button>
      {isOpen && <div data-testid={`${label}-menu`}><button onClick={onClose}>close {label}</button>{children}</div>}
    </section>
  ),
}));

import { CardArtFilterBar } from './CardArtFilterBar';

const cards = [
  { id: '1', name: 'A', sourceName: 'Favorite Source', tags: ['foil'], dpi: 1000 },
  { id: '2', name: 'B', sourceName: 'Other Source', tags: ['etched'], dpi: 800 },
] as never;

function renderBar(overrides: Partial<React.ComponentProps<typeof CardArtFilterBar>> = {}) {
  const props: React.ComponentProps<typeof CardArtFilterBar> = {
    filters: {
      minDpi: 0,
      sourceFilters: new Set<string>(),
      tagFilters: new Set<string>(),
      sortBy: 'name',
      sortDir: 'asc',
    },
    cards,
    filteredCards: [cards[0]] as never,
    groupedBySource: new Map([['Favorite Source', [cards[0]] as never]]),
    setMinDpi: vi.fn(),
    setSortBy: vi.fn(),
    setSortDir: vi.fn(),
    toggleSource: vi.fn(),
    toggleTag: vi.fn(),
    clearFilters: vi.fn(),
    setSourceFilters: vi.fn(),
    setTagFilters: vi.fn(),
    collapsedSources: new Set<string>(),
    setCollapsedSources: vi.fn(),
    allSourcesCollapsed: false,
    setAllSourcesCollapsed: vi.fn(),
    ...overrides,
  };
  render(<CardArtFilterBar {...props} />);
  return props;
}

describe('CardArtFilterBar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prefState.preferences = {
      favoriteMpcSources: ['Favorite Source'],
      favoriteMpcTags: ['foil'],
      favoriteMpcDpi: 1000,
      favoriteMpcSort: 'source',
    };
    settingsState.mpcFuzzySearch = false;
  });

  it('renders counts, toggles fuzzy search, sort direction, and clear filters', () => {
    const props = renderBar({
      filters: { minDpi: 800, sourceFilters: new Set(['Favorite Source']), tagFilters: new Set(['foil']), sortBy: 'source', sortDir: 'asc' },
    });

    expect(screen.getByText('1')).toBeDefined();
    expect(screen.getByText('2')).toBeDefined();

    fireEvent.click(screen.getByTitle('Ascending'));
    expect(props.setSortDir).toHaveBeenCalledWith('desc');

    fireEvent.click(screen.getByText('Exact'));
    expect(settingsState.setMpcFuzzySearch).toHaveBeenCalledWith(true);

    fireEvent.click(screen.getByTitle('Clear all filters'));
    expect(props.clearFilters).toHaveBeenCalled();

    fireEvent.click(screen.getByText('Collapse All'));
    expect(props.setAllSourcesCollapsed).toHaveBeenCalledWith(true);
    expect(props.setCollapsedSources).toHaveBeenCalledWith(new Set());
  });

  it('selects and favorites DPI and sort options', () => {
    const props = renderBar();

    fireEvent.click(screen.getByText('DPI: Any'));
    fireEvent.click(screen.getAllByTitle('Set as favorite')[0]);
    expect(prefState.setFavoriteMpcDpi).toHaveBeenCalledWith(0);
    fireEvent.click(screen.getByText('800+'));
    expect(props.setMinDpi).toHaveBeenCalledWith(800);

    fireEvent.click(screen.getByText('Sort: Name'));
    fireEvent.click(screen.getByTitle('Remove from favorites'));
    expect(prefState.setFavoriteMpcSort).toHaveBeenCalledWith(null);
    fireEvent.click(screen.getByText('Source'));
    expect(props.setSortBy).toHaveBeenCalledWith('source');
  });

  it('handles source and tag dropdown search, selection, favorites, and bulk actions', () => {
    const props = renderBar();

    fireEvent.click(screen.getByText('Source: 0'));
    fireEvent.change(screen.getByPlaceholderText('Search sources...'), { target: { value: 'other' } });
    expect(screen.getByText('Other Source')).toBeDefined();
    fireEvent.click(screen.getByTestId('Source-menu').querySelectorAll('button')[1]);
    expect(props.setSourceFilters).toHaveBeenCalledWith(new Set(['Favorite Source', 'Other Source']));
    fireEvent.click(screen.getByTitle('Add to favorites'));
    expect(prefState.toggleFavoriteMpcSource).toHaveBeenCalledWith('Other Source');

    fireEvent.click(screen.getByText('Tags: 0'));
    fireEvent.change(screen.getByPlaceholderText('Search tags...'), { target: { value: 'etch' } });
    expect(screen.getByText('etched')).toBeDefined();
    fireEvent.click(screen.getByTestId('Tags-menu').querySelectorAll('button')[1]);
    expect(props.setTagFilters).toHaveBeenCalledWith(new Set(['foil', 'etched']));
    fireEvent.click(screen.getByTestId('Tags-menu').querySelector('[title="Add to favorites"]')!);
    expect(prefState.toggleFavoriteMpcTag).toHaveBeenCalledWith('etched');
  });

  it('deselects all favorites when all favorites are active and expands collapsed sources', () => {
    const props = renderBar({
      filters: { minDpi: 1000, sourceFilters: new Set(['Favorite Source']), tagFilters: new Set(['foil']), sortBy: 'source', sortDir: 'desc' },
      allSourcesCollapsed: true,
    });

    fireEvent.click(screen.getByTitle('Deselect all favorites'));
    expect(props.setSourceFilters).toHaveBeenCalled();
    expect(props.setTagFilters).toHaveBeenCalled();

    fireEvent.click(screen.getByText('Expand All'));
    expect(props.setAllSourcesCollapsed).toHaveBeenCalledWith(false);
    expect(props.setCollapsedSources).toHaveBeenCalledWith(new Set());
  });
});
