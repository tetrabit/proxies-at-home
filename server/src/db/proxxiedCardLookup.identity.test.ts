import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let tempDir: string;

async function loadDbModules() {
  vi.resetModules();
  process.env.SERVER_DATA_DIR = tempDir;
  const dbModule = await import('./db.js');
  const lookupModule = await import('./proxxiedCardLookup.js');
  dbModule.initDatabase();
  return { dbModule, lookupModule };
}

describe('rowToScryfallCard identity projection', () => {
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proxxied-card-identity-'));
  });

  afterEach(async () => {
    const { closeDatabase } = await import('./db.js').catch(() => ({ closeDatabase: () => undefined }));
    closeDatabase();
    delete process.env.SERVER_DATA_DIR;
    vi.resetModules();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('preserves identity and existing payload fields when converting a SQLite row', async () => {
    const { dbModule, lookupModule } = await loadDbModules();
    const expected = {
      id: 'a1b2c3d4-e5f6-4789-8123-456789abcdef',
      oracle_id: 'f0e1d2c3-b4a5-4678-9012-3456789abcde',
      name: 'Identity Adept',
      set: 'tst',
      collector_number: '42',
      lang: 'en',
      colors: ['U', 'R'],
      mana_cost: '{1}{U}{R}',
      cmc: 3,
      type_line: 'Creature — Human Wizard',
      rarity: 'rare',
      layout: 'normal',
      image_uris: {
        png: 'https://example.test/identity.png',
        large: 'https://example.test/identity-large.jpg',
        normal: 'https://example.test/identity-normal.jpg',
      },
      card_faces: [
        {
          name: 'Identity Adept',
          colors: ['U', 'R'],
          mana_cost: '{1}{U}{R}',
          type_line: 'Creature — Human Wizard',
        },
      ],
      all_parts: [
        {
          id: '12345678-90ab-4cde-8f01-23456789abcd',
          component: 'token',
          name: 'Adept Token',
          type_line: 'Token Creature — Wizard',
          uri: 'https://api.scryfall.com/cards/12345678-90ab-4cde-8f01-23456789abcd',
        },
      ],
    };

    dbModule.getDatabase().prepare(`
      INSERT INTO cards (
        id, oracle_id, name, set_code, collector_number, lang,
        colors, mana_cost, cmc, type_line, rarity, layout,
        image_uris, card_faces, all_parts
      ) VALUES (
        @id, @oracle_id, @name, @set, @collector_number, @lang,
        @colors, @mana_cost, @cmc, @type_line, @rarity, @layout,
        @image_uris, @card_faces, @all_parts
      )
    `).run({
      ...expected,
      colors: JSON.stringify(expected.colors),
      image_uris: JSON.stringify(expected.image_uris),
      card_faces: JSON.stringify(expected.card_faces),
      all_parts: JSON.stringify(expected.all_parts),
    });

    expect(lookupModule.lookupCardBySetNumber('TST', '42', 'EN')).toEqual(expected);
  });
});
