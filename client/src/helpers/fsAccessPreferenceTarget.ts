import { db } from '@/db';
import type { MpcPreferenceFixture, PreferenceSyncTarget } from '@/types';
import { indexedDbStorage } from '@/store/indexedDbStorage';
import { writeMpcCalibrationFixtureToHandle } from './mpcCalibrationImport';

const FS_ACCESS_POINTER_KEY = 'proxxied:mpc-preferences:fs-handle:v1';
const FS_ACCESS_HANDLE_RECORD_ID = 'mpc-preferences-user-file';
const PREFERENCE_FILENAME = 'mpc-preferences.user.json';

type PermissionStateLike = 'granted' | 'prompt' | 'denied';

interface FsAccessPermissionOptions {
  mode: 'read' | 'readwrite';
}

interface FsAccessFileLike {
  text(): Promise<string>;
}

interface FsAccessFileHandleLike {
  getFile(): Promise<FsAccessFileLike>;
  createWritable(): Promise<{
    write(data: string): Promise<void>;
    close(): Promise<void>;
    abort?(): Promise<void>;
  }>;
  queryPermission?(options: FsAccessPermissionOptions): Promise<PermissionStateLike>;
  requestPermission?(options: FsAccessPermissionOptions): Promise<PermissionStateLike>;
}

type SaveFilePickerWindow = Window & {
  showSaveFilePicker?: (options: {
    suggestedName: string;
    types: Array<{
      description: string;
      accept: Record<string, string[]>;
    }>;
  }) => Promise<FsAccessFileHandleLike>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateLoadedFixture(data: unknown): MpcPreferenceFixture {
  if (
    !isRecord(data) ||
    typeof data.version !== 'number' ||
    typeof data.exportedAt !== 'string' ||
    !Array.isArray(data.cases)
  ) {
    throw new Error('Invalid preference fixture response');
  }

  return {
    version: data.version,
    exportedAt: data.exportedAt,
    cases: data.cases,
  };
}

async function loadHandlePointer(): Promise<string | null> {
  const stored = await indexedDbStorage.getItem(FS_ACCESS_POINTER_KEY);
  if (!stored) {
    return null;
  }

  const parsed = JSON.parse(stored) as { id?: unknown };
  return typeof parsed.id === 'string' ? parsed.id : null;
}

async function saveHandlePointer(id: string | null): Promise<void> {
  if (!id) {
    await indexedDbStorage.removeItem(FS_ACCESS_POINTER_KEY);
    return;
  }

  await indexedDbStorage.setItem(FS_ACCESS_POINTER_KEY, JSON.stringify({ id }));
}

async function clearPersistedHandle(): Promise<void> {
  await Promise.all([
    db.fsAccessHandles.delete(FS_ACCESS_HANDLE_RECORD_ID),
    saveHandlePointer(null),
  ]);
}

async function getPersistedHandle(): Promise<FsAccessFileHandleLike | null> {
  const pointerId = await loadHandlePointer();
  if (!pointerId) {
    return null;
  }

  const stored = await db.fsAccessHandles.get(pointerId);
  return (stored?.handle as FsAccessFileHandleLike | undefined) ?? null;
}

async function persistHandle(handle: FsAccessFileHandleLike): Promise<void> {
  const now = Date.now();
  await db.fsAccessHandles.put({
    id: FS_ACCESS_HANDLE_RECORD_ID,
    handle,
    createdAt: now,
    updatedAt: now,
  });
  await saveHandlePointer(FS_ACCESS_HANDLE_RECORD_ID);
}

async function getPermissionState(
  handle: FsAccessFileHandleLike,
  mode: FsAccessPermissionOptions['mode']
): Promise<PermissionStateLike> {
  if (typeof handle.queryPermission !== 'function') {
    return 'granted';
  }

  return handle.queryPermission({ mode });
}

async function ensurePermission(
  handle: FsAccessFileHandleLike,
  mode: FsAccessPermissionOptions['mode']
): Promise<boolean> {
  const currentPermission = await getPermissionState(handle, mode);
  if (currentPermission === 'granted') {
    return true;
  }

  if (currentPermission === 'denied') {
    return false;
  }

  if (typeof handle.requestPermission !== 'function') {
    return false;
  }

  return (await handle.requestPermission({ mode })) === 'granted';
}

function requestNewHandle(): Promise<FsAccessFileHandleLike | null> {
  const pickerWindow = window as SaveFilePickerWindow;
  if (!pickerWindow.showSaveFilePicker) {
    return Promise.resolve(null);
  }

  return pickerWindow.showSaveFilePicker({
    suggestedName: PREFERENCE_FILENAME,
    types: [
      {
        description: 'JSON',
        accept: {
          'application/json': ['.json'],
        },
      },
    ],
  });
}

function isPermissionError(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    (error.name === 'NotAllowedError' || error.name === 'SecurityError')
  );
}

async function fallbackDownload(fixture: MpcPreferenceFixture): Promise<void> {
  const blob = new Blob([JSON.stringify(fixture, null, 2)], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = PREFERENCE_FILENAME;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function isFsAccessPreferenceSyncAvailable(): boolean {
  return typeof window !== 'undefined';
}

export const fsAccessPreferenceTarget: PreferenceSyncTarget = {
  async load(): Promise<MpcPreferenceFixture | null> {
    const handle = await getPersistedHandle();
    if (!handle) {
      return null;
    }

    const canRead = await ensurePermission(handle, 'read');
    if (!canRead) {
      await clearPersistedHandle();
      return null;
    }

    const file = await handle.getFile();
    return validateLoadedFixture(JSON.parse(await file.text()));
  },

  async write(fixture: MpcPreferenceFixture): Promise<void> {
    let handle = await getPersistedHandle();

    if (handle && !(await ensurePermission(handle, 'readwrite'))) {
      await clearPersistedHandle();
      handle = null;
    }

    if (!handle) {
      handle = await requestNewHandle();
      if (!handle) {
        await fallbackDownload(fixture);
        return;
      }

      if (!(await ensurePermission(handle, 'readwrite'))) {
        await fallbackDownload(fixture);
        return;
      }

      await persistHandle(handle);
    }

    try {
      await writeMpcCalibrationFixtureToHandle(
        JSON.stringify(fixture, null, 2),
        handle
      );
    } catch (error) {
      if (isPermissionError(error)) {
        await clearPersistedHandle();
        await fallbackDownload(fixture);
        return;
      }

      throw error;
    }
  },

  describe(): string {
    return 'Local file';
  },
};

export async function resetFsAccessPreferenceHandleForTests(): Promise<void> {
  await clearPersistedHandle();
}
