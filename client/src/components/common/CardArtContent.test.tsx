import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CardArtContent } from "./CardArtContent";

type SearchState = {
  cards: Array<Record<string, unknown>>;
  isLoading: boolean;
  hasSearched: boolean;
  hasResults: boolean;
};

type PrintsState = {
  prints: Array<Record<string, unknown>>;
  isLoading: boolean;
  hasSearched: boolean;
  hasResults: boolean;
};

type MpcCard = {
  identifier: string;
  name: string;
  rawName: string;
  smallThumbnailUrl: string;
  mediumThumbnailUrl: string;
  dpi: number;
  tags: string[];
  sourceName: string;
  source: string;
  extension: string;
  size: number;
};

type MpcState = {
  filteredCards: MpcCard[];
  activeFilterCount: number;
  hasSearched: boolean;
  cards: MpcCard[];
  groupedBySource: Map<string, MpcCard[]> | null;
  filters: {
    minDpi: number;
    sourceFilters: Set<string>;
    tagFilters: Set<string>;
    sortBy: "name" | "dpi" | "source";
    sortDir: "asc" | "desc";
  };
  setMinDpi: ReturnType<typeof vi.fn>;
  setSortBy: ReturnType<typeof vi.fn>;
  setSortDir: ReturnType<typeof vi.fn>;
  toggleSource: ReturnType<typeof vi.fn>;
  toggleTag: ReturnType<typeof vi.fn>;
  toggleDpi: ReturnType<typeof vi.fn>;
  clearFilters: ReturnType<typeof vi.fn>;
  setSourceFilters: ReturnType<typeof vi.fn>;
  setTagFilters: ReturnType<typeof vi.fn>;
};

const cardOne = vi.hoisted<MpcCard>(() => ({
  identifier: "mpc-alpha-card-id",
  name: "Alpha Art",
  rawName: "Alpha Art",
  smallThumbnailUrl: "https://thumbs.example/alpha.jpg",
  mediumThumbnailUrl: "https://thumbs.example/alpha-medium.jpg",
  dpi: 800,
  tags: ["foil", "showcase", "borderless", "extra"],
  sourceName: "Source A",
  source: "source-a",
  extension: "jpg",
  size: 1,
}));

const cardTwo = vi.hoisted<MpcCard>(() => ({
  identifier: "mpc-beta-card-id",
  name: "Beta Art",
  rawName: "Beta Art",
  smallThumbnailUrl: "",
  mediumThumbnailUrl: "https://thumbs.example/beta-medium.jpg",
  dpi: 1200,
  tags: ["etched"],
  sourceName: "Source B",
  source: "source-b",
  extension: "jpg",
  size: 1,
}));

const mocked = vi.hoisted(() => ({
  scryfallSearch: {
    cards: [],
    isLoading: false,
    hasSearched: true,
    hasResults: false,
  } as SearchState,
  scryfallPrints: {
    prints: [
      {
        imageUrl: "https://example.com/front.png",
        set: "set1",
        number: "1",
        faceName: "Front Face",
      },
      {
        imageUrl: "https://example.com/back.png",
        set: "set1",
        number: "1",
        faceName: "Back Face",
      },
    ],
    isLoading: false,
    hasSearched: true,
    hasResults: true,
  } as PrintsState,
  mpc: {
    filteredCards: [],
    activeFilterCount: 0,
    hasSearched: false,
    cards: [],
    groupedBySource: new Map(),
    filters: {
      minDpi: 0,
      sourceFilters: new Set<string>(),
      tagFilters: new Set<string>(),
      sortBy: "name" as const,
      sortDir: "asc" as const,
    },
    setMinDpi: vi.fn(),
    setSortBy: vi.fn(),
    setSortDir: vi.fn(),
    toggleSource: vi.fn(),
    toggleTag: vi.fn(),
    toggleDpi: vi.fn(),
    clearFilters: vi.fn(),
    setSourceFilters: vi.fn(),
    setTagFilters: vi.fn(),
  } as MpcState,
  prefs: {
    preferences: { favoriteMpcSources: [] as string[] },
    toggleFavoriteMpcSource: vi.fn(),
  },
  searchCalls: [] as Array<{ query: string; options: Record<string, unknown> }>,
  printsCalls: [] as Array<Record<string, unknown>>,
  mpcCalls: [] as Array<{ query: string; options: Record<string, unknown> }>,
}));

vi.mock("@/hooks/useScryfallSearch", () => ({
  useScryfallSearch: (query: string, options: Record<string, unknown>) => {
    mocked.searchCalls.push({ query, options });
    return mocked.scryfallSearch;
  },
}));

vi.mock("@/hooks/useScryfallPrints", () => ({
  useScryfallPrints: (options: Record<string, unknown>) => {
    mocked.printsCalls.push(options);
    return mocked.scryfallPrints;
  },
}));

