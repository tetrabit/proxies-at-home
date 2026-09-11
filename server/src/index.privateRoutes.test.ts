import type { Server } from 'node:http';

import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PrivateCredentialVerifier, PrivateIdentity } from './auth/privateRouteAuth.js';
import { closeLoopbackServer, listenLoopback } from './testUtils/calibrationHarnessFixtures.js';

const state = vi.hoisted(() => ({
  getDatabase: vi.fn(),
  getMicroserviceMetrics: vi.fn(),
  isMicroserviceAvailable: vi.fn(),
  logMicroserviceMetrics: vi.fn(),
  resetMicroserviceMetrics: vi.fn(),
}));

vi.mock('./db/db.js', () => ({
  initDatabase: vi.fn(),
  getDatabase: state.getDatabase,
  LEGACY_UNASSIGNED_OWNER_ID: 'legacy-unassigned',
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
vi.mock('./routes/printerCalibrationRouter.js', () => ({ createPrinterCalibrationRouter: () => express.Router() }));
vi.mock('./routes/preferencesRouter.js', () => ({ createPreferencesRouter: () => express.Router() }));
vi.mock('./services/scryfallMicroserviceClient.js', () => ({
  getMicroserviceMetrics: state.getMicroserviceMetrics,
  isMicroserviceAvailable: state.isMicroserviceAvailable,
  logMicroserviceMetrics: state.logMicroserviceMetrics,
  resetMicroserviceMetrics: state.resetMicroserviceMetrics,
}));

const readIdentity: PrivateIdentity = {
  ownerId: 'server-owned-owner',
  capabilities: new Set(['metrics:read']),
  transport: 'server',
};
const writeIdentity: PrivateIdentity = {
  ownerId: 'server-owned-owner',
  capabilities: new Set(['metrics:write']),
  transport: 'server',
};
const backupReadIdentity: PrivateIdentity = {
  ownerId: 'server-owned-owner',
  capabilities: new Set(['backup:read']),
  transport: 'server',
};

function verifierFor(identity: PrivateIdentity | null): PrivateCredentialVerifier {
  return { verifyBearer: vi.fn(() => identity) };
}

const ownedServers: Server[] = [];

async function requestFor(app: express.Express): Promise<ReturnType<typeof request>> {
  const server = await listenLoopback(app);
  ownedServers.push(server);
  return request(server);
}

describe('private metrics route registration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.getDatabase.mockReturnValue({ prepare: vi.fn(() => ({ get: vi.fn(() => ({ ok: 1 })) })) });
    state.getMicroserviceMetrics.mockReturnValue({ averageResponseTime: 100, errorRate: 1, requests: 3 });
    state.isMicroserviceAvailable.mockResolvedValue(true);
  });

  afterEach(async () => {
    try {
      await Promise.all(ownedServers.splice(0).map((server) => closeLoopbackServer(server)));
    } finally {
      vi.restoreAllMocks();
      vi.resetModules();
    }
  });

  it('fails closed without server credential configuration before metrics data is read', async () => {
    const { createApp } = await import('./index.js');

    const app = createApp();
    const api = await requestFor(app);
    const response = await api.get('/api/metrics');
    const health = await api.get('/api/metrics/health');

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: 'unauthorized' });
    expect(response.text).not.toContain('averageResponseTime');
    expect(health.status).toBe(401);
    expect(health.body).toEqual({ error: 'unauthorized' });
    expect(health.text).not.toContain('averageResponseTime');
    expect(state.getMicroserviceMetrics).not.toHaveBeenCalled();
  });

  it('fails closed for every backup operation before database access', async () => {
    const { createApp } = await import('./index.js');
    const app = createApp();

    const api = await requestFor(app);
    const list = await api.get('/api/backup');
    const read = await api.get('/api/backup/project123');
    const write = await api.put('/api/backup/project123').send({ data: { cards: [] } });
    const remove = await api.delete('/api/backup/project123');

    for (const response of [list, read, write, remove]) {
      expect(response.status).toBe(401);
      expect(response.body).toEqual({ error: 'unauthorized' });
    }
    expect(state.getDatabase).not.toHaveBeenCalled();
  });

  it('registers backup read capability ahead of its handler', async () => {
    state.getDatabase.mockReturnValue({
      prepare: vi.fn(() => ({ all: vi.fn(() => []) })),
    });
    const { createApp } = await import('./index.js');

    const response = await (await requestFor(createApp({ privateCredentialVerifier: verifierFor(backupReadIdentity) })))
      .get('/api/backup')
      .set('Authorization', 'Bearer valid-bearer');

    expect(response.status).toBe(200);
    expect(state.getDatabase).toHaveBeenCalledOnce();
  });

  it('rejects an authenticated identity without metrics read capability before metrics data is read', async () => {
    const { createApp } = await import('./index.js');

    const response = await (await requestFor(createApp({ privateCredentialVerifier: verifierFor(writeIdentity) })))
      .get('/api/metrics')
      .set('Authorization', 'Bearer valid-bearer');

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: 'forbidden' });
    expect(response.text).not.toContain('averageResponseTime');
    expect(state.getMicroserviceMetrics).not.toHaveBeenCalled();
  });

  it('allows a server-verified metrics reader without trusting request identity fields', async () => {
    const { createApp } = await import('./index.js');

    const response = await (await requestFor(createApp({ privateCredentialVerifier: verifierFor(readIdentity) })))
      .get('/api/metrics?ownerId=client-owner')
      .set('Authorization', 'Bearer valid-bearer')
      .set('X-Owner-Id', 'client-owner');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      success: true,
      data: { averageResponseTime: 100, errorRate: 1, requests: 3 },
    });
    expect(state.getMicroserviceMetrics).toHaveBeenCalledOnce();
  });

  it('requires metrics write capability before log or reset side effects', async () => {
    const { createApp } = await import('./index.js');
    const readOnlyApp = createApp({ privateCredentialVerifier: verifierFor(readIdentity) });

    const missingConfiguration = await (await requestFor(createApp())).post('/api/metrics/log');
    const readOnly = await (await requestFor(readOnlyApp))
      .post('/api/metrics/reset')
      .set('Authorization', 'Bearer valid-bearer');

    expect(missingConfiguration.status).toBe(401);
    expect(missingConfiguration.body).toEqual({ error: 'unauthorized' });
    expect(readOnly.status).toBe(403);
    expect(readOnly.body).toEqual({ error: 'forbidden' });
    expect(state.logMicroserviceMetrics).not.toHaveBeenCalled();
    expect(state.resetMicroserviceMetrics).not.toHaveBeenCalled();

    const writerApp = createApp({ privateCredentialVerifier: verifierFor(writeIdentity) });
    const logged = await (await requestFor(writerApp))
      .post('/api/metrics/log')
      .set('Authorization', 'Bearer valid-bearer');
    const reset = await (await requestFor(writerApp))
      .post('/api/metrics/reset')
      .set('Authorization', 'Bearer valid-bearer');

    expect(logged.status).toBe(200);
    expect(reset.status).toBe(200);
    expect(state.logMicroserviceMetrics).toHaveBeenCalledOnce();
    expect(state.resetMicroserviceMetrics).toHaveBeenCalledOnce();
  });

  it('protects deep health before dependency checks', async () => {
    const { createApp } = await import('./index.js');

    const denied = await (await requestFor(createApp())).get('/health/deep');

    expect(denied.status).toBe(401);
    expect(denied.body).toEqual({ error: 'unauthorized' });
    expect(denied.text).not.toContain('checks');
    expect(state.getDatabase).not.toHaveBeenCalled();
    expect(state.isMicroserviceAvailable).not.toHaveBeenCalled();

    const authorized = await (await requestFor(createApp({ privateCredentialVerifier: verifierFor(readIdentity) })))
      .get('/health/deep')
      .set('Authorization', 'Bearer valid-bearer');
    expect(authorized.status).toBe(200);
    expect(authorized.body.checks).toEqual({ database: 'ok', microservice: 'ok' });
  });

  it('keeps shallow health public without exposing private metric details', async () => {
    const { createApp } = await import('./index.js');

    const response = await (await requestFor(createApp())).get('/health');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      status: 'ok',
      uptime: expect.any(Number),
      timestamp: expect.any(String),
    });
    expect(response.text).not.toContain('averageResponseTime');
    expect(state.getMicroserviceMetrics).not.toHaveBeenCalled();
    expect(state.getDatabase).not.toHaveBeenCalled();
  });
});
