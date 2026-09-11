import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import React from "react";
import {
  extractArchidektDeckId,
  fetchArchidektDeck,
  extractCardsFromDeck as extractArchidektCards,
} from "@/helpers/archidektApi";
import {
  extractMoxfieldDeckId,
  fetchMoxfieldDeck,
  extractCardsFromDeck as extractMoxfieldCards,
  type MoxfieldDeck,
} from "@/helpers/moxfieldApi";

// Mock hoisted values
const mockSetLoadingTask = vi.hoisted(() => vi.fn());
const mockSetLoadingMessage = vi.hoisted(() => vi.fn());
const mockOrchestratorProcess = vi.hoisted(() => vi.fn());
const mockHandleAutoImportTokens = vi.hoisted(() => vi.fn());

vi.mock("flowbite-react", () => ({
  Checkbox: (props: React.InputHTMLAttributes<HTMLInputElement>) => (
    <input {...props} type="checkbox" />
  ),
  TextInput: ({
    value,
    onChange,
    placeholder,
    disabled,
    color,
    className,
  }: {
    value: string;
    onChange: (e: { target: { value: string } }) => void;
    placeholder?: string;
    disabled?: boolean;
    color?: string;
    className?: string;
  }) => (
    <input
      data-testid="deck-url-input"
      type="text"
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      disabled={disabled}
      data-color={color}
      className={className}
    />
  ),
}));

vi.mock("@/store", () => ({
  useSettingsStore: Object.assign(
    vi.fn((selector) => {
      const state = {
        globalLanguage: "en",
        preferredArtSource: "scryfall",
        autoImportTokens: false,
      };
      return selector(state);
    }),
    {
      getState: () => ({
        globalLanguage: "en",
        preferredArtSource: "scryfall",
        autoImportTokens: false,
      }),
    }
  ),
}));

vi.mock("@/store/loading", () => ({
  useLoadingStore: vi.fn((selector) => {
    const state = {
      setLoadingTask: mockSetLoadingTask,
      setLoadingMessage: mockSetLoadingMessage,
    };
    return selector(state);
  }),
}));

vi.mock("@/helpers/ImportOrchestrator", () => ({
  ImportOrchestrator: {
    process: mockOrchestratorProcess,
  },
}));

vi.mock("@/helpers/tokenImportHelper", () => ({
  handleAutoImportTokens: mockHandleAutoImportTokens,
}));

const mockShowSuccessToast = vi.hoisted(() => vi.fn());
const mockShowErrorToast = vi.hoisted(() => vi.fn());

vi.mock("@/store/toast", () => ({
  useToastStore: Object.assign(
    vi.fn((selector) => {
      const state = {
        showSuccessToast: mockShowSuccessToast,
        showErrorToast: mockShowErrorToast,
      };
      return selector(state);
    }),
    {
      getState: () => ({
        showSuccessToast: mockShowSuccessToast,
        showErrorToast: mockShowErrorToast,
      }),
    }
  ),
}));

vi.mock("@/helpers/archidektApi", () => ({
  isArchidektUrl: (url: string) => url.includes("archidekt"),
  extractArchidektDeckId: vi.fn((url: string) =>
    url.includes("archidekt") ? "12345" : null
  ),
  fetchArchidektDeck: vi.fn(() =>
    Promise.resolve({ id: 1, name: "Test Deck" })
  ),
  extractCardsFromDeck: vi.fn(() => [
    {
      name: "Sol Ring",
      set: "c21",
      number: "289",
      quantity: 1,
      category: "ramp",
    },
  ]),
  getDeckSummary: vi.fn(() => ({ name: "Test Deck", cardCount: 1 })),
}));

vi.mock("@/helpers/moxfieldApi", () => ({
  isMoxfieldUrl: (url: string) => url.includes("moxfield"),
  extractMoxfieldDeckId: vi.fn((url: string) =>
    url.includes("moxfield") ? "abc123" : null
  ),
  fetchMoxfieldDeck: vi.fn(() =>
    Promise.resolve({ publicId: "abc", name: "Moxfield Deck" })
  ),
  extractCardsFromDeck: vi.fn(() => [
    {
      name: "Lightning Bolt",
      set: "leb",
      number: "163",
      quantity: 4,
      category: "removal",
      isToken: true,
    },
  ]),
  getDeckSummary: vi.fn(() => ({ name: "Moxfield Deck", cardCount: 4 })),
}));

