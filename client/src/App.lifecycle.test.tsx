import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const loadApp = async ({
  currentProjectId,
  projects,
  restoredProjects,
  userPrefs,
  autoRestoreResult,
}: {
  currentProjectId?: string;
  projects: Array<{ id: string }>;
  restoredProjects?: Array<{ id: string }>;
  userPrefs?: { lastProjectId?: string } | undefined;
  autoRestoreResult?: { restoredCount: number; projectNames: string[] } | null;
}) => {
  vi.resetModules();
  let loadCount = 0;
  const state = {
    currentProjectId,
    projects,
    loadProjects: vi.fn(async () => {
      loadCount += 1;
      if (loadCount > 1 && restoredProjects) state.projects = restoredProjects;
    }),
    createProject: vi.fn().mockResolvedValue("created-project"),
    switchProject: vi.fn().mockResolvedValue(undefined),
  };
  const preferencesState = { load: vi.fn().mockResolvedValue(undefined) };
  const dbGet = vi.fn().mockResolvedValue(userPrefs);
  const dbAdd = vi.fn().mockResolvedValue("pref-id");
  const showInfoToast = vi.fn();
  const prewarm = vi.fn();
  const useShareUrl = vi.fn();
  const autoRestore = vi.fn().mockResolvedValue(autoRestoreResult ?? null);

  vi.doMock("@/pages/ProxyBuilderPage", () => ({
    default: () => <div data-testid="proxy-builder-page" />,
  }));
  vi.doMock("@/components/common", () => ({
    Loader: () => <div data-testid="loader" />,
    UpdateNotification: () => <div data-testid="update-notification" />,
    AboutModal: ({ isOpen }: { isOpen: boolean }) => (
      <div data-testid="about-modal" data-open={String(isOpen)} />
    ),
  }));
  vi.doMock("@/helpers/imageProcessor", () => ({
    ImageProcessor: { getInstance: () => ({ prewarm }) },
  }));
  vi.doMock("@/hooks/useShareUrl", () => ({ useShareUrl }));
  vi.doMock("@/db", () => ({
    db: { userPreferences: { get: dbGet, add: dbAdd } },
  }));
  vi.doMock("@/store", () => ({
    useProjectStore: { getState: () => state },
    useUserPreferencesStore: { getState: () => preferencesState },
  }));
  vi.doMock("@/store/toast", () => ({
    useToastStore: { getState: () => ({ showInfoToast }) },
  }));
  vi.doMock("@/helpers/autoRestore", () => ({ autoRestore }));

  const { default: App } = await import("./App");
  return {
    App,
    state,
    preferencesState,
    dbGet,
    dbAdd,
    showInfoToast,
    prewarm,
    useShareUrl,
    autoRestore,
  };
};

describe("App project initialization lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("electronAPI", undefined);
  });

  it("skips project initialization when a project is already active", async () => {
    const { App, state, useShareUrl, prewarm } = await loadApp({
      currentProjectId: "active-project",
      projects: [],
    });

    render(<App />);

    await waitFor(() => expect(useShareUrl).toHaveBeenCalled());
    await waitFor(() => expect(prewarm).toHaveBeenCalled());
    expect(state.loadProjects).not.toHaveBeenCalled();
  });

  it("auto-restores empty project storage and switches to the restored project", async () => {
    const { App, state, autoRestore, showInfoToast } = await loadApp({
      projects: [],
      restoredProjects: [{ id: "restored-project" }],
      autoRestoreResult: { restoredCount: 2, projectNames: ["One", "Two"] },
    });

    render(<App />);

    await waitFor(() => expect(autoRestore).toHaveBeenCalled());
    await waitFor(() =>
      expect(state.switchProject).toHaveBeenCalledWith("restored-project")
    );
    expect(showInfoToast).toHaveBeenCalledWith(
      "Restored 2 projects from server: One, Two"
    );
    expect(state.createProject).not.toHaveBeenCalled();
  });

  it("creates preferences and a default project when no project can be loaded", async () => {
    const { App, state, dbGet, dbAdd } = await loadApp({
      projects: [],
      autoRestoreResult: null,
      userPrefs: undefined,
    });

    render(<App />);

    await waitFor(() =>
      expect(dbAdd).toHaveBeenCalledWith({
        id: "default",
        settings: {},
        favoriteCardbacks: [],
      })
    );
    await waitFor(() =>
      expect(state.createProject).toHaveBeenCalledWith("My Project")
    );
    expect(state.switchProject).toHaveBeenCalledWith("created-project");
    expect(dbGet).toHaveBeenCalledWith("default");
  });

  it("prefers last project when present and otherwise falls back to the first project", async () => {
    const last = await loadApp({
      projects: [{ id: "first-project" }, { id: "last-project" }],
      userPrefs: { lastProjectId: "last-project" },
    });
    const { unmount } = render(<last.App />);
    await waitFor(() =>
      expect(last.state.switchProject).toHaveBeenCalledWith("last-project")
    );
    unmount();

    const first = await loadApp({
      projects: [{ id: "first-project" }],
      userPrefs: { lastProjectId: "missing-project" },
    });
    render(<first.App />);
    await waitFor(() =>
      expect(first.state.switchProject).toHaveBeenCalledWith("first-project")
    );
  });
});
