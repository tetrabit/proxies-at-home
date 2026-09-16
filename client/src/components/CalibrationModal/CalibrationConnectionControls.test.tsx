import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useMpcCalibrationSyncStore } from "@/store/mpcCalibrationSync";

const { mockPair, mockMerge, mockReset, ReconciliationErrorMock } = vi.hoisted(() => ({
  mockPair: vi.fn(),
  mockMerge: vi.fn(),
  mockReset: vi.fn(),
  ReconciliationErrorMock: class extends Error {
    readonly code: string;
    constructor(code: string, message: string) {
      super(message);
      this.name = "MpcCalibrationReconciliationError";
      this.code = code;
    }
  },
}));

vi.mock("@/helpers/mpcCalibrationWebPairing", () => ({
  pairMpcCalibrationWeb: mockPair,
}));

vi.mock("@/helpers/mpcCalibrationReconcileAction", () => ({
  MpcCalibrationReconciliationError: ReconciliationErrorMock,
  reconcileMpcCalibrationMerge: mockMerge,
  resetMpcCalibrationToRemote: mockReset,
}));

import { CalibrationConnectionControls } from "./CalibrationConnectionControls";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

describe("CalibrationConnectionControls", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    useMpcCalibrationSyncStore.getState().clearSelection();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("pairs through the transient input and activates the app lifecycle only after success", async () => {
    mockPair.mockImplementation(async (input) => {
      expect(input.transientCredential.take()).toBe("one-time-web-credential");
      input.transientCredential.clear();
      return { kind: "paired", target: "linked-web", identity: { ownerId: "owner", harnessId: "harness", connectionId: "connection" } };
    });
    render(<CalibrationConnectionControls />);
    const credential = screen.getByTestId("mpc-calibration-web-credential") as HTMLInputElement;
    fireEvent.change(credential, { target: { value: "one-time-web-credential" } });

    fireEvent.click(screen.getByRole("button", { name: "Pair web service" }));

    await waitFor(() => expect(useMpcCalibrationSyncStore.getState().selection).toEqual({ kind: "linked", target: "linked-web" }));
    expect(credential.value).toBe("");
    expect(screen.getByTestId("mpc-calibration-connection-message").textContent).toContain("paired");
  });

  it("does not select local fallback after a rejected web pair", async () => {
    mockPair.mockImplementation(async (input) => {
      input.transientCredential.take();
      input.transientCredential.clear();
      return { kind: "rejected", target: "linked-web", status: "offline" };
    });
    render(<CalibrationConnectionControls />);
    fireEvent.change(screen.getByTestId("mpc-calibration-web-credential"), { target: { value: "credential" } });

    fireEvent.click(screen.getByRole("button", { name: "Pair web service" }));

    await waitFor(() => expect(screen.getByTestId("mpc-calibration-connection-message").textContent).toContain("offline"));
    expect(useMpcCalibrationSyncStore.getState().selection).toEqual({ kind: "unselected" });
  });

  it("cancels only the pending UI pair and clears its input", async () => {
    const held = deferred<{ kind: "paired"; target: "linked-web"; identity: { ownerId: string; harnessId: string; connectionId: string } }>();
    mockPair.mockImplementation((input) => {
      input.transientCredential.take();
      input.transientCredential.clear();
      return held.promise;
    });
    render(<CalibrationConnectionControls />);
    const credential = screen.getByTestId("mpc-calibration-web-credential") as HTMLInputElement;
    fireEvent.change(credential, { target: { value: "credential" } });
    fireEvent.click(screen.getByRole("button", { name: "Pair web service" }));

    expect(credential.value).toBe("");
    fireEvent.change(credential, { target: { value: "cancel-me" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel web pairing" }));
    expect(credential.value).toBe("cancel-me");
    expect(useMpcCalibrationSyncStore.getState().selection).toEqual({ kind: "unselected" });

    held.resolve({ kind: "paired", target: "linked-web", identity: { ownerId: "owner", harnessId: "harness", connectionId: "connection" } });
    await Promise.resolve();
    expect(useMpcCalibrationSyncStore.getState().selection).toEqual({ kind: "unselected" });
  });

  it("fences a late web-pair success after the user selects a different connection", async () => {
    const held = deferred<{ kind: "paired"; target: "linked-web"; identity: { ownerId: string; harnessId: string; connectionId: string } }>();
    mockPair.mockImplementation((input) => {
      input.transientCredential.take();
      input.transientCredential.clear();
      return held.promise;
    });
    render(<CalibrationConnectionControls />);
    fireEvent.change(screen.getByTestId("mpc-calibration-web-credential"), { target: { value: "credential" } });
    fireEvent.click(screen.getByRole("button", { name: "Pair web service" }));
    await act(async () => {
      useMpcCalibrationSyncStore.getState().selectLinked("linked-electron");
    });

    expect(mockPair.mock.calls[0][0].operation.isCurrent()).toBe(false);
    expect(mockPair.mock.calls[0][0].operation.signal.aborted).toBe(true);

    await act(async () => {
      held.resolve({ kind: "paired", target: "linked-web", identity: { ownerId: "owner", harnessId: "harness", connectionId: "connection" } });
      await held.promise;
    });

    expect(useMpcCalibrationSyncStore.getState().selection).toEqual({ kind: "linked", target: "linked-electron" });
    expect(screen.getByTestId("mpc-calibration-connection-message").textContent).not.toContain("paired");
  });

  it("renders only web pairing controls outside Electron", () => {
    render(<CalibrationConnectionControls />);

    expect(screen.getByTestId("mpc-calibration-web-credential")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Pair web service" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Connect configured service" })).toBeNull();
  });

  it("renders only configured Electron connection controls when its bridge is available", async () => {
    vi.stubGlobal("electronAPI", { calibrationHarnessExecute: vi.fn() });
    render(<CalibrationConnectionControls />);

    expect(screen.queryByTestId("mpc-calibration-web-credential")).toBeNull();
    expect(screen.queryByRole("button", { name: "Pair web service" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Connect configured service" }));

    expect(mockPair).not.toHaveBeenCalled();
    expect(useMpcCalibrationSyncStore.getState().selection).toEqual({ kind: "linked", target: "linked-electron" });
  });

  it("replaces configured Electron connection progress with the terminal conflict status", async () => {
    vi.stubGlobal("electronAPI", { calibrationHarnessExecute: vi.fn() });
    render(<CalibrationConnectionControls />);

    fireEvent.click(screen.getByRole("button", { name: "Connect configured service" }));
    expect(screen.getByTestId("mpc-calibration-connection-message").textContent).toContain("Connecting configured Electron service");

    await act(async () => {
      useMpcCalibrationSyncStore.getState().publishStatus("conflict");
    });

    const message = screen.getByTestId("mpc-calibration-connection-message").textContent;
    expect(message).toContain("Connection status: conflict.");
    expect(message).not.toContain("Connecting configured Electron service");
  });

  it("replaces configured Electron connection progress with a successful sync status", async () => {
    vi.stubGlobal("electronAPI", { calibrationHarnessExecute: vi.fn() });
    render(<CalibrationConnectionControls />);

    fireEvent.click(screen.getByRole("button", { name: "Connect configured service" }));
    await act(async () => {
      useMpcCalibrationSyncStore.getState().publishStatus("clean");
    });

    const message = screen.getByTestId("mpc-calibration-connection-message").textContent;
    expect(message).toContain("Connection status: clean.");
    expect(message).not.toContain("Connecting configured Electron service");
  });

  it("explains a conflict status with its reason text", async () => {
    vi.stubGlobal("electronAPI", { calibrationHarnessExecute: vi.fn() });
    render(<CalibrationConnectionControls />);

    await act(async () => {
      useMpcCalibrationSyncStore
        .getState()
        .publishStatus("conflict", "unbased-local-sync-state-is-not-clean");
    });

    const message = screen.getByTestId("mpc-calibration-connection-message").textContent;
    expect(message).toContain("Connection status: conflict.");
    expect(message).toContain(
      "The local sync record has unsent changes without a recorded base.",
    );
  });

  it("explains a blocked status with its reason text", async () => {
    vi.stubGlobal("electronAPI", { calibrationHarnessExecute: vi.fn() });
    render(<CalibrationConnectionControls />);

    await act(async () => {
      useMpcCalibrationSyncStore
        .getState()
        .publishStatus("blocked", "foreign-physical-binding");
    });

    const message = screen.getByTestId("mpc-calibration-connection-message").textContent;
    expect(message).toContain("Connection status: blocked.");
    expect(message).toContain(
      "The local calibration cache is bound to a different owner or service than the current connection.",
    );
  });

  it("explains a failed status with its reason text", async () => {
    vi.stubGlobal("electronAPI", { calibrationHarnessExecute: vi.fn() });
    render(<CalibrationConnectionControls />);

    await act(async () => {
      useMpcCalibrationSyncStore
        .getState()
        .publishStatus("failed", "service-unavailable");
    });

    const message = screen.getByTestId("mpc-calibration-connection-message").textContent;
    expect(message).toContain("Connection status: failed.");
    expect(message).toContain("The calibration service is not reachable.");
  });

  it("does not attach a reason explanation to non-terminal statuses", async () => {
    vi.stubGlobal("electronAPI", { calibrationHarnessExecute: vi.fn() });
    render(<CalibrationConnectionControls />);

    await act(async () => {
      useMpcCalibrationSyncStore
        .getState()
        .publishStatus("queued", "remote-diverged");
    });

    const message = screen.getByTestId("mpc-calibration-connection-message").textContent;
    expect(message).toBe("Connection status: queued.");
  });

  it("does not retain Electron connection progress after the selected connection is replaced", async () => {
    vi.stubGlobal("electronAPI", { calibrationHarnessExecute: vi.fn() });
    render(<CalibrationConnectionControls />);

    fireEvent.click(screen.getByRole("button", { name: "Connect configured service" }));
    await act(async () => {
      useMpcCalibrationSyncStore.getState().selectLinked("linked-web");
    });

    expect(screen.getByTestId("mpc-calibration-connection-message").textContent).not.toContain("Connecting configured Electron service");
  });

  it("shows a same-selection disable rejection instead of stale connection progress", async () => {
    vi.stubGlobal("electronAPI", { calibrationHarnessExecute: vi.fn() });
    render(<CalibrationConnectionControls />);
    fireEvent.click(screen.getByRole("button", { name: "Connect configured service" }));
    useMpcCalibrationSyncStore.getState().registerConnectionControl({
      target: "linked-electron",
      disable: async () => ({ kind: "rejected", target: "linked-electron", status: "unavailable" }),
    });

    fireEvent.click(screen.getByRole("button", { name: "Disable calibration sync" }));

    await waitFor(() => {
      const message = screen.getByTestId("mpc-calibration-connection-message").textContent;
      expect(message).toContain("Web pairing is unavailable.");
      expect(message).not.toContain("Connecting configured Electron service");
    });
  });

  it("shows new web pairing progress instead of same-selection paired progress", async () => {
    const held = deferred<{ kind: "cancelled"; target: "linked-web" }>();
    mockPair
      .mockResolvedValueOnce({
        kind: "paired",
        target: "linked-web",
        identity: { ownerId: "owner", harnessId: "harness", connectionId: "connection" },
      })
      .mockImplementationOnce(() => held.promise);
    render(<CalibrationConnectionControls />);
    const credential = screen.getByTestId("mpc-calibration-web-credential");
    fireEvent.change(credential, { target: { value: "credential" } });
    fireEvent.click(screen.getByRole("button", { name: "Pair web service" }));

    await waitFor(() => expect(useMpcCalibrationSyncStore.getState().selection).toEqual({ kind: "linked", target: "linked-web" }));
    fireEvent.change(credential, { target: { value: "replacement-credential" } });
    fireEvent.click(screen.getByRole("button", { name: "Pair web service" }));

    const message = screen.getByTestId("mpc-calibration-connection-message").textContent;
    expect(message).toContain("Pairing web service");
    expect(message).not.toContain("Web service paired. Connecting sync");

    await act(async () => {
      held.resolve({ kind: "cancelled", target: "linked-web" });
      await held.promise;
    });
  });

  it("does not resurface web pairing text after paired progress is invalidated", async () => {
    mockPair.mockResolvedValue({
      kind: "paired",
      target: "linked-web",
      identity: { ownerId: "owner", harnessId: "harness", connectionId: "connection" },
    });
    render(<CalibrationConnectionControls />);
    fireEvent.change(screen.getByTestId("mpc-calibration-web-credential"), { target: { value: "credential" } });
    fireEvent.click(screen.getByRole("button", { name: "Pair web service" }));

    await waitFor(() => expect(useMpcCalibrationSyncStore.getState().selection).toEqual({ kind: "linked", target: "linked-web" }));
    await act(async () => {
      useMpcCalibrationSyncStore.getState().selectLinked("linked-electron");
    });

    const message = screen.getByTestId("mpc-calibration-connection-message").textContent;
    expect(message).not.toContain("Pairing web service");
    expect(message).not.toContain("Web service paired. Connecting sync");
  });

  it("does not fall back to web pairing for an incomplete Electron bridge", () => {
    vi.stubGlobal("electronAPI", {});
    render(<CalibrationConnectionControls />);

    expect(screen.queryByTestId("mpc-calibration-web-credential")).toBeNull();
    expect(screen.queryByRole("button", { name: "Pair web service" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Connect configured service" }));

    expect(mockPair).not.toHaveBeenCalled();
    expect(useMpcCalibrationSyncStore.getState().selection).toEqual({ kind: "unselected" });
    expect(screen.getByTestId("mpc-calibration-connection-message").textContent).toContain("unavailable");
  });

  it("clears an unsubmitted credential when controls unmount", () => {
    const view = render(<CalibrationConnectionControls />);
    const credential = screen.getByTestId("mpc-calibration-web-credential") as HTMLInputElement;
    fireEvent.change(credential, { target: { value: "unsubmitted-credential" } });

    view.unmount();

    expect(credential.value).toBe("");
  });

  it("fences a rejected disable after the selected connection changes", async () => {
    const held = deferred<{ kind: "rejected"; target: "linked-web"; status: "offline" }>();
    useMpcCalibrationSyncStore.getState().selectLinked("linked-web");
    useMpcCalibrationSyncStore.getState().registerConnectionControl({
      target: "linked-web",
      disable: () => held.promise,
    });
    render(<CalibrationConnectionControls />);
    fireEvent.click(screen.getByRole("button", { name: "Disable calibration sync" }));

    await act(async () => {
      useMpcCalibrationSyncStore.getState().selectLinked("linked-electron");
    });
    await act(async () => {
      held.resolve({ kind: "rejected", target: "linked-web", status: "offline" });
      await held.promise;
    });

    expect(screen.getByTestId("mpc-calibration-connection-message").textContent).not.toContain("offline");
  });

  it("fences a late disable result when the renderer mode is replaced", async () => {
    const held = deferred<{ kind: "rejected"; target: "linked-web"; status: "offline" }>();
    useMpcCalibrationSyncStore.getState().selectLinked("linked-web");
    useMpcCalibrationSyncStore.getState().registerConnectionControl({
      target: "linked-web",
      disable: () => held.promise,
    });
    const view = render(<CalibrationConnectionControls />);
    fireEvent.click(screen.getByRole("button", { name: "Disable calibration sync" }));

    vi.stubGlobal("electronAPI", {});
    view.rerender(<CalibrationConnectionControls />);
    await act(async () => {
      held.resolve({ kind: "rejected", target: "linked-web", status: "offline" });
      await held.promise;
    });

    expect(screen.queryByTestId("mpc-calibration-web-credential")).toBeNull();
    expect(screen.getByTestId("mpc-calibration-connection-message").textContent).not.toContain("offline");
  });

  it("drops a late disable result after unmount", async () => {
    const held = deferred<{ kind: "rejected"; target: "linked-web"; status: "offline" }>();
    useMpcCalibrationSyncStore.getState().selectLinked("linked-web");
    useMpcCalibrationSyncStore.getState().registerConnectionControl({
      target: "linked-web",
      disable: () => held.promise,
    });
    const view = render(<CalibrationConnectionControls />);
    fireEvent.click(screen.getByRole("button", { name: "Disable calibration sync" }));

    view.unmount();
    await act(async () => {
      held.resolve({ kind: "rejected", target: "linked-web", status: "offline" });
      await held.promise;
    });

    expect(screen.queryByTestId("mpc-calibration-connection-message")).toBeNull();
  });

  it("shows a bounded disable failure only while its UI epoch is current", async () => {
    useMpcCalibrationSyncStore.getState().selectLinked("linked-web");
    useMpcCalibrationSyncStore.getState().registerConnectionControl({
      target: "linked-web",
      disable: async () => { throw new Error("private disable detail"); },
    });
    render(<CalibrationConnectionControls />);
    fireEvent.click(screen.getByRole("button", { name: "Disable calibration sync" }));

    await waitFor(() => expect(screen.getByTestId("mpc-calibration-connection-message").textContent).toContain("Unable to disable"));
  });
});

describe("CalibrationConnectionControls conflict recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    vi.stubGlobal("electronAPI", { calibrationHarnessExecute: vi.fn() });
    useMpcCalibrationSyncStore.getState().clearSelection();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const selectLinkedElectronAndPublish = (status: "conflict" | "blocked" | "clean") => {
    act(() => {
      useMpcCalibrationSyncStore.getState().selectLinked("linked-electron");
    });
    act(() => {
      useMpcCalibrationSyncStore.getState().publishStatus(status);
    });
  };

  it("offers merge and reset only in the conflict state", () => {
    selectLinkedElectronAndPublish("conflict");
    render(<CalibrationConnectionControls />);

    expect(screen.getByRole("button", { name: "Merge local and remote" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reset to remote" })).toBeTruthy();
  });

  it("offers only reset in the blocked state", () => {
    selectLinkedElectronAndPublish("blocked");
    render(<CalibrationConnectionControls />);

    expect(screen.queryByRole("button", { name: "Merge local and remote" })).toBeNull();
    expect(screen.getByRole("button", { name: "Reset to remote" })).toBeTruthy();
  });

  it("offers neither action in the clean state", () => {
    selectLinkedElectronAndPublish("clean");
    render(<CalibrationConnectionControls />);

    expect(screen.queryByRole("button", { name: "Merge local and remote" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reset to remote" })).toBeNull();
  });

  it("merge re-selects the linked target with a delta summary after success", async () => {
    mockMerge.mockResolvedValue({
      baseRevision: 1,
      delta: { datasets: 0, cases: 1, runs: 2, assets: 4, localWins: 0 },
    });
    selectLinkedElectronAndPublish("conflict");
    render(<CalibrationConnectionControls />);
    const revisionBefore = useMpcCalibrationSyncStore.getState().selectionRevision;

    fireEvent.click(screen.getByRole("button", { name: "Merge local and remote" }));

    expect(mockMerge).toHaveBeenCalledTimes(1);
    expect(mockMerge.mock.calls[0][0].transport).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId("mpc-calibration-connection-message").textContent).toContain("1 remote case, 4 assets added"));
    expect(useMpcCalibrationSyncStore.getState().selectionRevision).toBeGreaterThan(revisionBefore);
  });

  it("merge surfaces the typed reconciliation error without re-selecting", async () => {
    mockMerge.mockRejectedValue(new ReconciliationErrorMock("identity-mismatch", "The service identity does not match this local cache; use Reset to remote."));
    selectLinkedElectronAndPublish("conflict");
    render(<CalibrationConnectionControls />);
    const revisionBefore = useMpcCalibrationSyncStore.getState().selectionRevision;

    fireEvent.click(screen.getByRole("button", { name: "Merge local and remote" }));

    await waitFor(() => expect(screen.getByTestId("mpc-calibration-connection-message").textContent).toContain("does not match this local cache"));
    expect(useMpcCalibrationSyncStore.getState().selectionRevision).toBe(revisionBefore);
  });

  it("merge surfaces any unmasked underlying Error message without re-selecting", async () => {
    mockMerge.mockRejectedValue(new Error("Underlying sync failure"));
    selectLinkedElectronAndPublish("conflict");
    render(<CalibrationConnectionControls />);
    const revisionBefore = useMpcCalibrationSyncStore.getState().selectionRevision;

    fireEvent.click(screen.getByRole("button", { name: "Merge local and remote" }));

    await waitFor(() => expect(screen.getByTestId("mpc-calibration-connection-message").textContent).toContain("Underlying sync failure"));
    expect(useMpcCalibrationSyncStore.getState().selectionRevision).toBe(revisionBefore);
  });

  it("reset clears through the action and re-selects the linked target", async () => {
    mockReset.mockResolvedValue({ clearedTables: 8 });
    selectLinkedElectronAndPublish("blocked");
    render(<CalibrationConnectionControls />);
    const revisionBefore = useMpcCalibrationSyncStore.getState().selectionRevision;

    fireEvent.click(screen.getByRole("button", { name: "Reset to remote" }));

    expect(mockReset).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByTestId("mpc-calibration-connection-message").textContent).toContain("cleared"));
    expect(useMpcCalibrationSyncStore.getState().selectionRevision).toBeGreaterThan(revisionBefore);
  });
});
