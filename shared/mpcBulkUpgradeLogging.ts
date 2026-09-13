export const MPC_BULK_LOG_PREFIX = "[MPC Bulk Upgrade] ";
export const MPC_BULK_LOG_MAX_LENGTH = 4096;
export const MPC_BULK_LOG_EVENTS = [
  "started", "phase-started", "phase-completed", "group-started",
  "group-completed", "heartbeat", "cancel-requested", "completed", "cancelled", "failed",
] as const;

export type MpcBulkLogEvent = {
  event: typeof MPC_BULK_LOG_EVENTS[number];
  runId: string;
  elapsedMs: number;
  phase?: string;
  cardName?: string;
  projectId?: string;
  outcome?: string;
  reason?: string;
  selectedIdentifier?: string;
  sourceName?: string;
  cardType?: string;
  errorName?: string;
  phaseElapsedMs?: number;
  groupIndex?: number;
  totalImages?: number;
  processedImages?: number;
  inputCards?: number;
  eligibleCards?: number;
  totalCards?: number;
  upgraded?: number;
  skipped?: number;
  errors?: number;
  candidateCount?: number;
  exactMatchCount?: number;
  queryCount?: number;
  calibrationCases?: number;
  profileCount?: number;
  affectedCards?: number;
  dpi?: number;
};

const textFields = new Set([
  "phase", "cardName", "projectId", "outcome", "reason", "selectedIdentifier",
  "sourceName", "cardType", "errorName",
]);
const numberFields = new Set([
  "elapsedMs", "phaseElapsedMs", "groupIndex", "totalImages", "processedImages",
  "inputCards", "eligibleCards", "totalCards", "upgraded", "skipped", "errors",
  "candidateCount", "exactMatchCount", "queryCount", "calibrationCases",
  "profileCount", "affectedCards", "dpi",
]);
const eventNames = new Set<string>(MPC_BULK_LOG_EVENTS);

function safeText(value: string): string {
  return value
    .replace(/https?:\/\/\S+/gi, "[redacted-url]")
    .replace(/calibration_pair_[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/Bearer\s+\S+/gi, "[redacted]")
    .replace(/\b(?:api[_-]?key|token|secret|password)\s*[:=]\s*\S+/gi, "[redacted]")
    .replace(/[\p{Cc}\u2028\u2029]/gu, " ")
    .slice(0, 160);
}

function captureEvent(value: unknown): MpcBulkLogEvent | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (typeof input.event !== "string" || !eventNames.has(input.event) ||
      typeof input.runId !== "string" || !/^[A-Za-z0-9-]{1,64}$/.test(input.runId) ||
      typeof input.elapsedMs !== "number") return null;
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(input)) {
    if (key === "event" || key === "runId") {
      output[key] = entry;
    } else if (textFields.has(key)) {
      if (entry === undefined) continue;
      if (typeof entry !== "string") return null;
      output[key] = safeText(entry);
    } else if (numberFields.has(key)) {
      if (entry === undefined) continue;
      if (typeof entry !== "number" || !Number.isFinite(entry) || entry < 0 ||
          (!key.endsWith("Ms") && !Number.isSafeInteger(entry))) return null;
      output[key] = entry;
    } else {
      return null;
    }
  }
  return output as MpcBulkLogEvent;
}

export function formatMpcBulkLogEvent(event: MpcBulkLogEvent): string {
  const captured = captureEvent(event);
  if (!captured) throw new TypeError("Invalid MPC bulk log event");
  const message = MPC_BULK_LOG_PREFIX + JSON.stringify(captured);
  if (message.length > MPC_BULK_LOG_MAX_LENGTH) throw new RangeError("MPC bulk log exceeds line limit");
  return message;
}

export function parseMpcBulkLogMessage(message: unknown): MpcBulkLogEvent | null {
  if (typeof message !== "string" || message.length > MPC_BULK_LOG_MAX_LENGTH ||
      !message.startsWith(MPC_BULK_LOG_PREFIX)) return null;
  try {
    return captureEvent(JSON.parse(message.slice(MPC_BULK_LOG_PREFIX.length)));
  } catch {
    return null;
  }
}
