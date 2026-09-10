export class CalibrationTemporaryFileQuotaError extends Error {
  constructor(maxBytes: number) {
    super(`Printer calibration temporary-file quota is full (max bytes: ${maxBytes}).`);
    this.name = "CalibrationTemporaryFileQuotaError";
  }
}

export type CalibrationTemporaryFileAdmissionOptions = {
  maxBytes: number;
};

export type CalibrationTemporaryFileReservation = {
  release(): boolean;
  isReleased(): boolean;
};

export type CalibrationTemporaryFileCleanupReconciler = {
  /**
   * Attempts to remove one exact, server-owned path. It resolves after the
   * first physical operation; later retries remain responsible for a failed
   * path and its reservation.
   */
  reconcile(filePath: string, reservation: CalibrationTemporaryFileReservation): Promise<void>;
};

export type CalibrationTemporaryFileCleanupOptions = {
  unlink: (filePath: string) => Promise<void>;
  maxAttempts?: number;
  initialRetryDelayMs?: number;
  maxRetryDelayMs?: number;
  scheduleRetry?: (callback: () => void, delayMs: number) => void;
  log?: (message: string, error: unknown) => void;
};

const DEFAULT_CLEANUP_MAX_ATTEMPTS = 3;
const DEFAULT_CLEANUP_INITIAL_RETRY_DELAY_MS = 25;
const DEFAULT_CLEANUP_MAX_RETRY_DELAY_MS = 250;

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a finite integer greater than or equal to 1.`);
  }
}

/**
 * Tracks aggregate bytes reserved by calibration upload owners. A reservation is
 * intentionally retained until its owner has physically settled its temp file.
 */
export function createCalibrationTemporaryFileAdmission(
  options: CalibrationTemporaryFileAdmissionOptions
) {
  assertPositiveInteger("maxBytes", options.maxBytes);
  let reservedBytes = 0;

  return {
    reserve(bytes: number): CalibrationTemporaryFileReservation {
      assertPositiveInteger("bytes", bytes);
      if (bytes > options.maxBytes - reservedBytes) {
        throw new CalibrationTemporaryFileQuotaError(options.maxBytes);
      }

      reservedBytes += bytes;
      let released = false;
      return {
        release(): boolean {
          if (released) return false;
          released = true;
          reservedBytes -= bytes;
          return true;
        },
        isReleased(): boolean {
          return released;
        },
      };
    },
    stats() {
      return { reservedBytes, maxBytes: options.maxBytes };
    },
  };
}

/**
 * Keeps a quota reservation attached to a single owned file until unlink (or
 * ENOENT) confirms that file is gone. Retrying is intentionally bounded: a
 * permanent failure remains charged rather than claiming capacity we cannot
 * prove has been reclaimed.
 */
export function createCalibrationTemporaryFileCleanupReconciler(
  options: CalibrationTemporaryFileCleanupOptions
): CalibrationTemporaryFileCleanupReconciler {
  const maxAttempts = options.maxAttempts ?? DEFAULT_CLEANUP_MAX_ATTEMPTS;
  const initialRetryDelayMs =
    options.initialRetryDelayMs ?? DEFAULT_CLEANUP_INITIAL_RETRY_DELAY_MS;
  const maxRetryDelayMs = options.maxRetryDelayMs ?? DEFAULT_CLEANUP_MAX_RETRY_DELAY_MS;
  assertPositiveInteger("maxAttempts", maxAttempts);
  assertNonNegativeInteger("initialRetryDelayMs", initialRetryDelayMs);
  assertNonNegativeInteger("maxRetryDelayMs", maxRetryDelayMs);
  const scheduleRetry = options.scheduleRetry ?? ((callback, delayMs) => void setTimeout(callback, delayMs));
  const log = options.log ?? ((message, error) => console.error(message, error));
  const settledReservations = new WeakSet<CalibrationTemporaryFileReservation>();
  const exhaustedReservations = new WeakSet<CalibrationTemporaryFileReservation>();
  const reconcilingReservations = new WeakSet<CalibrationTemporaryFileReservation>();

  const delayForAttempt = (attempt: number): number =>
    Math.min(initialRetryDelayMs * 2 ** Math.max(0, attempt - 1), maxRetryDelayMs);

  return {
    async reconcile(filePath, reservation): Promise<void> {
      if (
        settledReservations.has(reservation) ||
        exhaustedReservations.has(reservation) ||
        reconcilingReservations.has(reservation)
      ) {
        return;
      }
      if (reservation.isReleased()) {
        settledReservations.add(reservation);
        return;
      }
      reconcilingReservations.add(reservation);

      const attemptUnlink = async (attempt: number): Promise<void> => {
        if (settledReservations.has(reservation) || reservation.isReleased()) {
          reconcilingReservations.delete(reservation);
          settledReservations.add(reservation);
          return;
        }

        try {
          await options.unlink(filePath);
          reservation.release();
          reconcilingReservations.delete(reservation);
          settledReservations.add(reservation);
        } catch (error: unknown) {
          const errorCode =
            typeof error === "object" && error !== null
              ? (error as NodeJS.ErrnoException).code
              : undefined;
          if (errorCode === "ENOENT") {
            reservation.release();
            reconcilingReservations.delete(reservation);
            settledReservations.add(reservation);
            return;
          }
          if (attempt >= maxAttempts) {
            reconcilingReservations.delete(reservation);
            exhaustedReservations.add(reservation);
            log(`[printer-calibration] retaining temporary-file reservation after ${attempt} unlink attempts: ${filePath}`, error);
            return;
          }
          scheduleRetry(() => void attemptUnlink(attempt + 1), delayForAttempt(attempt));
        }
      };

      await attemptUnlink(1);
    },
  };
}

function assertNonNegativeInteger(name: string, value: number): void {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a finite integer greater than or equal to 0.`);
  }
}
