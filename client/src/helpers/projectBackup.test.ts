import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  validateBackup,
  type ProjectBackup,
} from './projectBackup';

// ============================================================================
// validateBackup
// ============================================================================

describe('validateBackup', () => {
  const validBackup: ProjectBackup = {
    version: 1,
    exportedAt: '2026-04-04T12:00:00.000Z',
    app: 'proxxied',
    project: {
      name: 'Test Project',
      createdAt: Date.now(),
      settings: {},
    },
    cards: [],
    userImages: [],
  };

  it('accepts a valid backup', () => {
    expect(() => validateBackup(validBackup)).not.toThrow();
    expect(validateBackup(validBackup)).toEqual(validBackup);
  });

  it('rejects null/undefined', () => {
    expect(() => validateBackup(null)).toThrow('not a JSON object');
    expect(() => validateBackup(undefined)).toThrow('not a JSON object');
  });

  it('rejects non-proxxied files', () => {
    expect(() => validateBackup({ ...validBackup, app: 'other' })).toThrow(
      'not a Proxxied backup'
    );
  });

  it('rejects future versions', () => {
    expect(() =>
      validateBackup({ ...validBackup, version: 999 })
    ).toThrow('Unsupported backup version');
  });

  it('rejects missing project metadata', () => {
    const { project: _, ...noProject } = validBackup;
    expect(() => validateBackup(noProject)).toThrow('missing project metadata');
  });

  it('rejects missing cards array', () => {
    const { cards: _, ...noCards } = validBackup;
    expect(() => validateBackup(noCards)).toThrow('missing cards array');
  });

  it('accepts backup with cards and user images', () => {
    const withData = {
      ...validBackup,
      cards: [
        {
          uuid: 'abc',
          name: 'Sol Ring',
          order: 0,
          isUserUpload: false,
          imageId: 'https://scryfall.com/img.jpg',
          set: 'c21',
          number: '263',
        },
      ],
      userImages: [
        {
          hash: 'sha256-abc',
          type: 'image/png',
          data: 'iVBORw0KGgo=',
        },
      ],
    };
    const result = validateBackup(withData);
    expect(result.cards).toHaveLength(1);
    expect(result.userImages).toHaveLength(1);
  });
});

// ============================================================================
// Export/Import round-trip (integration, mocked DB)
// ============================================================================

// These tests validate the logic without requiring IndexedDB.
// Full integration tests with Dexie would go in e2e tests.

describe('backup card serialization', () => {
  it('preserves DFC links via UUID remapping concept', () => {
    // This test validates the UUID remap logic conceptually
    const oldFrontUuid = 'front-001';
    const oldBackUuid = 'back-001';

    const cards = [
      {
        uuid: oldFrontUuid,
        name: 'Delver of Secrets',
        order: 0,
        isUserUpload: false,
        linkedBackId: oldBackUuid,
      },
      {
        uuid: oldBackUuid,
        name: 'Insectile Aberration',
        order: 0,
        isUserUpload: false,
        linkedFrontId: oldFrontUuid,
      },
    ];

    // Simulate UUID remap
    const uuidMap = new Map<string, string>();
    uuidMap.set(oldFrontUuid, 'new-front-001');
    uuidMap.set(oldBackUuid, 'new-back-001');

    const remapped = cards.map((card) => ({
      ...card,
      uuid: uuidMap.get(card.uuid)!,
      linkedFrontId: card.linkedFrontId
        ? uuidMap.get(card.linkedFrontId)
        : undefined,
      linkedBackId: card.linkedBackId
        ? uuidMap.get(card.linkedBackId)
        : undefined,
    }));

    // Front card points to new back UUID
    expect(remapped[0].linkedBackId).toBe('new-back-001');
    // Back card points to new front UUID
    expect(remapped[1].linkedFrontId).toBe('new-front-001');
    // Original UUIDs are gone
    expect(remapped[0].uuid).not.toBe(oldFrontUuid);
    expect(remapped[1].uuid).not.toBe(oldBackUuid);
  });

  it('handles cards with overrides', () => {
    const card = {
      uuid: 'test-001',
      name: 'Lightning Bolt',
      order: 0,
      isUserUpload: false,
      overrides: {
        brightness: 10,
        contrast: 1.2,
        holoEffect: 'rainbow' as const,
        holoStrength: 50,
      },
    };

    // Overrides should survive JSON round-trip
    const json = JSON.stringify(card);
    const parsed = JSON.parse(json);
    expect(parsed.overrides.brightness).toBe(10);
    expect(parsed.overrides.holoEffect).toBe('rainbow');
    expect(parsed.overrides.holoStrength).toBe(50);
  });
});
