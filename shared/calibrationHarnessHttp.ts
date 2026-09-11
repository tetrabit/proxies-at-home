export const CALIBRATION_HARNESS_HTTP = Object.freeze({
  basePath: '/api/calibration-harness',
  pairPath: '/api/calibration-harness/pair',
  unpairPath: '/api/calibration-harness/unpair',
  sessionPath: '/api/calibration-harness/session',
  snapshotPath: '/api/calibration-harness/snapshot',
  blobsPath: '/api/calibration-harness/blobs',
  blobsMissingPath: '/api/calibration-harness/blobs/missing',
  cacheControl: 'no-store',
});

/** Returns whether a value is the canonical content-addressed blob key. */
export function isCalibrationHarnessBlobSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

/** Builds a fixed blob route only from a canonical SHA-256 key. */
export function calibrationHarnessBlobPath(sha256: string): string {
  if (!isCalibrationHarnessBlobSha256(sha256)) {
    throw new TypeError('Calibration harness blob SHA-256 must be exactly 64 lowercase hexadecimal characters');
  }
  return `${CALIBRATION_HARNESS_HTTP.blobsPath}/${sha256}`;
}

/** Formats the only ETag representation accepted for a persisted revision. */
export function calibrationHarnessRevisionEtag(revision: number): string {
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new TypeError('Calibration harness revision must be a positive safe integer');
  }
  return `"${revision}"`;
}

/** Parses one strong, quoted, canonical positive revision ETag. */
export function parseCalibrationHarnessRevisionEtag(value: string): number | null {
  const match = /^"([1-9][0-9]*)"$/.exec(value);
  if (match === null) return null;
  const revision = Number(match[1]);
  return Number.isSafeInteger(revision) && revision >= 1 ? revision : null;
}