vi.mock("@/hooks/useMpcSearch", () => ({
  useMpcSearch: (query: string, options: Record<string, unknown>) => {
    mocked.mpcCalls.push({ query, options });
    return mocked.mpc;
  },
}));

vi.mock("@/store", () => ({
  useUserPreferencesStore: (
    selector: (state: typeof mocked.prefs) => unknown
  ) => selector(mocked.prefs),
}));

vi.mock("./CardImageSvg", () => ({
  CardImageSvg: ({
    url,
    fallbackUrl,
    id,
  }: {
    url: string;
    fallbackUrl?: string;
    id: string;
  }) => (
    <img
      src={url}
      alt={id}
      data-testid="card-image"
      data-fallback={fallbackUrl ?? ""}
    />
  ),
}));

vi.mock("./CardArtFilterBar", () => ({
  CardArtFilterBar: ({
    clearFilters,
    setMinDpi,
    setSortBy,
    setSortDir,
  }: {
    clearFilters: () => void;
    setMinDpi: (dpi: number) => void;
    setSortBy: (sort: "name" | "dpi" | "source") => void;
    setSortDir: (dir: "asc" | "desc") => void;
  }) => (
    <div data-testid="mpc-filter-bar">
      <button onClick={clearFilters}>filter clear</button>
      <button onClick={() => setMinDpi(1000)}>filter dpi</button>
      <button onClick={() => setSortBy("dpi")}>filter sort</button>
      <button onClick={() => setSortDir("desc")}>filter dir</button>
    </div>
  ),
}));

function resetMockedState() {
  vi.clearAllMocks();
  mocked.searchCalls.length = 0;
  mocked.printsCalls.length = 0;
  mocked.mpcCalls.length = 0;
  mocked.scryfallSearch = {
    cards: [],
    isLoading: false,
    hasSearched: true,
    hasResults: false,
  };
  mocked.scryfallPrints = {
    prints: [
      {
        imageUrl: "https://example.com/front.png",
        set: "set1",
        number: "1",
        faceName: "Front Face",
      },
      {
        imageUrl: "https://example.com/back.png",
        set: "set1",
        number: "1",
        faceName: "Back Face",
      },
    ],
    isLoading: false,
    hasSearched: true,
    hasResults: true,
  };
  mocked.mpc = {
    filteredCards: [],
    activeFilterCount: 0,
    hasSearched: false,
    cards: [],
    groupedBySource: new Map(),
    filters: {
      minDpi: 0,
      sourceFilters: new Set<string>(),
      tagFilters: new Set<string>(),
      sortBy: "name",
      sortDir: "asc",
    },
    setMinDpi: vi.fn(),
    setSortBy: vi.fn(),
    setSortDir: vi.fn(),
    toggleSource: vi.fn(),
    toggleTag: vi.fn(),
    toggleDpi: vi.fn(),
    clearFilters: vi.fn(),
    setSourceFilters: vi.fn(),
    setTagFilters: vi.fn(),
  };
  mocked.prefs = {
    preferences: { favoriteMpcSources: [] },
    toggleFavoriteMpcSource: vi.fn(),
  };
}

