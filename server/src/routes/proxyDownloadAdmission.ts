export class ProxyDownloadQuotaError extends Error {
  constructor() {
    super("Image download service is temporarily unavailable.");
    this.name = "ProxyDownloadQuotaError";
  }
}

export type ProxyDownloadAdmissionOptions = {
  maxBytes: number;
};

export type ProxyDownloadReservation = {
  release(): boolean;
  isReleased(): boolean;
  markCleanupPending(): void;
  isCleanupPending(): boolean;
};

export type ProxyDownloadCleanupReconciler = {
  /** Removes one exact, server-owned temporary path before releasing its lease. */
  reconcile(filePath: string, reservation: ProxyDownloadReservation): Promise<void>;
};

export type ProxyDownloadCleanupOptions = {
  unlink: (filePath: string) => Promise<void>;
  maxAttempts?: number;
  initialRetryDelayMs?: number;
  maxRetryDelayMs?: number;
  scheduleRetry?: (callback: () => void, delayMs: number) => void;
  log?: (message: string, error: unknown) => void;
  onSettled?: (filePath: string) => void;
};

const DEFAULT_CLEANUP_MAX_ATTEMPTS = 3;
const DEFAULT_CLEANUP_INITIAL_RETRY_DELAY_MS = 25;
const DEFAULT_CLEANUP_MAX_RETRY_DELAY_MS = 250;

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a finite integer greater than or equal to 1.`);
  }
}

function assertNonNegativeInteger(name: string, value: number): void {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a finite integer greater than or equal to 0.`);
  }
}

/** Tracks temporary-spool reservations for started physical image owners. */
export function createProxyDownloadAdmission(options: ProxyDownloadAdmissionOptions) {
  assertPositiveInteger("maxBytes", options.maxBytes);
  let reservedBytes = 0;

  return {
    reserve(bytes: number): ProxyDownloadReservation {
      assertPositiveInteger("bytes", bytes);
      if (bytes > options.maxBytes - reservedBytes) {
        throw new ProxyDownloadQuotaError();
      }

      reservedBytes += bytes;
      let released = false;
      let cleanupPending = false;
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
        markCleanupPending(): void {
          cleanupPending = true;
        },
        isCleanupPending(): boolean {
          return cleanupPending && !released;
        },
      };
    },
    stats() {
      return { reservedBytes, maxBytes: options.maxBytes };
    },
  };
}

/**
 * Retains a lease until its one owned temporary file was removed or was already
 * absent. Bounded retry exhaustion deliberately leaves the lease charged.
 */
export function createProxyDownloadCleanupReconciler(
  options: ProxyDownloadCleanupOptions,
): ProxyDownloadCleanupReconciler {
  const maxAttempts = options.maxAttempts ?? DEFAULT_CLEANUP_MAX_ATTEMPTS;
  const initialRetryDelayMs = options.initialRetryDelayMs ?? DEFAULT_CLEANUP_INITIAL_RETRY_DELAY_MS;
  const maxRetryDelayMs = options.maxRetryDelayMs ?? DEFAULT_CLEANUP_MAX_RETRY_DELAY_MS;
  assertPositiveInteger("maxAttempts", maxAttempts);
  assertNonNegativeInteger("initialRetryDelayMs", initialRetryDelayMs);
  assertNonNegativeInteger("maxRetryDelayMs", maxRetryDelayMs);

  const scheduleRetry = options.scheduleRetry ?? ((callback, delayMs) => void setTimeout(callback, delayMs));
  const log = options.log ?? ((message, error) => console.error(message, error));
  const settled = new WeakSet<ProxyDownloadReservation>();
  const exhausted = new WeakSet<ProxyDownloadReservation>();
  const reconciling = new WeakSet<ProxyDownloadReservation>();
  const releaseAfterConfirmedRemoval = (filePath: string, reservation: ProxyDownloadReservation): void => {
    reservation.release();
    options.onSettled?.(filePath);
  };
  const delayForAttempt = (attempt: number): number =>
    Math.min(initialRetryDelayMs * 2 ** Math.max(0, attempt - 1), maxRetryDelayMs);

  return {
    async reconcile(filePath, reservation): Promise<void> {
      if (settled.has(reservation) || exhausted.has(reservation) || reconciling.has(reservation)) return;
      if (reservation.isReleased()) {
        settled.add(reservation);
        return;
      }
      reconciling.add(reservation);

      const attemptUnlink = async (attempt: number): Promise<void> => {
        if (settled.has(reservation) || reservation.isReleased()) {
          reconciling.delete(reservation);
          settled.add(reservation);
          return;
        }
        try {
          await options.unlink(filePath);
          releaseAfterConfirmedRemoval(filePath, reservation);
          reconciling.delete(reservation);
          settled.add(reservation);
        } catch (error: unknown) {
          const code = typeof error === "object" && error !== null
            ? (error as NodeJS.ErrnoException).code
            : undefined;
          if (code === "ENOENT") {
            releaseAfterConfirmedRemoval(filePath, reservation);
            reconciling.delete(reservation);
            settled.add(reservation);
            return;
          }
          reservation.markCleanupPending();
          if (attempt >= maxAttempts) {
            reconciling.delete(reservation);
            exhausted.add(reservation);
            log("[Proxy] retaining temporary download reservation after bounded owned-temp cleanup failure", error);
            return;
          }
          scheduleRetry(() => void attemptUnlink(attempt + 1), delayForAttempt(attempt));
        }
      };

      await attemptUnlink(1);
    },
  };
}
