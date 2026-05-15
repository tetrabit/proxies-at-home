import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type RequestHandler = (...args: unknown[]) => unknown;
type CorsOrigin = (origin: string | undefined, cb: (error: Error | null, allow?: boolean) => void) => void;
type CompressionFilter = (req: unknown, res: unknown) => unknown;

const state = vi.hoisted(() => ({
  app: undefined as undefined | {
    use: ReturnType<typeof vi.fn>;
    get: ReturnType<typeof vi.fn>;
    listen: ReturnType<typeof vi.fn>;
  },
  getHandlers: new Map<string, RequestHandler>(),
  corsOptions: undefined as undefined | { origin: CorsOrigin },
  compressionOptions: undefined as undefined | { filter: CompressionFilter },
  initDatabase: vi.fn(),
  getDatabase: vi.fn(),
  initCatalogs: vi.fn(),
  startImportScheduler: vi.fn(),
  cleanupExpiredShares: vi.fn(),
  closeDatabase: vi.fn(),
  isMicroserviceAvailable: vi.fn(),
  logMicroserviceMetrics: vi.fn(),
  listenAddress: undefined as undefined | string | { port?: number },
}));

vi.mock('express', () => {
  const express = vi.fn(() => {
    const app = {
      use: vi.fn(),
      get: vi.fn((path: string, handler: RequestHandler) => {
        state.getHandlers.set(path, handler);
      }),
      listen: vi.fn((port: number, _host: string, cb: () => void) => {
        const server = {
          address: () => state.listenAddress ?? { port: port === 0 ? 49152 : port },
        };
        queueMicrotask(() => cb());
        return server;
      }),
    };
    state.app = app;
    return app;
  });
  Object.assign(express, {
    json: vi.fn((options: unknown) => ({ middleware: 'json', options })),
  });
  return { default: express };
});

vi.mock('cors', () => ({
  default: vi.fn((options: { origin: CorsOrigin }) => {
    state.corsOptions = options;
    return { middleware: 'cors' };
  }),
}));

vi.mock('compression', () => {
  const compression = vi.fn((options: { filter: CompressionFilter }) => {
    state.compressionOptions = options;
    return { middleware: 'compression' };
  });
  Object.assign(compression, { filter: vi.fn(() => 'default-filter-result') });
  return { default: compression };
});

vi.mock('helmet', () => ({ default: vi.fn((options: unknown) => ({ middleware: 'helmet', options })) }));
vi.mock('./db/db.js', () => ({
  initDatabase: state.initDatabase,
  getDatabase: state.getDatabase,
  closeDatabase: state.closeDatabase,
}));
vi.mock('./services/importScheduler.js', () => ({ startImportScheduler: state.startImportScheduler }));
vi.mock('./utils/scryfallCatalog.js', () => ({ initCatalogs: state.initCatalogs }));
vi.mock('./services/scryfallMicroserviceClient.js', () => ({
  isMicroserviceAvailable: state.isMicroserviceAvailable,
  logMicroserviceMetrics: state.logMicroserviceMetrics,
}));
vi.mock('./routes/shareRouter.js', () => ({ shareRouter: { route: 'share' }, cleanupExpiredShares: state.cleanupExpiredShares }));
vi.mock('./routes/archidektRouter.js', () => ({ archidektRouter: { route: 'archidekt' } }));
vi.mock('./routes/moxfieldRouter.js', () => ({ moxfieldRouter: { route: 'moxfield' } }));
vi.mock('./routes/imageRouter.js', () => ({ imageRouter: { route: 'image' } }));
vi.mock('./routes/streamRouter.js', () => ({ streamRouter: { route: 'stream' } }));
vi.mock('./routes/mpcAutofillRouter.js', () => ({ mpcAutofillRouter: { route: 'mpc' } }));
vi.mock('./routes/scryfallRouter.js', () => ({ scryfallRouter: { route: 'scryfall' } }));
vi.mock('./routes/backupRouter.js', () => ({ backupRouter: { route: 'backup' } }));
vi.mock('./routes/printerCalibrationRouter.js', () => ({ printerCalibrationRouter: { route: 'printer' } }));
vi.mock('./routes/preferencesRouter.js', () => ({ preferencesRouter: { route: 'preferences' } }));
vi.mock('./routes/metricsRouter.js', () => ({ default: { route: 'metrics' } }));

