import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElectronApi } from './preload-api';

describe('preload', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('exposes MPC preference IPC helpers on electronAPI', async () => {
    const invoke = vi.fn();
    const on = vi.fn();
    const exposedApi = createElectronApi({ invoke, on }) as {
      loadMpcPreferences: () => Promise<unknown>;
      saveMpcPreferences: (fixture: unknown) => Promise<unknown>;
    };
    const fixture = { version: 1, exportedAt: '2026-04-18T12:00:00.000Z', cases: [] };

    await exposedApi.loadMpcPreferences();
    await exposedApi.saveMpcPreferences(fixture);

    expect(invoke).toHaveBeenNthCalledWith(1, 'mpc-preferences:load');
    expect(invoke).toHaveBeenNthCalledWith(2, 'mpc-preferences:save', fixture);
  });
});
