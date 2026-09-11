import type {
  CalibrationHarnessRevision,
  CalibrationHarnessSnapshot,
} from "./calibrationHarness.js";

/** Browser-safe DTOs for the fixed desktop calibration harness IPC channel. */
export type CalibrationHarnessIpcOperation =
  | Readonly<{ kind: "getSession" }>
  | Readonly<{ kind: "getSnapshot" }>
  | Readonly<{
      kind: "publishSnapshot";
      snapshot: CalibrationHarnessSnapshot;
      expectedRevision: number | null;
    }>
  | Readonly<{ kind: "getBlob"; sha256: string }>
  | Readonly<{ kind: "putBlob"; sha256: string; bytes: Uint8Array | ArrayBuffer }>
  | Readonly<{ kind: "missingBlobs"; hashes: string[] }>;

export type CalibrationHarnessIpcValue =
  | Readonly<{ ownerId: string; harnessId: string }>
  | CalibrationHarnessRevision
  | Uint8Array
  | Readonly<{ sha256: string; byteLength: number; inserted: boolean }>
  | Readonly<{ missing: string[] }>;

export type CalibrationHarnessIpcErrorCode =
  | "not-configured"
  | "invalid-operation"
  | "http"
  | "offline"
  | "timeout"
  | "aborted"
  | "redirect"
  | "response-too-large"
  | "invalid-response";

export type CalibrationHarnessIpcResult =
  | Readonly<{ ok: true; value: CalibrationHarnessIpcValue }>
  | Readonly<{
      ok: false;
      error: Readonly<{
        code: CalibrationHarnessIpcErrorCode;
        status?: number;
      }>;
    }>;
