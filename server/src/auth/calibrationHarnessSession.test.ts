import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type Database from 'better-sqlite3';
import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { createCalibrationHarnessCredentialStore } from './calibrationHarnessIdentity.js';
import { createCalibrationHarnessSessionAuth } from './calibrationHarnessSession.js';
import { createPrivateRouteAuth } from './privateRouteAuth.js';
import { initializeCalibrationHarnessSchema } from '../db/calibrationHarnessSchema.js';
import { openNativeDatabase } from '../db/openNativeDatabase.js';

const fixtureRoot = path.join(
  fileURLToPath(new URL('../../../', import.meta.url)),
  '.review-artifacts',
  'calibration-harness-session-01',
);
const webOrigin = 'http://localhost:5173';

function createExclusiveDatabase(): Database.Database {
  fs.mkdirSync(fixtureRoot, { recursive: true });
  const directory = path.join(fixtureRoot, randomUUID());
  fs.mkdirSync(directory);
  const database = openNativeDatabase(path.join(directory, 'calibration-harness.db'));
  initializeCalibrationHarnessSchema(database);
  return database;
}

describe('createCalibrationHarnessSessionAuth', () => {
  it('pairs an approved operator bearer into a scoped persistent cookie without returning a credential', async () => {
    const database = createExclusiveDatabase();
    const now = 1_700_000_000_000;
    try {
      const pairBearer = createCalibrationHarnessCredentialStore(database, { now: () => now }).provision({
        ownerId: 'owner-a',
        harnessId: 'harness-a',
        expiresAt: now + 60_000,
      });
      const sessionAuth = createCalibrationHarnessSessionAuth(database, {
        allowedWebOrigins: [webOrigin],
        now: () => now,
      });
      const app = express();
      app.post('/api/calibration-harness/pair', sessionAuth.pair);
      app.get('/api/calibration-harness/:harnessId', sessionAuth.authenticate, (req, res) => {
        res.json(req.calibrationHarnessIdentity);
      });

      const agent = request.agent(app);
      const paired = await agent
        .post('/api/calibration-harness/pair')
        .set('Origin', webOrigin)
        .set('Authorization', `Bearer ${pairBearer}`);

      expect(paired.status).toBe(200);
      expect(paired.body).toEqual({ ownerId: 'owner-a', harnessId: 'harness-a' });
      expect(JSON.stringify(paired.body)).not.toContain('calibration_');
      expect(paired.headers['set-cookie']).toEqual([
        expect.stringMatching(/proxxied_calibration_session=calibration_session_[A-Za-z0-9_-]{43}; Max-Age=60; Path=\/api\/calibration-harness; Expires=.*; HttpOnly; SameSite=Strict/),
      ]);

      const authenticated = await agent
        .get('/api/calibration-harness/harness-a')
        .set('Sec-Fetch-Site', 'same-origin')
        .set('Host', 'localhost:5173');

      expect(authenticated.status).toBe(200);
      expect(authenticated.body).toMatchObject({
        ownerId: 'owner-a',
        harnessId: 'harness-a',
        transport: 'server',
        capabilities: {},
      });
    } finally {
      database.close();
    }
  });

  it('denies anonymous, malformed, foreign-origin, unsafe-CSRF, ambiguous, and wrong-harness requests before the protected parser', async () => {
    const database = createExclusiveDatabase();
    const now = 1_700_000_000_000;
    try {
      const pairBearer = createCalibrationHarnessCredentialStore(database, { now: () => now }).provision({
        ownerId: 'owner-a', harnessId: 'harness-a', expiresAt: now + 60_000,
      });
      const sessionAuth = createCalibrationHarnessSessionAuth(database, { allowedWebOrigins: [webOrigin], now: () => now });
      const protectedParser = vi.fn((_req: unknown, _res: unknown, next: () => void) => next());
      const app = express();
      app.post('/api/calibration-harness/pair', sessionAuth.pair);
      app.post('/api/calibration-harness/:harnessId', sessionAuth.authenticate, protectedParser, (_req, res) => res.status(204).end());
      app.get('/api/calibration-harness/:harnessId', sessionAuth.authenticate, protectedParser, (_req, res) => res.status(204).end());

      expect((await request(app).post('/api/calibration-harness/pair')).status).toBe(401);
      expect((await request(app).post('/api/calibration-harness/pair').set('Origin', 'null').set('Authorization', `Bearer ${pairBearer}`)).status).toBe(401);
      expect((await request(app).post('/api/calibration-harness/pair').set('Origin', 'http://localhost:5174').set('Authorization', `Bearer ${pairBearer}`)).status).toBe(401);
      expect((await request(app).post('/api/calibration-harness/pair').set('Origin', webOrigin).set('Authorization', 'Bearer calibration_pair_bad')).status).toBe(401);

      const paired = await request(app).post('/api/calibration-harness/pair').set('Origin', webOrigin).set('Authorization', `Bearer ${pairBearer}`);
      const cookie = paired.headers['set-cookie'][0]!.split(';', 1)[0]!;
      expect((await request(app).post('/api/calibration-harness/harness-a').set('Cookie', cookie)).status).toBe(401);
      expect((await request(app).post('/api/calibration-harness/harness-a').set('Cookie', cookie).set('Origin', 'http://localhost:5174')).status).toBe(401);
      expect((await request(app).post('/api/calibration-harness/harness-other').set('Cookie', cookie).set('Origin', webOrigin)).status).toBe(401);
      expect((await request(app).get('/api/calibration-harness/harness-a').set('Cookie', cookie).set('Sec-Fetch-Site', 'cross-site').set('Host', 'localhost:5173')).status).toBe(401);
      expect((await request(app).get('/api/calibration-harness/harness-a').set('Cookie', cookie).set('Sec-Fetch-Site', 'same-origin').set('Host', 'localhost')).status).toBe(401);
      expect((await request(app).get('/api/calibration-harness/harness-a').set('Cookie', cookie).set('Authorization', `Bearer ${pairBearer}`).set('Origin', webOrigin)).status).toBe(401);
      expect((await request(app).get('/api/calibration-harness/harness-a').set('Cookie', [cookie, cookie] as unknown as string).set('Origin', webOrigin)).status).toBe(401);
      expect((await request(app).get('/api/calibration-harness/harness-a').set('Authorization', [`Bearer ${pairBearer}`, `Bearer ${pairBearer}`] as unknown as string)).status).toBe(401);
      expect(protectedParser).not.toHaveBeenCalled();
    } finally {
      database.close();
    }
  });

  it('keeps the server-derived owner isolated, caps expiry, and persists the session across reopen', async () => {
    const database = createExclusiveDatabase();
    const filename = database.name;
    let now = 1_700_000_000_000;
    let cookie: string;
    try {
      const pairBearer = createCalibrationHarnessCredentialStore(database, { now: () => now }).provision({
        ownerId: 'owner-a', harnessId: 'shared-harness', expiresAt: now + 30_000,
      });
      const sessionAuth = createCalibrationHarnessSessionAuth(database, { allowedWebOrigins: [webOrigin], now: () => now, maxAgeMs: 60_000 });
      const app = express();
      app.post('/api/calibration-harness/pair', sessionAuth.pair);
      app.get('/api/calibration-harness/:harnessId', sessionAuth.authenticate, (req, res) => res.json({
        ownerId: req.calibrationHarnessIdentity!.ownerId,
        harnessId: req.calibrationHarnessIdentity!.harnessId,
      }));
      const paired = await request(app).post('/api/calibration-harness/pair').set('Origin', webOrigin).set('Authorization', `Bearer ${pairBearer}`);
      expect(paired.headers['set-cookie'][0]).toContain('Max-Age=30');
      cookie = paired.headers['set-cookie'][0]!.split(';', 1)[0]!;
      const isolated = await request(app)
        .get('/api/calibration-harness/shared-harness?ownerId=owner-b')
        .set('Cookie', cookie)
        .set('Origin', webOrigin)
        .set('X-Owner-Id', 'owner-b');
      expect(isolated.body).toEqual({ ownerId: 'owner-a', harnessId: 'shared-harness' });
    } finally {
      database.close();
    }

    const reopened = openNativeDatabase(filename);
    try {
      initializeCalibrationHarnessSchema(reopened);
      const sessionAuth = createCalibrationHarnessSessionAuth(reopened, { allowedWebOrigins: [webOrigin], now: () => now });
      const app = express();
      app.get('/api/calibration-harness/:harnessId', sessionAuth.authenticate, (req, res) => res.json({ ownerId: req.calibrationHarnessIdentity!.ownerId }));
      const persisted = await request(app).get('/api/calibration-harness/shared-harness').set('Cookie', cookie!).set('Origin', webOrigin);
      expect(persisted.status).toBe(200);
      expect(persisted.body).toEqual({ ownerId: 'owner-a' });
      now += 30_000;
      expect((await request(app).get('/api/calibration-harness/shared-harness').set('Cookie', cookie!).set('Origin', webOrigin)).status).toBe(401);
    } finally {
      reopened.close();
    }
  });

  it('allows fixed pair bearers with an empty cookie origin allowlist but never enables cookie authentication', async () => {
    const database = createExclusiveDatabase();
    const now = 1_700_000_000_000;
    try {
      const pairBearer = createCalibrationHarnessCredentialStore(database, { now: () => now }).provision({
        ownerId: 'owner-a', harnessId: 'harness-a', expiresAt: now + 60_000,
      });
      const sessionAuth = createCalibrationHarnessSessionAuth(database, { allowedWebOrigins: [], now: () => now });
      const app = express();
      app.post('/api/calibration-harness/pair', sessionAuth.pair);
      app.get('/api/calibration-harness/:harnessId', sessionAuth.authenticate, (_req, res) => res.status(204).end());
      expect((await request(app).post('/api/calibration-harness/pair').set('Origin', webOrigin).set('Authorization', `Bearer ${pairBearer}`)).status).toBe(401);
      expect((await request(app).get('/api/calibration-harness/harness-a').set('Authorization', `Bearer ${pairBearer}`)).status).toBe(204);
      expect((await request(app).get('/api/calibration-harness/harness-a').set('Cookie', 'proxxied_calibration_session=calibration_session_' + 'a'.repeat(43)).set('Origin', webOrigin)).status).toBe(401);
    } finally {
      database.close();
    }
  });

  it('revokes only the authenticated session cookie on CSRF-checked unpair', async () => {
    const database = createExclusiveDatabase();
    const now = 1_700_000_000_000;
    try {
      const pairBearer = createCalibrationHarnessCredentialStore(database, { now: () => now }).provision({
        ownerId: 'owner-a', harnessId: 'harness-a', expiresAt: now + 60_000,
      });
      const sessionAuth = createCalibrationHarnessSessionAuth(database, { allowedWebOrigins: [webOrigin], now: () => now });
      const app = express();
      app.post('/api/calibration-harness/pair', sessionAuth.pair);
      app.post('/api/calibration-harness/unpair', sessionAuth.unpair);
      app.get('/api/calibration-harness/:harnessId', sessionAuth.authenticate, (_req, res) => res.status(204).end());
      const first = await request(app).post('/api/calibration-harness/pair').set('Origin', webOrigin).set('Authorization', `Bearer ${pairBearer}`);
      const second = await request(app).post('/api/calibration-harness/pair').set('Origin', webOrigin).set('Authorization', `Bearer ${pairBearer}`);
      const firstCookie = first.headers['set-cookie'][0]!.split(';', 1)[0]!;
      const secondCookie = second.headers['set-cookie'][0]!.split(';', 1)[0]!;
      expect((await request(app).post('/api/calibration-harness/unpair').set('Cookie', firstCookie)).status).toBe(401);
      const unpaired = await request(app).post('/api/calibration-harness/unpair').set('Cookie', firstCookie).set('Origin', webOrigin);
      expect(unpaired.status).toBe(204);
      expect(unpaired.headers['set-cookie'][0]).toContain('proxxied_calibration_session=; Path=/api/calibration-harness; Expires=');
      expect((await request(app).get('/api/calibration-harness/harness-a').set('Cookie', firstCookie).set('Origin', webOrigin)).status).toBe(401);
      expect((await request(app).get('/api/calibration-harness/harness-a').set('Cookie', secondCookie).set('Origin', webOrigin)).status).toBe(204);
      expect((await request(app).get('/api/calibration-harness/harness-a').set('Authorization', `Bearer ${pairBearer}`)).status).toBe(204);
    } finally {
      database.close();
    }
  });

  it('marks HTTPS session cookies Secure and rejects non-loopback HTTP origin configuration', async () => {
    const database = createExclusiveDatabase();
    const now = 1_700_000_000_000;
    try {
      const pairBearer = createCalibrationHarnessCredentialStore(database, { now: () => now }).provision({
        ownerId: 'owner-a', harnessId: 'harness-a', expiresAt: now + 60_000,
      });
      const sessionAuth = createCalibrationHarnessSessionAuth(database, { allowedWebOrigins: ['https://calibration.example.test'], now: () => now });
      const app = express();
      app.post('/api/calibration-harness/pair', sessionAuth.pair);
      const paired = await request(app).post('/api/calibration-harness/pair').set('Origin', 'https://calibration.example.test').set('Authorization', `Bearer ${pairBearer}`);
      expect(paired.headers['set-cookie'][0]).toContain('Secure');
      expect(() => createCalibrationHarnessSessionAuth(database, { allowedWebOrigins: ['http://calibration.example.test'] })).toThrow();
    } finally {
      database.close();
    }
  });

  it('does not extend existing private-route authentication to browser session cookies or session bearers', async () => {
    const database = createExclusiveDatabase();
    const now = 1_700_000_000_000;
    try {
      const credentialStore = createCalibrationHarnessCredentialStore(database, { now: () => now });
      const pairBearer = credentialStore.provision({ ownerId: 'owner-a', harnessId: 'harness-a', expiresAt: now + 60_000 });
      const sessionAuth = createCalibrationHarnessSessionAuth(database, { allowedWebOrigins: [webOrigin], now: () => now });
      const sessionApp = express();
      sessionApp.post('/api/calibration-harness/pair', sessionAuth.pair);
      const paired = await request(sessionApp).post('/api/calibration-harness/pair').set('Origin', webOrigin).set('Authorization', `Bearer ${pairBearer}`);
      const sessionCookie = paired.headers['set-cookie'][0]!.split(';', 1)[0]!;
      const sessionBearer = sessionCookie.slice(`${'proxxied_calibration_session='}`.length);

      const privateApp = express();
      privateApp.get('/private', createPrivateRouteAuth(credentialStore).private('calibration:read'), (_req, res) => res.status(204).end());
      expect((await request(privateApp).get('/private').set('Cookie', sessionCookie)).status).toBe(401);
      expect((await request(privateApp).get('/private').set('Authorization', `Bearer ${sessionBearer}`)).status).toBe(401);
    } finally {
      database.close();
    }
  });
});
