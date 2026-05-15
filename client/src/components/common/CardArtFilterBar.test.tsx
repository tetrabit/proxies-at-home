import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const prefState = vi.hoisted(() => ({
  preferences: {
    favoriteMpcSources: ["Favorite Source"],
    favoriteMpcTags: ["foil"],
    favoriteMpcDpi: 1000 as number | null,
    favoriteMpcSort: "source" as "name" | "dpi" | "source" | null,
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

vi.mock("@/store", () => ({
  useUserPreferencesStore: (selector: (state: typeof prefState) => unknown) =>
    selector(prefState),
  useSettingsStore: (selector: (state: typeof settingsState) => unknown) =>
    selector(settingsState),
}));

vi.mock("./", () => ({
  SelectDropdown: ({
    label,
    buttonText,
    isOpen,
    onToggle,
    onClose,
    children,
  }: {
    label: string;
    buttonText: string;
    isOpen: boolean;
    onToggle: () => void;
    onClose: () => void;
    children: React.ReactNode;
  }) => (
    <section>
      <button onClick={onToggle}>
        {label}: {buttonText}
      </button>
      {isOpen && (
        <div data-testid={`${label}-menu`}>
          <button onClick={onClose}>close {label}</button>
          {children}
        </div>
      )}
    </section>
  ),
  MultiSelectDropdown: ({
    label,
    selectedCount,
    isOpen,
    onToggle,
    onClose,
    children,
  }: {
    label: string;
    selectedCount: number;
    isOpen: boolean;
    onToggle: () => void;
    onClose: () => void;
    children: React.ReactNode;
  }) => (
    <section>
      <button onClick={onToggle}>
        {label}: {selectedCount}
      </button>
      {isOpen && (
        <div data-testid={`${label}-menu`}>
          <button onClick={onClose}>close {label}</button>
          {children}
        </div>
      )}
    </section>
  ),
}));

import { CardArtFilterBar } from "./CardArtFilterBar";

const cards = [
  {
    id: "1",
    name: "A",
    sourceName: "Favorite Source",
    tags: ["foil"],
    dpi: 1000,
  },
  {
    id: "2",
    name: "B",
    sourceName: "Other Source",
    tags: ["etched"],
    dpi: 800,
  },
] as never;

function renderBar(
  overrides: Partial<React.ComponentProps<typeof CardArtFilterBar>> = {}
) {
  const props: React.ComponentProps<typeof CardArtFilterBar> = {
    filters: {
      minDpi: 0,
      sourceFilters: new Set<string>(),
      tagFilters: new Set<string>(),
      sortBy: "name",
      sortDir: "asc",
    },
    cards,
    filteredCards: [cards[0]] as never,
    groupedBySource: new Map([["Favorite Source", [cards[0]] as never]]),
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

describe("CardArtFilterBar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prefState.preferences = {
      favoriteMpcSources: ["Favorite Source"],
      favoriteMpcTags: ["foil"],
      favoriteMpcDpi: 1000,
      favoriteMpcSort: "source",
    };
    settingsState.mpcFuzzySearch = false;
  });

  it("renders counts, toggles fuzzy search, sort direction, and clear filters", () => {
    const props = renderBar({
      filters: {
        minDpi: 800,
        sourceFilters: new Set(["Favorite Source"]),
        tagFilters: new Set(["foil"]),
        sortBy: "source",
        sortDir: "asc",
      },
    });

    expect(screen.getByText("1")).toBeDefined();
    expect(screen.getByText("2")).toBeDefined();

    fireEvent.click(screen.getByTitle("Ascending"));
    expect(props.setSortDir).toHaveBeenCalledWith("desc");

    fireEvent.click(screen.getByText("Exact"));
    expect(settingsState.setMpcFuzzySearch).toHaveBeenCalledWith(true);

    fireEvent.click(screen.getByTitle("Clear all filters"));
    expect(props.clearFilters).toHaveBeenCalled();

    fireEvent.click(screen.getByText("Collapse All"));
    expect(props.setAllSourcesCollapsed).toHaveBeenCalledWith(true);
    expect(props.setCollapsedSources).toHaveBeenCalledWith(new Set());
  });

  it("selects and favorites DPI and sort options", () => {
    const props = renderBar();

    fireEvent.click(screen.getByText("DPI: Any"));
    fireEvent.click(screen.getAllByTitle("Set as favorite")[0]);
    expect(prefState.setFavoriteMpcDpi).toHaveBeenCalledWith(0);
    fireEvent.click(screen.getByText("800+"));
    expect(props.setMinDpi).toHaveBeenCalledWith(800);

    fireEvent.click(screen.getByText("Sort: Name"));
    fireEvent.click(screen.getByTitle("Remove from favorites"));
    expect(prefState.setFavoriteMpcSort).toHaveBeenCalledWith(null);
    fireEvent.click(screen.getByText("Source"));
    expect(props.setSortBy).toHaveBeenCalledWith("source");
  });

  it("handles source and tag dropdown search, selection, favorites, and bulk actions", () => {
    const props = renderBar();

    fireEvent.click(screen.getByText("Source: 0"));
    fireEvent.change(screen.getByPlaceholderText("Search sources..."), {
      target: { value: "other" },
    });
    expect(screen.getByText("Other Source")).toBeDefined();
    fireEvent.click(
      screen.getByTestId("Source-menu").querySelectorAll("button")[1]
    );
    expect(props.setSourceFilters).toHaveBeenCalledWith(
      new Set(["Favorite Source", "Other Source"])
    );
    fireEvent.click(screen.getByTitle("Add to favorites"));
    expect(prefState.toggleFavoriteMpcSource).toHaveBeenCalledWith(
      "Other Source"
    );

    fireEvent.click(screen.getByText("Tags: 0"));
    fireEvent.change(screen.getByPlaceholderText("Search tags..."), {
      target: { value: "etch" },
    });
    expect(screen.getByText("etched")).toBeDefined();
    fireEvent.click(
      screen.getByTestId("Tags-menu").querySelectorAll("button")[1]
    );
    expect(props.setTagFilters).toHaveBeenCalledWith(
      new Set(["foil", "etched"])
    );
    fireEvent.click(
      screen
        .getByTestId("Tags-menu")
        .querySelector('[title="Add to favorites"]')!
    );
    expect(prefState.toggleFavoriteMpcTag).toHaveBeenCalledWith("etched");
  });

  it("deselects all favorites when all favorites are active and expands collapsed sources", () => {
    const props = renderBar({
      filters: {
        minDpi: 1000,
        sourceFilters: new Set(["Favorite Source"]),
        tagFilters: new Set(["foil"]),
        sortBy: "source",
        sortDir: "desc",
      },
      allSourcesCollapsed: true,
    });

    fireEvent.click(screen.getByTitle("Deselect all favorites"));
    expect(props.setSourceFilters).toHaveBeenCalled();
    expect(props.setTagFilters).toHaveBeenCalled();

    fireEvent.click(screen.getByText("Expand All"));
    expect(props.setAllSourcesCollapsed).toHaveBeenCalledWith(false);
    expect(props.setCollapsedSources).toHaveBeenCalledWith(new Set());
  });

  it("selects favorite presets and clears favorite source/tag filters through updater callbacks", () => {
    const props = renderBar();

    fireEvent.click(screen.getByTitle("Select all favorites"));
    expect(props.setSourceFilters).toHaveBeenCalledWith(expect.any(Function));
    expect(props.setTagFilters).toHaveBeenCalledWith(expect.any(Function));
    expect(props.setMinDpi).toHaveBeenCalledWith(1000);
    expect(props.setSortBy).toHaveBeenCalledWith("source");

    const sourceUpdater = props.setSourceFilters.mock.calls[0][0] as (
      prev: Set<string>
    ) => Set<string>;
    const tagUpdater = props.setTagFilters.mock.calls[0][0] as (
      prev: Set<string>
    ) => Set<string>;
    expect(sourceUpdater(new Set()).has("Favorite Source")).toBe(true);
    expect(tagUpdater(new Set()).has("foil")).toBe(true);

    cleanup();
    const selectedProps = renderBar({
      filters: {
        minDpi: 0,
        sourceFilters: new Set(["Favorite Source"]),
        tagFilters: new Set(["foil"]),
        sortBy: "name",
        sortDir: "asc",
      },
    });

    fireEvent.click(screen.getByText("Source: 1"));
    fireEvent.click(screen.getByText("Clear Favorites"));
    const clearSourceUpdater = selectedProps.setSourceFilters.mock
      .calls[0][0] as (prev: Set<string>) => Set<string>;
    expect(
      clearSourceUpdater(new Set(["Favorite Source", "Other Source"]))
    ).toEqual(new Set(["Other Source"]));
    fireEvent.click(screen.getByTitle("Remove from favorites"));
    expect(prefState.toggleFavoriteMpcSource).toHaveBeenCalledWith(
      "Favorite Source"
    );

    fireEvent.click(screen.getByText("Tags: 1"));
    fireEvent.click(
      screen.getByTestId("Tags-menu").querySelectorAll("button")[2]
    );
    const clearTagUpdater = selectedProps.setTagFilters.mock.calls[0][0] as (
      prev: Set<string>
    ) => Set<string>;
    expect(clearTagUpdater(new Set(["foil", "etched"]))).toEqual(
      new Set(["etched"])
    );
    fireEvent.click(
      screen
        .getByTestId("Tags-menu")
        .querySelector('[title="Remove from favorites"]')!
    );
    expect(prefState.toggleFavoriteMpcTag).toHaveBeenCalledWith("foil");
  });

  it("keeps favorites with no results disabled and hides optional buttons without favorites or filters", () => {
    prefState.preferences = {
      favoriteMpcSources: ["Ghost Source"],
      favoriteMpcTags: ["ghost"],
      favoriteMpcDpi: null,
      favoriteMpcSort: null,
    };
    const props = renderBar();

    fireEvent.click(screen.getByText("Source: 0"));
    expect(screen.getByText("Ghost Source (no results)")).toBeDefined();
    const disabledSource = screen
      .getByText("Ghost Source (no results)")
      .parentElement!.querySelector("input")!;
    expect((disabledSource as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(disabledSource);
    expect(props.toggleSource).not.toHaveBeenCalledWith("Ghost Source");

    fireEvent.click(screen.getByText("Tags: 0"));
    expect(screen.getByText("ghost (no results)")).toBeDefined();
    const disabledTag = screen
      .getByText("ghost (no results)")
      .parentElement!.querySelector("input")!;
    expect((disabledTag as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(disabledTag);
    expect(props.toggleTag).not.toHaveBeenCalledWith("ghost");

    cleanup();
    prefState.preferences = {
      favoriteMpcSources: [],
      favoriteMpcTags: [],
      favoriteMpcDpi: null,
      favoriteMpcSort: null,
    };
    settingsState.mpcFuzzySearch = true;
    const noFavoriteProps = renderBar({
      filters: {
        minDpi: 0,
        sourceFilters: new Set(),
        tagFilters: new Set(),
        sortBy: "dpi",
        sortDir: "desc",
      },
      filteredCards: cards,
      groupedBySource: null,
    });

    expect(screen.queryByTitle("Select all favorites")).toBeNull();
    expect(screen.queryByTitle("Deselect all favorites")).toBeNull();
    expect(screen.queryByTitle("Clear all filters")).toBeNull();
    expect(screen.queryByText("Collapse All")).toBeNull();
    fireEvent.click(screen.getByText("Fuzzy"));
    expect(settingsState.setMpcFuzzySearch).toHaveBeenCalledWith(false);
    fireEvent.click(screen.getByTitle("Descending"));
    expect(noFavoriteProps.setSortDir).toHaveBeenCalledWith("asc");
    expect(screen.getByText("Sort: DPI")).toBeDefined();
  });
});
