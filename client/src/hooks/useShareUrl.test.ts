import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useShareUrl } from "./useShareUrl";

const mockLoadShare = vi.hoisted(() => vi.fn());
const mockDeserializeForImport = vi.hoisted(() => vi.fn());
const mockCalculateStateHash = vi.hoisted(() => vi.fn());
const mockProcess = vi.hoisted(() => vi.fn());
const mockShowErrorToast = vi.hoisted(() => vi.fn());
const mockShowInfoToast = vi.hoisted(() => vi.fn());
const mockShowSuccessToast = vi.hoisted(() => vi.fn());
const mockSwitchProject = vi.hoisted(() => vi.fn());
const mockCreateProject = vi.hoisted(() => vi.fn());
const mockProjectsWhere = vi.hoisted(() => vi.fn());
const mockProjectsUpdate = vi.hoisted(() => vi.fn());
const mockCardsWhere = vi.hoisted(() => vi.fn());
const mockSettingsGetState = vi.hoisted(() => vi.fn(() => ({})));
const mockProjectGetState = vi.hoisted(() => vi.fn());

vi.mock("@/db", () => ({
    db: {
      projects: {
        where: mockProjectsWhere,
        update: mockProjectsUpdate,
      },
    cards: {
      where: mockCardsWhere,
    },
  },
}));

vi.mock("@/helpers/shareHelper", () => ({
  loadShare: mockLoadShare,
  deserializeForImport: mockDeserializeForImport,
  calculateStateHash: mockCalculateStateHash,
}));

vi.mock("@/store/settings", () => ({
  useSettingsStore: { getState: mockSettingsGetState },
}));

vi.mock("@/store/toast", () => ({
  useToastStore: {
    getState: () => ({
      showErrorToast: mockShowErrorToast,
      showInfoToast: mockShowInfoToast,
      showSuccessToast: mockShowSuccessToast,
    }),
  },
}));

vi.mock("@/store", () => ({
  useProjectStore: { getState: mockProjectGetState },
}));

vi.mock("@/helpers/ImportOrchestrator", () => ({
  ImportOrchestrator: { process: mockProcess },
}));

vi.mock("@/helpers/debug", () => ({
  debugLog: vi.fn(),
}));

