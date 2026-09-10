import { describe, expect, it, vi } from "vitest";
import {
  CalibrationTemporaryFileQuotaError,
  createCalibrationTemporaryFileCleanupReconciler,
  createCalibrationTemporaryFileAdmission,
} from "./calibrationTemporaryFileAdmission.js";

describe("calibration temporary-file admission", () => {
  it("rejects a concurrent reservation that would exceed the aggregate byte quota", () => {
    const admission = createCalibrationTemporaryFileAdmission({ maxBytes: 8 });
    const first = admission.reserve(5);

    expect(admission.stats()).toEqual({ reservedBytes: 5, maxBytes: 8 });
    expect(() => admission.reserve(4)).toThrow(CalibrationTemporaryFileQuotaError);

    first.release();
    expect(admission.stats()).toEqual({ reservedBytes: 0, maxBytes: 8 });
  });

  it("keeps a reservation until its owner settles and releases it exactly once", () => {
    const admission = createCalibrationTemporaryFileAdmission({ maxBytes: 8 });
    const reservation = admission.reserve(8);

    expect(reservation.release()).toBe(true);
    expect(reservation.release()).toBe(false);
    expect(admission.stats()).toEqual({ reservedBytes: 0, maxBytes: 8 });
    expect(() => admission.reserve(8)).not.toThrow();
  });

  it("rejects invalid quota and reservation values before accounting them", () => {
    expect(() => createCalibrationTemporaryFileAdmission({ maxBytes: 0 })).toThrow(
      "maxBytes must be a finite integer greater than or equal to 1."
    );

    const admission = createCalibrationTemporaryFileAdmission({ maxBytes: 8 });
    expect(() => admission.reserve(0)).toThrow(
      "bytes must be a finite integer greater than or equal to 1."
    );
    expect(admission.stats()).toEqual({ reservedBytes: 0, maxBytes: 8 });
  });

  it("reconciles a transient owned-file unlink failure before admitting another reservation", async () => {
    const admission = createCalibrationTemporaryFileAdmission({ maxBytes: 8 });
    const retryCallbacks: Array<() => void> = [];
    const unlink = vi
      .fn<(filePath: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error("temporary EBUSY"))
      .mockResolvedValueOnce(undefined);
    const cleanup = createCalibrationTemporaryFileCleanupReconciler({
      unlink,
      scheduleRetry: (callback) => retryCallbacks.push(callback),
      log: () => undefined,
    });
    const reservation = admission.reserve(8);

    await cleanup.reconcile("/current-operation/upload.pdf", reservation);

    expect(admission.stats().reservedBytes).toBe(8);
    expect(() => admission.reserve(1)).toThrow(CalibrationTemporaryFileQuotaError);
    expect(retryCallbacks).toHaveLength(1);

    retryCallbacks.shift()?.();
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(unlink).toHaveBeenCalledTimes(2);
    expect(admission.stats().reservedBytes).toBe(0);
    expect(() => admission.reserve(8)).not.toThrow();
  });

  it("releases successfully deleted siblings while retaining a failed sibling for reconciliation", async () => {
    const admission = createCalibrationTemporaryFileAdmission({ maxBytes: 8 });
    const retryCallbacks: Array<() => void> = [];
    const cleanup = createCalibrationTemporaryFileCleanupReconciler({
      unlink: vi.fn((filePath: string) =>
        filePath.endsWith("input.pdf")
          ? Promise.resolve()
          : Promise.reject(new Error("temporary EBUSY"))
      ),
      scheduleRetry: (callback) => retryCallbacks.push(callback),
      log: () => undefined,
    });
    const inputReservation = admission.reserve(4);
    const outputReservation = admission.reserve(4);

    await Promise.all([
      cleanup.reconcile("/current-operation/input.pdf", inputReservation),
      cleanup.reconcile("/current-operation/output.pdf", outputReservation),
    ]);

    expect(admission.stats().reservedBytes).toBe(4);
    expect(retryCallbacks).toHaveLength(1);
  });

  it("does not retry or double-release after a reservation has been released", async () => {
    const admission = createCalibrationTemporaryFileAdmission({ maxBytes: 8 });
    const retryCallbacks: Array<() => void> = [];
    const unlink = vi.fn<(filePath: string) => Promise<void>>().mockRejectedValue(new Error("EBUSY"));
    const cleanup = createCalibrationTemporaryFileCleanupReconciler({
      unlink,
      scheduleRetry: (callback) => retryCallbacks.push(callback),
      log: () => undefined,
    });
    const reservation = admission.reserve(8);

    await cleanup.reconcile("/current-operation/output.pdf", reservation);
    expect(reservation.release()).toBe(true);
    retryCallbacks.shift()?.();
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(unlink).toHaveBeenCalledTimes(1);
    expect(reservation.release()).toBe(false);
    expect(admission.stats().reservedBytes).toBe(0);
  });

  it("treats ENOENT as confirmed cleanup and releases the reservation", async () => {
    const admission = createCalibrationTemporaryFileAdmission({ maxBytes: 8 });
    const missing = Object.assign(new Error("already gone"), { code: "ENOENT" });
    const cleanup = createCalibrationTemporaryFileCleanupReconciler({
      unlink: vi.fn<(filePath: string) => Promise<void>>().mockRejectedValue(missing),
      scheduleRetry: () => {
        throw new Error("ENOENT must not retry");
      },
      log: () => undefined,
    });
    const reservation = admission.reserve(8);

    await cleanup.reconcile("/current-operation/output.pdf", reservation);

    expect(admission.stats().reservedBytes).toBe(0);
    expect(reservation.release()).toBe(false);
  });

  it("bounds permanent cleanup failures and retains the reservation without double-releasing it", async () => {
    const admission = createCalibrationTemporaryFileAdmission({ maxBytes: 8 });
    const retryCallbacks: Array<() => void> = [];
    const retryDelays: number[] = [];
    const unlink = vi.fn<(filePath: string) => Promise<void>>().mockRejectedValue(new Error("EACCES"));
    const log = vi.fn();
    const cleanup = createCalibrationTemporaryFileCleanupReconciler({
      unlink,
      maxAttempts: 3,
      scheduleRetry: (callback, delayMs) => {
        retryCallbacks.push(callback);
        retryDelays.push(delayMs);
      },
      log,
    });
    const reservation = admission.reserve(8);

    await cleanup.reconcile("/current-operation/output.pdf", reservation);
    while (retryCallbacks.length) {
      retryCallbacks.shift()?.();
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    expect(unlink).toHaveBeenCalledTimes(3);
    expect(retryDelays).toEqual([25, 50]);
    expect(admission.stats().reservedBytes).toBe(8);
    expect(retryCallbacks).toHaveLength(0);
    expect(log).toHaveBeenCalledTimes(1);

    await cleanup.reconcile("/current-operation/output.pdf", reservation);
    expect(unlink).toHaveBeenCalledTimes(3);

    reservation.release();
    expect(reservation.release()).toBe(false);
    expect(admission.stats().reservedBytes).toBe(0);
  });
});
