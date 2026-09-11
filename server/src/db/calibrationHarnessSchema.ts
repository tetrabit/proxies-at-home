import type Database from 'better-sqlite3';

export const CALIBRATION_HARNESS_SCHEMA_VERSION = 1;

const ownedTables = {
  mpc_harnesses: [
    { name: 'owner_id', type: 'TEXT', notnull: 1, pk: 1 },
    { name: 'harness_id', type: 'TEXT', notnull: 1, pk: 2 },
    { name: 'revision', type: 'INTEGER', notnull: 1, pk: 0 },
    { name: 'snapshot_json', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'updated_at', type: 'INTEGER', notnull: 1, pk: 0 },
  ],
  mpc_harness_revisions: [
    { name: 'owner_id', type: 'TEXT', notnull: 1, pk: 1 },
    { name: 'harness_id', type: 'TEXT', notnull: 1, pk: 2 },
    { name: 'revision', type: 'INTEGER', notnull: 1, pk: 3 },
    { name: 'snapshot_json', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'digest', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'created_at', type: 'INTEGER', notnull: 1, pk: 0 },
  ],
  mpc_harness_blobs: [
    { name: 'owner_id', type: 'TEXT', notnull: 1, pk: 1 },
    { name: 'sha256', type: 'TEXT', notnull: 1, pk: 2 },
    { name: 'data', type: 'BLOB', notnull: 1, pk: 0 },
    { name: 'byte_length', type: 'INTEGER', notnull: 1, pk: 0 },
    { name: 'created_at', type: 'INTEGER', notnull: 1, pk: 0 },
  ],
  mpc_harness_sessions: [
    { name: 'token_hash', type: 'TEXT', notnull: 1, pk: 1 },
    { name: 'owner_id', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'harness_id', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'created_at', type: 'INTEGER', notnull: 1, pk: 0 },
    { name: 'expires_at', type: 'INTEGER', notnull: 1, pk: 0 },
  ],
} as const;

type OwnedTableName = keyof typeof ownedTables;
type ColumnDefinition = (typeof ownedTables)[OwnedTableName][number];

const migrationSql = `
  CREATE TABLE IF NOT EXISTS mpc_harnesses (
    owner_id TEXT NOT NULL,
    harness_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision >= 1),
    snapshot_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (owner_id, harness_id)
  );

  CREATE TABLE IF NOT EXISTS mpc_harness_revisions (
    owner_id TEXT NOT NULL,
    harness_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision >= 1),
    snapshot_json TEXT NOT NULL,
    digest TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (owner_id, harness_id, revision),
    FOREIGN KEY (owner_id, harness_id)
      REFERENCES mpc_harnesses (owner_id, harness_id)
      ON DELETE RESTRICT
  );

  CREATE TABLE IF NOT EXISTS mpc_harness_blobs (
    owner_id TEXT NOT NULL,
    sha256 TEXT NOT NULL CHECK (
      length(sha256) = 64
      AND sha256 NOT GLOB '*[^0-9a-f]*'
    ),
    data BLOB NOT NULL,
    byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (owner_id, sha256),
    CHECK (length(data) = byte_length)
  );

  CREATE TABLE IF NOT EXISTS mpc_harness_sessions (
    token_hash TEXT NOT NULL PRIMARY KEY,
    owner_id TEXT NOT NULL,
    harness_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
`;

function readColumns(database: Database.Database, tableName: OwnedTableName): ColumnDefinition[] {
  return database.prepare(`PRAGMA table_info('${tableName}')`).all() as ColumnDefinition[];
}

function sameColumns(actual: ColumnDefinition[], expected: readonly ColumnDefinition[]): boolean {
  return actual.length === expected.length && actual.every((column, index) => {
    const expectedColumn = expected[index];
    return column.name === expectedColumn.name
      && column.type === expectedColumn.type
      && column.notnull === expectedColumn.notnull
      && column.pk === expectedColumn.pk;
  });
}

function assertOwnedTables(database: Database.Database): void {
  for (const [tableName, expectedColumns] of Object.entries(ownedTables) as Array<
    [OwnedTableName, readonly ColumnDefinition[]]
  >) {
    const table = database.prepare(
      "SELECT type FROM sqlite_master WHERE name = ?",
    ).get(tableName) as { type: string } | undefined;

    if (table?.type !== 'table') {
      throw new Error(`Calibration harness schema is missing required table ${tableName}`);
    }

    if (!sameColumns(readColumns(database, tableName), expectedColumns)) {
      throw new Error(`Calibration harness schema has incompatible table ${tableName}`);
    }
  }

  const foreignKeys = database.prepare("PRAGMA foreign_key_list('mpc_harness_revisions')").all() as Array<{
    table: string;
    from: string;
    to: string;
    on_delete: string;
  }>;
  const ownerScopedForeignKey = foreignKeys.filter((foreignKey) => foreignKey.table === 'mpc_harnesses');
  if (
    ownerScopedForeignKey.length !== 2
    || !ownerScopedForeignKey.some((foreignKey) => (
      foreignKey.from === 'owner_id'
      && foreignKey.to === 'owner_id'
      && foreignKey.on_delete === 'RESTRICT'
    ))
    || !ownerScopedForeignKey.some((foreignKey) => (
      foreignKey.from === 'harness_id'
      && foreignKey.to === 'harness_id'
      && foreignKey.on_delete === 'RESTRICT'
    ))
  ) {
    throw new Error('Calibration harness schema is missing its owner-scoped revision foreign key');
  }
}

/**
 * Initializes the separate persistent database used by calibration harnesses.
 * This intentionally does not share the cards-cache migration stream.
 */
export function initializeCalibrationHarnessSchema(database: Database.Database): void {
  const currentVersion = database.pragma('user_version', { simple: true }) as number;

  if (currentVersion > CALIBRATION_HARNESS_SCHEMA_VERSION) {
    throw new Error(
      `Calibration harness database version ${currentVersion} is newer than supported version ${CALIBRATION_HARNESS_SCHEMA_VERSION}`,
    );
  }
  if (currentVersion < 0) {
    throw new Error(`Calibration harness database has unsupported version ${currentVersion}`);
  }

  // This is connection state, so it must be set before the DDL transaction.
  database.pragma('foreign_keys = ON');

  if (currentVersion === CALIBRATION_HARNESS_SCHEMA_VERSION) {
    assertOwnedTables(database);
    return;
  }

  database.transaction(() => {
    database.exec(migrationSql);
    assertOwnedTables(database);
    database.pragma(`user_version = ${CALIBRATION_HARNESS_SCHEMA_VERSION}`);
  })();
}
