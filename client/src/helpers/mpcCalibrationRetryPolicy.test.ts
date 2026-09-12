import { describe, expect, it } from "vitest";
import {
  getMpcCalibrationRetryDecision,
  MPC_CALIBRATION_RETRY_DELAYS_MS,
  type MpcCalibrationRetryOutcome,
} from "./mpcCalibrationRetryPolicy";

describe("getMpcCalibrationRetryDecision", () => {
  it("keeps exported delay bounds immutable at runtime", () => {
    expect(Object.isFrozen(MPC_CALIBRATION_RETRY_DELAYS_MS)).toBe(true);
    expect(Reflect.set(MPC_CALIBRATION_RETRY_DELAYS_MS, "0", Infinity)).toBe(false);
    expect(Reflect.deleteProperty(MPC_CALIBRATION_RETRY_DELAYS_MS, "0")).toBe(false);
    expect(getMpcCalibrationRetryDecision("offline", 0)).toEqual({
      kind: "retry", delayMs: 1000, nextAttempt: 1,
    });
  });

  it.each([
    { outcome: "offline", attempts: 0, expected: { kind: "retry", delayMs: 1000, nextAttempt: 1 } },
    { outcome: "timeout", attempts: 1, expected: { kind: "retry", delayMs: 2000, nextAttempt: 2 } },
    { outcome: "offline", attempts: 2, expected: { kind: "retry", delayMs: 4000, nextAttempt: 3 } },
    { outcome: "timeout", attempts: 3, expected: { kind: "retry", delayMs: 8000, nextAttempt: 4 } },
  ] as const)("retries $outcome after $attempts completed retries", ({ outcome, attempts, expected }) => {
    expect(getMpcCalibrationRetryDecision(outcome, attempts)).toEqual(expected);
  });

  it.each([
    "success",
    "authentication",
    "blocked",
    "conflict",
    "failed",
    "cancelled",
  ] as const)("stops terminal $outcome outcomes", outcome => {
    expect(getMpcCalibrationRetryDecision(outcome, 0)).toEqual({ kind: "stop" });
  });

  it.each([
    { outcome: "offline", attempts: 4 },
    { outcome: "timeout", attempts: 4 },
    { outcome: "offline", attempts: 5 },
    { outcome: "timeout", attempts: Number.MAX_SAFE_INTEGER },
  ] as const)("stops eligible outcomes at the retry boundary", ({ outcome, attempts }) => {
    expect(getMpcCalibrationRetryDecision(outcome, attempts)).toEqual({ kind: "stop" });
  });

  it.each([
    undefined,
    null,
    "unavailable",
    0,
    true,
    [],
    {},
  ])("fails closed for malformed outcome %p", outcome => {
    expect(getMpcCalibrationRetryDecision(outcome, 0)).toEqual({ kind: "stop" });
  });

  it.each([
    NaN,
    Infinity,
    -Infinity,
    -1,
    0.5,
    1.5,
    Number.MAX_VALUE,
  ])("fails closed for malformed counter %p", attempts => {
    expect(getMpcCalibrationRetryDecision("offline", attempts)).toEqual({ kind: "stop" });
  });

  it("does not invoke malformed outcome accessors or reflect their values", () => {
    let reads = 0;
    const malformed = Object.create(null, {
      kind: {
        get() {
          reads += 1;
          return "offline";
        },
      },
    });

    const decision = getMpcCalibrationRetryDecision(malformed, 0);

    expect(decision).toEqual({ kind: "stop" });
    expect(reads).toBe(0);
  });

  it("returns fresh closed decisions without mutating its inputs", () => {
    const outcome: MpcCalibrationRetryOutcome = "offline";
    const first = getMpcCalibrationRetryDecision(outcome, 0);
    const second = getMpcCalibrationRetryDecision(outcome, 0);

    expect(first).toEqual({ kind: "retry", delayMs: 1000, nextAttempt: 1 });
    expect(second).toEqual(first);
    expect(second).not.toBe(first);
    expect(outcome).toBe("offline");
  });
});