vi.mock("../common", () => ({
  AutoTooltip: ({
    mobile,
    tooltipClassName,
  }: {
    content: React.ReactNode;
    mobile?: boolean;
    tooltipClassName?: string;
  }) => (
    <span
      data-testid="tooltip"
      data-mobile={mobile}
      className={tooltipClassName}
    >
      ?
    </span>
  ),
}));

import { DeckBuilderImporter } from "./DeckBuilderImporter";

describe("DeckBuilderImporter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockOrchestratorProcess.mockImplementation(async (_intents, options) => {
      options?.onComplete?.();
    });
  });

  describe("rendering", () => {
    it("should render Import Deck header", () => {
      render(<DeckBuilderImporter />);
      // Header and button both have 'Import Deck' text
      expect(screen.getAllByText("Import Deck").length).toBe(2);
    });

    it("should render URL input", () => {
      render(<DeckBuilderImporter />);
      expect(screen.getByTestId("deck-url-input")).toBeDefined();
      expect(
        screen.getByPlaceholderText("Paste Archidekt or Moxfield deck URL...")
      ).toBeDefined();
    });

    it("should render Import Deck button", () => {
      render(<DeckBuilderImporter />);
      expect(screen.getByRole("button", { name: /Import Deck/ })).toBeDefined();
    });

    it("should render with mobile styling when mobile prop is true", () => {
      render(<DeckBuilderImporter mobile />);
      // Should still render the heading (may be hidden on landscape)
      expect(screen.getAllByText(/Import/i).length).toBeGreaterThan(0);
    });
  });

  describe("Considering cards", () => {
    it.each([false, true])("defaults to unchecked (mobile=%s)", (mobile) => {
      render(<DeckBuilderImporter mobile={mobile} />);
      const checkbox = screen.getByRole("checkbox", { name: /Include considering cards/i }) as HTMLInputElement;
      expect(checkbox.checked).toBe(false);
    });

    it.each(["default", "checked", "unchecked again"])("imports the intended boards when %s", async (mode) => {
      const actual = await vi.importActual<typeof import("@/helpers/moxfieldApi")>("@/helpers/moxfieldApi");
      const card = { id: "test", uniqueCardId: "test", scryfall_id: "test", name: "Sol Ring", set: "C21", set_name: "Test", cn: "289", layout: "normal", type_line: "Artifact" };
      const deck: MoxfieldDeck = {
        id: "test", publicId: "test", publicUrl: "https://moxfield.com/decks/test", name: "Fixture", format: "commander",
        commanders: {}, companions: {}, sideboard: {},
        mainboard: { main: { card, quantity: 1, boardType: "mainboard", finish: "nonFoil", isFoil: false } },
        maybeboard: { maybe: { card: { ...card, name: "Counterspell", cn: "54", set: "LEA" }, quantity: 3, boardType: "maybeboard", finish: "nonFoil", isFoil: false } },
        mainboardCount: 1, commandersCount: 0, companionsCount: 0, sideboardCount: 0, maybeboardCount: 3,
      };
      vi.mocked(fetchMoxfieldDeck).mockResolvedValueOnce(deck);
      vi.mocked(extractMoxfieldCards).mockImplementationOnce(actual.extractCardsFromDeck);
      render(<DeckBuilderImporter />);
      fireEvent.change(screen.getByTestId("deck-url-input"), { target: { value: deck.publicUrl } });
      const checkbox = screen.getByRole("checkbox", { name: /Include considering cards/i });
      if (mode !== "default") fireEvent.click(checkbox);
      if (mode === "unchecked again") fireEvent.click(checkbox);
      fireEvent.click(screen.getByRole("button", { name: "Import Deck" }));
      expect(checkbox.hasAttribute("disabled")).toBe(true);
      await waitFor(() => expect(mockOrchestratorProcess).toHaveBeenCalledTimes(1));
      const intents = mockOrchestratorProcess.mock.calls[0][0];
      expect(intents).toEqual(mode === "checked" ? [
        expect.objectContaining({ name: "Sol Ring", quantity: 1, category: "Mainboard" }),
        expect.objectContaining({ name: "Counterspell", quantity: 3, set: "lea", number: "54", category: "Maybeboard" }),
      ] : [expect.objectContaining({ name: "Sol Ring", quantity: 1, category: "Mainboard" })]);
      await waitFor(() => expect(checkbox.hasAttribute("disabled")).toBe(false));
    });

    it("does not change Archidekt imports", async () => {
      render(<DeckBuilderImporter />);
      const checkbox = screen.getByRole("checkbox", { name: /Include considering cards/i });
      fireEvent.click(checkbox);
      fireEvent.change(screen.getByTestId("deck-url-input"), { target: { value: "https://archidekt.com/decks/12345" } });
      expect(checkbox.hasAttribute("disabled")).toBe(true);
      fireEvent.click(screen.getByRole("button", { name: "Import Deck" }));
      await waitFor(() => expect(mockOrchestratorProcess).toHaveBeenCalledTimes(1));
      expect(extractArchidektCards).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }));
      expect(extractMoxfieldCards).not.toHaveBeenCalled();
    });
  });

  describe("URL validation", () => {
    it("should disable button when URL is empty", () => {
      render(<DeckBuilderImporter />);
      const button = screen.getByRole("button", { name: /Import Deck/ });
      expect(button.hasAttribute("disabled")).toBe(true);
    });

    it("should disable button when URL is not a valid deck URL", () => {
      render(<DeckBuilderImporter />);
      const input = screen.getByTestId("deck-url-input");
      fireEvent.change(input, { target: { value: "https://google.com" } });
      const button = screen.getByRole("button", { name: /Import Deck/ });
      expect(button.hasAttribute("disabled")).toBe(true);
    });

    it("should enable button for valid Archidekt URL", () => {
      render(<DeckBuilderImporter />);
      const input = screen.getByTestId("deck-url-input");
      fireEvent.change(input, {
        target: { value: "https://archidekt.com/decks/12345" },
      });
      const button = screen.getByRole("button", { name: /Import Deck/ });
      expect(button.hasAttribute("disabled")).toBe(false);
    });

    it("should enable button for valid Moxfield URL", () => {
      render(<DeckBuilderImporter />);
      const input = screen.getByTestId("deck-url-input");
      fireEvent.change(input, {
        target: { value: "https://moxfield.com/decks/abc123" },
      });
      const button = screen.getByRole("button", { name: /Import Deck/ });
      expect(button.hasAttribute("disabled")).toBe(false);
    });
  });

  describe("import flow", () => {
    it("should show Importing... when loading", async () => {
      render(<DeckBuilderImporter />);
      const input = screen.getByTestId("deck-url-input");
      fireEvent.change(input, {
        target: { value: "https://archidekt.com/decks/12345" },
      });
      const button = screen.getByRole("button", { name: /Import Deck/ });

      // Mock a slow response
      mockOrchestratorProcess.mockImplementation(
        () => new Promise((resolve) => setTimeout(resolve, 100))
      );

      fireEvent.click(button);

      await waitFor(() => {
        expect(screen.getByText("Importing...")).toBeDefined();
      });
    });

    it("imports cards from a Moxfield deck", async () => {
      vi.mocked(extractMoxfieldCards).mockReturnValueOnce([
        {
          name: "Lightning Bolt",
          set: "leb",
          number: "163",
          quantity: 4,
          category: "",
          isToken: true,
        },
        {
          name: "Counterspell",
          set: "lea",
          number: "54",
          scryfallId: "counterspell-id",
          quantity: 1,
          category: "",
        },
      ]);

      render(<DeckBuilderImporter />);
      const input = screen.getByTestId("deck-url-input");
      fireEvent.change(input, {
        target: { value: "https://moxfield.com/decks/abc123" },
      });
      const button = screen.getByRole("button", { name: /Import Deck/ });

      fireEvent.click(button);

      await waitFor(() => {
        expect(fetchMoxfieldDeck).toHaveBeenCalledWith("abc123");
        expect(mockShowSuccessToast).toHaveBeenCalledWith(
          "Importing 2 cards from deck..."
        );
      });
    });

    it("should call setLoadingTask on import", async () => {
      render(<DeckBuilderImporter />);
      const input = screen.getByTestId("deck-url-input");
      fireEvent.change(input, {
        target: { value: "https://archidekt.com/decks/12345" },
      });
      const button = screen.getByRole("button", { name: /Import Deck/ });

      fireEvent.click(button);

      await waitFor(() => {
        expect(mockSetLoadingTask).toHaveBeenCalledWith("Fetching cards");
      });
    });

    it("should call onUploadComplete after successful import", async () => {
      const onUploadComplete = vi.fn();
      render(<DeckBuilderImporter onUploadComplete={onUploadComplete} />);
      const input = screen.getByTestId("deck-url-input");
      fireEvent.change(input, {
        target: { value: "https://archidekt.com/decks/12345" },
      });
      const button = screen.getByRole("button", { name: /Import Deck/ });

      fireEvent.click(button);

      await waitFor(() => {
        expect(onUploadComplete).toHaveBeenCalled();
      });
    });

    it("should clear URL after successful import", async () => {
      render(<DeckBuilderImporter />);
      const input = screen.getByTestId("deck-url-input") as HTMLInputElement;
      fireEvent.change(input, {
        target: { value: "https://archidekt.com/decks/12345" },
      });
      const button = screen.getByRole("button", { name: /Import Deck/ });

      fireEvent.click(button);

      await waitFor(() => {
        expect(input.value).toBe("");
      });
    });
  });
});

