import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gzipSync } from 'node:zlib';

const fixtureRoot = path.join(
  fileURLToPath(new URL('../../../', import.meta.url)),
  '.review-artifacts',
  'backup-owner-integration-rework-01',
);
const legacyOwnerId = 'legacy-unassigned';

type DbModule = typeof import('./db.js');

function createExclusiveArtifactDirectory(): string {
  fs.mkdirSync(fixtureRoot, { recursive: true });
  while (true) {
    const artifactDirectory = path.join(fixtureRoot, randomUUID());
    try {
      fs.mkdirSync(artifactDirectory);
      return artifactDirectory;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
    }
  }
}

function createV6Database(directory: string, extraSql = ''): Database.Database {
  const legacyDatabase = new Database(path.join(directory, 'proxxied-cards.db'));
  legacyDatabase.exec(`
    CREATE TABLE cards (
      id TEXT PRIMARY KEY,
      oracle_id TEXT,
      name TEXT NOT NULL,
      set_code TEXT,
      collector_number TEXT,
      lang TEXT DEFAULT 'en',
      colors TEXT,
      mana_cost TEXT,
      cmc REAL,
      type_line TEXT,
      rarity TEXT,
      layout TEXT,
      image_uris TEXT,
      card_faces TEXT,
      all_parts TEXT,
      updated_at TEXT
    );
    CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE backups (
      project_id TEXT PRIMARY KEY,
      project_name TEXT NOT NULL,
      data BLOB NOT NULL,
      card_count INTEGER DEFAULT 0,
      updated_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    INSERT INTO metadata (key, value) VALUES ('schema_version', '6');
    ${extraSql}
  `);
  return legacyDatabase;
}

