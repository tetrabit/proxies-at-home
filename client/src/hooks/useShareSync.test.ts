import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useShareSync } from "./useShareSync";

let currentProject: { id: string; lastSharedAt?: number } | null = null;

vi.mock("dexie-react-hooks", () => ({
  useLiveQuery: vi.fn(() => currentProject),
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
  });
});
