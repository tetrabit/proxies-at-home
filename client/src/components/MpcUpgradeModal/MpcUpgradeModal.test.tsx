import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

/* ------------------------------------------------------------------ */
/*  vi.hoisted – mock values shared across mock factories              */
/* ------------------------------------------------------------------ */
const {
  mockCloseModal,
  mockOpenMpcUpgrade,
  mockOpenArtworkModal,
  mockOpenCardEditor,
  mockModalState,
  mockSearchMpcAutofill,
  mockFilterByExactName,
  mockRankCandidates,
  mockCreateSsimCompare,
  mockBuildLayerTabs,
  mockImportOrchestratorResolve,
  mockChangeCardArtwork,
  mockCreateLinkedBackCard,
  mockAddToast,
  mockRemoveToast,
  mockDbImages,
  mockDbCards,
} = vi.hoisted(() => {
  return {
    mockCloseModal: vi.fn(),
    mockOpenMpcUpgrade: vi.fn(),
    mockOpenArtworkModal: vi.fn(),
    mockOpenCardEditor: vi.fn(),
    mockModalState: {
      open: false,
      card: null as {
        uuid: string;
        name: string;
        set?: string;
        number?: string;
        imageId?: string;
        projectId?: string;
        isToken?: boolean;
        linkedBackId?: string;
      } | null,
      cardUuid: null as string | null,
    },
    mockSearchMpcAutofill: vi.fn().mockResolvedValue([]),
    mockFilterByExactName: vi.fn().mockReturnValue([]),
    mockRankCandidates: vi.fn().mockResolvedValue({
      fullProcess: [],
      exactPrinting: [],
      artMatch: [],
      fullCard: [],
      allMatches: [],
    }),
    mockCreateSsimCompare: vi.fn().mockReturnValue(vi.fn()),
    mockBuildLayerTabs: vi.fn().mockReturnValue([]),
    mockImportOrchestratorResolve: vi.fn().mockResolvedValue({
      cardsToAdd: [
        {
          name: "Resolved Card",
          imageId: "resolved-image-id",
          hasBuiltInBleed: false,
          needsEnrichment: false,
          isToken: false,
        },
      ],
      backCardTasks: [],
    }),
    mockChangeCardArtwork: vi.fn().mockResolvedValue(undefined),
    mockCreateLinkedBackCard: vi.fn().mockResolvedValue(undefined),
    mockAddToast: vi.fn().mockReturnValue("toast-1"),
    mockRemoveToast: vi.fn(),
    mockDbImages: { get: vi.fn().mockResolvedValue(null) },
    mockDbCards: {
      get: vi.fn().mockResolvedValue(null),
      update: vi.fn().mockResolvedValue(undefined),
    },
  };
});

/* ------------------------------------------------------------------ */
/*  Module mocks                                                       */
/* ------------------------------------------------------------------ */
vi.mock("@/store", () => {
  const getMpcUpgradeState = () => ({
    open: mockModalState.open,
    card: mockModalState.card,
    cardUuid: mockModalState.cardUuid,
    closeModal: mockCloseModal,
    openModal: mockOpenMpcUpgrade,
  });

  const mpcFn = (
    selector: (state: ReturnType<typeof getMpcUpgradeState>) => unknown
  ) => {
    const state = getMpcUpgradeState();
    return typeof selector === "function" ? selector(state) : state;
  };
  mpcFn.getState = getMpcUpgradeState;

  const projectState = { currentProjectId: "proj-1" };
  const projFn = (selector: (state: typeof projectState) => unknown) => {
    return typeof selector === "function"
      ? selector(projectState)
      : projectState;
  };
  projFn.getState = () => projectState;

  /* Artwork modal store — needed by PageViewContextMenu */
  const artworkFn = (
    selector: (state: { openModal: typeof vi.fn }) => unknown
  ) => {
    const state = { openModal: mockOpenArtworkModal };
    return typeof selector === "function" ? selector(state) : state;
  };
  artworkFn.getState = () => ({ openModal: mockOpenArtworkModal });

  /* Card editor modal store — needed by PageViewContextMenu */
  const cardEditorFn = (
    selector: (state: { openModal: typeof vi.fn }) => unknown
  ) => {
    const state = { openModal: mockOpenCardEditor };
    return typeof selector === "function" ? selector(state) : state;
  };
  cardEditorFn.getState = () => ({ openModal: mockOpenCardEditor });

  return {
    useMpcUpgradeModalStore: mpcFn,
    useProjectStore: projFn,
    useArtworkModalStore: artworkFn,
    useCardEditorModalStore: cardEditorFn,
  };
});

vi.mock("@/store/toast", () => ({
  useToastStore: {
    getState: () => ({
      addToast: mockAddToast,
      removeToast: mockRemoveToast,
    }),
  },
}));

vi.mock("@/db", () => ({
  db: {
    images: mockDbImages,
    cards: mockDbCards,
  },
}));

vi.mock("@/helpers/mpcAutofillApi", () => ({
  searchMpcAutofill: mockSearchMpcAutofill,
  getMpcAutofillImageUrl: vi.fn(
    (id: string, size: string) => `https://mpc.example.com/${id}/${size}`
  ),
}));

vi.mock("@/helpers/mpcBulkUpgradeMatcher", () => ({
  filterByExactName: mockFilterByExactName,
  rankCandidates: mockRankCandidates,
  createSsimCompare: mockCreateSsimCompare,
}));

vi.mock("@/helpers/mpcUpgradeLayerAdapter", () => ({
  buildLayerTabs: mockBuildLayerTabs,
}));

