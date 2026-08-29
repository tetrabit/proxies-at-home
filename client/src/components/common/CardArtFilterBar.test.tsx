import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

const prefState = vi.hoisted(() => ({
  preferences: {
    favoriteMpcSources: ['Favorite Source'],
    favoriteMpcTags: ['foil'],
    favoriteMpcDpi: 1000 as number | null,
    favoriteMpcSort: 'source' as 'name' | 'dpi' | 'source' | null,
  } as {
    favoriteMpcSources: string[];
    favoriteMpcTags: string[];
    favoriteMpcDpi: number | null;
    favoriteMpcSort: 'name' | 'dpi' | 'source' | null;
  } | undefined,
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
      fuzzySearch: false,
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
  const view = render(<CardArtFilterBar {...props} />);
  return Object.assign(props, view);
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
      filters: { fuzzySearch: false, minDpi: 800, sourceFilters: new Set(['Favorite Source']), tagFilters: new Set(['foil']), sortBy: 'source', sortDir: 'asc' },
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
    fireEvent.click(screen.getByText('DPI: Any'));
    fireEvent.click(screen.getByText('close DPI'));

    fireEvent.click(screen.getByText('Sort: Name'));
    fireEvent.click(screen.getByTitle('Remove from favorites'));
    expect(prefState.setFavoriteMpcSort).toHaveBeenCalledWith(null);
    fireEvent.click(screen.getByText('Source'));
    expect(props.setSortBy).toHaveBeenCalledWith('source');
    fireEvent.click(screen.getByText('Sort: Name'));
    fireEvent.click(screen.getByText('close Sort'));
  });

  it('handles source and tag dropdown search, selection, favorites, and bulk actions', () => {
    const props = renderBar();

    fireEvent.click(screen.getByText('Source: 0'));
    const sourceSearch = screen.getByPlaceholderText('Search sources...');
    fireEvent.change(sourceSearch, { target: { value: 'other' } });
    fireEvent.click(sourceSearch);
    expect(screen.getByText('Other Source')).toBeDefined();
    fireEvent.click(screen.getByTestId('Source-menu').querySelectorAll('button')[1]);
    expect(props.setSourceFilters).toHaveBeenCalledWith(new Set(['Favorite Source', 'Other Source']));
    fireEvent.click(screen.getByTestId('Source-menu').querySelectorAll('button')[2]);
    const selectFavoriteSources = (props.setSourceFilters as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0] as (prev: Set<string>) => Set<string>;
    expect(selectFavoriteSources(new Set()).has('Favorite Source')).toBe(true);
    fireEvent.click(screen.getByText('Other Source').parentElement!.querySelector('input')!);
    expect(props.toggleSource).toHaveBeenCalledWith('Other Source');
    fireEvent.click(screen.getByTitle('Add to favorites'));
    expect(prefState.toggleFavoriteMpcSource).toHaveBeenCalledWith('Other Source');
    fireEvent.click(screen.getByText('close Source'));

    fireEvent.click(screen.getByText('Tags: 0'));
    const tagSearch = screen.getByPlaceholderText('Search tags...');
    fireEvent.change(tagSearch, { target: { value: 'etch' } });
    fireEvent.click(tagSearch);
    expect(screen.getByText('etched')).toBeDefined();
    fireEvent.click(screen.getByTestId('Tags-menu').querySelectorAll('button')[1]);
    expect(props.setTagFilters).toHaveBeenCalledWith(new Set(['foil', 'etched']));
    fireEvent.click(screen.getByTestId('Tags-menu').querySelectorAll('button')[2]);
    const selectFavoriteTags = (props.setTagFilters as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0] as (prev: Set<string>) => Set<string>;
    expect(selectFavoriteTags(new Set()).has('foil')).toBe(true);
    fireEvent.click(screen.getByText('etched').parentElement!.querySelector('input')!);
    expect(props.toggleTag).toHaveBeenCalledWith('etched');
    fireEvent.click(screen.getByTestId('Tags-menu').querySelector('[title="Add to favorites"]')!);
    expect(prefState.toggleFavoriteMpcTag).toHaveBeenCalledWith('etched');
    fireEvent.click(screen.getByText('close Tags'));
  });

  it('deselects all favorites when all favorites are active and expands collapsed sources', () => {
    const props = renderBar({
      filters: { fuzzySearch: false, minDpi: 1000, sourceFilters: new Set(['Favorite Source']), tagFilters: new Set(['foil']), sortBy: 'source', sortDir: 'desc' },
      allSourcesCollapsed: true,
    });

    fireEvent.click(screen.getByTitle('Deselect all favorites'));
    expect(props.setSourceFilters).toHaveBeenCalled();
    expect(props.setTagFilters).toHaveBeenCalled();
    const removeFavoriteSources = (props.setSourceFilters as ReturnType<typeof vi.fn>).mock.calls[0][0] as (prev: Set<string>) => Set<string>;
    const removeFavoriteTags = (props.setTagFilters as ReturnType<typeof vi.fn>).mock.calls[0][0] as (prev: Set<string>) => Set<string>;
    expect(removeFavoriteSources(new Set(['Favorite Source', 'Other Source']))).toEqual(new Set(['Other Source']));
    expect(removeFavoriteTags(new Set(['foil', 'etched']))).toEqual(new Set(['etched']));

    fireEvent.click(screen.getByText('Expand All'));
    expect(props.setAllSourcesCollapsed).toHaveBeenCalledWith(false);
    expect(props.setCollapsedSources).toHaveBeenCalledWith(new Set());
  });

  it('selects favorite presets from the toolbar shortcut', () => {
    const props = renderBar();

    fireEvent.click(screen.getByTitle('Select all favorites'));
    expect(props.setSourceFilters).toHaveBeenCalledWith(expect.any(Function));
    expect(props.setTagFilters).toHaveBeenCalledWith(expect.any(Function));
    expect(props.setMinDpi).toHaveBeenCalledWith(1000);
    expect(props.setSortBy).toHaveBeenCalledWith('source');

    const sourceUpdater = props.setSourceFilters.mock.calls[0][0] as (prev: Set<string>) => Set<string>;
    const tagUpdater = props.setTagFilters.mock.calls[0][0] as (prev: Set<string>) => Set<string>;
    expect(sourceUpdater(new Set()).has('Favorite Source')).toBe(true);
    expect(tagUpdater(new Set()).has('foil')).toBe(true);
  });

  it('clears favorite source and tag filters through dropdown updaters', () => {
    const props = renderBar({
      filters: { fuzzySearch: false, minDpi: 0, sourceFilters: new Set(['Favorite Source']), tagFilters: new Set(['foil']), sortBy: 'name', sortDir: 'asc' },
    });

    fireEvent.click(screen.getByText('Source: 1'));
    fireEvent.click(screen.getByTestId('Source-menu').querySelectorAll('button')[2]);
    const clearSourceUpdater = props.setSourceFilters.mock.calls[0][0] as (prev: Set<string>) => Set<string>;
    expect(clearSourceUpdater(new Set(['Favorite Source', 'Other Source']))).toEqual(new Set(['Other Source']));
    fireEvent.click(screen.getByTestId('Source-menu').querySelector('[title="Remove from favorites"]')!);
    expect(prefState.toggleFavoriteMpcSource).toHaveBeenCalledWith('Favorite Source');

    fireEvent.click(screen.getByText('Tags: 1'));
    fireEvent.click(screen.getByTestId('Tags-menu').querySelectorAll('button')[2]);
    const clearTagUpdater = props.setTagFilters.mock.calls[0][0] as (prev: Set<string>) => Set<string>;
    expect(clearTagUpdater(new Set(['foil', 'etched']))).toEqual(new Set(['etched']));
    fireEvent.click(screen.getByTestId('Tags-menu').querySelector('[title="Remove from favorites"]')!);
    expect(prefState.toggleFavoriteMpcTag).toHaveBeenCalledWith('foil');
  });

  it('keeps no-result favorites disabled', () => {
    prefState.preferences = {
      favoriteMpcSources: ['Ghost Source'],
      favoriteMpcTags: ['ghost'],
      favoriteMpcDpi: null,
      favoriteMpcSort: null,
    };
    const props = renderBar();

    fireEvent.click(screen.getByText('Source: 0'));
    const disabledSource = screen.getByText('Ghost Source (no results)').parentElement!.querySelector('input')!;
    expect((disabledSource as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(disabledSource);
    expect(props.toggleSource).not.toHaveBeenCalledWith('Ghost Source');

    fireEvent.click(screen.getByText('Tags: 0'));
    const disabledTag = screen.getByText('ghost (no results)').parentElement!.querySelector('input')!;
    expect((disabledTag as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(disabledTag);
    expect(props.toggleTag).not.toHaveBeenCalledWith('ghost');
  });

  it('selects each favorite category independently and skips unavailable favorite values', () => {
    const cases = [
      { sources: ['Favorite Source', 'Ghost Source'], tags: [], dpi: null, sort: null },
      { sources: [], tags: ['foil', 'ghost'], dpi: null, sort: null },
      { sources: [], tags: [], dpi: 1000, sort: null },
      { sources: [], tags: [], dpi: null, sort: 'source' as const },
    ];

    for (const entry of cases) {
      prefState.preferences = {
        favoriteMpcSources: entry.sources,
        favoriteMpcTags: entry.tags,
        favoriteMpcDpi: entry.dpi,
        favoriteMpcSort: entry.sort,
      };
      const view = renderBar({
        cards: [...cards, { id: '3', name: 'No Tags', sourceName: 'Third Source', dpi: 600 }] as never,
      });
      fireEvent.click(screen.getByTitle('Select all favorites'));

      if (entry.sources.length) {
        const updater = (view.setSourceFilters as ReturnType<typeof vi.fn>).mock.calls[0][0] as (prev: Set<string>) => Set<string>;
        expect(updater(new Set())).toEqual(new Set(['Favorite Source']));
      }
      if (entry.tags.length) {
        const updater = (view.setTagFilters as ReturnType<typeof vi.fn>).mock.calls[0][0] as (prev: Set<string>) => Set<string>;
        expect(updater(new Set())).toEqual(new Set(['foil']));
      }
      if (entry.dpi !== null) expect(view.setMinDpi).toHaveBeenCalledWith(entry.dpi);
      if (entry.sort !== null) expect(view.setSortBy).toHaveBeenCalledWith(entry.sort);

      view.unmount();
      vi.clearAllMocks();
    }
  });

  it('handles exact default favorites, removal toggles, and populated bulk clears', () => {
    prefState.preferences = {
      favoriteMpcSources: [],
      favoriteMpcTags: [],
      favoriteMpcDpi: 800,
      favoriteMpcSort: 'dpi',
    };
    const props = renderBar({
      filters: {
        fuzzySearch: false,
        minDpi: 800,
        sourceFilters: new Set(['Other Source']),
        tagFilters: new Set(['etched']),
        sortBy: 'dpi',
        sortDir: 'asc',
      },
    });

    fireEvent.click(screen.getByTitle('Deselect all favorites'));
    expect(props.setMinDpi).not.toHaveBeenCalled();
    expect(props.setSortBy).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('DPI: 800+'));
    fireEvent.click(screen.getByTitle('Remove from favorites'));
    expect(prefState.setFavoriteMpcDpi).toHaveBeenCalledWith(null);

    fireEvent.click(screen.getByText('Sort: DPI'));
    fireEvent.click(screen.getByTestId('Sort-menu').querySelector('[title="Set as favorite"]')!);
    expect(prefState.setFavoriteMpcSort).toHaveBeenCalledWith('name');
    fireEvent.click(screen.getByText('Name'));
    expect(props.setSortBy).toHaveBeenCalledWith('name');

    fireEvent.click(screen.getByText('Source: 1'));
    fireEvent.click(screen.getByText('Clear All'));
    expect(props.setSourceFilters).toHaveBeenCalledWith(new Set());
    fireEvent.click(screen.getByText('close Source'));

    fireEvent.click(screen.getByText('Tags: 1'));
    fireEvent.click(screen.getByText('Clear All'));
    expect(props.setTagFilters).toHaveBeenCalledWith(new Set());
  });

  it('uses empty preference defaults when preferences are unavailable', () => {
    prefState.preferences = undefined;
    renderBar();

    expect(screen.queryByTitle('Select all favorites')).toBeNull();
    expect(screen.getByText('DPI: Any')).toBeDefined();
    expect(screen.getByText('Sort: Name')).toBeDefined();
  });

  it('hides optional controls without favorites or active filters', () => {
    prefState.preferences = {
      favoriteMpcSources: [],
      favoriteMpcTags: [],
      favoriteMpcDpi: null,
      favoriteMpcSort: null,
    };
    settingsState.mpcFuzzySearch = true;
    const props = renderBar({
      filters: { fuzzySearch: false, minDpi: 0, sourceFilters: new Set(), tagFilters: new Set(), sortBy: 'dpi', sortDir: 'desc' },
      filteredCards: cards,
      groupedBySource: null,
    });

    expect(screen.queryByTitle('Select all favorites')).toBeNull();
    expect(screen.queryByTitle('Deselect all favorites')).toBeNull();
    expect(screen.queryByTitle('Clear all filters')).toBeNull();
    expect(screen.queryByText('Collapse All')).toBeNull();
    fireEvent.click(screen.getByText('Fuzzy'));
    expect(settingsState.setMpcFuzzySearch).toHaveBeenCalledWith(false);
    fireEvent.click(screen.getByTitle('Descending'));
    expect(props.setSortDir).toHaveBeenCalledWith('asc');
    expect(screen.getByText('Sort: DPI')).toBeDefined();
  });
});
