import { renderHook, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ImportIntent } from "@/helpers/importParsers";
import { useCardImport } from "./useCardImport";

const { showErrorToast, orchestratorProcess, handleAutoImportTokens } = vi.hoisted(() => {
  return {
    showErrorToast: vi.fn(),
    orchestratorProcess: vi.fn(),
    handleAutoImportTokens: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("@/helpers/ImportOrchestrator", () => ({
  ImportOrchestrator: {
    process: (...args: unknown[]) => orchestratorProcess(...args),
  },
}));

vi.mock("@/store/toast", () => ({
  useToastStore: {
    getState: () => ({
      showErrorToast,
    }),
  },
}));

vi.mock("@/helpers/tokenImportHelper", () => ({
  handleAutoImportTokens,
}));

describe("useCardImport", () => {
  beforeEach(() => {
    orchestratorProcess.mockReset();
    showErrorToast.mockReset();
    handleAutoImportTokens.mockClear();
  });

  it("shows an error when no intents are provided", async () => {
    const { result } = renderHook(() => useCardImport());

    await act(async () => {
      await result.current.processCards([]);
    });

    expect(orchestratorProcess).not.toHaveBeenCalled();
    expect(showErrorToast).toHaveBeenCalledWith(
      "No valid cards found to import. Please check your input."
    );
  });

  it("invokes ImportOrchestrator and triggers completion callback", async () => {
    const onComplete = vi.fn();
    const intent: ImportIntent = {
      name: "Sol Ring",
      quantity: 1,
      inputType: "decklist",
      source: "decklist",
      cardData: null,
      set: null,
      number: null,
      imageUrls: ["https://example.com/card.png"],
      preferredImageId: null,
      category: null,
      scryfallId: null,
      hasBuiltInBleed: false,
      order: 0,
      mpcIdentifier: null,
      linkedBackSet: null,
      linkedBackNumber: null,
      linkedBackImageId: null,
      linkedBackName: null,
      isToken: false,
      tokenAddedFrom: null,
      overrides: undefined,
      oracleId: undefined,
      lang: undefined,
      id: undefined,
    };

    orchestratorProcess.mockImplementation(
      async (_intents: ImportIntent[], options: { onComplete: () => void }) => {
        options.onComplete();
      }
    );

    const { result } = renderHook(() => useCardImport({ onComplete }));

    await act(async () => {
      await result.current.processCards([intent]);
    });

    expect(orchestratorProcess).toHaveBeenCalledOnce();
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(handleAutoImportTokens).toHaveBeenCalledWith({ silent: true });
  });

  it("shows an error toast for non-abort failures", async () => {
    orchestratorProcess.mockRejectedValue(new Error("network down"));

    const { result } = renderHook(() => useCardImport());

    await act(async () => {
      await result.current.processCards([{ name: "Black Lotus" } as ImportIntent]);
    });

    expect(showErrorToast).toHaveBeenCalledWith("network down");
  });

  it("shows a generic error toast for non-Error failures", async () => {
    orchestratorProcess.mockRejectedValue("boom" as unknown as Error);

    const { result } = renderHook(() => useCardImport());

    await act(async () => {
      await result.current.processCards([{ name: "Island" } as ImportIntent]);
    });

    expect(showErrorToast).toHaveBeenCalledWith(
      "An unknown error occurred while fetching cards."
    );
  });


  it("aborts an in-flight request before starting a new one", async () => {
    const abortHandler = vi.fn();
    let firstResolve: (() => void) | undefined;
    const implCalls: number[] = [];

    orchestratorProcess.mockImplementation(async (_intents: ImportIntent[], opts: { signal: AbortSignal }) => {
      implCalls.push(1);

      if (implCalls.length === 1) {
        opts.signal.addEventListener("abort", abortHandler);
        return new Promise<void>((resolve) => {
          firstResolve = resolve;
        });
      }

      return Promise.resolve(undefined);
    });

    const { result } = renderHook(() => useCardImport());

    void result.current.processCards([{ name: "Island" } as ImportIntent]);
    await Promise.resolve();
    expect(abortHandler).toHaveBeenCalledTimes(0);

    void result.current.processCards([{ name: "Island" } as ImportIntent]);
    expect(abortHandler).toHaveBeenCalledTimes(1);

    firstResolve?.();
  });

  it("cancels active import requests", async () => {
    const abortHandler = vi.fn();
    let resolve: (() => void) | undefined;
    orchestratorProcess.mockImplementation(async (_intents: ImportIntent[], opts: { signal: AbortSignal }) => {
      opts.signal.addEventListener("abort", abortHandler);
      return new Promise<void>((r) => {
        resolve = r;
      });
    });

    const { result } = renderHook(() => useCardImport());

    // Start import and immediately cancel while request is in-flight.
    void result.current.processCards([{ name: "Island" } as ImportIntent]);

    act(() => {
      result.current.cancel();
    });

    expect(abortHandler).toHaveBeenCalledTimes(1);
    resolve?.();
  });
});
