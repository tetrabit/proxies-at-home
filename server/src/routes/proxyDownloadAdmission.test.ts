import { describe, expect, it, vi } from "vitest";
import {
  ProxyDownloadQuotaError,
  createProxyDownloadAdmission,
  createProxyDownloadCleanupReconciler,
} from "./proxyDownloadAdmission.js";

describe("proxy download temporary-byte admission", () => {
  it("admits exactly the aggregate envelope and rejects an all-or-nothing overflow", () => {
    const admission = createProxyDownloadAdmission({ maxBytes: 10 });
    const first = admission.reserve(6);

    expect(admission.stats()).toEqual({ reservedBytes: 6, maxBytes: 10 });
    expect(() => admission.reserve(5)).toThrow(ProxyDownloadQuotaError);
    expect(admission.stats()).toEqual({ reservedBytes: 6, maxBytes: 10 });

    first.release();
    expect(admission.reserve(10).release()).toBe(true);
    expect(admission.stats()).toEqual({ reservedBytes: 0, maxBytes: 10 });
  });

  it("rejects invalid values before accounting and releases idempotently", () => {
    expect(() => createProxyDownloadAdmission({ maxBytes: 0 })).toThrow(
      "maxBytes must be a finite integer greater than or equal to 1."
    );

    const admission = createProxyDownloadAdmission({ maxBytes: 10 });
    expect(() => admission.reserve(0)).toThrow(
      "bytes must be a finite integer greater than or equal to 1."
    );
    expect(admission.stats()).toEqual({ reservedBytes: 0, maxBytes: 10 });

    const reservation = admission.reserve(10);
    expect(reservation.release()).toBe(true);
    expect(reservation.release()).toBe(false);
    expect(admission.stats()).toEqual({ reservedBytes: 0, maxBytes: 10 });
  });

  it("retains an owned-temp lease after a transient unlink failure until reconciliation confirms absence", async () => {
    const admission = createProxyDownloadAdmission({ maxBytes: 10 });
    const retries: Array<() => void> = [];
    const unlink = vi
      .fn<(filePath: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error("EBUSY"))
      .mockResolvedValueOnce(undefined);
    const cleanup = createProxyDownloadCleanupReconciler({
      unlink,
      scheduleRetry: callback => retries.push(callback),
      log: () => undefined,
    });
    const reservation = admission.reserve(10);

    await cleanup.reconcile("/cache/owner.tmp", reservation);

    expect(admission.stats().reservedBytes).toBe(10);
    expect(() => admission.reserve(1)).toThrow(ProxyDownloadQuotaError);
    expect(retries).toHaveLength(1);

    retries.shift()?.();
    await new Promise<void>(resolve => setImmediate(resolve));

    expect(unlink).toHaveBeenCalledTimes(2);
    expect(admission.stats()).toEqual({ reservedBytes: 0, maxBytes: 10 });
  });

  it("treats ENOENT as confirmed absence and retains a lease after bounded permanent failures", async () => {
    const missing = Object.assign(new Error("gone"), { code: "ENOENT" });
    const absentAdmission = createProxyDownloadAdmission({ maxBytes: 10 });
    const absentCleanup = createProxyDownloadCleanupReconciler({
      unlink: vi.fn<(filePath: string) => Promise<void>>().mockRejectedValue(missing),
      log: () => undefined,
    });
    await absentCleanup.reconcile("/cache/gone.tmp", absentAdmission.reserve(10));
    expect(absentAdmission.stats().reservedBytes).toBe(0);

    const retainedAdmission = createProxyDownloadAdmission({ maxBytes: 10 });
    const retries: Array<() => void> = [];
    const unlink = vi.fn<(filePath: string) => Promise<void>>().mockRejectedValue(new Error("EACCES"));
    const cleanup = createProxyDownloadCleanupReconciler({
      unlink,
      maxAttempts: 2,
      scheduleRetry: callback => retries.push(callback),
      log: () => undefined,
    });
    await cleanup.reconcile("/cache/retained.tmp", retainedAdmission.reserve(10));
    retries.shift()?.();
    await new Promise<void>(resolve => setImmediate(resolve));

    expect(unlink).toHaveBeenCalledTimes(2);
    expect(retainedAdmission.stats().reservedBytes).toBe(10);
    expect(() => retainedAdmission.reserve(1)).toThrow(ProxyDownloadQuotaError);
  });
});