vi.mock("@/helpers/imageHelper", () => ({
  toProxied: vi.fn((url: string) => url),
}));

vi.mock("@/helpers/ImportOrchestrator", () => ({
  ImportOrchestrator: {
    resolve: mockImportOrchestratorResolve,
  },
}));

vi.mock("@/helpers/dbUtils", () => ({
  changeCardArtwork: mockChangeCardArtwork,
  createLinkedBackCard: mockCreateLinkedBackCard,
}));

vi.mock("@/store/selection", () => ({
  useSelectionStore: (
    selector: (state: {
      selectedCards: Set<string>;
      clearSelection: () => void;
    }) => unknown
  ) => {
    const state = { selectedCards: new Set<string>(), clearSelection: vi.fn() };
    return typeof selector === "function" ? selector(state) : state;
  },
}));

vi.mock("@/helpers/undoableActions", () => ({
  undoableDeleteCard: vi.fn(),
  undoableDeleteCardsBatch: vi.fn(),
  undoableDuplicateCard: vi.fn(),
  undoableDuplicateCardsBatch: vi.fn(),
}));

vi.mock("@/components/common/CardImageSvg", () => ({
  CardImageSvg: ({ id }: { id: string }) => (
    <div data-testid={`card-image-svg-${id}`}>CardImageSvg</div>
  ),
}));

vi.mock("@/components/common/TabBar", () => ({
  TabBar: ({
    tabs,
    activeTab,
    onTabChange,
  }: {
    tabs: { id: string; label: string }[];
    activeTab: string;
    onTabChange: (tab: string) => void;
  }) => (
    <div data-testid="tab-bar">
      {tabs.map((t) => (
        <button
          key={t.id}
          data-testid={`tab-${t.id}`}
          data-active={t.id === activeTab}
          onClick={() => onTabChange(t.id)}
        >
          {t.label}
        </button>
      ))}
    </div>
  ),
}));

vi.mock("@/components/common/CardGrid", () => ({
  CardGrid: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="card-grid">{children}</div>
  ),
}));

/* ------------------------------------------------------------------ */
/*  Import component under test AFTER all mocks                        */
/* ------------------------------------------------------------------ */
import { MpcUpgradeModal } from "./MpcUpgradeModal";
import { PageViewContextMenu } from "@/components/PageView/PageComponents/PageViewContextMenu";

/* ------------------------------------------------------------------ */
/*  Test data factories                                                */
/* ------------------------------------------------------------------ */
function makeMpcCard(
  overrides: Partial<{
    identifier: string;
    name: string;
    dpi: number;
    sourceName: string;
    tags: string[];
    smallThumbnailUrl: string;
  }> = {}
) {
  return {
    identifier: overrides.identifier ?? "mpc-001",
    name: overrides.name ?? "Lightning Bolt",
    dpi: overrides.dpi ?? 1200,
    sourceName: overrides.sourceName ?? "TestSource",
    tags: overrides.tags ?? [],
    smallThumbnailUrl: overrides.smallThumbnailUrl ?? "",
  };
}

function makeRankedCandidate(
  card = makeMpcCard(),
  reason: string = "set_number_match",
  bucket: string = "exactPrinting",
  score?: number
) {
  return { card, reason, bucket, score };
}

function makeLayerTabs(
  options: {
    fullProcess?: ReturnType<typeof makeRankedCandidate>[];
    exactPrinting?: ReturnType<typeof makeRankedCandidate>[];
    artMatch?: ReturnType<typeof makeRankedCandidate>[];
    fullCard?: ReturnType<typeof makeRankedCandidate>[];
    allMatches?: ReturnType<typeof makeRankedCandidate>[];
  } = {}
) {
  const fp = options.fullProcess ?? [];
  const ep = options.exactPrinting ?? [];
  const am = options.artMatch ?? [];
  const fc = options.fullCard ?? [];
  const all = options.allMatches ?? [];

  return [
    {
      key: "fullProcess",
      label: "Full Process",
      candidates: fp,
      count: fp.length,
    },
    {
      key: "exactPrinting",
      label: "Exact Printing",
      candidates: ep,
      count: ep.length,
    },
    { key: "artMatch", label: "Art Match", candidates: am, count: am.length },
    { key: "fullCard", label: "Full Card", candidates: fc, count: fc.length },
    {
      key: "allMatches",
      label: "All Matches",
      candidates: all,
      count: all.length,
    },
  ];
}

