import { renderHook, act } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { backupProject, useAutoBackup } from "./useAutoBackup";

const mockExportProject = vi.hoisted(() => vi.fn());
const mockFetch = vi.hoisted(() => vi.fn());
const mockUseLiveQuery = vi.hoisted(() => vi.fn());
const mockUseProjectStore = vi.hoisted(() => vi.fn());
const mockProjectsToArray = vi.hoisted(() => vi.fn());
const mockProjectCardCounts = vi.hoisted(() => new Map<string, number>());
let currentProjectId = "project-1";

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
      where: vi.fn(() => ({
        equals: vi.fn((projectId: string) => ({
          count: vi.fn().mockImplementation(async () => mockProjectCardCounts.get(projectId) ?? 0),
        })),
      })),
    },
    projects: {
      get: vi.fn().mockResolvedValue({ settings: {} }),
      toArray: mockProjectsToArray,
    },
  },
}));

describe("useAutoBackup", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mockProjectCardCounts.clear();
    currentProjectId = "project-1";
    mockUseProjectStore.mockImplementation((selector) => selector({ currentProjectId }));
    mockUseLiveQuery.mockImplementation(() => ({ count: 1, settingsHash: 1 }));
    mockProjectsToArray.mockResolvedValue([]);
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

  it("returns true without sending when the backup has no main cards", async () => {
    mockExportProject.mockResolvedValue({
      project: { name: "Project 1" },
      cards: [{ linkedFrontId: "back-1" }],
    });

    await expect(backupProject("project-1")).resolves.toBe(true);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns false when the server rejects the backup", async () => {
    mockExportProject.mockResolvedValue({
      project: { name: "Project 1" },
      cards: [{ linkedFrontId: null }],
    });
    mockFetch.mockResolvedValue({ ok: false });

    await expect(backupProject("project-1")).resolves.toBe(false);
  });

  it("schedules a backup when the change signal changes", async () => {
    currentProjectId = "project-2";
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

  it("backs up projects during the periodic sweep", async () => {
    currentProjectId = "project-sweep";
    mockProjectsToArray.mockResolvedValue([
      { id: "project-sweep", name: "Sweep Project" },
      { id: "project-empty", name: "Empty Project" },
    ]);
    mockProjectCardCounts.set("project-sweep", 2);
    mockProjectCardCounts.set("project-empty", 0);
    mockExportProject.mockResolvedValue({
      project: { name: "Sweep Project" },
      cards: [{ linkedFrontId: null }],
    });
    mockFetch.mockResolvedValue({ ok: true });

    renderHook(() => useAutoBackup());

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60_000);
    });

    expect(mockExportProject).toHaveBeenCalledWith("project-sweep");
  });

  it("sends a beacon on page unload when a project is active", () => {
    const sendBeacon = vi.fn();
    vi.stubGlobal("navigator", {
      sendBeacon,
    });

    renderHook(() => useAutoBackup());

    window.dispatchEvent(new Event("beforeunload"));

    expect(sendBeacon).toHaveBeenCalledWith(
      "http://example.test/api/backup/project-1",
      expect.any(Blob)
    );
  });
});
