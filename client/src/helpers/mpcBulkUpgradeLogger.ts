import {
  formatMpcBulkLogEvent,
  type MpcBulkLogEvent,
} from "../../../shared/mpcBulkUpgradeLogging";

type LogFields = Omit<MpcBulkLogEvent, "event" | "runId" | "elapsedMs">;

type LoggerOptions = {
  runId?: string;
  signal?: AbortSignal;
  heartbeatIntervalMs?: number;
};

const DEFAULT_HEARTBEAT_INTERVAL_MS = 10_000;

function createRunId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `mpc-${Date.now().toString(36)}`;
}

/**
 * Best-effort renderer-side observability for one bulk MPC upgrade invocation.
 * It deliberately never lets formatting or console delivery affect the upgrade.
 */
export function createMpcBulkUpgradeLogger(options: LoggerOptions = {}) {
  const runId = options.runId ?? createRunId();
  const startedAt = Date.now();
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  let currentPhase: string | undefined;
  let phaseStartedAt = startedAt;
  let current: LogFields = {};
  let hasStarted = false;
  let terminal = false;
  let cancellationRequested = false;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;

  const elapsedMs = () => Math.max(0, Date.now() - startedAt);
  const carryProgress = () => {
    const { inputCards, eligibleCards, totalCards, totalImages, processedImages, upgraded, skipped, errors } = current;
    return { inputCards, eligibleCards, totalCards, totalImages, processedImages, upgraded, skipped, errors };
  };

  const emit = (event: MpcBulkLogEvent["event"], fields: LogFields = {}) => {
    if (terminal && event !== "completed" && event !== "cancelled" && event !== "failed") {
      return;
    }
    try {
      console.info(formatMpcBulkLogEvent({
        event,
        runId,
        elapsedMs: elapsedMs(),
        ...fields,
      }));
    } catch {
      // Observability must not make the upgrade fail.
    }
  };

  const stop = () => {
    if (heartbeatTimer !== undefined) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = undefined;
    }
    options.signal?.removeEventListener("abort", onAbort);
  };

  const onAbort = () => {
    cancellationRequested = true;
    if (hasStarted && !terminal) {
      emit("cancel-requested", { ...current, phase: currentPhase, reason: "aborted" });
    }
  };

  options.signal?.addEventListener("abort", onAbort, { once: true });

  const terminalEvent = (
    event: Extract<MpcBulkLogEvent["event"], "completed" | "cancelled" | "failed">,
    fields: LogFields
  ) => {
    if (terminal) return false;
    terminal = true;
    emit(event, { ...current, phase: currentPhase, ...fields });
    stop();
    return true;
  };

  return {
    runId,
    started(fields: LogFields = {}) {
      if (hasStarted || terminal) return;
      hasStarted = true;
      current = { ...current, ...fields };
      emit("started", current);
      heartbeatTimer = setInterval(() => {
        if (!terminal && currentPhase) {
          emit("heartbeat", { ...current, phase: currentPhase, phaseElapsedMs: Math.max(0, Date.now() - phaseStartedAt) });
        }
      }, heartbeatIntervalMs);
      if (options.signal?.aborted && !cancellationRequested) {
        onAbort();
      } else if (cancellationRequested) {
        emit("cancel-requested", { ...current, phase: currentPhase, reason: "aborted" });
      }
    },
    phaseStarted(phase: string, fields: LogFields = {}) {
      currentPhase = phase;
      phaseStartedAt = Date.now();
      current = { ...carryProgress(), ...fields, phase };
      emit("phase-started", current);
    },
    phaseCompleted(phase: string, fields: LogFields = {}) {
      const phaseElapsedMs = Math.max(0, Date.now() - phaseStartedAt);
      current = { ...current, ...fields, phase };
      emit("phase-completed", { ...current, phaseElapsedMs });
    },
    groupStarted(fields: LogFields = {}) {
      current = { ...current, ...fields };
      emit("group-started", { ...current, phase: currentPhase });
    },
    groupCompleted(fields: LogFields = {}) {
      current = { ...current, ...fields };
      emit("group-completed", { ...current, phase: currentPhase });
    },
    progress(fields: LogFields) {
      current = { ...current, ...fields };
    },
    completed(fields: LogFields) {
      return terminalEvent("completed", fields);
    },
    cancelled(fields: LogFields) {
      return terminalEvent("cancelled", fields);
    },
    failed(fields: LogFields) {
      return terminalEvent("failed", { reason: currentPhase, ...fields });
    },
    close() {
      stop();
    },
  };
}
