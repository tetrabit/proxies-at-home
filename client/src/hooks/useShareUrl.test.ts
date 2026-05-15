import { renderHook, act } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useShareUrl } from "./useShareUrl";

const mockLoadShare = vi.hoisted(() => vi.fn());
const mockShowErrorToast = vi.hoisted(() => vi.fn());
const mockUseProjectStore = vi.hoisted(() => vi.fn());
const mockUseSettingsStore = vi.hoisted(() => vi.fn());

vi.mock("@/db", () => ({
  db: {
    projects: {
      where: vi.fn(() => ({ equals: vi.fn(() => ({ first: vi.fn() })) })),
      update: vi.fn(),
    },
    cards: {
      where: vi.fn(() => ({ equals: vi.fn(() => ({ toArray: vi.fn(), delete: vi.fn() })) })),
    },
  },
}));

vi.mock("@/helpers/shareHelper", () => ({
  loadShare: mockLoadShare,
  deserializeForImport: vi.fn(),
  calculateStateHash: vi.fn(),
}));

vi.mock("@/store/settings", () => ({
  useSettingsStore: mockUseSettingsStore,
}));

vi.mock("@/store/toast", () => ({
  useToastStore: {
    getState: () => ({
      showErrorToast: mockShowErrorToast,
      showInfoToast: vi.fn(),
      showSuccessToast: vi.fn(),
    }),
  },
}));

vi.mock("@/store", () => ({
  useProjectStore: mockUseProjectStore,
}));

vi.mock("@/helpers/ImportOrchestrator", () => ({
  ImportOrchestrator: { process: vi.fn() },
}));

vi.mock("@/helpers/debug", () => ({
  debugLog: vi.fn(),
}));

describe("useShareUrl", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseProjectStore.mockReturnValue({
      switchProject: vi.fn(),
      createProject: vi.fn(),
      getState: vi.fn(),
    });
    mockUseSettingsStore.mockReturnValue({});
    window.history.pushState({}, "", "/?share=abc");
  });

  it("surfaces a load error when the share fetch fails", async () => {
    mockLoadShare.mockRejectedValue(new Error("share failed"));

    const { result } = renderHook(() => useShareUrl());

    await act(async () => {
      await Promise.resolve();
    });

    expect(mockLoadShare).toHaveBeenCalledWith("abc");
    expect(result.current.error).toBe("share failed");
    expect(mockShowErrorToast).toHaveBeenCalledWith("share failed");
  });
});