describe('Database layer retained SQLite assertions', () => {
  let database: Database.Database;

  beforeEach(() => {
    database = new Database(path.join(createExclusiveArtifactDirectory(), 'proxxied-cards.db'));
    database.pragma('journal_mode = WAL');
    database.exec(`
      CREATE TABLE cards (
        id TEXT PRIMARY KEY, oracle_id TEXT, name TEXT NOT NULL, set_code TEXT,
        collector_number TEXT, lang TEXT DEFAULT 'en', colors TEXT, mana_cost TEXT,
        cmc REAL, type_line TEXT, rarity TEXT, layout TEXT, image_uris TEXT,
        card_faces TEXT, updated_at TEXT
      );
      CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT);
      CREATE INDEX idx_cards_name ON cards(name COLLATE NOCASE);
      CREATE INDEX idx_cards_set_number ON cards(set_code, collector_number);
    `);
  });

  afterEach(() => database.close());

  describe('Card Insertion', () => {
    it('inserts a new card', () => {
      database.prepare('INSERT INTO cards (id, name, set_code, collector_number, lang) VALUES (?, ?, ?, ?, ?)')
        .run('test-id-1', 'Lightning Bolt', 'leb', '162', 'en');
      expect(database.prepare('SELECT name FROM cards WHERE id = ?').get('test-id-1')).toEqual({ name: 'Lightning Bolt' });
    });

    it('updates an existing card with INSERT OR REPLACE', () => {
      const insert = database.prepare('INSERT OR REPLACE INTO cards (id, name, set_code, collector_number, lang, rarity) VALUES (?, ?, ?, ?, ?, ?)');
      insert.run('test-id-1', 'Lightning Bolt', 'leb', '162', 'en', 'common');
      insert.run('test-id-1', 'Lightning Bolt', 'leb', '162', 'en', 'rare');
      expect(database.prepare('SELECT COUNT(*) AS count FROM cards').get()).toEqual({ count: 1 });
      expect(database.prepare('SELECT rarity FROM cards WHERE id = ?').get('test-id-1')).toEqual({ rarity: 'rare' });
    });
  });

  describe('Card Lookup', () => {
    beforeEach(() => {
      const insert = database.prepare('INSERT INTO cards (id, name, set_code, collector_number, lang, image_uris) VALUES (?, ?, ?, ?, ?, ?)');
      insert.run('id-1', 'Sol Ring', 'cmr', '332', 'en', '{"png":"http://example.com/sol.png"}');
      insert.run('id-2', 'Bala Ged Recovery // Bala Ged Sanctuary', 'znr', '180', 'en', null);
      insert.run('id-3', 'Sol Ring', 'c21', '289', 'en', '{"png":"http://example.com/sol-c21.png"}');
      insert.run('id-4', 'Gala Greeters', 'snc', '459', 'ru', '{"png":"http://example.com/gala-ru.png"}');
    });

    it('finds a card by set and collector number', () => {
      expect(database.prepare('SELECT name FROM cards WHERE set_code = ? AND collector_number = ?').get('cmr', '332')).toEqual({ name: 'Sol Ring' });
    });

    it('finds a card by case-insensitive name', () => {
      expect(database.prepare('SELECT set_code FROM cards WHERE name = ? COLLATE NOCASE LIMIT 1').get('sol ring')).toEqual({ set_code: 'cmr' });
    });

    it('finds a DFC by partial name with LIKE', () => {
      expect(database.prepare('SELECT name FROM cards WHERE name LIKE ? COLLATE NOCASE LIMIT 1').get('Bala Ged Recovery //%')).toEqual({ name: 'Bala Ged Recovery // Bala Ged Sanctuary' });
    });

    it('finds a card with the correct language', () => {
      expect(database.prepare('SELECT name, lang FROM cards WHERE set_code = ? AND collector_number = ? AND lang = ?').get('snc', '459', 'ru')).toEqual({ name: 'Gala Greeters', lang: 'ru' });
    });

    it('does not find a card when the language differs', () => {
      expect(database.prepare('SELECT name FROM cards WHERE set_code = ? AND collector_number = ? AND lang = ?').get('snc', '459', 'en')).toBeUndefined();
    });
  });

  describe('Batch Operations', () => {
    it('inserts multiple cards in a transaction', () => {
      const insert = database.prepare('INSERT INTO cards (id, name, set_code, collector_number, lang) VALUES (?, ?, ?, ?, ?)');
      database.transaction(() => {
        insert.run('b1', 'Card 1', 'set1', '1', 'en');
        insert.run('b2', 'Card 2', 'set1', '2', 'en');
        insert.run('b3', 'Card 3', 'set1', '3', 'en');
      })();
      expect(database.prepare('SELECT COUNT(*) AS count FROM cards').get()).toEqual({ count: 3 });
    });
  });

  describe('Metadata Table', () => {
    it('stores and retrieves metadata', () => {
      database.prepare('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)').run('last_import', '2024-01-01T00:00:00Z');
      expect(database.prepare('SELECT value FROM metadata WHERE key = ?').get('last_import')).toEqual({ value: '2024-01-01T00:00:00Z' });
    });

    it('updates existing metadata', () => {
      database.prepare('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)').run('last_import', '2024-01-01T00:00:00Z');
      database.prepare('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)').run('last_import', '2024-02-01T00:00:00Z');
      expect(database.prepare('SELECT value FROM metadata WHERE key = ?').get('last_import')).toEqual({ value: '2024-02-01T00:00:00Z' });
    });
  });

  describe('Database Size', () => {
    it('calculates database size in bytes', () => {
      const pageCount = database.pragma('page_count') as Array<{ page_count: number }>;
      const pageSize = database.pragma('page_size') as Array<{ page_size: number }>;
      expect(pageCount[0].page_count * pageSize[0].page_size).toBeGreaterThan(0);
    });
  });

  describe('PRAGMA Optimizations', () => {
    it('has WAL mode enabled', () => {
      expect(database.pragma('journal_mode')).toEqual([{ journal_mode: 'wal' }]);
    });

    it('supports synchronous NORMAL', () => {
      database.pragma('synchronous = NORMAL');
      expect(database.pragma('synchronous')).toEqual([{ synchronous: 1 }]);
    });

    it('supports temp_store MEMORY', () => {
      database.pragma('temp_store = MEMORY');
      expect(database.pragma('temp_store')).toEqual([{ temp_store: 2 }]);
    });

    it('supports mmap_size', () => {
      database.pragma('mmap_size = 268435456');
      expect(database.pragma('mmap_size')).toEqual([{ mmap_size: 268435456 }]);
    });
  });
});

