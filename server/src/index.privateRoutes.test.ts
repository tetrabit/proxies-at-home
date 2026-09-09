import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PrivateCredentialVerifier, PrivateIdentity } from './auth/privateRouteAuth.js';

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
vi.mock('./routes/backupRouter.js', () => ({ backupRouter: express.Router() }));
vi.mock('./routes/printerCalibrationRouter.js', () => ({ printerCalibrationRouter: express.Router() }));
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

function verifierFor(identity: PrivateIdentity | null): PrivateCredentialVerifier {
  return { verifyBearer: vi.fn(() => identity) };
}

describe('private metrics route registration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.getDatabase.mockReturnValue({ prepare: vi.fn(() => ({ get: vi.fn(() => ({ ok: 1 })) })) });
    state.getMicroserviceMetrics.mockReturnValue({ averageResponseTime: 100, errorRate: 1, requests: 3 });
    state.isMicroserviceAvailable.mockResolvedValue(true);
  });

  it('fails closed without server credential configuration before metrics data is read', async () => {
    const { createApp } = await import('./index.js');

    const app = createApp();
    const response = await request(app).get('/api/metrics');
    const health = await request(app).get('/api/metrics/health');

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: 'unauthorized' });
    expect(response.text).not.toContain('averageResponseTime');
    expect(health.status).toBe(401);
    expect(health.body).toEqual({ error: 'unauthorized' });
    expect(health.text).not.toContain('averageResponseTime');
    expect(state.getMicroserviceMetrics).not.toHaveBeenCalled();
  });

  it('rejects an authenticated identity without metrics read capability before metrics data is read', async () => {
    const { createApp } = await import('./index.js');

    const response = await request(createApp({ privateCredentialVerifier: verifierFor(writeIdentity) }))
      .get('/api/metrics')
      .set('Authorization', 'Bearer valid-bearer');

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: 'forbidden' });
    expect(response.text).not.toContain('averageResponseTime');
    expect(state.getMicroserviceMetrics).not.toHaveBeenCalled();
  });

  it('allows a server-verified metrics reader without trusting request identity fields', async () => {
    const { createApp } = await import('./index.js');

    const response = await request(createApp({ privateCredentialVerifier: verifierFor(readIdentity) }))
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

    const missingConfiguration = await request(createApp()).post('/api/metrics/log');
    const readOnly = await request(readOnlyApp)
      .post('/api/metrics/reset')
      .set('Authorization', 'Bearer valid-bearer');

    expect(missingConfiguration.status).toBe(401);
    expect(missingConfiguration.body).toEqual({ error: 'unauthorized' });
    expect(readOnly.status).toBe(403);
    expect(readOnly.body).toEqual({ error: 'forbidden' });
    expect(state.logMicroserviceMetrics).not.toHaveBeenCalled();
    expect(state.resetMicroserviceMetrics).not.toHaveBeenCalled();

    const writerApp = createApp({ privateCredentialVerifier: verifierFor(writeIdentity) });
    const logged = await request(writerApp)
      .post('/api/metrics/log')
      .set('Authorization', 'Bearer valid-bearer');
    const reset = await request(writerApp)
      .post('/api/metrics/reset')
      .set('Authorization', 'Bearer valid-bearer');

    expect(logged.status).toBe(200);
    expect(reset.status).toBe(200);
    expect(state.logMicroserviceMetrics).toHaveBeenCalledOnce();
    expect(state.resetMicroserviceMetrics).toHaveBeenCalledOnce();
  });

  it('protects deep health before dependency checks', async () => {
    const { createApp } = await import('./index.js');

    const denied = await request(createApp()).get('/health/deep');

    expect(denied.status).toBe(401);
    expect(denied.body).toEqual({ error: 'unauthorized' });
    expect(denied.text).not.toContain('checks');
    expect(state.getDatabase).not.toHaveBeenCalled();
    expect(state.isMicroserviceAvailable).not.toHaveBeenCalled();

    const authorized = await request(createApp({ privateCredentialVerifier: verifierFor(readIdentity) }))
      .get('/health/deep')
      .set('Authorization', 'Bearer valid-bearer');
    expect(authorized.status).toBe(200);
    expect(authorized.body.checks).toEqual({ database: 'ok', microservice: 'ok' });
  });

  it('keeps shallow health public without exposing private metric details', async () => {
    const { createApp } = await import('./index.js');

    const response = await request(createApp()).get('/health');

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
