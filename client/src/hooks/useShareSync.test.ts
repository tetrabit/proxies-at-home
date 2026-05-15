import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useShareSync } from "./useShareSync";

let currentProject: { id: string; lastSharedAt?: number } | null = null;

vi.mock("dexie-react-hooks", () => ({
  useLiveQuery: vi.fn((queryFn) => {
    void queryFn?.();
    return currentProject;
  }),
}));

vi.mock("@/store", () => ({
  useProjectStore: vi.fn((selector) => selector({ currentProjectId: currentProject?.id ?? null })),
}));

describe("useShareSync", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    currentProject = null;
  });

  it("tracks project changes and synced timestamps", async () => {
    currentProject = { id: "p1", lastSharedAt: 111 };
    const { result, rerender } = renderHook(() => useShareSync());

    expect(result.current.lastSyncedAt).toBe(111);
    expect(result.current.syncStatus).toBe("idle");

    currentProject = { id: "p1", lastSharedAt: 222 };
    rerender();

    expect(result.current.lastSyncedAt).toBe(222);
    expect(result.current.syncStatus).toBe("synced");

    currentProject = { id: "p1", lastSharedAt: 222 };
    rerender();

    expect(result.current.lastSyncedAt).toBe(222);
    expect(result.current.syncStatus).toBe("synced");
  });

  it("stays idle when there is no project and resets on project switches", () => {
    const { result, rerender } = renderHook(() => useShareSync());

    expect(result.current.lastSyncedAt).toBeNull();
    expect(result.current.syncStatus).toBe("idle");

    currentProject = { id: "p2", lastSharedAt: 333 };
    rerender();

    expect(result.current.lastSyncedAt).toBe(333);
    expect(result.current.syncStatus).toBe("idle");
  });

  it("stores null when a shared project has no timestamp", () => {
    currentProject = { id: "p1" };
    const { result, rerender } = renderHook(() => useShareSync());

    expect(result.current.lastSyncedAt).toBeNull();
    expect(result.current.syncStatus).toBe("idle");

    currentProject = { id: "p2" };
    rerender();

    expect(result.current.lastSyncedAt).toBeNull();
    expect(result.current.syncStatus).toBe("idle");
  });

  it("returns to idle after the synced toast timeout expires", async () => {
    currentProject = { id: "p1", lastSharedAt: 111 };
    const { result, rerender } = renderHook(() => useShareSync());

    act(() => {
      currentProject = { id: "p1", lastSharedAt: 222 };
      rerender();
    });

    expect(result.current.syncStatus).toBe("synced");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });

    expect(result.current.syncStatus).toBe("idle");
  });
});
