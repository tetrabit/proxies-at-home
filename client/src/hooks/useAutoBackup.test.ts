import { renderHook, act } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { backupProject, useAutoBackup } from "./useAutoBackup";

const mockExportProject = vi.hoisted(() => vi.fn());
const mockFetch = vi.hoisted(() => vi.fn());
const mockUseLiveQuery = vi.hoisted(() => vi.fn());
const mockUseProjectStore = vi.hoisted(() => vi.fn());

vi.mock("@/helpers/projectBackup", () => ({
  exportProject: mockExportProject,
}));

vi.mock("@/constants", () => ({
  API_BASE: "http://example.test",
}));

vi.mock("dexie-react-hooks", () => ({
  useLiveQuery: mockUseLiveQuery,
}));

vi.mock("@/store", () => ({
  useProjectStore: mockUseProjectStore,
}));

vi.mock("@/helpers/debug", () => ({
  debugLog: vi.fn(),
}));

vi.mock("@/db", () => ({
  db: {
    cards: {
      where: vi.fn(() => ({ equals: vi.fn(() => ({ count: vi.fn().mockResolvedValue(0) })) })),
    },
    projects: {
      get: vi.fn().mockResolvedValue({ settings: {} }),
      toArray: vi.fn().mockResolvedValue([]),
    },
  },
}));

describe("useAutoBackup", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mockUseProjectStore.mockImplementation((selector) => selector({ currentProjectId: "project-1" }));
    mockUseLiveQuery.mockImplementation(() => ({ count: 1, settingsHash: 1 }));
    vi.stubGlobal("fetch", mockFetch);
  });

  it("backs up a project directly", async () => {
    mockExportProject.mockResolvedValue({
      project: { name: "Project 1" },
      cards: [{ linkedFrontId: null }],
    });
    mockFetch.mockResolvedValue({ ok: true });

    await expect(backupProject("project-1")).resolves.toBe(true);
    expect(mockFetch).toHaveBeenCalledWith(
      "http://example.test/api/backup/project-1",
      expect.objectContaining({ method: "PUT" })
    );
  });

  it("schedules a backup when the change signal changes", async () => {
    mockExportProject.mockResolvedValue({
      project: { name: "Project 1" },
      cards: [{ linkedFrontId: null }],
    });
    mockFetch.mockResolvedValue({ ok: true });

    renderHook(() => useAutoBackup());

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });

    expect(mockExportProject).toHaveBeenCalled();
  });
});
