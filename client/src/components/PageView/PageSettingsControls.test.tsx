import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  preferences: {
    settingsPanelState: undefined as undefined | { order: string[]; collapsed: Record<string, boolean> },
    isSettingsPanelCollapsed: false,
  },
  setSettingsPanelState: vi.fn(),
  setIsSettingsPanelCollapsed: vi.fn(),
  filterManaCost: ['1'],
  filterColors: ['U'],
  filterTypes: [] as string[],
  filterCategories: ['creature'],
  setFilterManaCost: vi.fn(),
  setFilterColors: vi.fn(),
  setFilterTypes: vi.fn(),
  setFilterCategories: vi.fn(),
  isLandscape: false,
}));

vi.mock('@/store/userPreferences', () => ({
  useUserPreferencesStore: (selector: (state: { preferences: typeof mocks.preferences; setSettingsPanelState: typeof mocks.setSettingsPanelState; setIsSettingsPanelCollapsed: typeof mocks.setIsSettingsPanelCollapsed }) => unknown) => selector({
    preferences: mocks.preferences,
    setSettingsPanelState: mocks.setSettingsPanelState,
    setIsSettingsPanelCollapsed: mocks.setIsSettingsPanelCollapsed,
  }),
}));

vi.mock('@/store/settings', () => ({
  useSettingsStore: (selector: (state: {
    filterManaCost: string[];
    filterColors: string[];
    filterTypes: string[];
    filterCategories: string[];
    setFilterManaCost: typeof mocks.setFilterManaCost;
    setFilterColors: typeof mocks.setFilterColors;
    setFilterTypes: typeof mocks.setFilterTypes;
    setFilterCategories: typeof mocks.setFilterCategories;
  }) => unknown) => selector({
    filterManaCost: mocks.filterManaCost,
    filterColors: mocks.filterColors,
    filterTypes: mocks.filterTypes,
    filterCategories: mocks.filterCategories,
    setFilterManaCost: mocks.setFilterManaCost,
    setFilterColors: mocks.setFilterColors,
    setFilterTypes: mocks.setFilterTypes,
    setFilterCategories: mocks.setFilterCategories,
  }),
}));

vi.mock('@/hooks/useMediaQuery', () => ({
  useMediaQuery: () => mocks.isLandscape,
}));


vi.mock('@/hooks/useImageProcessing', () => ({
  useImageProcessing: () => ({ reprocessSelectedImages: vi.fn(), cancelProcessing: vi.fn() }),
}));

vi.mock('@dnd-kit/core', () => ({
  MouseSensor: vi.fn(),
  TouchSensor: vi.fn(),
  KeyboardSensor: vi.fn(),
  closestCenter: vi.fn(),
  useSensor: vi.fn(() => ({})),
  useSensors: vi.fn(() => []),
  DndContext: ({
    children,
    onDragStart,
    onDragEnd,
  }: {
    children: React.ReactNode;
    onDragStart: (event: { active: { id: string } }) => void;
    onDragEnd: (event: { active: { id: string }; over: { id: string } | null }) => void;
  }) => (
    <div data-testid="dnd-context">
      <button type="button" onClick={() => onDragStart({ active: { id: 'layout' } })}>mock drag start</button>
      <button type="button" onClick={() => onDragEnd({ active: { id: 'layout' }, over: { id: 'projects' } })}>mock drag reorder</button>
      <button type="button" onClick={() => onDragEnd({ active: { id: 'layout' }, over: null })}>mock drag cancel</button>
      {children}
    </div>
  ),
}));

vi.mock('@dnd-kit/modifiers', () => ({
  restrictToVerticalAxis: vi.fn(),
  restrictToParentElement: vi.fn(),
}));

vi.mock('@dnd-kit/sortable', () => ({
  arrayMove: (items: unknown[], from: number, to: number) => {
    const copy = [...items];
    const [item] = copy.splice(from, 1);
    copy.splice(to, 0, item);
    return copy;
  },
  SortableContext: ({ children }: { children: React.ReactNode }) => <div data-testid="sortable-context">{children}</div>,
  sortableKeyboardCoordinates: vi.fn(),
  verticalListSortingStrategy: 'vertical',
  rectSortingStrategy: 'rect',
}));

