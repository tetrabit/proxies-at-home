import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as electronPreferenceSyncTargetModule from './electronPreferenceSyncTarget';
import * as fsAccessPreferenceTargetModule from './fsAccessPreferenceTarget';
import * as mpcCalibrationStorageModule from './mpcCalibrationStorage';
import * as serverPreferenceSyncTargetModule from './serverPreferenceSyncTarget';
import {
  flushMpcPreferenceSync,
  getActivePreferenceSyncTarget,
  isServerPreferenceSyncAvailable,
  loadActivePreferenceOverrides,
  markMpcPreferenceSyncDirty,
  resetMpcPreferenceSyncForTests,
  serializeCurrentPreferenceFixture,
} from './mpcPreferenceSync';

describe('mpcPreferenceSync', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    resetMpcPreferenceSyncForTests();
  });

  it('serializes current default calibration cases into a preference fixture', async () => {
    vi.spyOn(mpcCalibrationStorageModule, 'listDefaultMpcCalibrationCases').mockResolvedValue([
      {
        id: 'case-1',
        datasetId: 'dataset-1',
        createdAt: 1,
        updatedAt: 1,
        source: { name: 'Sol Ring' },
        candidates: [],
        expectedIdentifier: 'preferred',
      },
    ]);

    await expect(serializeCurrentPreferenceFixture()).resolves.toEqual(
      expect.objectContaining({
        version: 1,
        cases: [
          expect.objectContaining({
            source: { name: 'Sol Ring' },
            expectedIdentifier: 'preferred',
          }),
        ],
      })
    );
  });

  it('treats 404 from the preferences route as a reachable server target', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(null, { status: 404, statusText: 'Not Found' })
    );

    await expect(isServerPreferenceSyncAvailable()).resolves.toBe(true);
  });

  it('selects the Electron target before server and FS access', async () => {
    vi.spyOn(electronPreferenceSyncTargetModule, 'isElectronPreferenceSyncAvailable').mockReturnValue(true);

    await expect(getActivePreferenceSyncTarget()).resolves.toBe(
      electronPreferenceSyncTargetModule.electronPreferenceSyncTarget
    );
  });

  it('falls back to the server target when Electron is unavailable and the route responds', async () => {
    vi.spyOn(electronPreferenceSyncTargetModule, 'isElectronPreferenceSyncAvailable').mockReturnValue(false);
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(null, { status: 404, statusText: 'Not Found' })
    );

    await expect(getActivePreferenceSyncTarget()).resolves.toBe(
      serverPreferenceSyncTargetModule.serverPreferenceSyncTarget
    );
  });

  it('loads overrides from the first reachable target', async () => {
    vi.spyOn(electronPreferenceSyncTargetModule, 'isElectronPreferenceSyncAvailable').mockReturnValue(false);
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ version: 1, exportedAt: '2026-04-18T12:00:00.000Z', cases: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    await expect(loadActivePreferenceOverrides()).resolves.toEqual({
      target: serverPreferenceSyncTargetModule.serverPreferenceSyncTarget,
      fixture: { version: 1, exportedAt: '2026-04-18T12:00:00.000Z', cases: [] },
    });
  });

  it('debounces dirty marks into a single flush', async () => {
    vi.useFakeTimers();
    vi.spyOn(electronPreferenceSyncTargetModule, 'isElectronPreferenceSyncAvailable').mockReturnValue(false);
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(null, { status: 404, statusText: 'Not Found' })
    );
    const writeSpy = vi
      .spyOn(serverPreferenceSyncTargetModule.serverPreferenceSyncTarget, 'write')
      .mockResolvedValue(undefined);
    vi.spyOn(mpcCalibrationStorageModule, 'listDefaultMpcCalibrationCases').mockResolvedValue([]);

    markMpcPreferenceSyncDirty();
    markMpcPreferenceSyncDirty();

    await vi.advanceTimersByTimeAsync(2000);

    expect(writeSpy).toHaveBeenCalledTimes(1);
  });

  it('flushes immediately when requested', async () => {
    vi.spyOn(electronPreferenceSyncTargetModule, 'isElectronPreferenceSyncAvailable').mockReturnValue(false);
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(null, { status: 404, statusText: 'Not Found' })
    );
    const writeSpy = vi
      .spyOn(serverPreferenceSyncTargetModule.serverPreferenceSyncTarget, 'write')
      .mockResolvedValue(undefined);
    vi.spyOn(mpcCalibrationStorageModule, 'listDefaultMpcCalibrationCases').mockResolvedValue([]);

    await flushMpcPreferenceSync();

    expect(writeSpy).toHaveBeenCalledTimes(1);
  });
});
