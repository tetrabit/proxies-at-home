import { describe, expect, it } from 'vitest';
import type { ProjectBackup } from './projectBackup';
import { backupContentDigest } from './backupContentDigest';

function makeBackup(): ProjectBackup {
  return {
    version: 1,
    exportedAt: '2026-09-08T00:00:00.000Z',
    app: 'proxxied',
    project: {
      name: 'Digest project',
      createdAt: 1,
      settings: {
        paperSize: 'letter',
        bleed: 'on',
      },
    },
    cards: [
      {
        uuid: 'front-1',
        name: 'Front card',
        order: 0,
        isUserUpload: false,
        linkedBackId: 'back-1',
      },
      {
        uuid: 'back-1',
        name: 'Back card',
        order: 1,
        isUserUpload: true,
        imageId: 'custom-art-1',
        linkedFrontId: 'front-1',
      },
    ],
    userImages: [
      {
        hash: 'custom-art-1',
        type: 'image/png',
        data: 'artwork-one',
      },
    ],
  };
}

describe('backupContentDigest', () => {
  it('is stable for unchanged exported content even when the export timestamp differs', () => {
    const backup = makeBackup();
    const laterExport = { ...backup, exportedAt: '2026-09-08T00:00:30.000Z' };

    expect(backupContentDigest(laterExport)).toBe(backupContentDigest(backup));
  });

  it('changes when card display order changes', () => {
    const backup = makeBackup();
    const reordered = {
      ...backup,
      cards: [
        { ...backup.cards[0], order: 1 },
        { ...backup.cards[1], order: 0 },
      ],
    };

    expect(backupContentDigest(reordered)).not.toBe(backupContentDigest(backup));
  });

  it('changes when a card override changes', () => {
    const backup = makeBackup();
    const withOverride = {
      ...backup,
      cards: [
        { ...backup.cards[0], overrides: { brightness: 12 } },
        backup.cards[1],
      ],
    };

    expect(backupContentDigest(withOverride)).not.toBe(backupContentDigest(backup));
  });

  it('changes when linked-face metadata changes', () => {
    const backup = makeBackup();
    const unlinked = {
      ...backup,
      cards: [
        { ...backup.cards[0], linkedBackId: undefined },
        { ...backup.cards[1], linkedFrontId: undefined },
      ],
    };

    expect(backupContentDigest(unlinked)).not.toBe(backupContentDigest(backup));
  });

  it('changes when custom artwork content changes', () => {
    const backup = makeBackup();
    const changedArtwork = {
      ...backup,
      userImages: [{ ...backup.userImages[0], data: 'artwork-two' }],
    };

    expect(backupContentDigest(changedArtwork)).not.toBe(backupContentDigest(backup));
  });

  it('changes when settings differ at equal serialized length', () => {
    const backup = makeBackup();
    const equalLengthSettings = {
      ...backup,
      project: {
        ...backup.project,
        settings: {
          paperSize: 'a4____',
          bleed: 'on',
        },
      },
    };

    expect(JSON.stringify(equalLengthSettings.project.settings)).toHaveLength(
      JSON.stringify(backup.project.settings).length
    );
    expect(backupContentDigest(equalLengthSettings)).not.toBe(backupContentDigest(backup));
  });
});
