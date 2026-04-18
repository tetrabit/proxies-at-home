import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MpcPreferenceFixture } from '../../../shared/types.js';
import { createPreferencesRouter, resolvePreferencesFilePath } from './preferencesRouter.js';

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

describe('preferencesRouter', () => {
    let tempDirectory: string;
    let dataDirectory: string;
    let app: express.Express;
    let preferencesPath: string;

    beforeEach(async () => {
        tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'preferences-router-'));
        dataDirectory = path.join(tempDirectory, 'data');
        app = express();
        app.use(express.json());
        app.use('/api/preferences', createPreferencesRouter({ dataDirectory }));
        preferencesPath = path.join(dataDirectory, 'mpc-preferences.user.json');
    });

    afterEach(async () => {
        await fs.rm(tempDirectory, { recursive: true, force: true });
    });

    it('rejects configured paths that escape the data directory', () => {
        expect(() => resolvePreferencesFilePath('../outside.json', dataDirectory)).toThrow(
            `MPC_PREFERENCES_PATH must stay within ${path.resolve(dataDirectory)}`
        );
        expect(() => resolvePreferencesFilePath(path.join(tempDirectory, 'outside.json'), dataDirectory)).toThrow(
            `MPC_PREFERENCES_PATH must stay within ${path.resolve(dataDirectory)}`
        );
    });

    it('returns 404 when the preference file is missing', async () => {
        const response = await request(app).get('/api/preferences');

        expect(response.status).toBe(404);
        expect(response.body.error).toBe('Preferences not found');
    });

    it('round-trips a valid fixture through PUT and GET', async () => {
        const putResponse = await request(app)
            .put('/api/preferences')
            .send(validFixture);

        expect(putResponse.status).toBe(200);
        expect(putResponse.body).toEqual({ saved: true });

        const writtenPayload = await fs.readFile(preferencesPath, 'utf-8');
        expect(JSON.parse(writtenPayload)).toEqual(validFixture);

        const getResponse = await request(app).get('/api/preferences');

        expect(getResponse.status).toBe(200);
        expect(getResponse.body).toEqual(validFixture);
    });

    it('rejects malformed PUT bodies with 400', async () => {
        const response = await request(app)
            .put('/api/preferences')
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
            request(app).put('/api/preferences').send(fixtureA),
            request(app).put('/api/preferences').send(fixtureB),
        ]);

        expect(responseA.status).toBe(200);
        expect(responseB.status).toBe(200);

        const persistedPayload = await fs.readFile(preferencesPath, 'utf-8');
        const persistedFixture = JSON.parse(persistedPayload) as MpcPreferenceFixture;
        expect([fixtureA.exportedAt, fixtureB.exportedAt]).toContain(persistedFixture.exportedAt);
        expect(() => JSON.parse(persistedPayload)).not.toThrow();
    });
});
