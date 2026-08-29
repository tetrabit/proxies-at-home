import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/db';
import type { MpcPreferenceFixture } from '@/types';
import {
  fsAccessPreferenceTarget,
  isFsAccessPreferenceSyncAvailable,
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



  it('returns null when the stored pointer does not reference a string id', async () => {
    await db.settings.put({
      id: 'proxxied:mpc-preferences:fs-handle:v1',
      value: { id: 42 },
    });

    await expect(fsAccessPreferenceTarget.load()).resolves.toBeNull();
  });

  it('returns null when the stored handle record is missing', async () => {
    await db.settings.put({
      id: 'proxxied:mpc-preferences:fs-handle:v1',
      value: { id: 'mpc-preferences-user-file' },
    });

    await expect(fsAccessPreferenceTarget.load()).resolves.toBeNull();
  });

  it('treats handles without permission methods as granted', async () => {
    const handle = {
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

  it('rejects invalid loaded fixture JSON', async () => {
    const handle = {
      queryPermission: vi.fn().mockResolvedValue('granted'),
      getFile: vi.fn().mockResolvedValue({
        text: async () => JSON.stringify({ version: 'bad', exportedAt: 1, cases: {} }),
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

    await expect(fsAccessPreferenceTarget.load()).rejects.toThrow(
      'Invalid preference fixture response'
    );
  });

  it('clears persisted handles when read permission is denied', async () => {
    const handle = {
      queryPermission: vi.fn().mockResolvedValue('denied'),
      getFile: vi.fn(),
      createWritable: vi.fn(),
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

    await expect(fsAccessPreferenceTarget.load()).resolves.toBeNull();

    expect(deleteSpy).toHaveBeenCalledWith('mpc-preferences-user-file');
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





  it('downloads when a picked prompt-state handle cannot request write permission', async () => {
    const createObjectURL = vi
      .spyOn(URL, 'createObjectURL')
      .mockReturnValue('blob:preferences');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const anchor = document.createElement('a');
    vi.spyOn(anchor, 'click').mockImplementation(vi.fn());
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
      queryPermission: vi.fn().mockResolvedValue('prompt'),
      createWritable: vi.fn(),
      getFile: vi.fn(),
    };
    const showSaveFilePicker = vi.fn().mockResolvedValue(handle);
    (window as Window & { showSaveFilePicker?: typeof showSaveFilePicker }).showSaveFilePicker =
      showSaveFilePicker;

    await expect(fsAccessPreferenceTarget.write(fixture)).resolves.toBeUndefined();

    expect(createObjectURL).toHaveBeenCalled();
    expect(handle.createWritable).not.toHaveBeenCalled();
  });

  it('downloads instead of persisting when a picked handle denies write permission', async () => {
    const createObjectURL = vi
      .spyOn(URL, 'createObjectURL')
      .mockReturnValue('blob:preferences');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const anchor = document.createElement('a');
    vi.spyOn(anchor, 'click').mockImplementation(vi.fn());
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
      queryPermission: vi.fn().mockResolvedValue('prompt'),
      requestPermission: vi.fn().mockResolvedValue('denied'),
      createWritable: vi.fn(),
      getFile: vi.fn(),
    };
    const showSaveFilePicker = vi.fn().mockResolvedValue(handle);
    (window as Window & { showSaveFilePicker?: typeof showSaveFilePicker }).showSaveFilePicker =
      showSaveFilePicker;

    await expect(fsAccessPreferenceTarget.write(fixture)).resolves.toBeUndefined();

    expect(createObjectURL).toHaveBeenCalled();
    expect(handle.createWritable).not.toHaveBeenCalled();
  });

  it('downloads instead of throwing when the stored handle hits a permission write error', async () => {
    const createObjectURL = vi
      .spyOn(URL, 'createObjectURL')
      .mockReturnValue('blob:preferences');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const anchor = document.createElement('a');
    vi.spyOn(anchor, 'click').mockImplementation(vi.fn());
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
      queryPermission: vi.fn().mockResolvedValue('granted'),
      createWritable: vi.fn().mockRejectedValue(new DOMException('nope', 'SecurityError')),
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

  it('propagates non-permission write failures from a stored handle', async () => {
    const handle = {
      queryPermission: vi.fn().mockResolvedValue('granted'),
      createWritable: vi.fn().mockRejectedValue(new Error('disk failed')),
      getFile: vi.fn(),
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

    await expect(fsAccessPreferenceTarget.write(fixture)).rejects.toThrow('disk failed');
  });



  it('revokes fallback download URLs after the timeout', async () => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:preferences');
    const revokeObjectURL = vi
      .spyOn(URL, 'revokeObjectURL')
      .mockImplementation(() => undefined);
    vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback: TimerHandler) => {
      (callback as () => void)();
      return 1 as unknown as ReturnType<typeof setTimeout>;
    });
    const anchor = document.createElement('a');
    vi.spyOn(anchor, 'click').mockImplementation(vi.fn());
    const originalCreateElement = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation(((tagName: string) => {
      if (tagName === 'a') {
        return anchor;
      }

      return originalCreateElement(tagName);
    }) as typeof document.createElement);
    vi.spyOn(document.body, 'appendChild');
    vi.spyOn(document.body, 'removeChild');

    await expect(fsAccessPreferenceTarget.write(fixture)).resolves.toBeUndefined();

    expect(revokeObjectURL).toHaveBeenCalledWith('blob:preferences');
  });

  it('skips fallback downloads when the document body is unavailable', async () => {
    const createObjectURL = vi
      .spyOn(URL, 'createObjectURL')
      .mockReturnValue('blob:preferences');
    const revokeObjectURL = vi
      .spyOn(URL, 'revokeObjectURL')
      .mockImplementation(() => undefined);
    const bodyDescriptor = Object.getOwnPropertyDescriptor(Document.prototype, 'body');
    Object.defineProperty(document, 'body', {
      configurable: true,
      value: null,
    });

    try {
      await expect(fsAccessPreferenceTarget.write(fixture)).resolves.toBeUndefined();
      expect(createObjectURL).toHaveBeenCalled();
      expect(revokeObjectURL).toHaveBeenCalledWith('blob:preferences');
    } finally {
      if (bodyDescriptor) {
        Object.defineProperty(Document.prototype, 'body', bodyDescriptor);
      } else {
        delete (document as Document & { body?: HTMLElement | null }).body;
      }
    }
  });

  it('reports availability when a window object exists', () => {
    expect(isFsAccessPreferenceSyncAvailable()).toBe(true);
  });

  it('describes the local file target', () => {
    expect(fsAccessPreferenceTarget.describe()).toBe('Local file');
  });
});
