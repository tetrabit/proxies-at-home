import type {
  BulkMpcUpgradeSummary,
  BulkUpgradeProgress,
} from "./mpcBulkUpgrade";

function getOtherSkippedCount(summary: BulkMpcUpgradeSummary): number {
  return Math.max(0, summary.skipped - summary.ambiguous - summary.noMatch);
}

export function formatBulkUpgradeProgressMessage(
  progress: BulkUpgradeProgress
): string {
  const { processedImages, totalImages, fraction, currentCardName, summary } =
    progress;
  const pct = Math.round(fraction * 100);
  const cardLabel = currentCardName ? ` — ${currentCardName}` : "";
  const otherSkipped = getOtherSkippedCount(summary);

  return `MPC Upgrade (${processedImages}/${totalImages}, ${pct}%)${cardLabel} · ${summary.autoMatched}✓ ${summary.ambiguous}? ${summary.noMatch}∅${otherSkipped ? ` ${otherSkipped}→` : ""}${summary.errors ? ` ${summary.errors}✗` : ""}`;
}

export function formatBulkUpgradeCancelledMessage(
  summary: BulkMpcUpgradeSummary
): string {
  const otherSkipped = getOtherSkippedCount(summary);
  return `MPC upgrade cancelled. ${summary.autoMatched} auto-matched, ${summary.ambiguous} ambiguous, ${summary.noMatch} no match${otherSkipped ? `, ${otherSkipped} other skipped` : ""}${summary.errors ? `, ${summary.errors} errors` : ""} before stopping.`;
}

export function formatBulkUpgradeResultMessage(
  summary: BulkMpcUpgradeSummary
): string {
  const otherSkipped = getOtherSkippedCount(summary);
  return `Bulk MPC upgrade: ${summary.autoMatched} auto-matched, ${summary.ambiguous} ambiguous, ${summary.noMatch} no match${otherSkipped ? `, ${otherSkipped} other skipped` : ""}${summary.errors ? `, ${summary.errors} errors` : ""}.`;
}
