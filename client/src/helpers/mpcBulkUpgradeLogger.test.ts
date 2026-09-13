import { afterEach, describe, expect, it, vi } from "vitest";

import { parseMpcBulkLogMessage } from "../../../shared/mpcBulkUpgradeLogging";
import { createMpcBulkUpgradeLogger } from "./mpcBulkUpgradeLogger";

describe("createMpcBulkUpgradeLogger", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("correlates ordered lifecycle events and stops heartbeats after one terminal outcome", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const logger = createMpcBulkUpgradeLogger({
      runId: "run-lifecycle",
      heartbeatIntervalMs: 10_000,
    });

    logger.started({ inputCards: 4, eligibleCards: 3, totalImages: 2 });
    logger.phaseStarted("prefetch", { queryCount: 2 });
    vi.advanceTimersByTime(100);
    logger.phaseCompleted("prefetch", { candidateCount: 5 });
    logger.phaseStarted("matching", { cardName: "Sol Ring", groupIndex: 1 });
    logger.progress({ processedImages: 1, upgraded: 1, skipped: 0, errors: 0 });
    vi.advanceTimersByTime(10_000);
    logger.completed({ totalCards: 3, processedImages: 2, upgraded: 2, skipped: 1, errors: 0 });
    logger.failed({ reason: "unexpected" });
    vi.advanceTimersByTime(20_000);

    const events = info.mock.calls.map(([message]) => parseMpcBulkLogMessage(message));
    expect(events).toEqual([
      expect.objectContaining({ event: "started", runId: "run-lifecycle", inputCards: 4, eligibleCards: 3, totalImages: 2 }),
      expect.objectContaining({ event: "phase-started", phase: "prefetch", queryCount: 2 }),
      expect.objectContaining({ event: "phase-completed", phase: "prefetch", phaseElapsedMs: 100, candidateCount: 5 }),
      expect.objectContaining({ event: "phase-started", phase: "matching", cardName: "Sol Ring", groupIndex: 1 }),
      expect.objectContaining({ event: "heartbeat", phase: "matching", cardName: "Sol Ring", processedImages: 1, upgraded: 1 }),
      expect.objectContaining({ event: "completed", totalCards: 3, processedImages: 2, upgraded: 2, skipped: 1, errors: 0 }),
    ]);
    expect(info.mock.calls.every((call) => call.length === 1 && typeof call[0] === "string")).toBe(true);
  });

  it("records immediate cancellation requests and safe failures without allowing a sink failure to escape", () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const info = vi.spyOn(console, "info")
      .mockImplementationOnce(() => { throw new Error("sink unavailable"); })
      .mockImplementation(() => undefined);
    const logger = createMpcBulkUpgradeLogger({
      runId: "run-cancel",
      signal: controller.signal,
      heartbeatIntervalMs: 10_000,
    });

    logger.started({ inputCards: 1, eligibleCards: 1, totalImages: 1 });
    controller.abort();
    logger.cancelled({ processedImages: 0, totalCards: 1, reason: "aborted" });
    logger.failed({ reason: "should-not-emit" });

    const events = info.mock.calls
      .map(([message]) => parseMpcBulkLogMessage(message))
      .filter((event) => event !== null);
    expect(events).toEqual([
      expect.objectContaining({ event: "started", runId: "run-cancel", inputCards: 1 }),
      expect.objectContaining({ event: "cancel-requested", runId: "run-cancel" }),
      expect.objectContaining({ event: "cancelled", runId: "run-cancel", processedImages: 0, totalCards: 1, reason: "aborted" }),
    ]);
  });
});