vi.mock('../common', () => ({
  AutoTooltip: ({ children, content }: { children: React.ReactNode; content: string }) => <span data-tooltip={content}>{children}</span>,
}));

vi.mock('../PullToRefresh', () => ({
  PullToRefresh: React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(({ children, onScroll, ...props }, ref) => (
    <div ref={ref} onScroll={onScroll} {...props}>{children}</div>
  )),
}));

vi.mock('../SettingsPanel/SettingsPanel', () => ({
  SettingsPanel: ({ id, title, isOpen, onToggle, badge, onClearBadge, children }: { id: string; title: string; isOpen: boolean; onToggle: () => void; badge?: number; onClearBadge?: () => void; children: React.ReactNode }) => (
    <section id={`settings-panel-${id}`} data-open={String(isOpen)}>
      <button onClick={onToggle}>{title}</button>
      {badge ? <button onClick={onClearBadge}>Clear badge {badge}</button> : null}
      {isOpen ? children : null}
    </section>
  ),
}));

vi.mock('../SettingsPanel/sections/ProjectsSection', () => ({ ProjectsSection: () => <div>Projects Section</div> }));
vi.mock('../SettingsPanel/sections/LayoutSection', () => ({ LayoutSection: () => <div>Layout Section</div> }));
vi.mock('../SettingsPanel/sections/BleedSection', () => ({ BleedSection: () => <div>Bleed Section</div> }));
vi.mock('../SettingsPanel/sections/DarkenSection', () => ({ DarkenSection: () => <div>Darken Section</div> }));
vi.mock('../SettingsPanel/sections/GuidesSection', () => ({ GuidesSection: () => <div>Guides Section</div> }));
vi.mock('../SettingsPanel/sections/CardSection', () => ({ CardSection: () => <div>Card Section</div> }));
vi.mock('../SettingsPanel/sections/FilterSortSection', () => ({ FilterSortSection: ({ cards }: { cards: unknown[] }) => <div>FilterSort Section {cards.length}</div> }));
vi.mock('../SettingsPanel/sections/ExportSection', () => ({ ExportSection: ({ cards }: { cards: unknown[] }) => <div>Export Section {cards.length}</div> }));
vi.mock('../SettingsPanel/sections/ApplicationSection', () => ({ ApplicationSection: () => <div>Application Section</div> }));

import { PageSettingsControls } from './PageSettingsControls';

const cards = [{ id: 'card-1' }] as never[];

function renderControls(props: Partial<React.ComponentProps<typeof PageSettingsControls>> = {}) {
  return render(<PageSettingsControls cards={cards} reprocessSelectedImages={vi.fn() as never} cancelProcessing={vi.fn() as never} {...props} />);
}

