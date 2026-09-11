import { describe, expect, it } from 'vitest';

import {
  CALIBRATION_HARNESS_HTTP,
  calibrationHarnessRevisionEtag,
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
      cacheControl: 'no-store',
    });
    expect(calibrationHarnessRevisionEtag(17)).toBe('"17"');
    expect(parseCalibrationHarnessRevisionEtag('"17"')).toBe(17);
    expect(parseCalibrationHarnessRevisionEtag('W/"17"')).toBeNull();
    expect(parseCalibrationHarnessRevisionEtag('"017"')).toBeNull();
    expect(parseCalibrationHarnessRevisionEtag('"0"')).toBeNull();
  });
});
