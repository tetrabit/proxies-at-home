import { describe, expect, it } from 'vitest';

import { verifyNativeDatabaseCompatibility } from './nativeCompatibility.js';

describe('verifyNativeDatabaseCompatibility', () => {
    it('opens the installed native driver and executes SQLite', () => {
        const result = verifyNativeDatabaseCompatibility();

        expect(result.nodeVersion).toBe(process.version);
        expect(result.nodeModuleVersion).toBe(process.versions.modules);
        expect(result.sqliteVersion).toMatch(/^\d+\.\d+\.\d+$/);
    });
});