describe('Database module lifecycle and migrations', () => {
  const originalServerDataDir = process.env.SERVER_DATA_DIR;
  let artifactDirectory: string;
  let dbModule: DbModule | undefined;

  async function importDbModule(): Promise<DbModule> {
    vi.resetModules();
    process.env.SERVER_DATA_DIR = artifactDirectory;
    return import('./db.js');
  }

  function createLegacyDatabase(schemaVersion: string, setupSql = ''): void {
    const legacyDatabase = new Database(path.join(artifactDirectory, 'proxxied-cards.db'));
    legacyDatabase.exec(`
      CREATE TABLE cards (
        id TEXT PRIMARY KEY,
        oracle_id TEXT,
        name TEXT NOT NULL,
        set_code TEXT,
        collector_number TEXT,
        lang TEXT DEFAULT 'en',
        colors TEXT,
        mana_cost TEXT,
        cmc REAL,
        type_line TEXT,
        rarity TEXT,
        layout TEXT,
        image_uris TEXT,
        card_faces TEXT,
        updated_at TEXT
      );
      CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT);
      INSERT INTO metadata (key, value) VALUES ('schema_version', '${schemaVersion}');
      ${setupSql}
    `);
    legacyDatabase.close();
  }

  function createV7Database(): Database.Database {
    const legacyDatabase = new Database(path.join(artifactDirectory, 'proxxied-cards.db'));
    legacyDatabase.exec(`
      CREATE TABLE cards (
        id TEXT PRIMARY KEY,
        oracle_id TEXT,
        name TEXT NOT NULL,
        set_code TEXT,
        collector_number TEXT,
        lang TEXT DEFAULT 'en',
        colors TEXT,
        mana_cost TEXT,
        cmc REAL,
        type_line TEXT,
        rarity TEXT,
        layout TEXT,
        image_uris TEXT,
        card_faces TEXT,
        all_parts TEXT,
        updated_at TEXT
      );
      CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE backups (
        owner_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        project_name TEXT NOT NULL,
        data BLOB NOT NULL,
        card_count INTEGER DEFAULT 0,
        updated_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (owner_id, project_id)
      );
      CREATE INDEX idx_backups_owner_updated_at ON backups(owner_id, updated_at DESC);
      INSERT INTO metadata (key, value) VALUES ('schema_version', '7');
    `);
    return legacyDatabase;
  }

  beforeEach(() => {
    artifactDirectory = createExclusiveArtifactDirectory();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  afterEach(() => {
    try {
      dbModule?.closeDatabase();
    } finally {
      if (originalServerDataDir === undefined) {
        delete process.env.SERVER_DATA_DIR;
      } else {
        process.env.SERVER_DATA_DIR = originalServerDataDir;
      }
      vi.resetModules();
    }
  });

  it('initializes a fresh database, returns the singleton, clears cards, and closes cleanly', async () => {
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    dbModule = await importDbModule();
    const initialized = dbModule.initDatabase();
    const schemaVersion = initialized.prepare("SELECT value FROM metadata WHERE key = 'schema_version'").get() as { value: string };
    initialized.prepare('INSERT INTO cards (id, name) VALUES (?, ?)').run('card-id', 'Sol Ring');

    expect(schemaVersion.value).toBe('8');
    expect(initialized.prepare("PRAGMA table_info('image_cache_metadata')").all().map((column: { name: string }) => column.name)).toEqual([
      'basename', 'size', 'last_access',
    ]);
    expect(initialized.prepare("PRAGMA index_list('image_cache_metadata')").all().map((index: { name: string }) => index.name)).toContain(
      'idx_image_cache_metadata_last_access',
    );
    expect(dbModule.getDatabase()).toBe(initialized);
    expect(dbModule.clearCardsCache()).toBe(1);

    dbModule.closeDatabase();
    expect(() => dbModule?.getDatabase()).toThrow('Database not initialized');
    expect(consoleLogSpy).toHaveBeenCalledWith('[DB] Database connection closed.');
  });

  it('recognizes an up-to-date existing schema without running migrations', async () => {
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    createLegacyDatabase('8', `
      CREATE TABLE image_cache_metadata (
        basename TEXT PRIMARY KEY,
        size INTEGER NOT NULL,
        last_access INTEGER NOT NULL
      );
      CREATE INDEX idx_image_cache_metadata_last_access ON image_cache_metadata(last_access ASC);
    `);
    dbModule = await importDbModule();
    const initialized = dbModule.initDatabase();

    expect(consoleLogSpy).toHaveBeenCalledWith('[DB] Schema is up to date (version 8)');
    expect(initialized.prepare("SELECT value FROM metadata WHERE key = 'schema_version'").get()).toEqual({ value: '8' });
  });

  it('warns and keeps newer database schemas untouched', async () => {
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    createLegacyDatabase('99');
    dbModule = await importDbModule();
    const initialized = dbModule.initDatabase();

    expect(consoleWarnSpy).toHaveBeenCalledWith('[DB] Warning: Database schema version 99 is newer than code version 8. This may cause issues.');
    expect(initialized.prepare("SELECT value FROM metadata WHERE key = 'schema_version'").get()).toEqual({ value: '99' });
  });

  it('runs pending migrations for older database schemas', async () => {
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    createLegacyDatabase('1');
    dbModule = await importDbModule();
    const initialized = dbModule.initDatabase();
    const schemaVersion = initialized.prepare("SELECT value FROM metadata WHERE key = 'schema_version'").get();
    const backupTable = initialized.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'backups'").get();

    expect(schemaVersion).toEqual({ value: '8' });
    expect(backupTable).toBeDefined();
    expect(consoleLogSpy).toHaveBeenCalledWith('[DB] All migrations complete. Now at version 8');
  });

  it('migrates real v7 composite-owner backup BLOBs unchanged while adding image cache metadata', async () => {
    const v7Database = createV7Database();
    const ownerABlob = Buffer.from([0, 1, 2, 255]);
    const ownerBBlob = Buffer.from([255, 2, 1, 0]);
    const insertBackup = v7Database.prepare(
      'INSERT INTO backups (owner_id, project_id, project_name, data, card_count, updated_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    insertBackup.run('owner-a', 'shared-project', 'Owner A', ownerABlob, 3, 1700000000001, 1600000000001);
    insertBackup.run('owner-b', 'shared-project', 'Owner B', ownerBBlob, 4, 1700000000002, 1600000000002);
    const beforeUpgrade = v7Database.prepare(
      'SELECT owner_id, project_id, project_name, data, card_count, updated_at, created_at FROM backups ORDER BY owner_id',
    ).all();
    v7Database.close();
    const cacheDirectory = path.join(artifactDirectory, 'cached-images');
    fs.mkdirSync(cacheDirectory);
    fs.writeFileSync(path.join(cacheDirectory, 'published.png'), 'exact');
    fs.writeFileSync(path.join(cacheDirectory, 'partial.tmp'), 'partial');
    fs.mkdirSync(path.join(cacheDirectory, 'nested'));
    dbModule = await importDbModule();
    const initialized = dbModule.initDatabase();

    expect(initialized.prepare("SELECT value FROM metadata WHERE key = 'schema_version'").get()).toEqual({ value: '8' });
    const columns = initialized.prepare("PRAGMA table_info('image_cache_metadata')").all() as Array<{ name: string; pk: number }>;
    const indexes = initialized.prepare("PRAGMA index_list('image_cache_metadata')").all() as Array<{ name: string }>;
    expect(columns.map(({ name, pk }) => ({ name, pk }))).toEqual([
      { name: 'basename', pk: 1 },
      { name: 'size', pk: 0 },
      { name: 'last_access', pk: 0 },
    ]);
    expect(indexes.map(({ name }) => name)).toContain('idx_image_cache_metadata_last_access');
    expect(initialized.prepare(
      'SELECT owner_id, project_id, project_name, data, card_count, updated_at, created_at FROM backups ORDER BY owner_id',
    ).all()).toEqual(beforeUpgrade);
    expect(initialized.prepare('SELECT basename, size FROM image_cache_metadata').all()).toEqual([
      { basename: 'published.png', size: Buffer.byteLength('exact') },
    ]);
  });

  it('rolls back every v8 artifact and preserves v7 backup bytes when v8 index creation fails', async () => {
    const v7Database = createV7Database();
    const backupBytes = Buffer.from([7, 8, 9, 255]);
    v7Database.prepare(
      'INSERT INTO backups (owner_id, project_id, project_name, data, card_count, updated_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run('owner-a', 'project-a', 'Atomic backup', backupBytes, 9, 20, 10);
    const beforeUpgrade = v7Database.prepare(
      'SELECT owner_id, project_id, project_name, data, card_count, updated_at, created_at FROM backups',
    ).all();
    v7Database.close();

    const originalExec = Database.prototype.exec;
    vi.spyOn(Database.prototype, 'exec').mockImplementation(function (this: Database.Database, sql: string) {
      if (sql.includes('CREATE INDEX IF NOT EXISTS idx_image_cache_metadata_last_access')) {
        throw new Error('forced v8 index failure');
      }
      return originalExec.call(this, sql);
    });
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    dbModule = await importDbModule();

    expect(() => dbModule?.initDatabase()).toThrow('forced v8 index failure');
    expect(consoleErrorSpy).toHaveBeenCalledWith('[DB] Migration 8 failed:', expect.any(Error));
    dbModule.closeDatabase();

    const inspected = new Database(path.join(artifactDirectory, 'proxxied-cards.db'));
    expect(inspected.prepare("SELECT value FROM metadata WHERE key = 'schema_version'").get()).toEqual({ value: '7' });
    expect(inspected.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'image_cache_metadata'",
    ).get()).toBeUndefined();
    expect(inspected.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_image_cache_metadata_last_access'",
    ).get()).toBeUndefined();
    expect(inspected.prepare(
      'SELECT owner_id, project_id, project_name, data, card_count, updated_at, created_at FROM backups',
    ).all()).toEqual(beforeUpgrade);
    inspected.close();
  });

  it('logs and rethrows migration failures', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    createLegacyDatabase('2', 'ALTER TABLE cards ADD COLUMN all_parts TEXT;');
    dbModule = await importDbModule();

    expect(() => dbModule?.initDatabase()).toThrow();
    expect(consoleErrorSpy).toHaveBeenCalledWith('[DB] Migration 3 failed:', expect.any(Error));
  });
});

describe('Database backup owner migration', () => {
  const originalServerDataDir = process.env.SERVER_DATA_DIR;
  let artifactDirectory: string;
  let dbModule: DbModule | undefined;

  async function importDbModule(): Promise<DbModule> {
    vi.resetModules();
    process.env.SERVER_DATA_DIR = artifactDirectory;
    return import('./db.js');
  }

  beforeEach(() => {
    artifactDirectory = createExclusiveArtifactDirectory();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  afterEach(() => {
    try {
      dbModule?.closeDatabase();
    } finally {
      if (originalServerDataDir === undefined) {
        delete process.env.SERVER_DATA_DIR;
      } else {
        process.env.SERVER_DATA_DIR = originalServerDataDir;
      }
      vi.resetModules();
    }
  });

  it('creates a fresh v8 owner-scoped backups table with the owner update index', async () => {
    dbModule = await importDbModule();
    const database = dbModule.initDatabase();

    const schemaVersion = database.prepare("SELECT value FROM metadata WHERE key = 'schema_version'").get() as { value: string };
    const columns = database.prepare("PRAGMA table_info('backups')").all() as Array<{ name: string; pk: number }>;
    const indexes = database.prepare("PRAGMA index_list('backups')").all() as Array<{ name: string }>;

    database.prepare(
      'INSERT INTO backups (owner_id, project_id, project_name, data, card_count, updated_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run('owner-a', 'shared-project', 'A', Buffer.from('a'), 1, 2, 1);
    database.prepare(
      'INSERT INTO backups (owner_id, project_id, project_name, data, card_count, updated_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run('owner-b', 'shared-project', 'B', Buffer.from('b'), 2, 4, 3);

    expect(schemaVersion.value).toBe('8');
    expect(columns.filter((column) => column.pk > 0).map(({ name, pk }) => ({ name, pk }))).toEqual([
      { name: 'owner_id', pk: 1 },
      { name: 'project_id', pk: 2 },
    ]);
    expect(indexes.map((index) => index.name)).toContain('idx_backups_owner_updated_at');
    expect(database.prepare('SELECT COUNT(*) AS count FROM backups WHERE project_id = ?').get('shared-project')).toEqual({ count: 2 });
  });

  it('migrates v6 backup bytes and metadata under the reserved owner without duplication on restart', async () => {
    const legacyData = gzipSync(Buffer.from(JSON.stringify({ project: { name: 'Legacy project' }, cards: ['Sol Ring'] }), 'utf-8'));
    const legacyDatabase = createV6Database(artifactDirectory);
    legacyDatabase.prepare(
      'INSERT INTO backups (project_id, project_name, data, card_count, updated_at, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('legacy-project', 'Legacy project', legacyData, 42, 1700000000123, 1600000000456);
    legacyDatabase.close();

    dbModule = await importDbModule();
    const database = dbModule.initDatabase();
    const migrated = database.prepare(
      'SELECT owner_id, project_id, project_name, data, card_count, updated_at, created_at FROM backups',
    ).get() as {
      owner_id: string;
      project_id: string;
      project_name: string;
      data: Buffer;
      card_count: number;
      updated_at: number;
      created_at: number;
    };

    expect(migrated).toEqual({
      owner_id: legacyOwnerId,
      project_id: 'legacy-project',
      project_name: 'Legacy project',
      data: legacyData,
      card_count: 42,
      updated_at: 1700000000123,
      created_at: 1600000000456,
    });
    const migratedColumns = database.prepare("PRAGMA table_info('backups')").all() as Array<{ name: string; pk: number }>;
    const migratedIndexes = database.prepare("PRAGMA index_list('backups')").all() as Array<{ name: string }>;
    expect(migratedColumns.filter((column) => column.pk > 0).map(({ name, pk }) => ({ name, pk }))).toEqual([
      { name: 'owner_id', pk: 1 },
      { name: 'project_id', pk: 2 },
    ]);
    expect(migratedIndexes.map((index) => index.name)).toContain('idx_backups_owner_updated_at');
    dbModule.closeDatabase();

    dbModule = await importDbModule();
    const restarted = dbModule.initDatabase();
    expect(restarted.prepare('SELECT COUNT(*) AS count FROM backups').get()).toEqual({ count: 1 });
    expect(restarted.prepare("SELECT value FROM metadata WHERE key = 'schema_version'").get()).toEqual({ value: '8' });
  });

  it('rolls back a failed v7 migration and leaves the v6 backup intact', async () => {
    const legacyData = gzipSync(Buffer.from(JSON.stringify({ rollback: true }), 'utf-8'));
    const legacyDatabase = createV6Database(artifactDirectory, 'CREATE INDEX idx_backups_owner_updated_at ON cards(name);');
    legacyDatabase.prepare(
      'INSERT INTO backups (project_id, project_name, data, card_count, updated_at, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('rollback-project', 'Rollback project', legacyData, 5, 20, 10);
    legacyDatabase.close();

    dbModule = await importDbModule();
    const consoleErrorSpy = vi.spyOn(console, 'error');
    expect(() => dbModule?.initDatabase()).toThrow();
    expect(consoleErrorSpy).toHaveBeenCalledWith('[DB] Migration 7 failed:', expect.any(Error));
    const inspected = new Database(path.join(artifactDirectory, 'proxxied-cards.db'));
    const version = inspected.prepare("SELECT value FROM metadata WHERE key = 'schema_version'").get();
    const preserved = inspected.prepare(
      'SELECT project_id, project_name, data, card_count, updated_at, created_at FROM backups',
    ).get();
    inspected.close();

    expect(version).toEqual({ value: '6' });
    expect(preserved).toEqual({
      project_id: 'rollback-project',
      project_name: 'Rollback project',
      data: legacyData,
      card_count: 5,
      updated_at: 20,
      created_at: 10,
    });
  });
});