function createResponse() {
  return {
    statusCode: 200,
    body: undefined as unknown,
    status: vi.fn(function (this: { statusCode: number }, code: number) {
      this.statusCode = code;
      return this;
    }),
    json: vi.fn(function (this: { body: unknown }, body: unknown) {
      this.body = body;
      return this;
    }),
    getHeader: vi.fn(),
  };
}

describe('server index bootstrap and app wiring', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:10Z'));
    delete process.env.SCRYFALL_CACHE_URL;
    delete process.env.ALLOWED_ORIGINS;
    state.getHandlers.clear();
    state.corsOptions = undefined;
    state.compressionOptions = undefined;
    state.listenAddress = undefined;
    state.initDatabase.mockClear();
    state.getDatabase.mockReset().mockReturnValue({ prepare: vi.fn(() => ({ get: vi.fn(() => ({ ok: 1 })) })) });
    state.initCatalogs.mockClear();
    state.startImportScheduler.mockClear();
    state.cleanupExpiredShares.mockClear();
    state.closeDatabase.mockClear();
    state.isMicroserviceAvailable.mockReset().mockResolvedValue(true);
    state.logMicroserviceMetrics.mockClear();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('initializes side effects, registers middleware/routes, and starts on requested port', async () => {
    const { startServer } = await import('./index.js');

    expect(state.initDatabase).toHaveBeenCalledOnce();
    expect(state.initCatalogs).toHaveBeenCalledOnce();
    expect(state.startImportScheduler).toHaveBeenCalledOnce();
    expect(state.cleanupExpiredShares).toHaveBeenCalledOnce();

    const port = await startServer(0);
    expect(port).toBe(49152);
    expect(state.app?.use).toHaveBeenCalledWith('/api/scryfall', { route: 'scryfall' });
    expect(state.app?.use).toHaveBeenCalledWith('/api/metrics', { route: 'metrics' });
    expect(state.app?.listen).toHaveBeenCalledWith(0, '0.0.0.0', expect.any(Function));

    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(state.cleanupExpiredShares).toHaveBeenCalledTimes(2);
  });

  it('implements health and deep-health success/degraded branches', async () => {
    const { startServer } = await import('./index.js');
    await startServer(3001);

    const healthRes = createResponse();
    state.getHandlers.get('/health')?.({}, healthRes);
    expect(healthRes.body).toMatchObject({ status: 'ok', uptime: 0 });

    const deepOk = createResponse();
    await state.getHandlers.get('/health/deep')?.({}, deepOk);
    expect(deepOk.status).toHaveBeenCalledWith(200);
    expect(deepOk.body).toMatchObject({ status: 'ok', checks: { database: 'ok', microservice: 'ok' } });

    state.isMicroserviceAvailable.mockResolvedValueOnce(false);
    const deepUnavailable = createResponse();
    await state.getHandlers.get('/health/deep')?.({}, deepUnavailable);
    expect(deepUnavailable.status).toHaveBeenCalledWith(503);
    expect(deepUnavailable.body).toMatchObject({ status: 'degraded', checks: { microservice: 'unavailable' } });
  });

  it('implements deep-health database and microservice error branches', async () => {
    const { startServer } = await import('./index.js');
    await startServer(3001);

    state.getDatabase.mockImplementationOnce(() => {
      throw new Error('db closed');
    });
    const databaseError = createResponse();
    await state.getHandlers.get('/health/deep')?.({}, databaseError);
    expect(databaseError.status).toHaveBeenCalledWith(503);
    expect(databaseError.body).toMatchObject({ status: 'degraded', checks: { database: 'error', microservice: 'ok' } });

    state.isMicroserviceAvailable.mockRejectedValueOnce(new Error('health failed'));
    const microserviceError = createResponse();
    await state.getHandlers.get('/health/deep')?.({}, microserviceError);
    expect(microserviceError.status).toHaveBeenCalledWith(503);
    expect(microserviceError.body).toMatchObject({ status: 'degraded', checks: { database: 'ok', microservice: 'error' } });
  });

  it('covers CORS origin decisions and compression filter branches', async () => {
    process.env.ALLOWED_ORIGINS = 'https://app.example';
    const compression = (await import('compression')).default as unknown as { filter: ReturnType<typeof vi.fn> };
    const { startServer } = await import('./index.js');
    await startServer(3001);

    const corsCallback = vi.fn();
    state.corsOptions?.origin(undefined, corsCallback);
    state.corsOptions?.origin('https://app.example', corsCallback);
    state.corsOptions?.origin('http://localhost:5173', corsCallback);
    state.corsOptions?.origin('http://127.0.0.1:5173', corsCallback);
    state.corsOptions?.origin('http://[::1]:5173', corsCallback);
    state.corsOptions?.origin('not a url', corsCallback);

    expect(corsCallback).toHaveBeenNthCalledWith(1, null, true);
    expect(corsCallback).toHaveBeenNthCalledWith(2, null, true);
    expect(corsCallback).toHaveBeenNthCalledWith(3, null, true);
    expect(corsCallback).toHaveBeenNthCalledWith(4, null, true);
    expect(corsCallback).toHaveBeenNthCalledWith(5, null, true);
    expect(corsCallback.mock.calls[5][0]).toBeInstanceOf(Error);

    const sseRes = createResponse();
    sseRes.getHeader.mockReturnValue('text/event-stream');
    expect(state.compressionOptions?.filter({}, sseRes)).toBe(false);

    const jsonRes = createResponse();
    jsonRes.getHeader.mockReturnValue('application/json');
    expect(state.compressionOptions?.filter({ accepts: true }, jsonRes)).toBe('default-filter-result');
    expect(compression.filter).toHaveBeenCalledWith({ accepts: true }, jsonRes);
  });

  it('schedules metrics logging when SCRYFALL_CACHE_URL is configured', async () => {
    process.env.SCRYFALL_CACHE_URL = 'http://microservice.test';
    await import('./index.js');

    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(state.logMicroserviceMetrics).toHaveBeenCalledOnce();
  });

  it('uses port fallbacks for non-TCP and missing-address listeners', async () => {
    const { startServer } = await import('./index.js');

    state.listenAddress = 'named-pipe';
    await expect(startServer(3002)).resolves.toBe(3002);

    state.listenAddress = {};
    await expect(startServer(3003)).resolves.toBe(3003);
  });

  it('starts when executed directly and handles graceful shutdown outcomes', async () => {
    const originalArgv1 = process.argv[1];
    const processOnSpy = vi.spyOn(process, 'on').mockImplementation(() => process);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    process.argv[1] = fileURLToPath(new URL('./index.ts', import.meta.url));
    await import('./index.js');
    await Promise.resolve();

    expect(state.app?.listen).toHaveBeenCalledWith(3001, '0.0.0.0', expect.any(Function));

    const sigtermHandler = processOnSpy.mock.calls.find(([event]) => event === 'SIGTERM')?.[1] as (() => Promise<void>) | undefined;
    const sigintHandler = processOnSpy.mock.calls.find(([event]) => event === 'SIGINT')?.[1] as (() => Promise<void>) | undefined;

    await sigtermHandler?.();
    expect(state.closeDatabase).toHaveBeenCalledOnce();
    expect(exitSpy).toHaveBeenCalledWith(0);

    state.closeDatabase.mockImplementationOnce(() => {
      throw new Error('close failed');
    });
    await sigintHandler?.();
    expect(console.error).toHaveBeenCalledWith('[Server] Error during shutdown:', expect.any(Error));
    expect(exitSpy).toHaveBeenCalledWith(1);

    process.argv[1] = originalArgv1;
  });
});
