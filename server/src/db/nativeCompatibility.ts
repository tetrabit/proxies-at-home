import Database from 'better-sqlite3';

export interface NativeDatabaseCompatibility {
    nodeVersion: string;
    nodeModuleVersion: string | undefined;
    sqliteVersion: string;
}

export function verifyNativeDatabaseCompatibility(): NativeDatabaseCompatibility {
    const database = new Database(':memory:');

    try {
        const row = database
            .prepare('SELECT sqlite_version() AS version')
            .get() as { version: string };

        return {
            nodeVersion: process.version,
            nodeModuleVersion: process.versions.modules,
            sqliteVersion: row.version,
        };
    } finally {
        database.close();
    }
}
