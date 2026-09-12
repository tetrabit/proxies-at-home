import { randomBytes } from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { chmod, mkdir, writeFile } from 'node:fs/promises';

import express from 'express';
import { createServer as createViteServer, type ViteDevServer } from 'vite';

import { createCalibrationHarnessCredentialStore } from '../../server/src/auth/calibrationHarnessIdentity.js';
import { createCalibrationHarnessRuntime } from '../../server/src/services/calibrationHarnessRuntime.js';
import { createCalibrationHarnessStore } from '../../server/src/db/calibrationHarnessStore.js';

export type SharedSyncService = Readonly<{
  origin: string;
  close(): Promise<void>;
}>;

type SharedSyncInput = Readonly<{
  root: string;
  run: string;
  data: string;
  browserCredentialFile: string;
  electronConnectionFile: string;
}>;

const credentialPattern = /^calibration_pair_[A-Za-z0-9_-]{43}$/;
const token = () => `calibration_pair_${randomBytes(32).toString('base64url')}`;

async function stage(run: string, value: string): Promise<void> {
  await writeFile(path.join(run, 'reports', 'service-stage.txt'), `${value}\n`, { mode: 0o600 });
}

async function closeListener(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

/** Starts the real calibration runtime and only reports ready after router, credential, and Vite middleware are usable. */
export async function startSharedSyncService(input: SharedSyncInput): Promise<SharedSyncService> {
  await stage(input.run, 'directories');
  for (const directory of [input.run, input.data, path.dirname(input.browserCredentialFile), path.dirname(input.electronConnectionFile)]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
  }

  const app = express();
  const server = http.createServer(app);
  let runtime: ReturnType<typeof createCalibrationHarnessRuntime> | null = null;
  let vite: ViteDevServer | null = null;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('owned loopback service has no TCP address');
    const origin = `http://127.0.0.1:${address.port}`;
    await stage(input.run, 'listener-ready');

    runtime = createCalibrationHarnessRuntime({ dataDirectory: input.data, allowedWebOrigins: [origin] });
    createCalibrationHarnessStore(runtime.database).publish('q1-synthetic-owner', 'q1-shared-harness', null, {
      version: 1, datasets: [], cases: [], assets: [], runs: [],
    });
    const credential = createCalibrationHarnessCredentialStore(runtime.database).provision({
      ownerId: 'q1-synthetic-owner',
      harnessId: 'q1-shared-harness',
      expiresAt: Date.now() + 10 * 60_000,
    });
    if (!credentialPattern.test(credential)) throw new Error('production credential store returned invalid synthetic credential');
    await writeFile(input.browserCredentialFile, `${credential}\n`, { mode: 0o600 });
    await chmod(input.browserCredentialFile, 0o600);
    await writeFile(input.electronConnectionFile, JSON.stringify({
      version: 1,
      backendOrigin: origin,
      harnessId: 'q1-shared-harness',
      credential,
    }), { mode: 0o600 });
    await chmod(input.electronConnectionFile, 0o600);
    await stage(input.run, 'runtime-ready');

    app.use('/api/calibration-harness', runtime.router);
    app.get('/calibration-shared-sync.html', (request, response) => {
      const webControls = request.query.role === 'browser'
        ? '<label>Credential <input id="credential" type="password" autocomplete="off"></label><button data-action="pair">Pair</button><button data-action="browser-edit">Browser edit</button>'
        : '';
      response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
      response.type('html').send(`<!doctype html><main><h1>Shared calibration Q1</h1>${webControls}<button data-action="electron-edit">Electron edit</button><output id="status">ready</output><script type="module" src="/scripts/fixtures/calibration-shared-sync-browser.mjs"></script></main>`);
    });
    vite = await createViteServer({
      configFile: false,
      resolve: { alias: { '@': path.join(input.root, 'client/src') } },
      root: input.root,
      appType: 'custom',
      optimizeDeps: { exclude: ['playwright', 'playwright-core'] },
      cacheDir: path.join(input.run, 'vite-cache'),
      server: { middlewareMode: true, hmr: false, watch: null },
    });
    app.use(vite.middlewares);
    await stage(input.run, 'router-ready');

    let closed = false;
    return {
      origin,
      async close() {
        if (closed) return;
        closed = true;
        const failures: unknown[] = [];
        try { await vite?.close(); } catch (error) { failures.push(error); }
        try { await closeListener(server); } catch (error) { failures.push(error); }
        try { runtime?.close(); } catch (error) { failures.push(error); }
        if (failures.length > 0) throw failures[0];
      },
    };
  } catch (error) {
    await stage(input.run, 'startup-failed');
    try { await vite?.close(); } catch { /* preserve startup failure */ }
    try { await closeListener(server); } catch { /* preserve startup failure */ }
    try { runtime?.close(); } catch { /* preserve startup failure */ }
    throw error;
  }
}

async function runCli(): Promise<void> {
  const [root, run, data, browserCredentialFile, electronConnectionFile] = process.argv.slice(3);
  if (![root, run, data, browserCredentialFile, electronConnectionFile].every((value) => typeof value === 'string' && path.isAbsolute(value))) {
    throw new Error('service requires absolute owned paths');
  }
  const service = await startSharedSyncService({ root, run, data, browserCredentialFile, electronConnectionFile });
  process.stdout.write(`${JSON.stringify({ kind: 'ready', origin: service.origin })}\n`);
  let stopping: Promise<void> | null = null;
  const stop = () => {
    stopping ??= service.close().then(() => { process.exitCode = 0; });
    return stopping;
  };
  process.once('SIGTERM', () => { void stop(); });
  process.once('SIGINT', () => { void stop(); });
}

if (process.argv[2] === '--run') {
  void runCli().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
