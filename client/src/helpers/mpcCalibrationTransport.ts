import type {
  CalibrationHarnessRevision,
  CalibrationHarnessSnapshot,
} from "../../../shared/calibrationHarness";

/** Browser-safe identity returned by the cookie-authenticated harness session. */
export type MpcCalibrationSession = Readonly<{ ownerId: string; harnessId: string }>;
export type MpcCalibrationBlobReceipt = Readonly<{
  sha256: string;
  byteLength: number;
  inserted: boolean;
}>;
export type MpcCalibrationMissingBlobs = Readonly<{ missing: string[] }>;

export type MpcCalibrationTransportErrorCode =
  | "unpaired"
  | "authentication"
  | "http"
  | "offline"
  | "timeout"
  | "aborted"
  | "redirect"
  | "response-too-large"
  | "invalid-response"
  | "invalid-operation";

/** No route, origin, header, or credential override is accepted from callers. */
export type MpcCalibrationRequestOptions = Readonly<{ signal?: AbortSignal }>;

export interface MpcCalibrationTransport {
  /** Pair is explicit; its credential exists only for the duration of this call. */
  pair(credential: string, options?: MpcCalibrationRequestOptions): Promise<MpcCalibrationSession>;
  /** Retires in-memory pairing state after the server has revoked its cookie session. */
  unpair(options?: MpcCalibrationRequestOptions): Promise<void>;
  /** Identity is server-derived; callers must preserve owner/harness binding themselves. */
  getSession(options?: MpcCalibrationRequestOptions): Promise<MpcCalibrationSession>;
  /** A 404 means no remote snapshot exists and is represented only as null. */
  getSnapshot(options?: MpcCalibrationRequestOptions): Promise<CalibrationHarnessRevision | null>;
  publishSnapshot(
    snapshot: CalibrationHarnessSnapshot,
    expectedRevision: number | null,
    options?: MpcCalibrationRequestOptions
  ): Promise<CalibrationHarnessRevision>;
  getBlob(sha256: string, options?: MpcCalibrationRequestOptions): Promise<Uint8Array>;
  putBlob(
    sha256: string,
    bytes: Uint8Array | ArrayBuffer,
    options?: MpcCalibrationRequestOptions
  ): Promise<MpcCalibrationBlobReceipt>;
  missingBlobs(
    hashes: string[],
    options?: MpcCalibrationRequestOptions
  ): Promise<MpcCalibrationMissingBlobs>;
}

export class MpcCalibrationTransportError extends Error {
  readonly code: MpcCalibrationTransportErrorCode;
  readonly status?: number;

  constructor(code: MpcCalibrationTransportErrorCode, status?: number) {
    super(code === "http" ? "Calibration harness request failed" : `Calibration harness ${code}`);
    this.name = "MpcCalibrationTransportError";
    this.code = code;
    this.status = status;
  }
}
