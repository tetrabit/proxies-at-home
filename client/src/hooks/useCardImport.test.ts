import { renderHook, act } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useCardImport } from "./useCardImport";

const mockProcess = vi.hoisted(() => vi.fn());
const mockHandleAutoImportTokens = vi.hoisted(() => vi.fn());
const mockShowErrorToast = vi.hoisted(() => vi.fn());

vi.mock("@/helpers/ImportOrchestrator", () => ({
  ImportOrchestrator: {
    process: mockProcess,
  },
}));

vi.mock("@/helpers/tokenImportHelper", () => ({
  handleAutoImportTokens: mockHandleAutoImportTokens,
}));

vi.mock("@/store/toast", () => ({
  useToastStore: {
    getState: () => ({
      showErrorToast: mockShowErrorToast,
    }),
  },
}));

describe("useCardImport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows a toast when there are no intents", async () => {
    const { result } = renderHook(() => useCardImport());
    await act(async () => {
      await result.current.processCards([]);
    });
    expect(mockShowErrorToast).toHaveBeenCalled();
  });

  it("runs the import orchestrator and auto-imports tokens", async () => {
    const onComplete = vi.fn();
    mockProcess.mockImplementation(async (_intents, options) => {
      options.onComplete();
    });

    const { result } = renderHook(() => useCardImport({ onComplete }));
    await act(async () => {
      await result.current.processCards([{ name: "Card", quantity: 1 }] as never);
    });

    expect(mockProcess).toHaveBeenCalled();
    expect(onComplete).toHaveBeenCalled();
    expect(mockHandleAutoImportTokens).toHaveBeenCalledWith({ silent: true });
  });
});