describe("useShareUrl", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.history.pushState({}, "", "/?share=abc");
    mockProjectGetState.mockReturnValue({
      switchProject: mockSwitchProject,
      createProject: mockCreateProject,
    });
    mockSettingsGetState.mockReturnValue({});
    mockProjectsWhere.mockReturnValue({
      equals: vi.fn(() => ({ first: vi.fn() })),
    });
    mockProjectsUpdate.mockResolvedValue(undefined);
    mockCardsWhere.mockReturnValue({
      equals: vi.fn(() => ({ toArray: vi.fn(), delete: vi.fn() })),
    });
    mockCalculateStateHash.mockResolvedValue("local-hash");
    mockProcess.mockResolvedValue(undefined);
    vi.stubGlobal("crypto", {
      subtle: {
        digest: vi.fn(async () => new Uint8Array(32).fill(1).buffer),
      },
    });
  });

  const createSettingsStoreSpies = () => ({
    setPageSizePreset: vi.fn(),
    setColumns: vi.fn(),
    setRows: vi.fn(),
    setDpi: vi.fn(),
    setBleedEdge: vi.fn(),
    setBleedEdgeWidth: vi.fn(),
    setWithBleedSourceAmount: vi.fn(),
    setWithBleedTargetMode: vi.fn(),
    setWithBleedTargetAmount: vi.fn(),
    setNoBleedTargetMode: vi.fn(),
    setNoBleedTargetAmount: vi.fn(),
    setDarkenMode: vi.fn(),
    setDarkenContrast: vi.fn(),
    setDarkenEdgeWidth: vi.fn(),
    setDarkenAmount: vi.fn(),
    setDarkenBrightness: vi.fn(),
    setDarkenAutoDetect: vi.fn(),
    setPerCardGuideStyle: vi.fn(),
    setGuideColor: vi.fn(),
    setGuideWidth: vi.fn(),
    setGuidePlacement: vi.fn(),
    setCutGuideLengthMm: vi.fn(),
    setCutLineStyle: vi.fn(),
    setCardSpacingMm: vi.fn(),
    setCardPositionX: vi.fn(),
    setCardPositionY: vi.fn(),
    setUseCustomBackOffset: vi.fn(),
    setCardBackPositionX: vi.fn(),
    setCardBackPositionY: vi.fn(),
    setPreferredArtSource: vi.fn(),
    setGlobalLanguage: vi.fn(),
    setAutoImportTokens: vi.fn(),
    setMpcFuzzySearch: vi.fn(),
    setShowProcessingToasts: vi.fn(),
    setSortBy: vi.fn(),
    setSortOrder: vi.fn(),
    setFilterManaCost: vi.fn(),
    setFilterColors: vi.fn(),
    setFilterTypes: vi.fn(),
    setFilterCategories: vi.fn(),
    setFilterFeatures: vi.fn(),
    setFilterMatchType: vi.fn(),
    setExportMode: vi.fn(),
    setDecklistSortAlpha: vi.fn(),
  });

  it("surfaces a load error when the share fetch fails", async () => {
    mockLoadShare.mockRejectedValue(new Error("share failed"));

    const { result } = renderHook(() => useShareUrl());

    await waitFor(() => expect(mockLoadShare).toHaveBeenCalledWith("abc"));
    await waitFor(() => expect(result.current.error).toBe("share failed"));
    expect(mockShowErrorToast).toHaveBeenCalledWith("share failed");
  });

  it("does nothing when no share parameter is present", async () => {
    window.history.pushState({}, "", "/");

    const { result } = renderHook(() => useShareUrl());

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(mockLoadShare).not.toHaveBeenCalled();
    expect(result.current.error).toBeNull();
    expect(result.current.shareData).toBeNull();
  });

  it("only loads a shared deck once on rerender after the first load starts", async () => {
    const sharedData = {
      v: 1 as const,
      c: [{ name: "Island" }],
      st: undefined,
    };
    mockLoadShare.mockResolvedValue(sharedData);
    mockProjectsWhere.mockReturnValueOnce({
      equals: vi.fn(() => ({ first: vi.fn().mockResolvedValue(null) })),
    });
    mockDeserializeForImport.mockReturnValue({
      cards: [{ name: "Island" }],
      dfcLinks: [],
      settings: undefined,
    });
    mockCreateProject.mockResolvedValue("project-strict-mode");
    mockProcess.mockResolvedValue(undefined);

    renderHook((_count: number) => useShareUrl(), {
      initialProps: 0,
      reactStrictMode: true,
    });

    await waitFor(() => expect(mockLoadShare).toHaveBeenCalledTimes(1));
    expect(mockProcess).toHaveBeenCalledTimes(1);
  });

  it("skips reloading after the initial load guard trips on rerender", async () => {
    const sharedData = {
      v: 1 as const,
      c: [{ name: "Island" }],
      st: undefined,
    };
    mockLoadShare.mockResolvedValue(sharedData);
    mockProjectsWhere.mockReturnValueOnce({
      equals: vi.fn(() => ({ first: vi.fn().mockResolvedValue(null) })),
    });
    mockDeserializeForImport.mockReturnValue({
      cards: [{ name: "Island" }],
      dfcLinks: [],
      settings: undefined,
    });
    mockCreateProject.mockResolvedValue("project-strict-guard");
    mockProcess.mockResolvedValue(undefined);

    const { rerender } = renderHook(() => useShareUrl());

    await waitFor(() => expect(mockLoadShare).toHaveBeenCalledTimes(1));
    rerender();
    await waitFor(() => expect(mockLoadShare).toHaveBeenCalledTimes(1));
    expect(mockProcess).toHaveBeenCalledTimes(1);
  });

  it("opens an existing clean project and clears the share parameter", async () => {
    const sharedData = {
      v: 1 as const,
      c: [{ name: "Island" }],
      st: undefined,
    };
    const existingProject = {
      id: "project-1",
      name: "Local Deck",
      lastSyncedHash: undefined,
      settings: {},
    };

    mockLoadShare.mockResolvedValue(sharedData);
    mockDeserializeForImport.mockReturnValue({
      cards: [{ name: "Island" }],
      dfcLinks: [],
      settings: undefined,
    });
    mockProjectsWhere.mockReturnValueOnce({
      equals: vi.fn(() => ({ first: vi.fn().mockResolvedValue(existingProject) })),
    });
    mockCardsWhere.mockReturnValue({
      equals: vi.fn(() => ({ toArray: vi.fn().mockResolvedValue([{ uuid: "card-1" }]) })),
    });
    mockCalculateStateHash.mockResolvedValue("0101010101010101010101010101010101010101010101010101010101010101");

    const { result } = renderHook(() => useShareUrl());

    await waitFor(() => expect(mockSwitchProject).toHaveBeenCalledWith("project-1"));
    await waitFor(() => expect(mockShowSuccessToast).toHaveBeenCalledWith('Opened existing project "Local Deck"'));

    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.shareData).toBe(sharedData);
    expect(window.location.search).toBe("");
  });

  it("backfills lastSyncedHash for a legacy clean project", async () => {
    const sharedData = {
      v: 1 as const,
      c: [{ name: "Island" }],
      st: {},
    };
    const existingProject = {
      id: "project-legacy",
      name: "Legacy Deck",
      lastSyncedHash: undefined,
      settings: {},
    };

    mockLoadShare.mockResolvedValue(sharedData);
    mockDeserializeForImport.mockReturnValue({
      cards: [{ name: "Island" }],
      dfcLinks: [],
      settings: undefined,
    });
    mockProjectsWhere.mockReturnValueOnce({
      equals: vi.fn(() => ({ first: vi.fn().mockResolvedValue(existingProject) })),
    });
    mockCardsWhere.mockReturnValue({
      equals: vi.fn(() => ({ toArray: vi.fn().mockResolvedValue([{ uuid: "card-1" }]) })),
    });
    mockCalculateStateHash.mockResolvedValue("0101010101010101010101010101010101010101010101010101010101010101");

    renderHook(() => useShareUrl());

    await waitFor(() => expect(mockSwitchProject).toHaveBeenCalledWith("project-legacy"));
    expect(mockProjectsUpdate).toHaveBeenCalledWith("project-legacy", {
      lastSyncedHash: "0101010101010101010101010101010101010101010101010101010101010101",
    });
  });

  it("skips lastSyncedHash backfill when the clean project already has one", async () => {
    const sharedData = {
      v: 1 as const,
      c: [{ name: "Island" }],
      st: {},
    };
    const existingProject = {
      id: "project-modern",
      name: "Modern Deck",
      lastSyncedHash: "0101010101010101010101010101010101010101010101010101010101010101",
      settings: {},
    };

    mockLoadShare.mockResolvedValue(sharedData);
    mockDeserializeForImport.mockReturnValue({
      cards: [{ name: "Island" }],
      dfcLinks: [],
      settings: undefined,
    });
    mockProjectsWhere.mockReturnValueOnce({
      equals: vi.fn(() => ({ first: vi.fn().mockResolvedValue(existingProject) })),
    });
    mockCardsWhere.mockReturnValue({
      equals: vi.fn(() => ({ toArray: vi.fn().mockResolvedValue([{ uuid: "card-1" }]) })),
    });
    mockCalculateStateHash.mockResolvedValue("0101010101010101010101010101010101010101010101010101010101010101");
    vi.stubGlobal("crypto", {
      subtle: {
        digest: vi.fn(async () => new Uint8Array(32).fill(1).buffer),
      },
    });

    renderHook(() => useShareUrl());

    await waitFor(() => expect(mockSwitchProject).toHaveBeenCalledWith("project-modern"));
    expect(mockProjectsUpdate).not.toHaveBeenCalledWith("project-modern", expect.objectContaining({ lastSyncedHash: expect.anything() }));
  });

  it("creates a new project and imports shared cards when none exists locally", async () => {
    const sharedData = {
      v: 1 as const,
      c: [{ name: "Alpha" }],
      dfc: [],
      st: {},
    };

    mockLoadShare.mockResolvedValue(sharedData);
    mockDeserializeForImport.mockReturnValue({
      cards: [{ name: "Alpha" }, { name: "Beta", builtInCardbackId: "cardback_blank" }],
      dfcLinks: [[0, 1]],
      settings: undefined,
    });
    mockProjectsWhere.mockReturnValueOnce({
      equals: vi.fn(() => ({ first: vi.fn().mockResolvedValue(null) })),
    });
    mockCreateProject.mockResolvedValue("project-new");
    mockCalculateStateHash.mockResolvedValue("remote-hash");
    mockProcess.mockImplementation(async (_intents, options) => {
      await options.onComplete();
    });

    const { result } = renderHook(() => useShareUrl());

    await waitFor(() => expect(mockCreateProject).toHaveBeenCalledWith("Alpha (Shared)"));
    await waitFor(() => expect(mockProcess).toHaveBeenCalled());

    expect(mockSwitchProject).toHaveBeenCalledWith("project-new");
    expect(mockShowSuccessToast).toHaveBeenCalledWith('Imported 1 cards from shared deck');
    expect(result.current.error).toBeNull();
    expect(result.current.shareData).toBe(sharedData);
    expect(window.location.search).toBe("");
  });

  it("falls back to the default shared deck name when no card has a name", async () => {
    const sharedData = {
      v: 1 as const,
      c: [],
      dfc: undefined,
      st: undefined,
    };

    mockLoadShare.mockResolvedValue(sharedData);
    mockDeserializeForImport.mockReturnValue({
      cards: [
        { imageId: "front-a", order: 0 },
        { builtInCardbackId: "cardback_default", order: 1 },
      ],
      dfcLinks: [[0, 1]],
      settings: undefined,
    });
    mockProjectsWhere.mockReturnValueOnce({
      equals: vi.fn(() => ({ first: vi.fn().mockResolvedValue(null) })),
    });
    mockCreateProject.mockResolvedValue("project-default-name");
    mockProcess.mockResolvedValue(undefined);

    await renderHook(() => useShareUrl());

    await waitFor(() => expect(mockCreateProject).toHaveBeenCalledWith("Shared Deck (Shared)"));
  });

  it("falls back to a generic error when the share load rejects with a non-Error value", async () => {
    mockLoadShare.mockRejectedValue("boom");

    const { result } = renderHook(() => useShareUrl());

    await waitFor(() => expect(result.current.error).toBe("Failed to load shared deck"));
    expect(mockShowErrorToast).toHaveBeenCalledWith("Failed to load shared deck");
  });

  it("applies shared settings and converts all linked back types when creating a new project", async () => {
    const sharedData = {
      v: 1 as const,
      c: [{ name: "Front A" }, { name: "Front B" }, { name: "Front C" }],
      dfc: [[0, 1], [2, 3], [4, 5]],
      st: { pr: "A4" },
    };
    const settings = {
      pr: "A4",
      c: 3,
      r: 2,
      dpi: 600,
      bl: true,
      blMm: 1.5,
      wbSrc: 0.25,
      wbTm: "crop",
      wbTa: 0.5,
      nbTm: "trim",
      nbTa: 0.25,
      dk: "contrast",
      dkC: 1.2,
      dkE: 2,
      dkA: 0.3,
      dkB: 0.4,
      dkAd: true,
      gs: "solid",
      gc: "#00ff00",
      gw: 2,
      gp: "inside",
      cgL: 5,
      cls: "solid",
      spc: 1.25,
      pX: 0.1,
      pY: 0.2,
      ucbo: true,
      bpX: 0.3,
      bpY: 0.4,
      pas: "mpc",
      gl: "en",
      ait: true,
      mfs: true,
      spt: true,
      sb: "name",
      so: "asc",
      fmc: "any",
      fcol: "W,U",
      ftyp: "Creature",
      fcat: "Token",
      ffeat: "Flying",
      fmt: "contains",
      em: "grid",
      dsa: true,
    };
    const settingsStore = createSettingsStoreSpies();
    mockSettingsGetState.mockReturnValue(settingsStore);
    mockLoadShare.mockResolvedValue(sharedData);
    mockDeserializeForImport.mockReturnValue({
      cards: [
        { name: "Front A", imageId: "front-a", order: 0 },
        { name: "Back A", builtInCardbackId: "cardback_default", order: 1 },
        { name: "Front B", imageId: "front-b", order: 2, mpcIdentifier: "mpc-front-b" },
        { name: "Back B", mpcIdentifier: "mpc-back-b", order: 3 },
        { name: "Front C", imageId: "front-c", order: 4, set: "abc", number: "7" },
        { name: "Back C", set: "xyz", number: "8", order: 5 },
      ],
      dfcLinks: [[0, 1], [2, 3], [4, 5]],
      settings,
    });
    mockProjectsWhere.mockReturnValueOnce({
      equals: vi.fn(() => ({ first: vi.fn().mockResolvedValue(null) })),
    });
    mockCreateProject.mockResolvedValue("project-settings");
    let capturedIntents: unknown[] = [];
    mockProcess.mockImplementation(async (intents) => {
      capturedIntents = intents as unknown[];
    });

    renderHook(() => useShareUrl());

    await waitFor(() => expect(mockProcess).toHaveBeenCalled());

    expect(settingsStore.setPageSizePreset).toHaveBeenCalledWith("A4");
    expect(settingsStore.setColumns).toHaveBeenCalledWith(3);
    expect(settingsStore.setRows).toHaveBeenCalledWith(2);
    expect(settingsStore.setDpi).toHaveBeenCalledWith(600);
    expect(settingsStore.setBleedEdge).toHaveBeenCalledWith(true);
    expect(settingsStore.setBleedEdgeWidth).toHaveBeenCalledWith(1.5);
    expect(settingsStore.setWithBleedSourceAmount).toHaveBeenCalledWith(0.25);
    expect(settingsStore.setWithBleedTargetMode).toHaveBeenCalledWith("crop");
    expect(settingsStore.setWithBleedTargetAmount).toHaveBeenCalledWith(0.5);
    expect(settingsStore.setNoBleedTargetMode).toHaveBeenCalledWith("trim");
    expect(settingsStore.setNoBleedTargetAmount).toHaveBeenCalledWith(0.25);
    expect(settingsStore.setDarkenMode).toHaveBeenCalledWith("contrast");
    expect(settingsStore.setDarkenContrast).toHaveBeenCalledWith(1.2);
    expect(settingsStore.setDarkenEdgeWidth).toHaveBeenCalledWith(2);
    expect(settingsStore.setDarkenAmount).toHaveBeenCalledWith(0.3);
    expect(settingsStore.setDarkenBrightness).toHaveBeenCalledWith(0.4);
    expect(settingsStore.setDarkenAutoDetect).toHaveBeenCalledWith(true);
    expect(settingsStore.setPerCardGuideStyle).toHaveBeenCalledWith("solid");
    expect(settingsStore.setGuideColor).toHaveBeenCalledWith("#00ff00");
    expect(settingsStore.setGuideWidth).toHaveBeenCalledWith(2);
    expect(settingsStore.setGuidePlacement).toHaveBeenCalledWith("inside");
    expect(settingsStore.setCutGuideLengthMm).toHaveBeenCalledWith(5);
    expect(settingsStore.setCutLineStyle).toHaveBeenCalledWith("solid");
    expect(settingsStore.setCardSpacingMm).toHaveBeenCalledWith(1.25);
    expect(settingsStore.setCardPositionX).toHaveBeenCalledWith(0.1);
    expect(settingsStore.setCardPositionY).toHaveBeenCalledWith(0.2);
    expect(settingsStore.setUseCustomBackOffset).toHaveBeenCalledWith(true);
    expect(settingsStore.setCardBackPositionX).toHaveBeenCalledWith(0.3);
    expect(settingsStore.setCardBackPositionY).toHaveBeenCalledWith(0.4);
    expect(settingsStore.setPreferredArtSource).toHaveBeenCalledWith("mpc");
    expect(settingsStore.setGlobalLanguage).toHaveBeenCalledWith("en");
    expect(settingsStore.setAutoImportTokens).toHaveBeenCalledWith(true);
    expect(settingsStore.setMpcFuzzySearch).toHaveBeenCalledWith(true);
    expect(settingsStore.setShowProcessingToasts).toHaveBeenCalledWith(true);
    expect(settingsStore.setSortBy).toHaveBeenCalledWith("name");
    expect(settingsStore.setSortOrder).toHaveBeenCalledWith("asc");
    expect(settingsStore.setFilterManaCost).toHaveBeenCalledWith("any");
    expect(settingsStore.setFilterColors).toHaveBeenCalledWith("W,U");
    expect(settingsStore.setFilterTypes).toHaveBeenCalledWith("Creature");
    expect(settingsStore.setFilterCategories).toHaveBeenCalledWith("Token");
    expect(settingsStore.setFilterFeatures).toHaveBeenCalledWith("Flying");
    expect(settingsStore.setFilterMatchType).toHaveBeenCalledWith("contains");
    expect(settingsStore.setExportMode).toHaveBeenCalledWith("grid");
    expect(settingsStore.setDecklistSortAlpha).toHaveBeenCalledWith(true);
    expect(settingsStore.setPageSizePreset).toHaveBeenCalledTimes(2);

    expect(capturedIntents).toHaveLength(3);
    expect(capturedIntents[0]).toMatchObject({
      name: "Front A",
      linkedBackImageId: "cardback_default",
      linkedBackName: "Back A",
    });
    expect(capturedIntents[1]).toMatchObject({
      name: "Front B",
      linkedBackImageId: "mpc-back-b",
      linkedBackName: "Back B",
    });
    expect(capturedIntents[2]).toMatchObject({
      name: "Front C",
      linkedBackSet: "xyz",
      linkedBackNumber: "8",
      linkedBackName: "Back C",
    });
  });

  it("uses fallback back names when linked backs do not provide names", async () => {
    const sharedData = {
      v: 1 as const,
      c: [{ name: "Front A" }, { name: "Front B" }, { name: "Front C" }],
      dfc: [[0, 1], [2, 3], [4, 5]],
      st: {},
    };

    mockLoadShare.mockResolvedValue(sharedData);
    mockDeserializeForImport.mockReturnValue({
      cards: [
        { name: "Front A", order: 0 },
        { builtInCardbackId: "cardback_default", order: 1 },
        { name: "Front B", order: 2 },
        { mpcIdentifier: "mpc-back-b", order: 3 },
        { name: "Front C", order: 4 },
        { set: "xyz", number: "8", order: 5 },
        { name: "Front D", order: 6 },
        { order: 7 },
      ],
      dfcLinks: [[0, 1], [2, 3], [4, 5], [6, 7]],
      settings: undefined,
    });
    mockProjectsWhere.mockReturnValueOnce({
      equals: vi.fn(() => ({ first: vi.fn().mockResolvedValue(null) })),
    });
    mockCreateProject.mockResolvedValue("project-fallbacks");
    let capturedIntents: unknown[] = [];
    mockProcess.mockImplementation(async (intents) => {
      capturedIntents = intents as unknown[];
    });

    renderHook(() => useShareUrl());

    await waitFor(() => expect(mockProcess).toHaveBeenCalled());

    expect(capturedIntents[0]).toMatchObject({ linkedBackName: "Cardback" });
    expect(capturedIntents[1]).toMatchObject({ linkedBackName: "Back" });
    expect(capturedIntents[2]).toMatchObject({ linkedBackName: "Back" });
    expect(capturedIntents[3]).not.toHaveProperty("linkedBackImageId");
  });

  it("forks a dirty existing project and creates a new shared copy", async () => {
    const sharedData = {
      v: 1 as const,
      c: [{ name: "Fork Me" }],
      dfc: [],
      st: {},
    };
    const existingProject = {
      id: "project-dirty",
      name: "Dirty Deck",
      lastSyncedHash: undefined,
      settings: {},
    };

    mockLoadShare.mockResolvedValue(sharedData);
    mockDeserializeForImport.mockReturnValue({
      cards: [{ name: "Fork Me" }],
      dfcLinks: [],
      settings: undefined,
    });
    mockProjectsWhere.mockReturnValueOnce({
      equals: vi.fn(() => ({ first: vi.fn().mockResolvedValue(existingProject) })),
    });
    mockCardsWhere.mockReturnValue({
      equals: vi.fn(() => ({ toArray: vi.fn().mockResolvedValue([{ uuid: "card-1" }]), delete: vi.fn().mockResolvedValue(undefined) })),
    });
    mockCalculateStateHash.mockResolvedValue("local-dirty-hash");
    mockCreateProject.mockResolvedValue("project-forked");
    vi.stubGlobal("crypto", {
      subtle: {
        digest: vi.fn(async () => new Uint8Array(32).fill(2).buffer),
      },
    });

    const { result } = renderHook(() => useShareUrl());

    await waitFor(() => expect(mockCreateProject).toHaveBeenCalledWith("Fork Me (Shared)"));
    await waitFor(() => expect(mockProcess).toHaveBeenCalled());

    expect(mockShowInfoToast).toHaveBeenCalledWith("Local changes detected. Created new copy of shared deck.");
    expect(result.current.error).toBeNull();
    expect(result.current.shareData).toBe(sharedData);
  });

  it("overwrites a clean but out-of-date project", async () => {
    const sharedData = {
      v: 1 as const,
      c: [{ name: "Overwrite Me" }],
      dfc: [],
      st: {},
    };
    const existingProject = {
      id: "project-clean",
      name: "Clean Deck",
      lastSyncedHash: "local-clean-hash",
      settings: {},
    };

    mockLoadShare.mockResolvedValue(sharedData);
    mockDeserializeForImport.mockReturnValue({
      cards: [{ name: "Overwrite Me" }],
      dfcLinks: [],
      settings: undefined,
    });
    mockProjectsWhere.mockReturnValueOnce({
      equals: vi.fn(() => ({ first: vi.fn().mockResolvedValue(existingProject) })),
    });
    mockCardsWhere.mockReturnValue({
      equals: vi.fn(() => ({
        toArray: vi.fn().mockResolvedValue([{ uuid: "card-1" }]),
        delete: vi.fn().mockResolvedValue(undefined),
      })),
    });
    mockCalculateStateHash.mockResolvedValue("local-clean-hash");
    mockProcess.mockImplementation(async (_intents, options) => {
      await options.onComplete();
    });
    vi.stubGlobal("crypto", {
      subtle: {
        digest: vi.fn(async () => new Uint8Array(32).fill(3).buffer),
      },
    });

    const { result } = renderHook(() => useShareUrl());

    await waitFor(() => expect(mockProcess).toHaveBeenCalled());
    await waitFor(() => expect(mockShowSuccessToast).toHaveBeenCalledWith('Updated "Clean Deck" from share'));

    expect(result.current.error).toBeNull();
    expect(result.current.shareData).toBe(sharedData);
  });

  it("applies shared settings when overwriting a clean but out-of-date project", async () => {
    const sharedData = {
      v: 1 as const,
      c: [{ name: "Overwrite With Settings" }],
      dfc: [],
      st: {},
    };
    const existingProject = {
      id: "project-clean-settings",
      name: "Clean Settings Deck",
      lastSyncedHash: "local-clean-hash",
      settings: {},
    };
    const settingsStore = createSettingsStoreSpies();

    mockSettingsGetState.mockReturnValue(settingsStore);
    mockLoadShare.mockResolvedValue(sharedData);
    mockDeserializeForImport.mockReturnValue({
      cards: [{ name: "Overwrite With Settings" }],
      dfcLinks: [],
      settings: {
        pr: "A4",
        c: 2,
        r: 2,
        dpi: 300,
        fmc: "any",
        fcol: "W,U",
        ftyp: "Creature",
        fcat: "Token",
        ffeat: "Flying",
        fmt: "contains",
      },
    });
    mockProjectsWhere.mockReturnValueOnce({
      equals: vi.fn(() => ({ first: vi.fn().mockResolvedValue(existingProject) })),
    });
    mockCardsWhere.mockReturnValue({
      equals: vi.fn(() => ({ toArray: vi.fn().mockResolvedValue([{ uuid: "card-1" }]), delete: vi.fn().mockResolvedValue(undefined) })),
    });
    mockCalculateStateHash.mockResolvedValue("local-clean-hash");
    mockProcess.mockImplementation(async (_intents, options) => {
      await options.onComplete();
    });

    renderHook(() => useShareUrl());

    await waitFor(() => expect(mockProcess).toHaveBeenCalled());

    expect(settingsStore.setPageSizePreset).toHaveBeenCalledWith("A4");
    expect(settingsStore.setColumns).toHaveBeenCalledWith(2);
    expect(settingsStore.setRows).toHaveBeenCalledWith(2);
    expect(settingsStore.setDpi).toHaveBeenCalledWith(300);
    expect(settingsStore.setFilterManaCost).toHaveBeenCalledWith("any");
    expect(settingsStore.setFilterColors).toHaveBeenCalledWith("W,U");
    expect(settingsStore.setFilterTypes).toHaveBeenCalledWith("Creature");
    expect(settingsStore.setFilterCategories).toHaveBeenCalledWith("Token");
    expect(settingsStore.setFilterFeatures).toHaveBeenCalledWith("Flying");
    expect(settingsStore.setFilterMatchType).toHaveBeenCalledWith("contains");
  });

  it("skips shared-setting setters when the share payload includes an empty settings object", async () => {
    const sharedData = {
      v: 1 as const,
      c: [{ name: "Minimal" }],
      dfc: [],
      st: {},
    };
    const settingsStore = createSettingsStoreSpies();
    const existingProject = {
      id: "project-empty-settings",
      name: "Empty Settings Deck",
      lastSyncedHash: "local-clean-hash",
      settings: {},
    };

    mockSettingsGetState.mockReturnValue(settingsStore);
    mockLoadShare.mockResolvedValue(sharedData);
    mockDeserializeForImport.mockReturnValue({
      cards: [{ name: "Minimal" }],
      dfcLinks: [],
      settings: {},
    });
    mockProjectsWhere.mockReturnValueOnce({
      equals: vi.fn(() => ({ first: vi.fn().mockResolvedValue(existingProject) })),
    });
    mockCardsWhere.mockReturnValue({
      equals: vi.fn(() => ({ toArray: vi.fn().mockResolvedValue([{ uuid: "card-1" }]), delete: vi.fn().mockResolvedValue(undefined) })),
    });
    mockCalculateStateHash.mockResolvedValue("local-clean-hash");
    mockProcess.mockImplementation(async (_intents, options) => {
      await options.onComplete();
    });

    renderHook(() => useShareUrl());

    await waitFor(() => expect(mockProcess).toHaveBeenCalled());
    expect(settingsStore.setPageSizePreset).not.toHaveBeenCalled();
    expect(settingsStore.setColumns).not.toHaveBeenCalled();
    expect(settingsStore.setDpi).not.toHaveBeenCalled();
  });

  it("reports an error when the shared deck has no cards", async () => {
    mockLoadShare.mockResolvedValue({
      v: 1 as const,
      c: [],
      dfc: [],
      st: {},
    });
    mockDeserializeForImport.mockReturnValue({
      cards: [],
      dfcLinks: [],
      settings: undefined,
    });
    mockProjectsWhere.mockReturnValueOnce({
      equals: vi.fn(() => ({ first: vi.fn().mockResolvedValue(null) })),
    });

    const { result } = renderHook(() => useShareUrl());

    await waitFor(() => expect(result.current.error).toBe("Shared deck contains no cards"));
    expect(mockShowErrorToast).toHaveBeenCalledWith("Shared deck contains no cards");
  });

});
