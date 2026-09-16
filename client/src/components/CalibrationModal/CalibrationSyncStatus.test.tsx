import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  CalibrationSyncStatus,
  type CalibrationSyncStatusValue,
} from "./CalibrationSyncStatus";

const labels: Readonly<Record<CalibrationSyncStatusValue, string>> = {
  unpaired: "Sync is not paired.",
  authenticating: "Authenticating sync connection.",
  "paired-not-hydrated": "Sync paired; data is not yet loaded.",
  clean: "Sync is up to date.",
  queued: "Sync is queued.",
  "in-flight": "Sync is in progress.",
  conflict: "Sync needs attention because of a conflict.",
  offline: "Sync is offline.",
  blocked: "Sync is blocked.",
  failed: "Sync failed.",
};

describe("CalibrationSyncStatus", () => {
  it("renders each closed status as a distinct fixed live-status label", () => {
    const statuses = Object.keys(labels) as CalibrationSyncStatusValue[];
    const { rerender } = render(<CalibrationSyncStatus status={statuses[0]} />);

    const liveStatus = screen.getByRole("status");
    expect(liveStatus.getAttribute("aria-live")).toBe("polite");
    expect(liveStatus.getAttribute("aria-atomic")).toBe("true");

    for (const status of statuses) {
      rerender(<CalibrationSyncStatus status={status} />);
      expect(liveStatus.textContent).toBe(labels[status]);
    }
  });

  it("uses a fixed unavailable fallback for an unknown runtime status", () => {
    const maliciousStatus = "<img src=x onerror=alert('unexpected')>";
    render(
      <CalibrationSyncStatus
        status={maliciousStatus as CalibrationSyncStatusValue}
      />
    );

    const liveStatus = screen.getByRole("status");
    expect(liveStatus.textContent).toBe("Sync status is unavailable.");
    expect(liveStatus.textContent).not.toContain(maliciousStatus);
    expect(liveStatus.querySelector("img")).toBeNull();
  });

  it("renders the reason text below each terminal status", () => {
    const terminalReasons: Readonly<
      Array<[CalibrationSyncStatusValue, string, string]>
    > = [
      [
        "conflict",
        "unbased-local-sync-state-is-not-clean",
        "The local sync record has unsent changes without a recorded base.",
      ],
      [
        "conflict",
        "remote-diverged",
        "The remote snapshot diverged from the local sync base.",
      ],
      [
        "blocked",
        "foreign-physical-binding",
        "The local calibration cache is bound to a different owner or service than the current connection.",
      ],
      [
        "blocked",
        "identity-changed",
        "The service identity changed since this cache was last connected.",
      ],
      [
        "blocked",
        "stale-local-base",
        "The local sync base no longer matches the stored cache binding.",
      ],
      [
        "failed",
        "transport-unavailable",
        "The calibration transport could not be established.",
      ],
      [
        "failed",
        "retries-exhausted",
        "Repeated connection attempts timed out.",
      ],
      [
        "offline",
        "service-unavailable",
        "The calibration service is not reachable.",
      ],
    ];

    const { rerender } = render(
      <CalibrationSyncStatus status="clean" />
    );
    for (const [status, reason, text] of terminalReasons) {
      rerender(<CalibrationSyncStatus status={status} reason={reason} />);
      const liveStatus = screen.getByRole("status");
      expect(liveStatus.textContent).toContain(labels[status]);
      expect(liveStatus.textContent).toContain(text);
    }
  });

  it("falls back to the raw reason code for an unknown code and never renders markup", () => {
    render(
      <CalibrationSyncStatus
        status="blocked"
        reason="<img src=x onerror=alert('unexpected')>"
      />
    );

    const liveStatus = screen.getByRole("status");
    expect(liveStatus.textContent).toContain("<img src=x onerror=alert('unexpected')>");
    expect(liveStatus.querySelector("img")).toBeNull();
  });

  it("renders the generic text for the unspecified reason", () => {
    render(<CalibrationSyncStatus status="conflict" reason="unspecified" />);
    expect(screen.getByRole("status").textContent).toContain(
      "No further details are available.",
    );
  });

  it("does not render a reason for non-terminal statuses", () => {
    render(
      <CalibrationSyncStatus status="in-flight" reason="remote-diverged" />
    );
    const liveStatus = screen.getByRole("status");
    expect(liveStatus.textContent).toBe("Sync is in progress.");
    expect(liveStatus.textContent).not.toContain("diverged");
  });
});