describe("advanced scenarios", () => {
  it("should handle invalid Archidekt deck ID", async () => {
    vi.mocked(extractArchidektDeckId).mockReturnValueOnce(null);

    render(<DeckBuilderImporter />);
    const input = screen.getByTestId("deck-url-input");
    fireEvent.change(input, {
      target: { value: "https://archidekt.com/decks/bad-url" },
    });
    const button = screen.getByRole("button", { name: /Import Deck/ });

    fireEvent.click(button);

    await waitFor(() => {
      expect(
        screen.getByText(
          "Invalid Archidekt URL. Please paste a valid deck link."
        )
      ).toBeDefined();
    });
  });

  it("should handle invalid Moxfield deck ID", async () => {
    vi.mocked(extractMoxfieldDeckId).mockReturnValueOnce(null);

    render(<DeckBuilderImporter />);
    const input = screen.getByTestId("deck-url-input");
    fireEvent.change(input, {
      target: { value: "https://moxfield.com/decks/bad-url" },
    });
    const button = screen.getByRole("button", { name: /Import Deck/ });

    fireEvent.click(button);

    await waitFor(() => {
      expect(
        screen.getByText(
          "Invalid Moxfield URL. Please paste a valid deck link."
        )
      ).toBeDefined();
    });
  });

  it("should handle empty deck result", async () => {
    vi.mocked(extractArchidektCards).mockReturnValueOnce([]);

    render(<DeckBuilderImporter />);
    const input = screen.getByTestId("deck-url-input");
    fireEvent.change(input, {
      target: { value: "https://archidekt.com/decks/12345" },
    });
    const button = screen.getByRole("button", { name: /Import Deck/ });

    fireEvent.click(button);

    await waitFor(() => {
      expect(
        screen.getByText("No cards found in deck. The deck may be empty.")
      ).toBeDefined();
    });
  });

  it("should handle fetch errors", async () => {
    vi.mocked(fetchArchidektDeck).mockRejectedValueOnce(
      new Error("Network error")
    );

    render(<DeckBuilderImporter />);
    const input = screen.getByTestId("deck-url-input");
    fireEvent.change(input, {
      target: { value: "https://archidekt.com/decks/12345" },
    });
    const button = screen.getByRole("button", { name: /Import Deck/ });

    fireEvent.click(button);

    await waitFor(() => {
      expect(screen.getByText("Network error")).toBeDefined();
    });
  });

  it("should handle ImportOrchestrator errors", async () => {
    mockOrchestratorProcess.mockRejectedValueOnce(new Error("Import failed"));

    render(<DeckBuilderImporter />);
    const input = screen.getByTestId("deck-url-input");
    fireEvent.change(input, {
      target: { value: "https://archidekt.com/decks/12345" },
    });
    const button = screen.getByRole("button", { name: /Import Deck/ });

    fireEvent.click(button);

    // Wait for the button to return to normal state (error handled gracefully)
    await waitFor(() => {
      expect(screen.queryByText("Importing...")).toBeNull();
    });
  });

  it("should abort previous request if import clicked again quickly", async () => {
    mockOrchestratorProcess.mockImplementation(
      () => new Promise((resolve) => setTimeout(resolve, 100))
    );

    render(<DeckBuilderImporter />);
    const input = screen.getByTestId("deck-url-input");
    fireEvent.change(input, {
      target: { value: "https://archidekt.com/decks/12345" },
    });
    const button = screen.getByRole("button", { name: /Import Deck/ });

    fireEvent.click(button);
    fireEvent.click(button); // Click again immediately

    // Verify no crash, and eventually finishes
    await waitFor(() => {
      expect(screen.queryByText(/Importing/)).toBeNull();
    });
  });

  it("should handle unknown errors", async () => {
    vi.mocked(fetchArchidektDeck).mockRejectedValueOnce("Unknown string error");

    render(<DeckBuilderImporter />);
    const input = screen.getByTestId("deck-url-input");
    fireEvent.change(input, {
      target: { value: "https://archidekt.com/decks/12345" },
    });
    const button = screen.getByRole("button", { name: /Import Deck/ });

    fireEvent.click(button);

    await waitFor(() => {
      expect(screen.getByText("Failed to fetch deck")).toBeDefined();
    });
  });
});
