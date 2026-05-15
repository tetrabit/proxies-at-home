import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Suspense } from "react";

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

// Mock ImageProcessor to avoid Worker errors in jsdom
vi.mock("@/helpers/imageProcessor", () => ({
  ImageProcessor: {
    getInstance: () => ({
      prewarm: vi.fn(),
    }),
  },
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
    let electronAboutHandler: (() => void) | undefined;
    vi.stubGlobal("electronAPI", {
      onShowAbout: vi.fn((handler: () => void) => {
        electronAboutHandler = handler;
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

    electronAboutHandler?.();
    await waitFor(() =>
      expect(screen.getByTestId("about-modal").dataset.open).toBe("true")
    );
    expect(window.electronAPI?.onShowAbout).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByText("Close about"));
    unmount();
    fireEvent(window, new Event("open-about-modal"));
    expect(screen.queryByTestId("about-modal")).toBeNull();
  });
});
