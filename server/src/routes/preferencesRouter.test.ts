import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MpcPreferenceFixture } from '../../../shared/types.js';
import { createPrivateRouteAuth, type PrivateIdentity } from '../auth/privateRouteAuth.js';
import { createPreferencesRouter, resolvePreferencesFilePath, validatePreferenceFixture } from './preferencesRouter.js';

const fixtureRoot = fileURLToPath(
    new URL('../../../.review-artifacts/preferences-fixtures/', import.meta.url),
);
const fixturePrefix = 'preferences-fixture-rework-01-';

const validFixture: MpcPreferenceFixture = {
    version: 1,
    exportedAt: '2026-04-18T12:00:00.000Z',
    cases: [
        {
            source: {
                name: 'Lightning Bolt',
                set: 'lea',
                collectorNumber: '161',
            },
            candidates: [
                {
                    identifier: 'bolt-1',
                    name: 'Lightning Bolt',
                    rawName: 'Lightning Bolt',
                    smallThumbnailUrl: 'https://example.com/small.jpg',
                    mediumThumbnailUrl: 'https://example.com/medium.jpg',
                    imageUrl: 'https://example.com/full.jpg',
                    dpi: 800,
                    tags: ['classic'],
                    sourceName: 'MPC Fill',
                    source: 'mpcfill',
                    extension: 'jpg',
                    size: 1024,
                },
            ],
            expectedIdentifier: 'bolt-1',
            notes: 'baseline',
            comparisonHints: {
                fullCard: { art: 0.98, frame: null },
            },
        },
    ],
};

const identitiesByBearer = new Map<string, PrivateIdentity>([
    ['owner-a-read-write', {
        ownerId: 'owner-a',
        capabilities: new Set(['preferences:read', 'preferences:write']),
        transport: 'server',
    }],
    ['owner-a-read-only', {
        ownerId: 'owner-a',
        capabilities: new Set(['preferences:read']),
        transport: 'server',
    }],
    ['owner-a-write-only', {
        ownerId: 'owner-a',
        capabilities: new Set(['preferences:write']),
        transport: 'server',
    }],
    ['owner-b-read-write', {
        ownerId: 'owner-b',
        capabilities: new Set(['preferences:read', 'preferences:write']),
        transport: 'server',
    }],
]);

const privateRouteAuth = createPrivateRouteAuth({
    verifyBearer: bearer => identitiesByBearer.get(bearer) ?? null,
});

function authorizationFor(bearer: string): { Authorization: string } {
    return { Authorization: `Bearer ${bearer}` };
}

