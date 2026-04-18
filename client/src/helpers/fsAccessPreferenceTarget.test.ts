import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/db';
import type { MpcPreferenceFixture } from '@/types';
import {
  fsAccessPreferenceTarget,
  resetFsAccessPreferenceHandleForTests,
} from './fsAccessPreferenceTarget';

const fixture: MpcPreferenceFixture = {
  version: 1,
  exportedAt: '2026-04-18T12:00:00.000Z',
  cases: [],
};

describe('fsAccessPreferenceTarget', () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    delete (window as Window & { showSaveFilePicker?: unknown }).showSaveFilePicker;
    await db.settings.clear();
    await db.fsAccessHandles.clear();
    await resetFsAccessPreferenceHandleForTests();
  });

  it('returns null when no persisted file handle exists', async () => {
    await expect(fsAccessPreferenceTarget.load()).resolves.toBeNull();
  });

  it('loads preferences from a persisted file handle', async () => {
    const handle = {
      queryPermission: vi.fn().mockResolvedValue('granted'),
      getFile: vi.fn().mockResolvedValue({
        text: async () => JSON.stringify(fixture),
      }),
      createWritable: vi.fn(),
    };

    vi.spyOn(db.fsAccessHandles, 'get').mockResolvedValue({
      id: 'mpc-preferences-user-file',
      handle,
      createdAt: 1,
      updatedAt: 1,
    });
    await db.settings.put({
      id: 'proxxied:mpc-preferences:fs-handle:v1',
      value: { id: 'mpc-preferences-user-file' },
    });

    await expect(fsAccessPreferenceTarget.load()).resolves.toEqual(fixture);
  });

  it('falls back to a picker and persists the granted handle', async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const close = vi.fn().mockResolvedValue(undefined);
    const handle = {
      queryPermission: vi.fn().mockResolvedValue('prompt'),
      requestPermission: vi.fn().mockResolvedValue('granted'),
      createWritable: vi.fn().mockResolvedValue({ write, close }),
      getFile: vi.fn(),
    };
    const showSaveFilePicker = vi.fn().mockResolvedValue(handle);
    const persistSpy = vi.spyOn(db.fsAccessHandles, 'put').mockResolvedValue('mpc-preferences-user-file');
    (window as Window & { showSaveFilePicker?: typeof showSaveFilePicker }).showSaveFilePicker =
      showSaveFilePicker;

    await expect(fsAccessPreferenceTarget.write(fixture)).resolves.toBeUndefined();

    expect(showSaveFilePicker).toHaveBeenCalled();
    expect(write).toHaveBeenCalledWith(JSON.stringify(fixture, null, 2));
    expect(persistSpy).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'mpc-preferences-user-file', handle })
    );
  });

  it('falls back to a blob download when the picker is unavailable', async () => {
    const createObjectURL = vi
      .spyOn(URL, 'createObjectURL')
      .mockReturnValue('blob:preferences');
    const revokeObjectURL = vi
      .spyOn(URL, 'revokeObjectURL')
      .mockImplementation(() => undefined);
    const click = vi.fn();
    const appendChild = vi.spyOn(document.body, 'appendChild');
    const removeChild = vi.spyOn(document.body, 'removeChild');
    const anchor = document.createElement('a');
    vi.spyOn(anchor, 'click').mockImplementation(click);
    const originalCreateElement = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation(((tagName: string) => {
      if (tagName === 'a') {
        return anchor;
      }

      return originalCreateElement(tagName);
    }) as typeof document.createElement);

    await expect(fsAccessPreferenceTarget.write(fixture)).resolves.toBeUndefined();

    expect(createObjectURL).toHaveBeenCalled();
    expect(click).toHaveBeenCalled();
    expect(appendChild).toHaveBeenCalledWith(anchor);
    expect(removeChild).toHaveBeenCalledWith(anchor);
    revokeObjectURL.mockRestore();
  });

  it('clears the stored handle and downloads when permissions are revoked', async () => {
    const createObjectURL = vi
      .spyOn(URL, 'createObjectURL')
      .mockReturnValue('blob:preferences');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const click = vi.fn();
    const anchor = document.createElement('a');
    vi.spyOn(anchor, 'click').mockImplementation(click);
    const originalCreateElement = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation(((tagName: string) => {
      if (tagName === 'a') {
        return anchor;
      }

      return originalCreateElement(tagName);
    }) as typeof document.createElement);
    vi.spyOn(document.body, 'appendChild');
    vi.spyOn(document.body, 'removeChild');

    const handle = {
      queryPermission: vi.fn().mockResolvedValue('denied'),
      createWritable: vi.fn(),
      getFile: vi.fn(),
    };

    vi.spyOn(db.fsAccessHandles, 'get').mockResolvedValue({
      id: 'mpc-preferences-user-file',
      handle,
      createdAt: 1,
      updatedAt: 1,
    });
    const deleteSpy = vi.spyOn(db.fsAccessHandles, 'delete').mockResolvedValue(undefined);
    await db.settings.put({
      id: 'proxxied:mpc-preferences:fs-handle:v1',
      value: { id: 'mpc-preferences-user-file' },
    });

    await expect(fsAccessPreferenceTarget.write(fixture)).resolves.toBeUndefined();

    expect(deleteSpy).toHaveBeenCalledWith('mpc-preferences-user-file');
    expect(createObjectURL).toHaveBeenCalled();
  });

  it('describes the local file target', () => {
    expect(fsAccessPreferenceTarget.describe()).toBe('Local file');
  });
});