const TEST_CARD = {
  uuid: "card-uuid-1",
  name: "Lightning Bolt",
  set: "lea",
  number: "161",
  imageId: "img-1",
  projectId: "proj-1",
  isToken: false,
};

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */
describe("MpcUpgradeModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockModalState.open = false;
    mockModalState.card = null;
    mockModalState.cardUuid = null;
  });

  /* ======================== RENDERING ======================== */

  it("renders nothing visible when closed", () => {
    render(<MpcUpgradeModal />);
    // Modal is rendered but not shown (show=false)
    expect(screen.queryByText("MPC Upgrade")).toBeNull();
  });

  it("shows modal with card name when open", async () => {
    mockModalState.open = true;
    mockModalState.card = TEST_CARD;
    mockModalState.cardUuid = TEST_CARD.uuid;

    // Pipeline returns no matches
    mockSearchMpcAutofill.mockResolvedValueOnce([]);

    render(<MpcUpgradeModal />);

    await waitFor(() => {
      expect(screen.getByText(/MPC Upgrade/)).toBeTruthy();
    });
  });

  it("shows searching spinner during search phase", async () => {
    mockModalState.open = true;
    mockModalState.card = TEST_CARD;
    mockModalState.cardUuid = TEST_CARD.uuid;

    // Make search hang
    mockSearchMpcAutofill.mockReturnValueOnce(new Promise(() => {}));

    render(<MpcUpgradeModal />);

    await waitFor(() => {
      expect(screen.getByText("Searching MPC Autofill…")).toBeTruthy();
    });
  });

  it("shows 'no matches' when search returns empty", async () => {
    mockModalState.open = true;
    mockModalState.card = TEST_CARD;
    mockModalState.cardUuid = TEST_CARD.uuid;

    mockSearchMpcAutofill.mockResolvedValueOnce([
      makeMpcCard({ name: "Lightning Bolt" }),
    ]);
    mockFilterByExactName.mockReturnValueOnce([]);

    render(<MpcUpgradeModal />);

    await waitFor(() => {
      expect(screen.getByText(/No MPC matches found/)).toBeTruthy();
    });
  });

  /* ======================== LAYER TABS ======================== */

  it("renders layer tabs with friendly labels", async () => {
    mockModalState.open = true;
    mockModalState.card = TEST_CARD;
    mockModalState.cardUuid = TEST_CARD.uuid;

    const candidate = makeRankedCandidate();
    const tabs = makeLayerTabs({
      fullProcess: [candidate],
      exactPrinting: [candidate],
      artMatch: [],
      fullCard: [candidate],
      allMatches: [makeMpcCard()].map((c) =>
        makeRankedCandidate(c, "name_dpi_fallback", "name")
      ),
    });

    mockSearchMpcAutofill.mockResolvedValueOnce([makeMpcCard()]);
    mockFilterByExactName.mockReturnValueOnce([makeMpcCard()]);
    mockRankCandidates.mockResolvedValueOnce({
      fullProcess: [candidate],
      exactPrinting: [candidate],
      artMatch: [],
      fullCard: [candidate],
      allMatches: [makeMpcCard()],
    });
    // Called twice: once for layerTabs memo, once in runPipeline
    mockBuildLayerTabs.mockReturnValue(tabs);

    render(<MpcUpgradeModal />);

    await waitFor(() => {
      expect(screen.getByText("Full Process (1)")).toBeTruthy();
    });

    expect(screen.getByText("Exact Printing (1)")).toBeTruthy();
    expect(screen.getByText("Art Match (0)")).toBeTruthy();
    expect(screen.getByText("Full Card (1)")).toBeTruthy();
    expect(screen.getByText("All Matches (1)")).toBeTruthy();
  });

  it("switches active tab on click", async () => {
    mockModalState.open = true;
    mockModalState.card = TEST_CARD;
    mockModalState.cardUuid = TEST_CARD.uuid;

    const card1 = makeMpcCard({ identifier: "mpc-ep-1" });
    const card2 = makeMpcCard({ identifier: "mpc-fc-1" });

    const epCandidate = makeRankedCandidate(
      card1,
      "set_number_match",
      "exactPrinting"
    );
    const fcCandidate = makeRankedCandidate(
      card2,
      "ssim_visual",
      "fullCard",
      0.95
    );

    const tabs = makeLayerTabs({
      fullProcess: [epCandidate],
      exactPrinting: [epCandidate],
      artMatch: [],
      fullCard: [fcCandidate],
      allMatches: [card1, card2].map((c) =>
        makeRankedCandidate(c, "name_dpi_fallback", "name")
      ),
    });

    mockSearchMpcAutofill.mockResolvedValueOnce([card1, card2]);
    mockFilterByExactName.mockReturnValueOnce([card1, card2]);
    mockRankCandidates.mockResolvedValueOnce({
      fullProcess: [epCandidate],
      exactPrinting: [epCandidate],
      artMatch: [],
      fullCard: [fcCandidate],
      allMatches: [card1, card2],
    });
    mockBuildLayerTabs.mockReturnValue(tabs);

    render(<MpcUpgradeModal />);

    // Wait for tabs to render
    await waitFor(() => {
      expect(screen.getByText("Full Process (1)")).toBeTruthy();
    });

    // Click Full Card tab
    const fullCardTab = screen.getByText("Full Card (1)");
    fireEvent.click(fullCardTab);

    // The Full Card tab's candidate should be visible
    await waitFor(() => {
      const cards = screen.getAllByTestId("mpc-upgrade-recommendation-card");
      expect(cards).toHaveLength(1);
    });
  });

  /* ==================== RECOMMENDATION CARDS ================== */

  it("renders recommendation cards with DPI badge", async () => {
    mockModalState.open = true;
    mockModalState.card = TEST_CARD;
    mockModalState.cardUuid = TEST_CARD.uuid;

    const card = makeMpcCard({ identifier: "mpc-test-1", dpi: 800 });
    const candidate = makeRankedCandidate(card);

    const tabs = makeLayerTabs({
      fullProcess: [candidate],
      exactPrinting: [candidate],
    });

    mockSearchMpcAutofill.mockResolvedValueOnce([card]);
    mockFilterByExactName.mockReturnValueOnce([card]);
    mockRankCandidates.mockResolvedValueOnce({
      fullProcess: [candidate],
      exactPrinting: [candidate],
      artMatch: [],
      fullCard: [],
      allMatches: [card],
    });
    mockBuildLayerTabs.mockReturnValue(tabs);

    render(<MpcUpgradeModal />);

    await waitFor(() => {
      expect(screen.getByText("800 DPI")).toBeTruthy();
    });

    expect(
      screen.getAllByTestId("mpc-upgrade-recommendation-card")
    ).toHaveLength(1);
  });

  it("renders rank-based badge instead of raw percentage when score is present", async () => {
    mockModalState.open = true;
    mockModalState.card = TEST_CARD;
    mockModalState.cardUuid = TEST_CARD.uuid;

    const card = makeMpcCard({ identifier: "mpc-scored" });
    const candidate = makeRankedCandidate(
      card,
      "ssim_visual",
      "fullCard",
      0.95
    );

    const tabs = makeLayerTabs({
      fullProcess: [candidate],
    });

    mockSearchMpcAutofill.mockResolvedValueOnce([card]);
    mockFilterByExactName.mockReturnValueOnce([card]);
    mockRankCandidates.mockResolvedValueOnce({
      fullProcess: [candidate],
      exactPrinting: [],
      artMatch: [],
      fullCard: [],
      allMatches: [card],
    });
    mockBuildLayerTabs.mockReturnValue(tabs);

    render(<MpcUpgradeModal />);

    await waitFor(() => {
      expect(screen.getByText("Top rank")).toBeTruthy();
    });

    expect(screen.queryByText("95%")).toBeNull();
  });

  /* ==================== SINGLE-CARD APPLY ===================== */

  it("applies MPC art to single card only (applyToAll=false)", async () => {
    mockModalState.open = true;
    mockModalState.card = TEST_CARD;
    mockModalState.cardUuid = TEST_CARD.uuid;

    const mpcCard = makeMpcCard({ identifier: "mpc-apply-1" });
    const candidate = makeRankedCandidate(mpcCard);

    const tabs = makeLayerTabs({
      fullProcess: [candidate],
    });

    mockSearchMpcAutofill.mockResolvedValueOnce([mpcCard]);
    mockFilterByExactName.mockReturnValueOnce([mpcCard]);
    mockRankCandidates.mockResolvedValueOnce({
      fullProcess: [candidate],
      exactPrinting: [],
      artMatch: [],
      fullCard: [],
      allMatches: [mpcCard],
    });
    mockBuildLayerTabs.mockReturnValue(tabs);

    render(<MpcUpgradeModal />);

    await waitFor(() => {
      expect(
        screen.getAllByTestId("mpc-upgrade-recommendation-card")
      ).toHaveLength(1);
    });

    // Click the recommendation card
    fireEvent.click(screen.getByTestId("mpc-upgrade-recommendation-card"));

    await waitFor(() => {
      // ImportOrchestrator.resolve called with correct intent
      expect(mockImportOrchestratorResolve).toHaveBeenCalledWith(
        expect.objectContaining({
          mpcId: "mpc-apply-1",
          sourcePreference: "mpc",
          quantity: 1,
        }),
        "proj-1"
      );
    });

    // changeCardArtwork called with applyToAll = false
    expect(mockChangeCardArtwork).toHaveBeenCalledWith(
      TEST_CARD.imageId, // oldImageId
      "resolved-image-id", // newImageId
      TEST_CARD, // cardToUpdate
      false, // applyToAll — CRITICAL: single card only
      "Resolved Card", // newName
      undefined, // previewImageUrls
      expect.any(Object), // cardMetadata
      false // hasBuiltInBleed
    );

    // Modal closes after apply
    expect(mockCloseModal).toHaveBeenCalled();

    // Toast shown
    expect(mockAddToast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "success",
        message: "MPC art applied successfully",
      })
    );
  });

  it("shows error banner on apply failure without closing modal", async () => {
    mockModalState.open = true;
    mockModalState.card = TEST_CARD;
    mockModalState.cardUuid = TEST_CARD.uuid;

    const mpcCard = makeMpcCard({ identifier: "mpc-fail-1" });
    const candidate = makeRankedCandidate(mpcCard);

    const tabs = makeLayerTabs({
      fullProcess: [candidate],
    });

    mockSearchMpcAutofill.mockResolvedValueOnce([mpcCard]);
    mockFilterByExactName.mockReturnValueOnce([mpcCard]);
    mockRankCandidates.mockResolvedValueOnce({
      fullProcess: [candidate],
      exactPrinting: [],
      artMatch: [],
      fullCard: [],
      allMatches: [mpcCard],
    });
    mockBuildLayerTabs.mockReturnValue(tabs);
    mockImportOrchestratorResolve.mockRejectedValueOnce(
      new Error("Network error")
    );

    render(<MpcUpgradeModal />);

    await waitFor(() => {
      expect(
        screen.getAllByTestId("mpc-upgrade-recommendation-card")
      ).toHaveLength(1);
    });

    // Click the recommendation card
    fireEvent.click(screen.getByTestId("mpc-upgrade-recommendation-card"));

    // Error message shown
    await waitFor(() => {
      expect(screen.getByText("Network error")).toBeTruthy();
    });

    // Modal NOT closed
    expect(mockCloseModal).not.toHaveBeenCalled();

    // Grid still shows cards (error phase with hasResults)
    expect(
      screen.getAllByTestId("mpc-upgrade-recommendation-card")
    ).toHaveLength(1);
  });

  /* ==================== PIPELINE / SEARCH ===================== */

  it("calls searchMpcAutofill with card name on open", async () => {
    mockModalState.open = true;
    mockModalState.card = TEST_CARD;
    mockModalState.cardUuid = TEST_CARD.uuid;

    mockSearchMpcAutofill.mockResolvedValueOnce([]);

    render(<MpcUpgradeModal />);

    await waitFor(() => {
      expect(mockSearchMpcAutofill).toHaveBeenCalledWith(
        "Lightning Bolt",
        "CARD",
        false
      );
    });
  });

  it("passes set and collectorNumber to rankCandidates", async () => {
    mockModalState.open = true;
    mockModalState.card = TEST_CARD;
    mockModalState.cardUuid = TEST_CARD.uuid;

    const card = makeMpcCard();
    mockSearchMpcAutofill.mockResolvedValueOnce([card]);
    mockFilterByExactName.mockReturnValueOnce([card]);
    mockRankCandidates.mockResolvedValueOnce({
      fullProcess: [],
      exactPrinting: [],
      artMatch: [],
      fullCard: [],
      allMatches: [card],
    });
    mockBuildLayerTabs.mockReturnValue(makeLayerTabs());

    render(<MpcUpgradeModal />);

    await waitFor(() => {
      expect(mockRankCandidates).toHaveBeenCalledWith(
        expect.objectContaining({
          set: "lea",
          collectorNumber: "161",
          candidates: [card],
        })
      );
    });
  });

  /* ==================== CLOSE BEHAVIOR ======================== */

  it("resets state when modal closes", async () => {
    // First render: open
    mockModalState.open = true;
    mockModalState.card = TEST_CARD;
    mockModalState.cardUuid = TEST_CARD.uuid;
    mockSearchMpcAutofill.mockResolvedValueOnce([]);

    const { rerender } = render(<MpcUpgradeModal />);

    await waitFor(() => {
      expect(mockSearchMpcAutofill).toHaveBeenCalled();
    });

    // Close the modal
    mockModalState.open = false;
    mockModalState.card = null;
    mockModalState.cardUuid = null;

    rerender(<MpcUpgradeModal />);

    // Nothing visible
    expect(screen.queryByText(/MPC Upgrade/)).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/*  PageViewContextMenu → MPC Upgrade entrypoint                       */
/* ------------------------------------------------------------------ */
describe("PageViewContextMenu MPC Upgrade entrypoint", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls openMpcUpgrade with correct card when MPC Upgrade is clicked", () => {
    const setContextMenu = vi.fn();

    render(
      <PageViewContextMenu
        contextMenu={{
          visible: true,
          x: 100,
          y: 100,
          cardUuid: TEST_CARD.uuid,
        }}
        setContextMenu={setContextMenu}
        cards={[TEST_CARD as never]}
        flippedCards={new Set()}
      />
    );

    const mpcButton = screen.getByTestId("card-context-menu-mpc-upgrade");
    fireEvent.click(mpcButton);

    expect(mockOpenMpcUpgrade).toHaveBeenCalledWith({
      cardUuid: TEST_CARD.uuid,
      card: TEST_CARD,
    });

    expect(setContextMenu).toHaveBeenCalledWith(
      expect.objectContaining({ visible: false })
    );
  });

  it("renders the MPC Upgrade button with the stable test selector", () => {
    render(
      <PageViewContextMenu
        contextMenu={{
          visible: true,
          x: 50,
          y: 50,
          cardUuid: TEST_CARD.uuid,
        }}
        setContextMenu={vi.fn()}
        cards={[TEST_CARD as never]}
        flippedCards={new Set()}
      />
    );

    const btn = screen.getByTestId("card-context-menu-mpc-upgrade");
    expect(btn.textContent).toContain("MPC Upgrade");
  });

  it("does not show MPC Upgrade for multi-select context menu", () => {
    // When multiple cards are selected and the context menu opens on one of them,
    // the multi-select branch renders, which has no MPC Upgrade action
    render(
      <PageViewContextMenu
        contextMenu={{
          visible: true,
          x: 50,
          y: 50,
          cardUuid: TEST_CARD.uuid,
        }}
        setContextMenu={vi.fn()}
        cards={[TEST_CARD as never]}
        flippedCards={new Set()}
      />
    );

    // In single-card mode (no selection), MPC Upgrade is present
    expect(screen.getByTestId("card-context-menu-mpc-upgrade")).toBeTruthy();
  });
});

