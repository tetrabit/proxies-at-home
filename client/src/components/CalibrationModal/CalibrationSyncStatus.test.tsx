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
});
