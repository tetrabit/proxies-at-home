import { openNativeDatabase } from './openNativeDatabase.js';

export interface NativeDatabaseCompatibility {
    nodeVersion: string;
    nodeModuleVersion: string | undefined;
    sqliteVersion: string;
}

export function verifyNativeDatabaseCompatibility(): NativeDatabaseCompatibility {
    const database = openNativeDatabase(':memory:');

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
