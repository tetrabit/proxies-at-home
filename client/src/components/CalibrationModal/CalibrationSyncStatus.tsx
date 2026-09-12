export type CalibrationSyncStatusValue =
  | "unpaired"
  | "authenticating"
  | "paired-not-hydrated"
  | "clean"
  | "queued"
  | "in-flight"
  | "conflict"
  | "offline"
  | "blocked"
  | "failed";

export type CalibrationSyncStatusProps = {
  status: CalibrationSyncStatusValue;
};

function statusLabel(status: CalibrationSyncStatusValue): string {
  switch (status) {
    case "unpaired":
      return "Sync is not paired.";
    case "authenticating":
      return "Authenticating sync connection.";
    case "paired-not-hydrated":
      return "Sync paired; data is not yet loaded.";
    case "clean":
      return "Sync is up to date.";
    case "queued":
      return "Sync is queued.";
    case "in-flight":
      return "Sync is in progress.";
    case "conflict":
      return "Sync needs attention because of a conflict.";
    case "offline":
      return "Sync is offline.";
    case "blocked":
      return "Sync is blocked.";
    case "failed":
      return "Sync failed.";
    default:
      return "Sync status is unavailable.";
  }
}

export function CalibrationSyncStatus({
  status,
}: CalibrationSyncStatusProps) {
  return (
    <p
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className="text-xs text-gray-600 dark:text-gray-300"
    >
      {statusLabel(status)}
    </p>
  );
}
