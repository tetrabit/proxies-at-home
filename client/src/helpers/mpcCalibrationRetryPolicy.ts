export type MpcCalibrationRetryOutcome =
  | "success"
  | "offline"
  | "timeout"
  | "authentication"
  | "blocked"
  | "conflict"
  | "failed"
  | "cancelled";

export type MpcCalibrationRetryDecision =
  | Readonly<{ kind: "retry"; delayMs: number; nextAttempt: number }>
  | Readonly<{ kind: "stop" }>;

export const MPC_CALIBRATION_RETRY_DELAYS_MS = Object.freeze([1000, 2000, 4000, 8000] as const);
export const MPC_CALIBRATION_MAX_RETRY_ATTEMPTS = 4;

export function getMpcCalibrationRetryDecision(
  outcome: unknown,
  attempts: number,
): MpcCalibrationRetryDecision {
  if (
    (outcome !== "offline" && outcome !== "timeout")
    || !Number.isInteger(attempts)
    || attempts < 0
    || attempts >= MPC_CALIBRATION_MAX_RETRY_ATTEMPTS
  ) {
    return { kind: "stop" };
  }

  return {
    kind: "retry",
    delayMs: MPC_CALIBRATION_RETRY_DELAYS_MS[attempts],
    nextAttempt: attempts + 1,
  };
}