describe('PageSettingsControls', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    mocks.preferences.settingsPanelState = undefined;
    mocks.preferences.isSettingsPanelCollapsed = false;
    mocks.filterManaCost = ['1'];
    mocks.filterColors = ['U'];
    mocks.filterTypes = [];
    mocks.filterCategories = ['creature'];
    mocks.isLandscape = false;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders the default panel order with filter badge clearing', () => {
    renderControls();

    expect(screen.getByText('Settings')).toBeDefined();
    expect(screen.getByText('Projects Section')).toBeDefined();
    expect(screen.getByText('FilterSort Section 1')).toBeDefined();
    expect(screen.getByText('Export Section 1')).toBeDefined();

    fireEvent.click(screen.getByText('Clear badge 3'));
    expect(mocks.setFilterManaCost).toHaveBeenCalledWith([]);
    expect(mocks.setFilterColors).toHaveBeenCalledWith([]);
    expect(mocks.setFilterTypes).toHaveBeenCalledWith([]);
    expect(mocks.setFilterCategories).toHaveBeenCalledWith([]);
  });

  it('collapses or expands all sections based on current collapsed count', () => {
    const order = ['projects', 'layout', 'filterSort', 'export'];
    mocks.preferences.settingsPanelState = { order, collapsed: {} };
    renderControls();

    fireEvent.click(screen.getByLabelText('Collapse all sections'));
    expect(mocks.setSettingsPanelState).toHaveBeenCalledWith({ order, collapsed: { projects: true, layout: true, filterSort: true, export: true } });

    mocks.preferences.settingsPanelState = { order, collapsed: { projects: true, layout: true } };
    renderControls();
    fireEvent.click(screen.getByLabelText('Expand all sections'));
    expect(mocks.setSettingsPanelState).toHaveBeenCalledWith({ order, collapsed: {} });
  });

  it('renders collapsed icon rail and expands a collapsed target section', () => {
    vi.useFakeTimers();
    const scrollIntoView = vi.fn();
    const target = document.createElement('div');
    target.id = 'settings-panel-export';
    target.scrollIntoView = scrollIntoView;
    document.body.appendChild(target);
    mocks.preferences.isSettingsPanelCollapsed = true;
    mocks.preferences.settingsPanelState = { order: ['projects', 'export'], collapsed: { export: true } };

    const { container } = renderControls({ mobile: true });
    fireEvent.dblClick(container.firstElementChild as HTMLElement);
    expect(mocks.setIsSettingsPanelCollapsed).toHaveBeenCalledWith(false);

    fireEvent.click(screen.getAllByRole('button')[1]);
    expect(mocks.setSettingsPanelState).toHaveBeenCalledWith({
      order: ['projects', 'export'],
      collapsed: { export: false },
    });
    vi.advanceTimersByTime(100);
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' });
    target.remove();
  });

  it('renders every collapsed rail icon label branch', () => {
    mocks.preferences.isSettingsPanelCollapsed = true;
    mocks.preferences.settingsPanelState = {
      order: ['projects', 'layout', 'bleed', 'darken', 'guides', 'card', 'filterSort', 'export', 'application'],
      collapsed: {},
    };

    renderControls();

    expect(screen.getByText('Projects').parentElement).toHaveAttribute('data-tooltip', 'Projects');
    expect(screen.getByText('Layout').parentElement).toHaveAttribute('data-tooltip', 'Layout');
    expect(screen.getByText('Bleed').parentElement).toHaveAttribute('data-tooltip', 'Bleed');
    expect(screen.getByText('Darken').parentElement).toHaveAttribute('data-tooltip', 'Darken');
    expect(screen.getByText('Guides').parentElement).toHaveAttribute('data-tooltip', 'Guides');
    expect(screen.getByText('Card').parentElement).toHaveAttribute('data-tooltip', 'Card');
    expect(screen.getByText('Filter & Sort').parentElement).toHaveAttribute('data-tooltip', 'Filter & Sort');
    expect(screen.getByText('Export').parentElement).toHaveAttribute('data-tooltip', 'Export');
    expect(screen.getByText('Application').parentElement).toHaveAttribute('data-tooltip', 'Application');
  });

  it('uses the mobile landscape two-column layout when requested', () => {
    mocks.isLandscape = true;
    mocks.preferences.settingsPanelState = { order: ['projects', 'layout', 'export', 'application'], collapsed: {} };
    renderControls({ mobile: true });

    expect(screen.getByText('Projects Section')).toBeDefined();
    expect(screen.getByText('Layout Section')).toBeDefined();
    expect(screen.getByText('Export Section 1')).toBeDefined();
    expect(screen.getByText('Application Section')).toBeDefined();
  });

  it('records scroll position and reorders panels through drag callbacks', () => {
    const order = ['projects', 'layout', 'filterSort', 'unknown'];
    mocks.preferences.settingsPanelState = { order, collapsed: {} };
    const { container } = renderControls();

    const scrollRoot = container.firstElementChild as HTMLElement;
    Object.defineProperty(scrollRoot, 'scrollTop', { value: 123, writable: true });
    fireEvent.scroll(scrollRoot);

    fireEvent.click(screen.getByText('mock drag start'));
    fireEvent.click(screen.getByText('mock drag reorder'));
    expect(mocks.setSettingsPanelState).toHaveBeenCalledWith({
      order: ['layout', 'projects', 'filterSort', 'unknown'],
      collapsed: {},
    });

    fireEvent.click(screen.getByText('mock drag cancel'));
    expect(screen.queryByText('unknown')).toBeNull();
  });
});
