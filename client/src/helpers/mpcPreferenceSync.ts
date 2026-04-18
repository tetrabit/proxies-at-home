import { apiUrl } from '@/constants';
import type {
  MpcPreferenceCase,
  MpcPreferenceFixture,
  PreferenceSyncTarget,
} from '@/types';
import {
  electronPreferenceSyncTarget,
  isElectronPreferenceSyncAvailable,
} from './electronPreferenceSyncTarget';
import {
  fsAccessPreferenceTarget,
  isFsAccessPreferenceSyncAvailable,
} from './fsAccessPreferenceTarget';
import {
  listDefaultMpcCalibrationCases,
} from './mpcCalibrationStorage';
import { serverPreferenceSyncTarget } from './serverPreferenceSyncTarget';

const PREFERENCES_API_URL = apiUrl('/api/preferences');
const DEBOUNCE_MS = 2000;

let pendingTimer: ReturnType<typeof setTimeout> | null = null;
let pendingFlush = Promise.resolve();

export interface MpcPreferenceSyncStatus {
  targetLabel: string;
  saveStateLabel: string;
}

let currentStatus: MpcPreferenceSyncStatus = {
  targetLabel: 'Loading…',
  saveStateLabel: 'Idle',
};

const statusListeners = new Set<(status: MpcPreferenceSyncStatus) => void>();

function publishStatus(partial: Partial<MpcPreferenceSyncStatus>): void {
  currentStatus = { ...currentStatus, ...partial };
  for (const listener of statusListeners) {
    listener(currentStatus);
  }
}

export function getMpcPreferenceSyncStatus(): MpcPreferenceSyncStatus {
  return currentStatus;
}

export function subscribeToMpcPreferenceSyncStatus(
  listener: (status: MpcPreferenceSyncStatus) => void
): () => void {
  statusListeners.add(listener);
  listener(currentStatus);
  return () => statusListeners.delete(listener);
}

function toPreferenceCase(
  calibrationCase: Awaited<ReturnType<typeof listDefaultMpcCalibrationCases>>[number]
): MpcPreferenceCase {
  return {
    source: calibrationCase.source,
    candidates: calibrationCase.candidates,
    expectedIdentifier: calibrationCase.expectedIdentifier,
    notes: calibrationCase.notes,
    comparisonHints: calibrationCase.comparisonHints,
  };
}

export async function serializeCurrentPreferenceFixture(): Promise<MpcPreferenceFixture> {
  const cases = await listDefaultMpcCalibrationCases();
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    cases: cases.map(toPreferenceCase),
  };
}

export async function isServerPreferenceSyncAvailable(): Promise<boolean> {
  try {
    const response = await fetch(PREFERENCES_API_URL, { method: 'GET' });
    return response.ok || response.status === 404;
  } catch {
    return false;
  }
}

export async function getActivePreferenceSyncTarget(): Promise<PreferenceSyncTarget | null> {
  if (isElectronPreferenceSyncAvailable()) {
    publishStatus({ targetLabel: electronPreferenceSyncTarget.describe() });
    return electronPreferenceSyncTarget;
  }

  if (await isServerPreferenceSyncAvailable()) {
    publishStatus({ targetLabel: serverPreferenceSyncTarget.describe() });
    return serverPreferenceSyncTarget;
  }

  if (isFsAccessPreferenceSyncAvailable()) {
    publishStatus({ targetLabel: fsAccessPreferenceTarget.describe() });
    return fsAccessPreferenceTarget;
  }

  publishStatus({ targetLabel: 'Unavailable', saveStateLabel: 'Unavailable' });
  return null;
}

export async function loadActivePreferenceOverrides(): Promise<{
  target: PreferenceSyncTarget | null;
  fixture: MpcPreferenceFixture | null;
}> {
  if (isElectronPreferenceSyncAvailable()) {
    return {
      target: electronPreferenceSyncTarget,
      fixture: await electronPreferenceSyncTarget.load(),
    };
  }

  if (await isServerPreferenceSyncAvailable()) {
    return {
      target: serverPreferenceSyncTarget,
      fixture: await serverPreferenceSyncTarget.load(),
    };
  }

  if (isFsAccessPreferenceSyncAvailable()) {
    return {
      target: fsAccessPreferenceTarget,
      fixture: await fsAccessPreferenceTarget.load(),
    };
  }

  return { target: null, fixture: null };
}

export async function flushMpcPreferenceSync(): Promise<void> {
  if (pendingTimer) {
    clearTimeout(pendingTimer);
    pendingTimer = null;
  }

  publishStatus({ saveStateLabel: 'Saving…' });

  pendingFlush = pendingFlush.then(async () => {
    const target = await getActivePreferenceSyncTarget();
    if (!target) {
      publishStatus({ saveStateLabel: 'Unavailable' });
      return;
    }

    try {
      await target.write(await serializeCurrentPreferenceFixture());
      publishStatus({ saveStateLabel: 'Saved just now' });
    } catch (error) {
      publishStatus({
        saveStateLabel:
          error instanceof Error ? `Save failed: ${error.message}` : 'Save failed',
      });
      throw error;
    }
  });

  await pendingFlush;
}

export function markMpcPreferenceSyncDirty(): void {
  publishStatus({ saveStateLabel: 'Saving…' });

  if (pendingTimer) {
    clearTimeout(pendingTimer);
  }

  pendingTimer = setTimeout(() => {
    pendingTimer = null;
    void flushMpcPreferenceSync();
  }, DEBOUNCE_MS);
}

export function resetMpcPreferenceSyncForTests(): void {
  if (pendingTimer) {
    clearTimeout(pendingTimer);
    pendingTimer = null;
  }

  pendingFlush = Promise.resolve();
  currentStatus = {
    targetLabel: 'Loading…',
    saveStateLabel: 'Idle',
  };
  statusListeners.clear();
}
