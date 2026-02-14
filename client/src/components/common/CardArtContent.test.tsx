import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CardArtContent } from "./CardArtContent";

vi.mock("@/hooks/useScryfallSearch", () => ({
  useScryfallSearch: () => ({
    cards: [],
    isLoading: false,
    hasSearched: true,
    hasResults: false,
  }),
}));

vi.mock("@/hooks/useScryfallPrints", () => ({
  useScryfallPrints: () => ({
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
  }),
}));

vi.mock("@/hooks/useMpcSearch", () => ({
  useMpcSearch: () => ({
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
    clearFilters: vi.fn(),
    setSourceFilters: vi.fn(),
    setTagFilters: vi.fn(),
  }),
}));

vi.mock("@/store", () => ({
  useUserPreferencesStore: (selector: (state: {
    preferences?: { favoriteMpcSources: string[] };
    toggleFavoriteMpcSource: (source: string) => void;
  }) => unknown) =>
    selector({
      preferences: { favoriteMpcSources: [] },
      toggleFavoriteMpcSource: vi.fn(),
    }),
}));

vi.mock("./CardImageSvg", () => ({
  CardImageSvg: ({ url }: { url: string }) => <img src={url} alt="" />,
}));

describe("CardArtContent", () => {
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

    const artCards = screen.getAllByTestId("artwork-card");
    expect(artCards).toHaveLength(1);

    fireEvent.click(artCards[0]);
    expect(onSelectCard).toHaveBeenCalledWith(
      "Back Face",
      "https://example.com/back.png"
    );
  });
});
