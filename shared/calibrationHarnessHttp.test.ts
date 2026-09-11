import { describe, expect, it } from 'vitest';

import {
  CALIBRATION_HARNESS_HTTP,
  calibrationHarnessBlobPath,
  calibrationHarnessRevisionEtag,
  isCalibrationHarnessBlobSha256,
  parseCalibrationHarnessRevisionEtag,
} from './calibrationHarnessHttp.js';

describe('calibration harness HTTP contract', () => {
  it('exposes fixed credential-scoped paths and canonical strong revision ETags', () => {
    expect(CALIBRATION_HARNESS_HTTP).toEqual({
      basePath: '/api/calibration-harness',
      pairPath: '/api/calibration-harness/pair',
      unpairPath: '/api/calibration-harness/unpair',
      sessionPath: '/api/calibration-harness/session',
      snapshotPath: '/api/calibration-harness/snapshot',
      blobsPath: '/api/calibration-harness/blobs',
      blobsMissingPath: '/api/calibration-harness/blobs/missing',
      cacheControl: 'no-store',
    });
    const hash = 'a'.repeat(64);
    expect(isCalibrationHarnessBlobSha256(hash)).toBe(true);
    expect(isCalibrationHarnessBlobSha256(hash.toUpperCase())).toBe(false);
    expect(isCalibrationHarnessBlobSha256('a'.repeat(63))).toBe(false);
    expect(calibrationHarnessBlobPath(hash)).toBe('/api/calibration-harness/blobs/' + hash);
    expect(() => calibrationHarnessBlobPath('../not-a-hash')).toThrow(TypeError);
    expect(calibrationHarnessRevisionEtag(17)).toBe('"17"');
    expect(parseCalibrationHarnessRevisionEtag('"17"')).toBe(17);
    expect(parseCalibrationHarnessRevisionEtag('W/"17"')).toBeNull();
    expect(parseCalibrationHarnessRevisionEtag('"017"')).toBeNull();
    expect(parseCalibrationHarnessRevisionEtag('"0"')).toBeNull();
  });
});
