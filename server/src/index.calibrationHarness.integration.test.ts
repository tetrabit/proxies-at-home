import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Server } from 'node:http';

import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createCalibrationHarnessCredentialStore } from './auth/calibrationHarnessIdentity.js';
import { initializeCalibrationHarnessSchema } from './db/calibrationHarnessSchema.js';
import { openNativeDatabase } from './db/openNativeDatabase.js';
import {
  closeLoopbackServer,
  createCalibrationHarnessFixtureProvider,
  listenLoopback,
} from './testUtils/calibrationHarnessFixtures.js';

vi.mock('./db/db.js', () => ({
  initDatabase: vi.fn(),
  getDatabase: vi.fn(),
  closeDatabase: vi.fn(),
}));
vi.mock('./services/importScheduler.js', () => ({ startImportScheduler: vi.fn() }));
vi.mock('./utils/scryfallCatalog.js', () => ({ initCatalogs: vi.fn() }));
vi.mock('./routes/shareRouter.js', () => ({ shareRouter: express.Router(), cleanupExpiredShares: vi.fn() }));
vi.mock('./routes/archidektRouter.js', () => ({ archidektRouter: express.Router() }));
vi.mock('./routes/moxfieldRouter.js', () => ({ moxfieldRouter: express.Router() }));
vi.mock('./routes/imageRouter.js', () => ({ imageRouter: express.Router() }));
vi.mock('./routes/streamRouter.js', () => ({ streamRouter: express.Router() }));
vi.mock('./routes/mpcAutofillRouter.js', () => ({ mpcAutofillRouter: express.Router() }));
vi.mock('./routes/scryfallRouter.js', () => ({ scryfallRouter: express.Router() }));
vi.mock('./routes/backupRouter.js', () => ({ createBackupRouter: () => express.Router() }));
vi.mock('./routes/printerCalibrationRouter.js', () => ({ createPrinterCalibrationRouter: () => express.Router() }));
vi.mock('./routes/preferencesRouter.js', () => ({ createPreferencesRouter: () => express.Router() }));
vi.mock('./routes/metricsRouter.js', () => ({ createMetricsRouter: () => express.Router() }));
vi.mock('./services/scryfallMicroserviceClient.js', () => ({
  isMicroserviceAvailable: vi.fn().mockResolvedValue(true),
  logMicroserviceMetrics: vi.fn(),
}));

const fixtures = createCalibrationHarnessFixtureProvider({ parentName: 'td-b1b266-h3-integration' });
const now = Date.now();
const webOrigin = 'http://127.0.0.1:4173';
let originalSigtermListeners: NodeJS.SignalsListener[];
let originalSigintListeners: NodeJS.SignalsListener[];

beforeEach(() => {
  originalSigtermListeners = process.listeners('SIGTERM');
  originalSigintListeners = process.listeners('SIGINT');
  vi.spyOn(globalThis, 'setInterval').mockImplementation((() => 0) as never);
});

afterEach(() => {
  for (const [signal, original] of [
    ['SIGTERM', originalSigtermListeners],
    ['SIGINT', originalSigintListeners],
  ] as const) {
    for (const listener of process.listeners(signal)) {
      if (!original.includes(listener)) process.off(signal, listener);
    }
  }
  vi.restoreAllMocks();
  vi.resetModules();
});

function snapshot() {
  return {
    version: 1,
    datasets: [],
    cases: [],
    assets: [],
    runs: [],
  };
}