describe('preferencesRouter', () => {
    let fixtureDirectory: string;
    let dataDirectory: string;
    let app: express.Express;
    let preferencesPath: string;

    beforeEach(async () => {
        await fs.mkdir(fixtureRoot, { recursive: true });
        fixtureDirectory = await fs.mkdtemp(path.join(fixtureRoot, fixturePrefix));
        dataDirectory = path.join(fixtureDirectory, 'data');
        app = express();
        app.use(express.json());
        app.use('/api/preferences', createPreferencesRouter({ dataDirectory, privateRouteAuth }));
        preferencesPath = path.join(
            dataDirectory,
            'preferences',
            Buffer.from('owner-a').toString('base64url'),
            'mpc-preferences.user.json',
        );
    });

    it('rejects configured paths that escape the data directory', () => {
        expect(() => resolvePreferencesFilePath('../outside.json', dataDirectory)).toThrow(
            `MPC_PREFERENCES_PATH must stay within ${path.resolve(dataDirectory)}`
        );
        expect(() => resolvePreferencesFilePath(path.join(fixtureDirectory, 'outside.json'), dataDirectory)).toThrow(
            `MPC_PREFERENCES_PATH must stay within ${path.resolve(dataDirectory)}`
        );
    });

    it('rejects anonymous and wrong-capability requests before filesystem reads or writes', async () => {
        const readFileSpy = vi.spyOn(fs, 'readFile');
        const writeFileSpy = vi.spyOn(fs, 'writeFile');

        const anonymousRead = await request(app).get('/api/preferences');
        const writeOnlyRead = await request(app)
            .get('/api/preferences')
            .set(authorizationFor('owner-a-write-only'));
        const anonymousWrite = await request(app).put('/api/preferences').send(validFixture);
        const readOnlyWrite = await request(app)
            .put('/api/preferences')
            .set(authorizationFor('owner-a-read-only'))
            .send(validFixture);

        expect(anonymousRead.status).toBe(401);
        expect(anonymousRead.body).toEqual({ error: 'unauthorized' });
        expect(writeOnlyRead.status).toBe(403);
        expect(writeOnlyRead.body).toEqual({ error: 'forbidden' });
        expect(anonymousWrite.status).toBe(401);
        expect(anonymousWrite.body).toEqual({ error: 'unauthorized' });
        expect(readOnlyWrite.status).toBe(403);
        expect(readOnlyWrite.body).toEqual({ error: 'forbidden' });
        expect(readFileSpy).not.toHaveBeenCalled();
        expect(writeFileSpy).not.toHaveBeenCalled();
    });

    it('returns 404 when the authenticated owner preference file is missing', async () => {
        const response = await request(app)
            .get('/api/preferences')
            .set(authorizationFor('owner-a-read-write'));

        expect(response.status).toBe(404);
        expect(response.body.error).toBe('Preferences not found');
    });

    it('round-trips a valid fixture through authenticated PUT and GET', async () => {
        const putResponse = await request(app)
            .put('/api/preferences')
            .set(authorizationFor('owner-a-read-write'))
            .send(validFixture);

        expect(putResponse.status).toBe(200);
        expect(putResponse.body).toEqual({ saved: true });

        const writtenPayload = await fs.readFile(preferencesPath, 'utf-8');
        expect(JSON.parse(writtenPayload)).toEqual(validFixture);

        const getResponse = await request(app)
            .get('/api/preferences')
            .set(authorizationFor('owner-a-read-write'));

        expect(getResponse.status).toBe(200);
        expect(getResponse.body).toEqual(validFixture);
    });

    it('isolates owners by the server-verified identity instead of client owner fields', async () => {
        const ownerBFixture: MpcPreferenceFixture = {
            ...validFixture,
            exportedAt: '2026-04-18T12:00:01.000Z',
        };

        const ownerAWrite = await request(app)
            .put('/api/preferences')
            .set(authorizationFor('owner-a-read-write'))
            .send(validFixture);
        const crossScopeRead = await request(app)
            .get('/api/preferences?ownerId=owner-a')
            .set(authorizationFor('owner-b-read-write'))
            .set('X-Owner-Id', 'owner-a');
        const ownerBWrite = await request(app)
            .put('/api/preferences?ownerId=owner-a')
            .set(authorizationFor('owner-b-read-write'))
            .set('X-Owner-Id', 'owner-a')
            .send(ownerBFixture);
        const ownerARead = await request(app)
            .get('/api/preferences')
            .set(authorizationFor('owner-a-read-write'));
        const ownerBRead = await request(app)
            .get('/api/preferences')
            .set(authorizationFor('owner-b-read-write'));

        expect(ownerAWrite.status).toBe(200);
        expect(crossScopeRead.status).toBe(404);
        expect(crossScopeRead.body).toEqual({ error: 'Preferences not found' });
        expect(ownerBWrite.status).toBe(200);
        expect(ownerARead.body).toEqual(validFixture);
        expect(ownerBRead.body).toEqual(ownerBFixture);
    });

    it('does not read or migrate a configured legacy global preference file', async () => {
        const legacyPath = path.join(dataDirectory, 'legacy-preferences.json');
        await fs.mkdir(dataDirectory, { recursive: true });
        await fs.writeFile(legacyPath, JSON.stringify(validFixture), 'utf-8');

        const legacyApp = express();
        legacyApp.use(express.json());
        legacyApp.use('/api/preferences', createPreferencesRouter({
            dataDirectory,
            configuredPath: 'legacy-preferences.json',
            privateRouteAuth,
        }));

        const response = await request(legacyApp)
            .get('/api/preferences')
            .set(authorizationFor('owner-a-read-write'));

        expect(response.status).toBe(404);
        expect(await fs.readFile(legacyPath, 'utf-8')).toBe(JSON.stringify(validFixture));
    });

    it('rejects malformed PUT bodies with 400', async () => {
        const response = await request(app)
            .put('/api/preferences')
            .set(authorizationFor('owner-a-read-write'))
            .send({
                version: 1,
                exportedAt: '2026-04-18T12:00:00.000Z',
                cases: [
                    {
                        source: { name: 'Lightning Bolt' },
                        candidates: 'not-an-array',
                    },
                ],
            });

        expect(response.status).toBe(400);
        expect(response.body.error).toBe('Invalid preference fixture: candidates must be an array');
    });

    it('rejects every malformed fixture shape with a specific validation error', () => {
        const malformedCases: Array<[unknown, string]> = [
            [null, 'Invalid preference fixture: not a JSON object'],
            [{ exportedAt: validFixture.exportedAt, cases: [] }, 'Invalid preference fixture: missing version'],
            [{ version: 1, cases: [] }, 'Invalid preference fixture: missing exportedAt'],
            [{ version: 1, exportedAt: validFixture.exportedAt }, 'Invalid preference fixture: missing cases array'],
            [{ ...validFixture, cases: [null] }, 'Invalid preference fixture: case must be an object'],
            [{ ...validFixture, cases: [{ source: null, candidates: [] }] }, 'Invalid preference fixture: malformed source card'],
            [{ ...validFixture, cases: [{ source: { name: 'Bolt', set: 1 }, candidates: [] }] }, 'Invalid preference fixture: malformed source card'],
            [{ ...validFixture, cases: [{ source: { name: 'Bolt' }, candidates: [null] }] }, 'Invalid preference fixture: candidate must be an object'],
            [{
                ...validFixture,
                cases: [{ source: { name: 'Bolt' }, candidates: [{ ...validFixture.cases[0].candidates[0], dpi: 'high' }] }],
            }, 'Invalid preference fixture: malformed candidate'],
            [{ ...validFixture, cases: [{ source: { name: 'Bolt' }, candidates: [], expectedIdentifier: 1 }] }, 'Invalid preference fixture: malformed case metadata'],
            [{ ...validFixture, cases: [{ source: { name: 'Bolt' }, candidates: [], comparisonHints: null }] }, 'Invalid preference fixture: malformed comparison hints'],
            [{ ...validFixture, cases: [{ source: { name: 'Bolt' }, candidates: [], comparisonHints: { fullCard: { score: 'high' } } }] }, 'Invalid preference fixture: malformed comparison hints'],
        ];

        for (const [payload, message] of malformedCases) {
            expect(() => validatePreferenceFixture(payload)).toThrow(message);
        }
    });

    it('preserves optional source fields, art-match hints, and omitted case metadata', () => {
        const fixture = {
            version: 1,
            exportedAt: validFixture.exportedAt,
            cases: [
                {
                    source: {
                        name: 'Island',
                        sourceImageUrl: 'https://example.com/source.jpg',
                        sourceArtImageUrl: 'https://example.com/art.jpg',
                    },
                    candidates: [validFixture.cases[0].candidates[0]],
                    comparisonHints: {
                        artMatch: {
                            composition: 0.9,
                            frame: null,
                        },
                    },
                },
            ],
        };

        expect(validatePreferenceFixture(fixture)).toEqual(fixture);

        const fixtureWithoutHints = {
            version: 1,
            exportedAt: validFixture.exportedAt,
            cases: [
                {
                    source: { name: 'Island' },
                    candidates: [],
                },
            ],
        };
        expect(validatePreferenceFixture(fixtureWithoutHints)).toEqual(fixtureWithoutHints);
    });

    it('serializes concurrent writes without corrupting the preference file', async () => {
        const fixtureA: MpcPreferenceFixture = {
            ...validFixture,
            exportedAt: '2026-04-18T12:00:01.000Z',
        };
        const fixtureB: MpcPreferenceFixture = {
            ...validFixture,
            exportedAt: '2026-04-18T12:00:02.000Z',
            cases: [
                {
                    ...validFixture.cases[0],
                    expectedIdentifier: 'bolt-2',
                },
            ],
        };

        const [responseA, responseB] = await Promise.all([
            request(app).put('/api/preferences').set(authorizationFor('owner-a-read-write')).send(fixtureA),
            request(app).put('/api/preferences').set(authorizationFor('owner-a-read-write')).send(fixtureB),
        ]);

        expect(responseA.status).toBe(200);
        expect(responseB.status).toBe(200);

        const persistedPayload = await fs.readFile(preferencesPath, 'utf-8');
        const persistedFixture = JSON.parse(persistedPayload) as MpcPreferenceFixture;
        expect([fixtureA.exportedAt, fixtureB.exportedAt]).toContain(persistedFixture.exportedAt);
        expect(() => JSON.parse(persistedPayload)).not.toThrow();
    });

    it('returns 500 when preference JSON is corrupt or writes fail', async () => {
        await fs.mkdir(path.dirname(preferencesPath), { recursive: true });
        await fs.writeFile(preferencesPath, '{not-json', 'utf-8');
        const loadResponse = await request(app)
            .get('/api/preferences')
            .set(authorizationFor('owner-a-read-write'));
        expect(loadResponse.status).toBe(500);
        expect(loadResponse.body.error).toBe('Failed to load preferences');

        const blockedDataDirectory = path.join(fixtureDirectory, 'blocked-data-directory');
        await fs.writeFile(blockedDataDirectory, 'not a directory', 'utf-8');
        const blockedApp = express();
        blockedApp.use(express.json());
        blockedApp.use('/api/preferences', createPreferencesRouter({
            dataDirectory: blockedDataDirectory,
            privateRouteAuth,
        }));
        const saveResponse = await request(blockedApp)
            .put('/api/preferences')
            .set(authorizationFor('owner-a-read-write'))
            .send(validFixture);
        expect(saveResponse.status).toBe(500);
        expect(saveResponse.body.error).toBe('Failed to save preferences');
    });

    it('removes the temporary preference file when atomic rename fails', async () => {
        const renameSpy = vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('rename failed'));
        const unlinkSpy = vi.spyOn(fs, 'unlink');
        const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

        try {
            const response = await request(app)
                .put('/api/preferences')
                .set(authorizationFor('owner-a-read-write'))
                .send(validFixture);

            expect(response.status).toBe(500);
            expect(response.body.error).toBe('Failed to save preferences');
            expect(unlinkSpy).toHaveBeenCalledWith(expect.stringContaining('mpc-preferences.user.json.'));
        } finally {
            renameSpy.mockRestore();
            unlinkSpy.mockRestore();
            consoleErrorSpy.mockRestore();
        }
    });

    it('still reports the original write failure when temporary cleanup fails', async () => {
        const renameSpy = vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('rename failed'));
        const unlinkSpy = vi.spyOn(fs, 'unlink').mockRejectedValueOnce(new Error('cleanup failed'));
        const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

        try {
            const response = await request(app)
                .put('/api/preferences')
                .set(authorizationFor('owner-a-read-write'))
                .send(validFixture);

            expect(response.status).toBe(500);
            expect(response.body.error).toBe('Failed to save preferences');
            expect(unlinkSpy).toHaveBeenCalledWith(expect.stringContaining('mpc-preferences.user.json.'));
        } finally {
            renameSpy.mockRestore();
            unlinkSpy.mockRestore();
            consoleErrorSpy.mockRestore();
        }
    });

});
