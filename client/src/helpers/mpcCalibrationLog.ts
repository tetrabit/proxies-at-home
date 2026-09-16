/**
 * Single, stable console format for the MPC calibration sync path.
 *
 * Every line starts with the `[mpc-calibration]` prefix followed by an event
 * name and `key=value` fields, so renderer logs (which Electron mirrors to a
 * file via the console-message sink) can be grepped by event name and the
 * state transition can be reconstructed without database forensics.
 *
 * Logging is strictly observational: it never throws, never changes a result,
 * and never logs identity material (owner/harness/connection ids are logged
 * as short prefixes only).
 */
const PREFIX = "[mpc-calibration]";

type LogField = string | number | undefined;

function formatFields(entries: Readonly<Record<string, LogField>>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(entries)) {
    if (value === undefined || value === "") continue;
    parts.push(`${key}=${value}`);
  }
  return parts.length > 0 ? ` ${parts.join(" ")}` : "";
}

function shortId(value: unknown): string | undefined {
  return typeof value === "string" && value.length >= 8 ? value.slice(0, 8) : undefined;
}

export function mpcCalibrationLogInfo(
  event: string,
  entries: Readonly<Record<string, LogField>> = {},
): void {
  try {
    console.info(`${PREFIX} ${event}${formatFields(entries)}`);
  } catch {
    // Console delivery must never affect the sync path.
  }
}

export function mpcCalibrationLogWarn(
  event: string,
  entries: Readonly<Record<string, LogField>> = {},
): void {
  try {
    console.warn(`${PREFIX} ${event}${formatFields(entries)}`);
  } catch {
    // Console delivery must never affect the sync path.
  }
}

export function mpcCalibrationLogError(
  event: string,
  error: unknown,
  entries: Readonly<Record<string, LogField>> = {},
): void {
  try {
    console.error(`${PREFIX} ${event}${formatFields(entries)}`, error ?? "");
  } catch {
    // Console delivery must never affect the sync path.
  }
}

/** Non-secret identity fields for log lines: short prefixes only. */
export function identityLogFields(
  identity: Readonly<{ ownerId?: unknown; harnessId?: unknown; connectionId?: unknown }> | undefined,
): Readonly<Record<string, LogField>> {
  return {
    owner: shortId(identity?.ownerId),
    harness: shortId(identity?.harnessId),
    connection: shortId(identity?.connectionId),
  };
}