describe("CardArtContent", () => {
  beforeEach(resetMockedState);

  it("shows back-face print when selectedFace is back in prints mode", () => {
    const onSelectCard = vi.fn();

    render(
      <CardArtContent
        artSource="scryfall"
        mode="prints"
        query="Back Face"
        selectedFace="back"
        onSelectCard={onSelectCard}
        isActive={true}
      />
    );

    expect(mocked.printsCalls[0]).toMatchObject({
      name: "Back Face",
      enabled: true,
      initialPrints: undefined,
    });

    const artCards = screen.getAllByTestId("artwork-card");
    expect(artCards).toHaveLength(1);

    fireEvent.click(artCards[0]);
    expect(onSelectCard).toHaveBeenCalledWith(
      "Back Face",
      "https://example.com/back.png"
    );
  });

  it("renders Scryfall search cards, selected processed art, and DFC flips", () => {
    mocked.scryfallSearch = {
      isLoading: false,
      hasSearched: true,
      hasResults: true,
      cards: [
        {
          name: "Single Face",
          imageUrls: ["https://img.example/single.png"],
          set: "one",
          number: "1",
        },
        {
          name: "Double Face",
          imageUrls: ["https://img.example/front-fallback.png"],
          card_faces: [
            { imageUrl: "https://img.example/front.png" },
            { imageUrl: "https://img.example/back.png" },
          ],
          set: "dfc",
          number: "42",
        },
      ],
    };
    const onSelectCard = vi.fn();

    render(
      <CardArtContent
        artSource="scryfall"
        mode="search"
        query="Double Face"
        selectedArtId="https://img.example/back.png?cache-bust=1"
        processedDisplayUrl="https://processed.example/current.png"
        onSelectCard={onSelectCard}
        isActive
      />
    );

    expect(mocked.searchCalls[0]).toMatchObject({
      query: "Double Face",
      options: { autoSearch: true },
    });
    expect(mocked.mpcCalls[0]).toMatchObject({
      query: "",
      options: { autoSearch: true },
    });
    expect(screen.getAllByTestId("artwork-card")).toHaveLength(2);
    expect(screen.getByAltText("scry-1-front").getAttribute("src")).toBe(
      "https://processed.example/current.png"
    );

    fireEvent.click(
      screen
        .getByAltText("scry-1-front")
        .closest("[data-testid='artwork-card']")!
    );
    expect(onSelectCard).toHaveBeenLastCalledWith(
      "Double Face",
      "https://img.example/front.png",
      {
        set: "dfc",
        number: "42",
      }
    );

    fireEvent.click(screen.getByTitle("Show back"));
    expect(screen.getByAltText("scry-1-back").getAttribute("src")).toBe(
      "https://processed.example/current.png"
    );
    fireEvent.click(
      screen
        .getByAltText("scry-1-back")
        .closest("[data-testid='artwork-card']")!
    );
    expect(onSelectCard).toHaveBeenLastCalledWith(
      "Double Face",
      "https://img.example/back.png",
      {
        set: "dfc",
        number: "42",
      }
    );

    fireEvent.click(
      screen
        .getByAltText("scry-0-front")
        .closest("[data-testid='artwork-card']")!
    );
    expect(onSelectCard).toHaveBeenLastCalledWith(
      "Single Face",
      "https://img.example/single.png",
      {
        set: "one",
        number: "1",
      }
    );
  });

  it("renders grouped MPC cards, forwards filters, favorites, and badge clicks", () => {
    mocked.mpc = {
      ...mocked.mpc,
      cards: [cardOne, cardTwo],
      filteredCards: [cardOne, cardTwo],
      activeFilterCount: 2,
      hasSearched: true,
      groupedBySource: new Map([
        ["Source A", [cardOne]],
        ["Source B", [cardTwo]],
      ]),
      filters: {
        minDpi: 800,
        sourceFilters: new Set(["Source A"]),
        tagFilters: new Set(["foil"]),
        sortBy: "source",
        sortDir: "asc",
      },
    };
    mocked.prefs.preferences.favoriteMpcSources = ["Source A"];
    const onSelectCard = vi.fn();
    const onSelectMpcCard = vi.fn();
    const onFilterCountChange = vi.fn();

    render(
      <CardArtContent
        artSource="mpc"
        query="Alpha"
        cardTypeLine="Token Creature"
        selectedArtId="/api/cards/images/mpc?id=mpc-beta-card-id"
        onSelectCard={onSelectCard}
        onSelectMpcCard={onSelectMpcCard}
        onFilterCountChange={onFilterCountChange}
        isActive
      />
    );

    expect(mocked.mpcCalls[0]).toMatchObject({
      query: "Alpha",
      options: { autoSearch: true, cardData: { type_line: "Token Creature" } },
    });
    expect(onFilterCountChange).toHaveBeenCalledWith(2);
    expect(screen.getByTestId("mpc-filter-bar")).toBeDefined();

    fireEvent.click(screen.getByText("filter clear"));
    fireEvent.click(screen.getByText("filter dpi"));
    fireEvent.click(screen.getByText("filter sort"));
    fireEvent.click(screen.getByText("filter dir"));
    expect(mocked.mpc.clearFilters).toHaveBeenCalled();
    expect(mocked.mpc.setMinDpi).toHaveBeenCalledWith(1000);
    expect(mocked.mpc.setSortBy).toHaveBeenCalledWith("dpi");
    expect(mocked.mpc.setSortDir).toHaveBeenCalledWith("desc");

    fireEvent.click(screen.getByText("800 DPI"));
    expect(mocked.mpc.toggleDpi).toHaveBeenCalledWith(800);
    fireEvent.click(screen.getAllByText("Source A")[1]);
    expect(mocked.mpc.toggleSource).toHaveBeenCalledWith("Source A");
    fireEvent.click(screen.getByText("foil"));
    expect(mocked.mpc.toggleTag).toHaveBeenCalledWith("foil");
    expect(screen.queryByText("extra")).toBeNull();

    fireEvent.click(screen.getByTitle("Remove from favorites"));
    expect(mocked.prefs.toggleFavoriteMpcSource).toHaveBeenCalledWith(
      "Source A"
    );

    fireEvent.click(
      screen
        .getByAltText("mpc-alpha-card-id")
        .closest("[data-testid='artwork-card']")!
    );
    expect(onSelectMpcCard).toHaveBeenCalledWith(cardOne);
    expect(onSelectCard).not.toHaveBeenCalled();

    const sourceBHeader = screen
      .getAllByText("Source B")
      .map((node) => node.closest('[role="button"]'))
      .find(Boolean)!;
    expect(screen.getByAltText("mpc-beta-card-id")).toBeDefined();
    fireEvent.keyDown(sourceBHeader, { key: " " });
    expect(screen.queryByAltText("mpc-beta-card-id")).toBeNull();
    fireEvent.keyDown(sourceBHeader, { key: "Enter" });
    expect(screen.getByAltText("mpc-beta-card-id")).toBeDefined();
  });

  it("uses fallback MPC selection and stable active-sort behavior for flat grids", () => {
    mocked.mpc = {
      ...mocked.mpc,
      cards: [cardOne, cardTwo],
      filteredCards: [cardOne, cardTwo],
      hasSearched: true,
      groupedBySource: null,
      filters: {
        minDpi: 0,
        sourceFilters: new Set<string>(),
        tagFilters: new Set<string>(),
        sortBy: "name",
        sortDir: "asc",
      },
    };
    const onSelectCard = vi.fn();

    const { rerender } = render(
      <CardArtContent
        artSource="mpc"
        query="Alpha"
        selectedArtId="/api/cards/images/mpc?id=mpc-beta-card-id"
        onSelectCard={onSelectCard}
        isActive={false}
      />
    );
    rerender(
      <CardArtContent
        artSource="mpc"
        query="Alpha"
        selectedArtId="/api/cards/images/mpc?id=mpc-beta-card-id"
        onSelectCard={onSelectCard}
        isActive
      />
    );

    const cards = screen.getAllByTestId("artwork-card");
    expect(within(cards[0]).getByAltText("mpc-beta-card-id")).toBeDefined();
    fireEvent.click(cards[0]);
    expect(onSelectCard).toHaveBeenCalledWith(
      "Beta Art",
      expect.stringContaining("mpc-beta-card-id")
    );
  });

  it("shows filtered-out and empty MPC states with recovery actions", () => {
    mocked.mpc = {
      ...mocked.mpc,
      cards: [cardOne, cardTwo],
      filteredCards: [],
      hasSearched: true,
      groupedBySource: new Map([["Source A", [cardOne]]]),
      filters: {
        minDpi: 1400,
        sourceFilters: new Set(["Source A"]),
        tagFilters: new Set<string>(),
        sortBy: "source",
        sortDir: "asc",
      },
    };

    const { rerender } = render(
      <CardArtContent
        artSource="mpc"
        query="Missing"
        onSelectCard={vi.fn()}
        filtersCollapsed
      />
    );

    expect(screen.queryByTestId("mpc-filter-bar")).toBeNull();
    expect(
      screen.getByText(
        '"Missing" had 2 results, but current filters return none.'
      )
    ).toBeDefined();
    fireEvent.click(screen.getByText("Clear All Filters"));
    expect(mocked.mpc.clearFilters).toHaveBeenCalled();

    mocked.mpc = {
      ...mocked.mpc,
      cards: [],
      filteredCards: [],
      hasSearched: true,
      filters: {
        minDpi: 0,
        sourceFilters: new Set<string>(),
        tagFilters: new Set<string>(),
        sortBy: "name",
        sortDir: "asc",
      },
    };
    const onSwitchSource = vi.fn();
    rerender(
      <CardArtContent
        artSource="mpc"
        query="Missing"
        onSelectCard={vi.fn()}
        onSwitchSource={onSwitchSource}
      />
    );

    expect(screen.getByText('No MPC art found for "Missing"')).toBeDefined();
    fireEvent.click(screen.getByText("Switch to Scryfall"));
    expect(onSwitchSource).toHaveBeenCalled();
  });

  it("renders Scryfall empty search guidance without auto-searching prints", () => {
    mocked.scryfallSearch = {
      cards: [],
      isLoading: false,
      hasSearched: false,
      hasResults: false,
    };
    mocked.scryfallPrints = {
      prints: [],
      isLoading: false,
      hasSearched: false,
      hasResults: false,
    };
    const initialPrints = [
      {
        imageUrl: "https://example.com/initial-front.png",
        set: "set2",
        number: "2",
        faceName: "Initial",
      },
    ];

    render(
      <CardArtContent
        artSource="scryfall"
        query=""
        mode="prints"
        initialPrints={initialPrints}
        onSelectCard={vi.fn()}
      />
    );

    expect(mocked.printsCalls[0]).toMatchObject({
      enabled: false,
      initialPrints,
    });
    expect(
      screen.getByText("Scryfall syntax").closest("p")?.textContent
    ).toContain("Search for a card to preview.");
    expect(screen.getByText("Scryfall syntax").getAttribute("href")).toBe(
      "https://scryfall.com/docs/syntax"
    );
  });
});
