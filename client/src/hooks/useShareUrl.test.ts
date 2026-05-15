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
const mockCardsWhere = vi.hoisted(() => vi.fn());
const mockSettingsGetState = vi.hoisted(() => vi.fn(() => ({})));
const mockProjectGetState = vi.hoisted(() => vi.fn());

vi.mock("@/db", () => ({
  db: {
    projects: {
      where: mockProjectsWhere,
      update: vi.fn(),
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

  it("surfaces a load error when the share fetch fails", async () => {
    mockLoadShare.mockRejectedValue(new Error("share failed"));

    const { result } = renderHook(() => useShareUrl());

    await waitFor(() => expect(mockLoadShare).toHaveBeenCalledWith("abc"));

    expect(result.current.error).toBe("share failed");
    expect(mockShowErrorToast).toHaveBeenCalledWith("share failed");
  });

  it("opens an existing clean project and clears the share parameter", async () => {
    const sharedData = {
      v: 1 as const,
      c: [{ name: "Island" }],
      st: {},
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
});
