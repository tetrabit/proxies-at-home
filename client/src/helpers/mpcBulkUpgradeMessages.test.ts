import { describe, expect, it } from "vitest";

import type {
  BulkMpcUpgradeSummary,
  BulkUpgradeProgress,
} from "./mpcBulkUpgrade";
import {
  formatBulkUpgradeCancelledMessage,
  formatBulkUpgradeProgressMessage,
  formatBulkUpgradeResultMessage,
} from "./mpcBulkUpgradeMessages";

function makeSummary(
  overrides: Partial<BulkMpcUpgradeSummary> = {}
): BulkMpcUpgradeSummary {
  return {
    totalCards: 3,
    upgraded: 1,
    autoMatched: 1,
    ambiguous: 1,
    noMatch: 1,
    skipped: 2,
    errors: 0,
    ...overrides,
  };
}

describe("mpcBulkUpgradeMessages", () => {
  it("formats progress messages with explicit outcome counts", () => {
    const progress: BulkUpgradeProgress = {
      processedImages: 2,
      totalImages: 5,
      fraction: 0.4,
      currentCardName: "Sol Ring",
      summary: makeSummary(),
    };

    expect(formatBulkUpgradeProgressMessage(progress)).toBe(
      "MPC Upgrade (2/5, 40%) — Sol Ring · 1✓ 1? 1∅"
    );
  });

  it("formats cancelled messages with explicit outcome counts", () => {
    expect(formatBulkUpgradeCancelledMessage(makeSummary())).toBe(
      "MPC upgrade cancelled. 1 auto-matched, 1 ambiguous, 1 no match before stopping."
    );
  });

  it("formats final result messages with explicit outcome counts", () => {
    expect(formatBulkUpgradeResultMessage(makeSummary())).toBe(
      "Bulk MPC upgrade: 1 auto-matched, 1 ambiguous, 1 no match."
    );
  });

  it("includes other skipped and errors when present", () => {
    expect(
      formatBulkUpgradeResultMessage(makeSummary({ skipped: 4, errors: 2 }))
    ).toBe(
      "Bulk MPC upgrade: 1 auto-matched, 1 ambiguous, 1 no match, 2 other skipped, 2 errors."
    );
  });
});