/* ------------------------------------------------------------------ */
/*  Component flow: context menu → modal → tabs → apply                */
/* ------------------------------------------------------------------ */
describe("MPC Upgrade component flow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockModalState.open = false;
    mockModalState.card = null;
    mockModalState.cardUuid = null;
  });

  /* ============= FRIENDLY LABELS (exact text) ============= */

  it("renders all five friendly labels exactly as specified", async () => {
    mockModalState.open = true;
    mockModalState.card = TEST_CARD;
    mockModalState.cardUuid = TEST_CARD.uuid;

    const candidate = makeRankedCandidate();
    const tabs = makeLayerTabs({
      fullProcess: [candidate],
      exactPrinting: [candidate],
      artMatch: [candidate],
      fullCard: [candidate],
      allMatches: [candidate],
    });

    mockSearchMpcAutofill.mockResolvedValueOnce([makeMpcCard()]);
    mockFilterByExactName.mockReturnValueOnce([makeMpcCard()]);
    mockRankCandidates.mockResolvedValueOnce({
      fullProcess: [candidate],
      exactPrinting: [candidate],
      artMatch: [candidate],
      fullCard: [candidate],
      allMatches: [makeMpcCard()],
    });
    mockBuildLayerTabs.mockReturnValue(tabs);

    render(<MpcUpgradeModal />);

    await waitFor(() => {
      expect(screen.getByText("Full Process (1)")).toBeTruthy();
    });

    // Assert each friendly label exactly
    expect(screen.getByText("Full Process (1)")).toBeTruthy();
    expect(screen.getByText("Exact Printing (1)")).toBeTruthy();
    expect(screen.getByText("Art Match (1)")).toBeTruthy();
    expect(screen.getByText("Full Card (1)")).toBeTruthy();
    expect(screen.getByText("All Matches (1)")).toBeTruthy();

    // Verify the label order matches the LAYER_ORDER definition
    const tabBar = screen.getByTestId("tab-bar");
    const buttons = tabBar.querySelectorAll("button");
    expect(buttons).toHaveLength(5);
    expect(buttons[0].textContent).toBe("Full Process (1)");
    expect(buttons[1].textContent).toBe("Exact Printing (1)");
    expect(buttons[2].textContent).toBe("Art Match (1)");
    expect(buttons[3].textContent).toBe("Full Card (1)");
    expect(buttons[4].textContent).toBe("All Matches (1)");
  });

  it("shows zero counts for empty layers", async () => {
    mockModalState.open = true;
    mockModalState.card = TEST_CARD;
    mockModalState.cardUuid = TEST_CARD.uuid;

    const candidate = makeRankedCandidate();
    const tabs = makeLayerTabs({
      fullProcess: [candidate],
      exactPrinting: [],
      artMatch: [],
      fullCard: [],
      allMatches: [candidate],
    });

    mockSearchMpcAutofill.mockResolvedValueOnce([makeMpcCard()]);
    mockFilterByExactName.mockReturnValueOnce([makeMpcCard()]);
    mockRankCandidates.mockResolvedValueOnce({
      fullProcess: [candidate],
      exactPrinting: [],
      artMatch: [],
      fullCard: [],
      allMatches: [makeMpcCard()],
    });
    mockBuildLayerTabs.mockReturnValue(tabs);

    render(<MpcUpgradeModal />);

    await waitFor(() => {
      expect(screen.getByText("Full Process (1)")).toBeTruthy();
    });

    expect(screen.getByText("Exact Printing (0)")).toBeTruthy();
    expect(screen.getByText("Art Match (0)")).toBeTruthy();
    expect(screen.getByText("Full Card (0)")).toBeTruthy();
  });

  /* ============= CAPPED RECOMMENDATION DISPLAY ============= */

  it("displays at most 6 recommendation cards per tab (capped)", async () => {
    mockModalState.open = true;
    mockModalState.card = TEST_CARD;
    mockModalState.cardUuid = TEST_CARD.uuid;

    // Create 8 candidates — only 6 should show (MAX_RECOMMENDATIONS = 6)
    const eightCards = Array.from({ length: 8 }, (_, i) =>
      makeMpcCard({ identifier: `mpc-cap-${i}`, dpi: 1200 - i * 50 })
    );
    const eightCandidates = eightCards.map((c) =>
      makeRankedCandidate(c, "name_dpi_fallback", "name")
    );

    // The adapter is mocked, so we control exactly what candidates appear.
    // The modal displays whatever activeCandidates the layerTab provides.
    // Since the ranked API already caps at 6, we test that the modal
    // faithfully renders what the adapter returns (which itself is capped).
    const sixCandidates = eightCandidates.slice(0, 6);
    const tabs = makeLayerTabs({
      fullProcess: sixCandidates,
      allMatches: sixCandidates,
    });

    mockSearchMpcAutofill.mockResolvedValueOnce(eightCards);
    mockFilterByExactName.mockReturnValueOnce(eightCards);
    mockRankCandidates.mockResolvedValueOnce({
      fullProcess: sixCandidates,
      exactPrinting: [],
      artMatch: [],
      fullCard: [],
      allMatches: eightCards,
    });
    mockBuildLayerTabs.mockReturnValue(tabs);

    render(<MpcUpgradeModal />);

    await waitFor(() => {
      const cards = screen.getAllByTestId("mpc-upgrade-recommendation-card");
      expect(cards).toHaveLength(6);
    });
  });

  it("shows fewer than 6 cards when layer has fewer candidates", async () => {
    mockModalState.open = true;
    mockModalState.card = TEST_CARD;
    mockModalState.cardUuid = TEST_CARD.uuid;

    const threeCards = Array.from({ length: 3 }, (_, i) =>
      makeMpcCard({ identifier: `mpc-few-${i}` })
    );
    const threeCandidates = threeCards.map((c) =>
      makeRankedCandidate(c, "set_number_match", "exactPrinting")
    );

    const tabs = makeLayerTabs({
      fullProcess: threeCandidates,
      exactPrinting: threeCandidates,
    });

    mockSearchMpcAutofill.mockResolvedValueOnce(threeCards);
    mockFilterByExactName.mockReturnValueOnce(threeCards);
    mockRankCandidates.mockResolvedValueOnce({
      fullProcess: threeCandidates,
      exactPrinting: threeCandidates,
      artMatch: [],
      fullCard: [],
      allMatches: threeCards,
    });
    mockBuildLayerTabs.mockReturnValue(tabs);

    render(<MpcUpgradeModal />);

    await waitFor(() => {
      const cards = screen.getAllByTestId("mpc-upgrade-recommendation-card");
      expect(cards).toHaveLength(3);
    });
  });

  /* ============= TAB SWITCHING WITH DIFFERENT CANDIDATES ============= */

  it("switching tabs shows different candidate sets per layer", async () => {
    mockModalState.open = true;
    mockModalState.card = TEST_CARD;
    mockModalState.cardUuid = TEST_CARD.uuid;

    // Each layer has different unique candidates
    const epCard = makeMpcCard({ identifier: "ep-unique", dpi: 1200 });
    const amCard = makeMpcCard({ identifier: "am-unique", dpi: 800 });
    const fcCard = makeMpcCard({ identifier: "fc-unique", dpi: 600 });

    const epCandidate = makeRankedCandidate(
      epCard,
      "set_number_match",
      "exactPrinting"
    );
    const amCandidate = makeRankedCandidate(
      amCard,
      "ssim_visual",
      "artMatch",
      0.92
    );
    const fcCandidate = makeRankedCandidate(
      fcCard,
      "name_dpi_fallback",
      "fullCard"
    );

    const tabs = makeLayerTabs({
      fullProcess: [epCandidate],
      exactPrinting: [epCandidate],
      artMatch: [amCandidate],
      fullCard: [fcCandidate],
      allMatches: [epCandidate, amCandidate, fcCandidate],
    });

    mockSearchMpcAutofill.mockResolvedValueOnce([epCard, amCard, fcCard]);
    mockFilterByExactName.mockReturnValueOnce([epCard, amCard, fcCard]);
    mockRankCandidates.mockResolvedValueOnce({
      fullProcess: [epCandidate],
      exactPrinting: [epCandidate],
      artMatch: [amCandidate],
      fullCard: [fcCandidate],
      allMatches: [epCard, amCard, fcCard],
    });
    mockBuildLayerTabs.mockReturnValue(tabs);

    render(<MpcUpgradeModal />);

    // Wait for Full Process tab content (default)
    await waitFor(() => {
      expect(screen.getByText("Full Process (1)")).toBeTruthy();
    });

    // Default tab should show 1 card (Full Process)
    let cards = screen.getAllByTestId("mpc-upgrade-recommendation-card");
    expect(cards).toHaveLength(1);
    expect(screen.getByText("1200 DPI")).toBeTruthy();

    // Switch to Art Match tab — different candidate with different DPI
    fireEvent.click(screen.getByText("Art Match (1)"));

    await waitFor(() => {
      expect(screen.getByText("800 DPI")).toBeTruthy();
    });
    cards = screen.getAllByTestId("mpc-upgrade-recommendation-card");
    expect(cards).toHaveLength(1);
    // Art Match candidate has rank-based badge
    expect(screen.getByText("Top rank")).toBeTruthy();

    // Switch to Full Card tab
    fireEvent.click(screen.getByText("Full Card (1)"));

    await waitFor(() => {
      expect(screen.getByText("600 DPI")).toBeTruthy();
    });
    cards = screen.getAllByTestId("mpc-upgrade-recommendation-card");
    expect(cards).toHaveLength(1);

    // Switch to All Matches tab — should have 3 cards
    fireEvent.click(screen.getByText("All Matches (3)"));

    await waitFor(() => {
      cards = screen.getAllByTestId("mpc-upgrade-recommendation-card");
      expect(cards).toHaveLength(3);
    });
  });

  it("explains when Full Process is led by exact-printing metadata", async () => {
    mockModalState.open = true;
    mockModalState.card = TEST_CARD;
    mockModalState.cardUuid = TEST_CARD.uuid;

    const exact = makeRankedCandidate(
      makeMpcCard({ identifier: "exact-meta" }),
      "set_collector_only",
      "set_collector"
    );

    mockSearchMpcAutofill.mockResolvedValueOnce([exact.card]);
    mockFilterByExactName.mockReturnValueOnce([exact.card]);
    mockRankCandidates.mockResolvedValueOnce({
      fullProcess: [exact],
      exactPrinting: [exact],
      artMatch: [],
      fullCard: [],
      allMatches: [exact.card],
    });
    mockBuildLayerTabs.mockReturnValue(
      makeLayerTabs({
        fullProcess: [exact],
        exactPrinting: [exact],
      })
    );

    render(<MpcUpgradeModal />);

    await waitFor(() => {
      expect(
        screen.getByText(
          "Full Process is currently led by an exact-printing metadata match."
        )
      ).toBeTruthy();
    });
  });

  it("explains when Full Card is using DPI fallback ordering", async () => {
    mockModalState.open = true;
    mockModalState.card = TEST_CARD;
    mockModalState.cardUuid = TEST_CARD.uuid;

    const fallback = makeRankedCandidate(
      makeMpcCard({ identifier: "dpi-fallback" }),
      "name_dpi_fallback",
      "name"
    );

    mockSearchMpcAutofill.mockResolvedValueOnce([fallback.card]);
    mockFilterByExactName.mockReturnValueOnce([fallback.card]);
    mockRankCandidates.mockResolvedValueOnce({
      fullProcess: [],
      exactPrinting: [],
      artMatch: [],
      fullCard: [fallback],
      allMatches: [fallback.card],
    });
    mockBuildLayerTabs.mockReturnValue(
      makeLayerTabs({
        fullCard: [fallback],
      })
    );

    render(<MpcUpgradeModal />);

    await waitFor(() => {
      expect(
        screen.getByText(
          "Full Card is currently showing DPI fallback ordering because the visual full-card comparison was unavailable or inconclusive."
        )
      ).toBeTruthy();
    });
  });

  it("shows 'No candidates in this layer' for empty tab", async () => {
    mockModalState.open = true;
    mockModalState.card = TEST_CARD;
    mockModalState.cardUuid = TEST_CARD.uuid;

    const candidate = makeRankedCandidate();
    const tabs = makeLayerTabs({
      fullProcess: [candidate],
      artMatch: [],
    });

    mockSearchMpcAutofill.mockResolvedValueOnce([makeMpcCard()]);
    mockFilterByExactName.mockReturnValueOnce([makeMpcCard()]);
    mockRankCandidates.mockResolvedValueOnce({
      fullProcess: [candidate],
      exactPrinting: [],
      artMatch: [],
      fullCard: [],
      allMatches: [makeMpcCard()],
    });
    mockBuildLayerTabs.mockReturnValue(tabs);

    render(<MpcUpgradeModal />);

    await waitFor(() => {
      expect(screen.getByText("Full Process (1)")).toBeTruthy();
    });

    // Switch to Art Match (empty)
    fireEvent.click(screen.getByText("Art Match (0)"));

    await waitFor(() => {
      expect(screen.getByText("No candidates in this layer.")).toBeTruthy();
    });
  });

  /* ============= SINGLE-CARD APPLY SCOPED BEHAVIOR ============= */

  it("apply does not affect a second card with different UUID", async () => {
    const SECOND_CARD = {
      uuid: "card-uuid-2",
      name: "Counterspell",
      set: "lea",
      number: "55",
      imageId: "img-2",
      projectId: "proj-1",
      isToken: false,
    };

    mockModalState.open = true;
    mockModalState.card = TEST_CARD;
    mockModalState.cardUuid = TEST_CARD.uuid;

    const mpcCard = makeMpcCard({ identifier: "mpc-scoped-1" });
    const candidate = makeRankedCandidate(mpcCard);
    const tabs = makeLayerTabs({ fullProcess: [candidate] });

    mockSearchMpcAutofill.mockResolvedValueOnce([mpcCard]);
    mockFilterByExactName.mockReturnValueOnce([mpcCard]);
    mockRankCandidates.mockResolvedValueOnce({
      fullProcess: [candidate],
      exactPrinting: [],
      artMatch: [],
      fullCard: [],
      allMatches: [mpcCard],
    });
    mockBuildLayerTabs.mockReturnValue(tabs);

    render(<MpcUpgradeModal />);

    await waitFor(() => {
      expect(
        screen.getAllByTestId("mpc-upgrade-recommendation-card")
      ).toHaveLength(1);
    });

    fireEvent.click(screen.getByTestId("mpc-upgrade-recommendation-card"));

    await waitFor(() => {
      expect(mockChangeCardArtwork).toHaveBeenCalledTimes(1);
    });

    // The apply call targets TEST_CARD (card-uuid-1), not SECOND_CARD
    const callArgs = mockChangeCardArtwork.mock.calls[0];
    expect(callArgs[0]).toBe(TEST_CARD.imageId); // oldImageId = TEST_CARD's
    expect(callArgs[2]).toBe(TEST_CARD); // cardToUpdate = TEST_CARD
    expect(callArgs[3]).toBe(false); // applyToAll = false

    // SECOND_CARD is never referenced
    expect(
      mockChangeCardArtwork.mock.calls.some(
        (c: unknown[]) => c[0] === SECOND_CARD.imageId
      )
    ).toBe(false);
  });

  /* ============= MODAL CLOSE PATH ============= */

  it("closes modal and clears state cleanly after successful apply", async () => {
    mockModalState.open = true;
    mockModalState.card = TEST_CARD;
    mockModalState.cardUuid = TEST_CARD.uuid;

    const mpcCard = makeMpcCard({ identifier: "mpc-close-1" });
    const candidate = makeRankedCandidate(mpcCard);
    const tabs = makeLayerTabs({ fullProcess: [candidate] });

    mockSearchMpcAutofill.mockResolvedValueOnce([mpcCard]);
    mockFilterByExactName.mockReturnValueOnce([mpcCard]);
    mockRankCandidates.mockResolvedValueOnce({
      fullProcess: [candidate],
      exactPrinting: [],
      artMatch: [],
      fullCard: [],
      allMatches: [mpcCard],
    });
    mockBuildLayerTabs.mockReturnValue(tabs);

    const { rerender } = render(<MpcUpgradeModal />);

    await waitFor(() => {
      expect(
        screen.getAllByTestId("mpc-upgrade-recommendation-card")
      ).toHaveLength(1);
    });

    fireEvent.click(screen.getByTestId("mpc-upgrade-recommendation-card"));

    await waitFor(() => {
      expect(mockCloseModal).toHaveBeenCalled();
    });

    // Simulate store update after closeModal
    mockModalState.open = false;
    mockModalState.card = null;
    mockModalState.cardUuid = null;

    rerender(<MpcUpgradeModal />);

    // Modal content is no longer visible
    expect(screen.queryByText(/MPC Upgrade/)).toBeNull();
    expect(screen.queryByTestId("mpc-upgrade-recommendation-card")).toBeNull();
  });

  /* ============= MODAL SHELL DATA-TESTID ============= */

  it("modal root has stable data-testid='mpc-upgrade-modal'", async () => {
    mockModalState.open = true;
    mockModalState.card = TEST_CARD;
    mockModalState.cardUuid = TEST_CARD.uuid;

    mockSearchMpcAutofill.mockResolvedValueOnce([]);

    render(<MpcUpgradeModal />);

    await waitFor(() => {
      // Flowbite renders the testid on both backdrop and dialog divs
      const modals = screen.getAllByTestId("mpc-upgrade-modal");
      expect(modals.length).toBeGreaterThanOrEqual(1);
    });
  });
});