describe('createApp calibration harness integration', () => {
  it('mounts the explicit dedicated harness service before the generic parser', async () => {
    const fixtureRoot = fixtures.createInvocationRoot();
    const dataDirectory = fixtures.createExclusiveDirectory(fixtureRoot);
    const filename = path.join(dataDirectory, 'calibration-harness.db');
    const setup = openNativeDatabase(filename);
    initializeCalibrationHarnessSchema(setup);
    const credential = createCalibrationHarnessCredentialStore(setup, { now: () => now });
    const token = credential.provision({
      ownerId: 'owner-a',
      harnessId: 'harness-a',
      expiresAt: now + 60_000,
    });
    setup.close();

    let server: Server | undefined;
    let application: { calibrationHarness: { database: { open: boolean } } | undefined; app: express.Express; close(): void } | undefined;
    try {
      const { createApplicationRuntime } = await import('./index.js');
      application = createApplicationRuntime({
        calibrationHarness: { dataDirectory, allowedWebOrigins: [webOrigin] },
      } as never);
      server = await listenLoopback(application.app);
      const api = request(server);

      const paired = await api.post('/api/calibration-harness/pair')
        .set('Origin', webOrigin)
        .set('Authorization', `Bearer ${token}`);
      expect(paired.status).toBe(200);
      expect(paired.headers['cache-control']).toBe('no-store');

      const created = await api.put('/api/calibration-harness/snapshot')
        .set('Authorization', `Bearer ${token}`)
        .set('If-None-Match', '*')
        .send(snapshot());
      expect(created.status).toBe(201);
      expect(created.body).toEqual({ revision: 1, snapshot: snapshot() });

      const bytes = Buffer.from([0, 255, 1, 128, 64, 0]);
      const digest = createHash('sha256').update(bytes).digest('hex');
      const uploaded = await api.put(`/api/calibration-harness/blobs/${digest}`)
        .set('Authorization', `Bearer ${token}`)
        .set('Content-Type', 'application/octet-stream')
        .send(bytes);
      expect(uploaded.status).toBe(201);
      const loaded = await api.get(`/api/calibration-harness/blobs/${digest}`)
        .set('Authorization', `Bearer ${token}`);
      expect(loaded.status).toBe(200);
      expect(loaded.body).toEqual(bytes);
    } finally {
      try {
        if (server !== undefined) await closeLoopbackServer(server);
      } finally {
        application?.close();
      }
    }
    expect(application?.calibrationHarness?.database.open).toBe(false);
  });

  it('fails closed without explicit harness configuration before the generic parser', async () => {
    let server: Server | undefined;
    try {
      const { createApp } = await import('./index.js');
      server = await listenLoopback(createApp());
      const response = await request(server)
        .put('/api/calibration-harness/snapshot')
        .set('Content-Type', 'application/json')
        .send('{not-json');
      expect(response.status).toBe(404);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.body).toEqual({ error: 'not_found' });
    } finally {
      if (server !== undefined) await closeLoopbackServer(server);
    }
  });

  it('settles owned HTTP before closing the dedicated database and preserves revisions and blobs across restart', async () => {
    const fixtureRoot = fixtures.createInvocationRoot();
    const dataDirectory = fixtures.createExclusiveDirectory(fixtureRoot);
    const filename = path.join(dataDirectory, 'calibration-harness.db');
    const sentinel = path.join(dataDirectory, 'unrelated-sentinel.txt');
    const setup = openNativeDatabase(filename);
    initializeCalibrationHarnessSchema(setup);
    const token = createCalibrationHarnessCredentialStore(setup, { now: () => now }).provision({
      ownerId: 'owner-a',
      harnessId: 'harness-a',
      expiresAt: now + 60_000,
    });
    setup.close();
    fs.writeFileSync(sentinel, 'must-survive-harness-restart\n', { mode: 0o600 });

    const options = {
      host: '127.0.0.1',
      calibrationHarness: { dataDirectory, allowedWebOrigins: [webOrigin] },
    };
    const bytes = Buffer.from([0, 255, 1, 128, 64, 0]);
    const digest = createHash('sha256').update(bytes).digest('hex');
    let first: { close(): Promise<void>; server: Server } | undefined;
    let second: { close(): Promise<void>; server: Server } | undefined;
    try {
      const { startServerRuntime } = await import('./index.js');
      first = await startServerRuntime(0, options);
      const firstApi = request(first.server);
      expect((await firstApi.put(`/api/calibration-harness/blobs/${digest}`)
        .set('Authorization', `Bearer ${token}`)
        .set('Content-Type', 'application/octet-stream')
        .send(bytes)).status).toBe(201);
      expect((await firstApi.put('/api/calibration-harness/snapshot')
        .set('Authorization', `Bearer ${token}`)
        .set('If-None-Match', '*')
        .send(snapshot())).body).toEqual({ revision: 1, snapshot: snapshot() });

      await first.close();
      await first.close();
      expect(first.server.listening).toBe(false);
      first = undefined;

      const inspected = openNativeDatabase(filename);
      try {
        expect(inspected.prepare('SELECT revision FROM mpc_harness_revisions WHERE owner_id = ? AND harness_id = ?').all('owner-a', 'harness-a'))
          .toEqual([{ revision: 1 }]);
        expect(inspected.prepare('SELECT data FROM mpc_harness_blobs WHERE owner_id = ? AND sha256 = ?').get('owner-a', digest))
          .toEqual({ data: bytes });
        expect(fs.readFileSync(sentinel, 'utf8')).toBe('must-survive-harness-restart\n');
      } finally {
        inspected.close();
      }

      second = await startServerRuntime(0, options);
      const secondApi = request(second.server);
      const reopened = await secondApi.get('/api/calibration-harness/snapshot').set('Authorization', `Bearer ${token}`);
      expect(reopened.body).toEqual({ revision: 1, snapshot: snapshot() });
      const reloaded = await secondApi.get(`/api/calibration-harness/blobs/${digest}`).set('Authorization', `Bearer ${token}`);
      expect(reloaded.body).toEqual(bytes);
    } finally {
      try {
        if (second !== undefined) await second.close();
      } finally {
        if (first !== undefined) await first.close();
      }
    }
  });

  it('rejects a listener failure without leaving the owned runtime startup pending', async () => {
    const fixtureRoot = fixtures.createInvocationRoot();
    const dataDirectory = fixtures.createExclusiveDirectory(fixtureRoot);
    const blocker = await listenLoopback(express());
    const address = blocker.address();
    if (address === null || typeof address === 'string') throw new Error('expected an owned loopback TCP listener');
    try {
      const { startServerRuntime } = await import('./index.js');
      await expect(startServerRuntime(address.port, {
        host: '127.0.0.1',
        calibrationHarness: { dataDirectory, allowedWebOrigins: [webOrigin] },
      })).rejects.toMatchObject({ code: 'EADDRINUSE' });

      const reopened = openNativeDatabase(path.join(dataDirectory, 'calibration-harness.db'));
      try {
        initializeCalibrationHarnessSchema(reopened);
      } finally {
        reopened.close();
      }
    } finally {
      await closeLoopbackServer(blocker);
    }
  });
});
