import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as electronPreferenceSyncTargetModule from './electronPreferenceSyncTarget';
import * as fsAccessPreferenceTargetModule from './fsAccessPreferenceTarget';
import * as mpcCalibrationStorageModule from './mpcCalibrationStorage';
import * as serverPreferenceSyncTargetModule from './serverPreferenceSyncTarget';
import {
  flushMpcPreferenceSync,
  getActivePreferenceSyncTarget,
  getMpcPreferenceSyncStatus,
  isServerPreferenceSyncAvailable,
  loadActivePreferenceOverrides,
  markMpcPreferenceSyncDirty,
  resetMpcPreferenceSyncForTests,
  serializeCurrentPreferenceFixture,
  subscribeToMpcPreferenceSyncStatus,
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

  it('reports the server target unavailable for unsupported responses and fetch failures', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch');

    fetchSpy.mockResolvedValueOnce(
      new Response(null, { status: 500, statusText: 'Server Error' })
    );
    await expect(isServerPreferenceSyncAvailable()).resolves.toBe(false);

    fetchSpy.mockRejectedValueOnce(new Error('offline'));
    await expect(isServerPreferenceSyncAvailable()).resolves.toBe(false);
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

  it('falls back to FS access when Electron and server targets are unavailable', async () => {
    vi.spyOn(electronPreferenceSyncTargetModule, 'isElectronPreferenceSyncAvailable').mockReturnValue(false);
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(null, { status: 503, statusText: 'Unavailable' })
    );
    vi.spyOn(fsAccessPreferenceTargetModule, 'isFsAccessPreferenceSyncAvailable').mockReturnValue(true);

    await expect(getActivePreferenceSyncTarget()).resolves.toBe(
      fsAccessPreferenceTargetModule.fsAccessPreferenceTarget
    );
  });

  it('publishes unavailable status to subscribers and stops after unsubscribe', async () => {
    vi.spyOn(electronPreferenceSyncTargetModule, 'isElectronPreferenceSyncAvailable').mockReturnValue(false);
    vi.spyOn(global, 'fetch').mockRejectedValue(new Error('offline'));
    vi.spyOn(fsAccessPreferenceTargetModule, 'isFsAccessPreferenceSyncAvailable').mockReturnValue(false);
    const listener = vi.fn();

    const unsubscribe = subscribeToMpcPreferenceSyncStatus(listener);

    expect(listener).toHaveBeenCalledWith({
      targetLabel: 'Loading…',
      saveStateLabel: 'Idle',
    });
    await expect(getActivePreferenceSyncTarget()).resolves.toBeNull();
    expect(listener).toHaveBeenLastCalledWith({
      targetLabel: 'Unavailable',
      saveStateLabel: 'Unavailable',
    });

    const callsBeforeUnsubscribe = listener.mock.calls.length;
    unsubscribe();
    markMpcPreferenceSyncDirty();

    expect(listener).toHaveBeenCalledTimes(callsBeforeUnsubscribe);
    expect(getMpcPreferenceSyncStatus()).toEqual({
      targetLabel: 'Unavailable',
      saveStateLabel: 'Saving…',
    });
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

  it('loads Electron overrides before checking server or FS targets', async () => {
    vi.spyOn(electronPreferenceSyncTargetModule, 'isElectronPreferenceSyncAvailable').mockReturnValue(true);
    const fixture = { version: 1, exportedAt: '2026-04-18T12:00:00.000Z', cases: [] };
    const loadSpy = vi
      .spyOn(electronPreferenceSyncTargetModule.electronPreferenceSyncTarget, 'load')
      .mockResolvedValue(fixture);
    const fetchSpy = vi.spyOn(global, 'fetch');

    await expect(loadActivePreferenceOverrides()).resolves.toEqual({
      target: electronPreferenceSyncTargetModule.electronPreferenceSyncTarget,
      fixture,
    });
    expect(loadSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('loads FS access overrides when browser-local storage is the only available target', async () => {
    vi.spyOn(electronPreferenceSyncTargetModule, 'isElectronPreferenceSyncAvailable').mockReturnValue(false);
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(null, { status: 503, statusText: 'Unavailable' })
    );
    vi.spyOn(fsAccessPreferenceTargetModule, 'isFsAccessPreferenceSyncAvailable').mockReturnValue(true);
    const fixture = { version: 1, exportedAt: '2026-04-18T12:00:00.000Z', cases: [] };
    vi.spyOn(fsAccessPreferenceTargetModule.fsAccessPreferenceTarget, 'load').mockResolvedValue(fixture);

    await expect(loadActivePreferenceOverrides()).resolves.toEqual({
      target: fsAccessPreferenceTargetModule.fsAccessPreferenceTarget,
      fixture,
    });
  });

  it('returns an empty override result when no sync target is available', async () => {
    vi.spyOn(electronPreferenceSyncTargetModule, 'isElectronPreferenceSyncAvailable').mockReturnValue(false);
    vi.spyOn(global, 'fetch').mockRejectedValue(new Error('offline'));
    vi.spyOn(fsAccessPreferenceTargetModule, 'isFsAccessPreferenceSyncAvailable').mockReturnValue(false);

    await expect(loadActivePreferenceOverrides()).resolves.toEqual({
      target: null,
      fixture: null,
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

  it('clears a pending debounce timer before an immediate flush', async () => {
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
    await flushMpcPreferenceSync();
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

  it('reports unavailable when an immediate flush has no target', async () => {
    vi.spyOn(electronPreferenceSyncTargetModule, 'isElectronPreferenceSyncAvailable').mockReturnValue(false);
    vi.spyOn(global, 'fetch').mockRejectedValue(new Error('offline'));
    vi.spyOn(fsAccessPreferenceTargetModule, 'isFsAccessPreferenceSyncAvailable').mockReturnValue(false);

    await flushMpcPreferenceSync();

    expect(getMpcPreferenceSyncStatus()).toEqual({
      targetLabel: 'Unavailable',
      saveStateLabel: 'Unavailable',
    });
  });

  it('publishes Error save failures and rethrows them', async () => {
    vi.spyOn(electronPreferenceSyncTargetModule, 'isElectronPreferenceSyncAvailable').mockReturnValue(false);
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(null, { status: 404, statusText: 'Not Found' })
    );
    vi.spyOn(serverPreferenceSyncTargetModule.serverPreferenceSyncTarget, 'write')
      .mockRejectedValue(new Error('disk full'));
    vi.spyOn(mpcCalibrationStorageModule, 'listDefaultMpcCalibrationCases').mockResolvedValue([]);

    await expect(flushMpcPreferenceSync()).rejects.toThrow('disk full');
    expect(getMpcPreferenceSyncStatus().saveStateLabel).toBe('Save failed: disk full');
  });

  it('publishes generic save failures for non-Error rejections', async () => {
    vi.spyOn(electronPreferenceSyncTargetModule, 'isElectronPreferenceSyncAvailable').mockReturnValue(false);
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(null, { status: 404, statusText: 'Not Found' })
    );
    vi.spyOn(serverPreferenceSyncTargetModule.serverPreferenceSyncTarget, 'write')
      .mockRejectedValue('permission denied');
    vi.spyOn(mpcCalibrationStorageModule, 'listDefaultMpcCalibrationCases').mockResolvedValue([]);

    await expect(flushMpcPreferenceSync()).rejects.toBe('permission denied');
    expect(getMpcPreferenceSyncStatus().saveStateLabel).toBe('Save failed');
  });

  it('resets pending timers, status, and listeners for test isolation', async () => {
    vi.useFakeTimers();
    const listener = vi.fn();

    subscribeToMpcPreferenceSyncStatus(listener);
    markMpcPreferenceSyncDirty();
    resetMpcPreferenceSyncForTests();
    await vi.advanceTimersByTimeAsync(2000);

    expect(listener).toHaveBeenCalledTimes(2);
    expect(getMpcPreferenceSyncStatus()).toEqual({
      targetLabel: 'Loading…',
      saveStateLabel: 'Idle',
    });
  });
});
