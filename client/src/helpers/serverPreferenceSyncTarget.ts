import { privateFetch } from './privateTransport';
import type { MpcPreferenceFixture, PreferenceSyncTarget } from '@/types';

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateLoadedFixture(data: unknown): MpcPreferenceFixture {
  if (!isRecord(data)) {
    throw new Error('Invalid preference fixture response');
  }

  if (
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

export const serverPreferenceSyncTarget: PreferenceSyncTarget = {
  async load(): Promise<MpcPreferenceFixture | null> {
    const response = await privateFetch('/api/preferences');

    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      throw new Error(
        `Failed to load preferences: ${response.status} ${response.statusText}`
      );
    }

    return validateLoadedFixture(await response.json());
  },

  async write(fixture: MpcPreferenceFixture): Promise<void> {
    const response = await privateFetch('/api/preferences', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(fixture),
    });

    if (!response.ok) {
      throw new Error(
        `Failed to save preferences: ${response.status} ${response.statusText}`
      );
    }
  },

  describe(): string {
    return 'Server';
  },
};
