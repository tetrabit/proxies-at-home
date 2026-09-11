export const CALIBRATION_HARNESS_HTTP = Object.freeze({
  basePath: '/api/calibration-harness',
  pairPath: '/api/calibration-harness/pair',
  unpairPath: '/api/calibration-harness/unpair',
  sessionPath: '/api/calibration-harness/session',
  snapshotPath: '/api/calibration-harness/snapshot',
  cacheControl: 'no-store',
});

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
