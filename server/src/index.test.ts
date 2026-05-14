import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => {
  const app = {
    use: vi.fn(),
    get: vi.fn(),
    listen: vi.fn(),
  };
  return {
    app,
    corsOptions: undefined as unknown,
    compressionOptions: undefined as unknown,
    helmetOptions: undefined as unknown,
    initDatabase: vi.fn(),
    initCatalogs: vi.fn(),
    startImportScheduler: vi.fn(),
    cleanupExpiredShares: vi.fn(),
    logMicroserviceMetrics: vi.fn(),
    isMicroserviceAvailable: vi.fn(),
    dbPrepare: vi.fn(),
  };
});

vi.mock('express', () => {
  const expressFn = Object.assign(vi.fn(() => mocks.app), {
    json: vi.fn(() => 'json-middleware'),
  });
  return { default: expressFn };
});

vi.mock('cors', () => ({
  default: vi.fn((options) => {
    mocks.corsOptions = options;
    return 'cors-middleware';
  }),
}));

vi.mock('compression', () => {
  const compressionFn = Object.assign(vi.fn((options) => {
    mocks.compressionOptions = options;
    return 'compression-middleware';
  }), {
    filter: vi.fn(() => true),
  });
  return { default: compressionFn };
});

vi.mock('helmet', () => ({
  default: vi.fn((options) => {
    mocks.helmetOptions = options;
    return 'helmet-middleware';
  }),
}));

vi.mock('./db/db.js', () => ({
  initDatabase: mocks.initDatabase,
  getDatabase: () => ({ prepare: mocks.dbPrepare }),
  closeDatabase: vi.fn(),
}));
vi.mock('./utils/scryfallCatalog.js', () => ({ initCatalogs: mocks.initCatalogs }));
vi.mock('./services/importScheduler.js', () => ({ startImportScheduler: mocks.startImportScheduler }));
vi.mock('./services/scryfallMicroserviceClient.js', () => ({
  logMicroserviceMetrics: mocks.logMicroserviceMetrics,
  isMicroserviceAvailable: mocks.isMicroserviceAvailable,
}));
vi.mock('./routes/shareRouter.js', () => ({ shareRouter: 'share-router', cleanupExpiredShares: mocks.cleanupExpiredShares }));
vi.mock('./routes/archidektRouter.js', () => ({ archidektRouter: 'archidekt-router' }));
vi.mock('./routes/moxfieldRouter.js', () => ({ moxfieldRouter: 'moxfield-router' }));
vi.mock('./routes/imageRouter.js', () => ({ imageRouter: 'image-router' }));
vi.mock('./routes/streamRouter.js', () => ({ streamRouter: 'stream-router' }));
vi.mock('./routes/mpcAutofillRouter.js', () => ({ mpcAutofillRouter: 'mpc-router' }));
vi.mock('./routes/scryfallRouter.js', () => ({ scryfallRouter: 'scryfall-router' }));
vi.mock('./routes/backupRouter.js', () => ({ backupRouter: 'backup-router' }));
vi.mock('./routes/printerCalibrationRouter.js', () => ({ printerCalibrationRouter: 'printer-router' }));
vi.mock('./routes/preferencesRouter.js', () => ({ preferencesRouter: 'preferences-router' }));
vi.mock('./routes/metricsRouter.js', () => ({ default: 'metrics-router' }));

function getRoute(path: string) {
  const call = mocks.app.get.mock.calls.find(([registered]) => registered === path);
  return call?.[1] as ((req: unknown, res: { status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> }) => unknown) | undefined;
}

describe('server index', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    delete process.env.ALLOWED_ORIGINS;
    delete process.env.SCRYFALL_CACHE_URL;
    mocks.app.listen.mockImplementation((_port, _host, cb) => {
      const server = { address: () => ({ port: 4321 }) };
      queueMicrotask(cb);
      return server;
    });
    mocks.dbPrepare.mockReturnValue({ get: vi.fn(() => ({ ok: 1 })) });
    mocks.isMicroserviceAvailable.mockResolvedValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('runs startup hooks, registers middleware/routes, and resolves the actual port', async () => {
    const { startServer } = await import('./index.js');
    const port = await startServer(0);

    expect(port).toBe(4321);
    expect(mocks.initDatabase).toHaveBeenCalled();
    expect(mocks.initCatalogs).toHaveBeenCalled();
    expect(mocks.startImportScheduler).toHaveBeenCalled();
    expect(mocks.cleanupExpiredShares).toHaveBeenCalled();
    expect(mocks.app.use).toHaveBeenCalledWith('/api/metrics', 'metrics-router');
    expect(mocks.helmetOptions).toMatchObject({ hsts: { includeSubDomains: true, preload: true } });
  });

  it('allows configured, localhost, and originless CORS while rejecting unlisted remote origins', async () => {
    process.env.ALLOWED_ORIGINS = 'https://allowed.example';
    const { startServer } = await import('./index.js');
    await startServer(3001);

    const origin = (mocks.corsOptions as { origin: (origin: string | undefined, cb: (err: Error | null, ok?: boolean) => void) => void }).origin;
    const cb = vi.fn();
    origin(undefined, cb);
    origin('https://allowed.example', cb);
    origin('http://localhost:9999', cb);
    origin('not a url', cb);

    expect(cb).toHaveBeenNthCalledWith(1, null, true);
    expect(cb).toHaveBeenNthCalledWith(2, null, true);
    expect(cb).toHaveBeenNthCalledWith(3, null, true);
    expect(cb.mock.calls[3][0]).toBeInstanceOf(Error);
  });

  it('skips compression for server-sent events and uses default compression otherwise', async () => {
    const compression = await import('compression');
    const { startServer } = await import('./index.js');
    await startServer(3001);

    const filter = (mocks.compressionOptions as { filter: (req: unknown, res: { getHeader: (name: string) => string | undefined }) => boolean }).filter;
    expect(filter({}, { getHeader: () => 'text/event-stream; charset=utf-8' })).toBe(false);
    expect(filter({}, { getHeader: () => 'application/json' })).toBe(true);
    expect(compression.default.filter).toHaveBeenCalled();
  });

  it('serves simple and deep health checks', async () => {
    const { startServer } = await import('./index.js');
    await startServer(3001);

    const simpleRes = { json: vi.fn(), status: vi.fn().mockReturnThis() };
    getRoute('/health')?.({}, simpleRes);
    expect(simpleRes.json).toHaveBeenCalledWith(expect.objectContaining({ status: 'ok' }));

    const deepRes = { json: vi.fn(), status: vi.fn().mockReturnThis() };
    await getRoute('/health/deep')?.({}, deepRes);
    expect(deepRes.status).toHaveBeenCalledWith(200);
    expect(deepRes.json).toHaveBeenCalledWith(expect.objectContaining({
      status: 'ok',
      checks: { database: 'ok', microservice: 'ok' },
    }));
  });

  it('marks deep health degraded when checks fail', async () => {
    mocks.dbPrepare.mockImplementation(() => { throw new Error('db down'); });
    mocks.isMicroserviceAvailable.mockRejectedValue(new Error('service down'));
    const { startServer } = await import('./index.js');
    await startServer(3001);

    const deepRes = { json: vi.fn(), status: vi.fn().mockReturnThis() };
    await getRoute('/health/deep')?.({}, deepRes);

    expect(deepRes.status).toHaveBeenCalledWith(503);
    expect(deepRes.json).toHaveBeenCalledWith(expect.objectContaining({
      status: 'degraded',
      checks: { database: 'error', microservice: 'error' },
    }));
  });
});
