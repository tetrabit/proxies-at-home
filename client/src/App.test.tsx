import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Suspense } from "react";

type AboutListener = Parameters<
  NonNullable<Window["electronAPI"]>["onShowAbout"]
>[0];

const appFixture = vi.hoisted(() => {
  const imageProcessor = {
    prewarm: vi.fn<(count?: number) => void>(),
    cancelAll: vi.fn<() => void>(),
  };

  return {
    imageProcessor,
    projectState: {
      currentProjectId: "app-test-project",
      projects: [],
      loadProjects: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
      createProject: vi
        .fn<(name: string) => Promise<string>>()
        .mockResolvedValue("app-test-project"),
      switchProject: vi.fn<(projectId: string) => Promise<void>>().mockResolvedValue(undefined),
    },
    loadPreferences: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    getPreferences: vi.fn<() => Promise<undefined>>().mockResolvedValue(undefined),
    addPreferences: vi.fn<() => Promise<string>>().mockResolvedValue("default"),
    autoRestore: vi.fn<() => Promise<null>>().mockResolvedValue(null),
    showInfoToast: vi.fn<(message: string) => void>(),
    useShareUrl: vi.fn<() => void>(),
  };
});

// Mock the lazy-loaded module before importing App
vi.mock("@/pages/ProxyBuilderPage", () => ({
  default: () => <div data-testid="proxy-builder-page">ProxyBuilderPage</div>,
}));

vi.mock("@/components/common", () => ({
  Loader: () => <div data-testid="loader">Loader</div>,
  UpdateNotification: () => <div data-testid="update-notification">Update</div>,
  AboutModal: ({
    isOpen,
    onClose,
  }: {
    isOpen: boolean;
    onClose: () => void;
  }) => (
    <div data-testid="about-modal" data-open={String(isOpen)}>
      AboutModal
      <button type="button" onClick={onClose}>
        Close about
      </button>
    </div>
  ),
}));

// Keep this presentation fixture independent of project bootstrap, IndexedDB,
// server restoration, and worker startup. App.lifecycle.test.tsx covers those paths.
vi.mock("@/helpers/imageProcessor", () => ({
  ImageProcessor: {
    getInstance: () => appFixture.imageProcessor,
  },
}));

vi.mock("@/hooks/useShareUrl", () => ({
  useShareUrl: appFixture.useShareUrl,
}));

vi.mock("@/db", () => ({
  db: {
    userPreferences: {
      get: appFixture.getPreferences,
      add: appFixture.addPreferences,
    },
  },
}));

vi.mock("@/store", () => ({
  useProjectStore: {
    getState: () => appFixture.projectState,
  },
  useUserPreferencesStore: {
    getState: () => ({ load: appFixture.loadPreferences }),
  },
}));

vi.mock("@/store/toast", () => ({
  useToastStore: {
    getState: () => ({ showInfoToast: appFixture.showInfoToast }),
  },
}));

vi.mock("@/helpers/autoRestore", () => ({
  autoRestore: appFixture.autoRestore,
}));

import App from "./App";

// Helper to wrap App with Suspense for lazy loading
const renderApp = () => {
  return render(
    <Suspense fallback={<div>Loading...</div>}>
      <App />
    </Suspense>
  );
};

describe("App", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("electronAPI", undefined);
  });

  it("should render the main heading for accessibility", async () => {
    renderApp();
    await waitFor(() => {
      const heading = screen.getByRole("heading", { level: 1, hidden: true });
      expect(heading).toBeDefined();
      expect(heading.textContent).toContain("Proxxied");
    });
  });

  it("should render the Loader component", async () => {
    renderApp();
    await waitFor(() => {
      expect(screen.getByTestId("loader")).toBeDefined();
    });
  });

  it("should render the UpdateNotification component", async () => {
    renderApp();
    await waitFor(() => {
      expect(screen.getByTestId("update-notification")).toBeDefined();
    });
  });

  it("should render the ProxyBuilderPage component", async () => {
    renderApp();
    await waitFor(() => {
      expect(screen.getByTestId("proxy-builder-page")).toBeDefined();
    });
  });

  it("should have sr-only class on heading for screen readers", async () => {
    renderApp();
    await waitFor(() => {
      const heading = screen.getByRole("heading", { level: 1, hidden: true });
      expect(heading.className).toContain("sr-only");
    });
  });

  it("opens and closes AboutModal from the app event bridge", async () => {
    let electronAboutHandler: AboutListener | undefined;
    vi.stubGlobal("electronAPI", {
      onShowAbout: vi.fn((handler: AboutListener) => {
        electronAboutHandler = handler;
        return vi.fn();
      }),
    });

    const { unmount } = renderApp();

    const aboutModal = await screen.findByTestId("about-modal");
    expect(aboutModal.dataset.open).toBe("false");

    fireEvent(window, new Event("open-about-modal"));
    await waitFor(() =>
      expect(screen.getByTestId("about-modal").dataset.open).toBe("true")
    );

    fireEvent.click(screen.getByText("Close about"));
    await waitFor(() =>
      expect(screen.getByTestId("about-modal").dataset.open).toBe("false")
    );

    act(() => {
      electronAboutHandler?.();
    });
    await waitFor(() =>
      expect(screen.getByTestId("about-modal").dataset.open).toBe("true")
    );
    expect(window.electronAPI?.onShowAbout).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByText("Close about"));
    unmount();
    fireEvent(window, new Event("open-about-modal"));
    expect(screen.queryByTestId("about-modal")).toBeNull();
  });

  it("removes About bridge listeners on teardown without duplicating them across rerenders and remounts", async () => {
    const subscribedHandlers = new Set<AboutListener>();
    const disposeAboutListener = vi.fn();
    const onShowAbout = vi.fn((handler: AboutListener) => {
      subscribedHandlers.add(handler);
      return () => {
        subscribedHandlers.delete(handler);
        disposeAboutListener();
      };
    });
    vi.stubGlobal("electronAPI", { onShowAbout });
    const addEventListener = vi.spyOn(window, "addEventListener");
    const removeEventListener = vi.spyOn(window, "removeEventListener");

    const initial = renderApp();
    await screen.findByTestId("about-modal");
    initial.rerender(
      <Suspense fallback={<div>Loading...</div>}>
        <App />
      </Suspense>
    );

    const firstAboutHandler = addEventListener.mock.calls.find(
      ([eventName]) => String(eventName) === "open-about-modal"
    )?.[1];
    expect(onShowAbout).toHaveBeenCalledTimes(1);
    expect(addEventListener).toHaveBeenCalledTimes(1);
    expect(subscribedHandlers.size).toBe(1);

    fireEvent(window, new Event("open-about-modal"));
    await waitFor(() =>
      expect(screen.getByTestId("about-modal").dataset.open).toBe("true")
    );

    initial.unmount();
    expect(disposeAboutListener).toHaveBeenCalledTimes(1);
    expect(removeEventListener).toHaveBeenCalledWith(
      "open-about-modal",
      firstAboutHandler
    );
    expect(subscribedHandlers.size).toBe(0);

    const remounted = renderApp();
    await screen.findByTestId("about-modal");
    expect(onShowAbout).toHaveBeenCalledTimes(2);
    expect(addEventListener).toHaveBeenCalledTimes(2);
    expect(subscribedHandlers.size).toBe(1);

    remounted.unmount();
    expect(disposeAboutListener).toHaveBeenCalledTimes(2);
    expect(removeEventListener).toHaveBeenCalledTimes(2);
    expect(subscribedHandlers.size).toBe(0);
    addEventListener.mockRestore();
    removeEventListener.mockRestore();
  });
});
