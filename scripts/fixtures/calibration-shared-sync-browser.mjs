const BYTE_SETS = Object.freeze({
  browser: new Uint8Array([2, 7, 1, 8, 2, 8]),
  electron: new Uint8Array([3, 1, 4, 1, 5, 9]),
});
const MIME_TYPE = 'application/octet-stream';
const MAX_ERROR_LENGTH = 180;

function bytesFor(role) {
  const bytes = BYTE_SETS[role];
  if (bytes === undefined) throw new Error('fixture page role is invalid');
  return bytes;
}

async function digest(bytes) {
  const copied = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', copied)),
    byte => byte.toString(16).padStart(2, '0'),
  ).join('');
}

export async function assertExactBytes(blob, expected) {
  if (blob === null || typeof blob !== 'object' || typeof blob.arrayBuffer !== 'function') {
    throw new Error('asset blob is unavailable');
  }
  if (!(expected instanceof Uint8Array) || blob.size !== expected.byteLength) {
    throw new Error('asset byte length differs');
  }
  const actual = new Uint8Array(await blob.arrayBuffer());
  for (let index = 0; index < expected.byteLength; index += 1) {
    if (actual[index] !== expected[index]) throw new Error(`asset byte mismatch at offset ${index}`);
  }
  const [actualSha256, expectedSha256] = await Promise.all([digest(actual), digest(expected)]);
  if (actualSha256 !== expectedSha256) throw new Error('asset SHA-256 differs');
  return Object.freeze({ byteLength: actual.byteLength, sha256: actualSha256 });
}

function boundedError(error) {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/calibration_pair_[A-Za-z0-9_-]+/g, '[credential]')
    .replace(/[\r\n]+/g, ' ')
    .slice(0, MAX_ERROR_LENGTH) || 'fixture failed';
}

function redactResult(value, key = '') {
  if (/credential|token|secret|authorization|origin|profile|connection|endpoint/i.test(key)) return undefined;
  if (typeof value === 'string') return /^calibration_pair_[A-Za-z0-9_-]+$/.test(value) ? undefined : value;
  if (Array.isArray(value)) return value.map(entry => redactResult(entry)).filter(entry => entry !== undefined);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .map(([entryKey, entryValue]) => [entryKey, redactResult(entryValue, entryKey)])
      .filter(([, entryValue]) => entryValue !== undefined));
  }
  return value;
}

export function browserResultEnvelope(mode, result) {
  if (mode !== 'seed' && mode !== 'observe') throw new Error('browser fixture mode is invalid');
  return { kind: 'browser-result', mode, result: redactResult(result) };
}

export function parseBrowserDriverArguments(args) {
  if (!Array.isArray(args) || args.length !== 4) {
    throw new Error('browser fixture requires mode, loopback origin, and absolute owned paths');
  }
  const [mode, origin, profile, credentialFile] = args;
  let parsedOrigin;
  try {
    parsedOrigin = new URL(origin);
  } catch {
    parsedOrigin = undefined;
  }
  if (
    (mode !== 'seed' && mode !== 'observe') ||
    parsedOrigin?.protocol !== 'http:' ||
    parsedOrigin.hostname !== '127.0.0.1' ||
    !/^[1-9][0-9]{0,4}$/.test(parsedOrigin.port) ||
    parsedOrigin.pathname !== '/' || parsedOrigin.search !== '' || parsedOrigin.hash !== '' ||
    typeof profile !== 'string' || !profile.startsWith('/') ||
    typeof credentialFile !== 'string' || !credentialFile.startsWith('/')
  ) throw new Error('browser fixture requires mode, loopback origin, and absolute owned paths');
  return { mode, origin: parsedOrigin.origin, profile, credentialFile };
}

async function waitFor(check, message) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await check();
    if (result !== undefined) return result;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(message);
}

async function browserPage() {
  const role = new URL(location.href).searchParams.get('role');
  if (role !== 'browser' && role !== 'electron') throw new Error('fixture page role is invalid');
  const [
    { ProxxiedDexie },
    { createMpcCalibrationWebTransport },
    { createMpcCalibrationElectronTransport },
    { pairMpcCalibrationWeb },
    { runMpcCalibrationInitialAdmissionWithIdentity },
    { createMpcCalibrationMutationCoordinator },
    { createMpcCalibrationQueueRecoveryController },
    { createMpcCalibrationOperationScope },
  ] = await Promise.all([
    import('/client/src/db.ts'),
    import('/client/src/helpers/mpcCalibrationWebTransport.ts'),
    import('/client/src/helpers/mpcCalibrationElectronTransport.ts'),
    import('/client/src/helpers/mpcCalibrationWebPairing.ts'),
    import('/client/src/helpers/mpcCalibrationInitialAdmission.ts'),
    import('/client/src/helpers/mpcCalibrationMutations.ts'),
    import('/client/src/helpers/mpcCalibrationQueueRecoveryController.ts'),
    import('/client/src/helpers/mpcCalibrationOperationScope.ts'),
  ]);
  const database = new ProxxiedDexie(`q1-shared-sync-${role}`);
  const target = role === 'browser' ? 'linked-web' : 'linked-electron';
  const transport = role === 'browser' ? createMpcCalibrationWebTransport() : createMpcCalibrationElectronTransport();
  const output = document.querySelector('#status');
  if (!(output instanceof HTMLElement)) throw new Error('fixture status output is unavailable');
  const set = text => { output.textContent = text; };
  let identity;
  let appScope;
  let appOperation;

  const requireAction = action => {
    const element = document.querySelector(`[data-action=${action}]`);
    if (!(element instanceof HTMLButtonElement)) throw new Error(`fixture action ${action} is unavailable`);
    return element;
  };

  async function authenticateAndAdmit() {
    let pairedIdentity = null;
    if (role === 'browser') {
      const input = document.querySelector('#credential');
      if (!(input instanceof HTMLInputElement)) throw new Error('browser credential input is unavailable');
      const pairScope = createMpcCalibrationOperationScope({ target, identity: null });
      try {
        const paired = await pairMpcCalibrationWeb({
          database,
          target,
          operation: pairScope.captureUiOperation(),
          transientCredential: {
            take: () => input.value,
            clear: () => { input.value = ''; },
          },
          createWebTransport: () => transport,
        });
        if (paired.kind !== 'paired') throw new Error(`browser pairing failed: ${paired.kind}`);
        pairedIdentity = paired.identity;
      } finally {
        pairScope.dispose();
      }
    } else if (document.querySelector('#credential, [data-action=pair]') !== null) {
      throw new Error('Electron renderer must not expose a web credential form or pairing action');
    }

    const admissionScope = createMpcCalibrationOperationScope({ target, identity: pairedIdentity });
    try {
      const admitted = await runMpcCalibrationInitialAdmissionWithIdentity({
        database,
        target,
        operation: admissionScope.captureAppOperation(),
        ...(role === 'browser' ? { createWebTransport: () => transport } : {}),
      });
      if (admitted.kind !== 'hydrated' || !('identity' in admitted)) {
        throw new Error(`admission failed: ${admitted.kind}`);
      }
      identity = admitted.identity;
    } finally {
      admissionScope.dispose();
    }
    appScope?.dispose();
    appScope = createMpcCalibrationOperationScope({ target, identity });
    appOperation = appScope.captureAppOperation();
  }

  async function assertPersistedRoles(roles) {
    const proofs = [];
    for (const expectedRole of roles) {
      const dataset = await database.mpcCalibrationDatasets.get(`${expectedRole}-dataset`);
      const asset = await database.mpcCalibrationAssets.get(`${expectedRole}-asset`);
      if (dataset === undefined || asset === undefined) throw new Error(`${expectedRole} dataset or asset is absent from IndexedDB`);
      const proof = await assertExactBytes(asset.blob, bytesFor(expectedRole));
      const expectedSha256 = await digest(bytesFor(expectedRole));
      if (asset.mimeType !== MIME_TYPE || asset.sha256 !== expectedSha256 || asset.byteLength !== proof.byteLength || proof.sha256 !== expectedSha256) {
        throw new Error(`${expectedRole} asset metadata is not byte-identical`);
      }
      proofs.push({ role: expectedRole, assetBytes: proof.byteLength, sha256: proof.sha256 });
    }
    return proofs;
  }

  async function mutateAndPublish() {
    if (identity === undefined || appOperation === undefined) throw new Error('fixture was not admitted');
    if (role === 'electron') await assertPersistedRoles(['browser']);
    const mutation = createMpcCalibrationMutationCoordinator(database);
    const mutationScope = await mutation.captureScope();
    if (mutationScope.kind !== 'bound') throw new Error('admitted cache has no durable mutation binding');
    const marker = `${role}-dataset`;
    const caseId = `${role}-case`;
    const assetId = `${role}-asset`;
    const binary = bytesFor(role);
    const sha256 = await digest(binary);
    const c5Results = [];
    const controller = createMpcCalibrationQueueRecoveryController({
      database,
      operation: appOperation,
      transport,
      onResult: result => c5Results.push(result),
    });
    try {
      await mutation.mutate(async () => {
        const now = Date.now();
        await database.mpcCalibrationDatasets.put({
          id: marker,
          name: marker,
          targetCaseCount: 1,
          createdAt: now,
          updatedAt: now,
          version: 1,
        });
        await database.mpcCalibrationCases.put({
          id: caseId,
          datasetId: marker,
          createdAt: now,
          updatedAt: now,
          source: { name: `${role} source` },
          candidates: [],
        });
        await database.mpcCalibrationAssets.put({
          id: assetId,
          datasetId: marker,
          caseId,
          role: 'source',
          mimeType: MIME_TYPE,
          blob: new Blob([binary], { type: MIME_TYPE }),
          createdAt: now,
        });
        return { value: undefined, changed: true };
      }, mutationScope);
      const c5 = await waitFor(
        async () => c5Results.find(result => result.kind === 'recovery' && result.status === 'published'),
        'C5 did not publish the queued mutation',
      );
      const remote = await transport.getSnapshot({ signal: appOperation.signal });
      const remoteAsset = remote?.snapshot.assets.find(asset => asset.id === assetId);
      if (
        remote === null ||
        !remote.snapshot.datasets.some(dataset => dataset.id === marker) ||
        remoteAsset === undefined ||
        remoteAsset.sha256 !== sha256 || remoteAsset.byteLength !== binary.byteLength || remoteAsset.mimeType !== MIME_TYPE
      ) throw new Error('C5 remote snapshot lacks the durable mutation');
      const remoteBytes = await transport.getBlob(sha256, { signal: appOperation.signal });
      await assertExactBytes(new Blob([remoteBytes], { type: MIME_TYPE }), binary);
      return { marker, assetId, sha256, assetBytes: binary.byteLength, revision: remote.revision, c5: c5.status };
    } finally {
      controller.dispose();
    }
  }

  async function observeBothClients() {
    if (identity === undefined || appOperation === undefined) throw new Error('fixture was not admitted');
    const assets = await assertPersistedRoles(['browser', 'electron']);
    const remote = await transport.getSnapshot({ signal: appOperation.signal });
    if (remote === null || !remote.snapshot.datasets.some(dataset => dataset.id === 'browser-dataset') || !remote.snapshot.datasets.some(dataset => dataset.id === 'electron-dataset')) {
      throw new Error('reopened browser did not admit the Electron revision');
    }
    return { revision: remote.revision, assets };
  }

  if (role === 'browser') {
    requireAction('pair').addEventListener('click', async () => {
      try {
        await authenticateAndAdmit();
        set('paired');
      } catch (error) {
        set(`failed:${boundedError(error)}`);
      }
    });
    requireAction('browser-edit').addEventListener('click', async () => {
      try {
        const proof = await mutateAndPublish();
        window.__calibrationSharedSyncResult = { status: 'PASS', role, proof };
        set('browser-published');
      } catch (error) {
        set(`failed:${boundedError(error)}`);
      }
    });
    requireAction('electron-edit').addEventListener('click', async () => {
      try {
        const proof = await observeBothClients();
        window.__calibrationSharedSyncResult = { status: 'PASS', role, proof };
        set('electron-observed');
      } catch (error) {
        set(`failed:${boundedError(error)}`);
      }
    });
  } else {
    requireAction('electron-edit').addEventListener('click', async () => {
      try {
        await authenticateAndAdmit();
        const proof = await mutateAndPublish();
        window.__calibrationSharedSyncResult = { status: 'PASS', role, proof };
        set('electron-published');
      } catch (error) {
        set(`failed:${boundedError(error)}`);
      }
    });
  }
}

function isDirectNodeEntry() {
  if (typeof process === 'undefined' || typeof process.argv?.[1] !== 'string' || typeof process.cwd !== 'function') return false;
  try {
    return new URL(process.argv[1], `file://${process.cwd()}/`).href === import.meta.url;
  } catch {
    return false;
  }
}

async function browserDriver() {
  const { mode, origin, profile, credentialFile } = parseBrowserDriverArguments(process.argv.slice(2));
  const [{ chromium }, { readFile }, path] = await Promise.all([
    import('playwright'),
    import('node:fs/promises'),
    import('node:path'),
  ]);
  if (!path.isAbsolute(profile) || !path.isAbsolute(credentialFile)) {
    throw new Error('browser fixture requires mode, loopback origin, and absolute owned paths');
  }
  let credential = (await readFile(credentialFile, 'utf8')).trim();
  if (!/^calibration_pair_[A-Za-z0-9_-]{43}$/.test(credential)) throw new Error('browser synthetic credential unavailable');
  let context;
  try {
    context = await chromium.launchPersistentContext(profile, {
      headless: true,
      executablePath: process.env.Q1_CHROMIUM_EXECUTABLE,
      chromiumSandbox: true,
      serviceWorkers: 'block',
      args: ['--no-proxy-server', '--enable-logging=stderr'],
    });
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    process.stderr.write('browser-stage: launched\n');
    const page = await context.newPage();
    page.on('pageerror', error => process.stderr.write(`browser-page-error: ${boundedError(error)}\n`));
    page.on('requestfailed', request => process.stderr.write(`browser-request-failed: ${new URL(request.url()).pathname}\n`));
    await page.goto(`${origin}/calibration-shared-sync.html?role=browser`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => {
      const status = document.querySelector('#status')?.textContent ?? '';
      if (status.startsWith('failed:')) throw new Error(status);
      return window.__calibrationSharedSyncReady === true;
    }, null, { timeout: 8000 });
    process.stderr.write('browser-stage: modules-ready\n');
    await page.locator('#credential').fill(credential);
    credential = '';
    await page.locator('[data-action=pair]').click();
    await page.waitForFunction(() => {
      const status = document.querySelector('#status')?.textContent ?? '';
      if (status.startsWith('failed:')) throw new Error(status);
      return status === 'paired';
    }, null, { timeout: 8000 });
    process.stderr.write('browser-stage: paired\n');
    await page.locator(mode === 'seed' ? '[data-action=browser-edit]' : '[data-action=electron-edit]').click();
    await page.waitForFunction(expected => {
      const status = document.querySelector('#status')?.textContent ?? '';
      if (status.startsWith('failed:')) throw new Error(status);
      return status === expected;
    }, mode === 'seed' ? 'browser-published' : 'electron-observed', { timeout: 8000 });
    const result = await page.evaluate(() => window.__calibrationSharedSyncResult);
    if (result?.status !== 'PASS') throw new Error('browser renderer did not prove production client lifecycle');
    process.stdout.write(`${JSON.stringify(browserResultEnvelope(mode, result))}\n`);
  } finally {
    credential = '';
    await context?.close();
  }
}

if (typeof window !== 'undefined') {
  void browserPage().then(() => { window.__calibrationSharedSyncReady = true; }).catch(error => {
    document.querySelector('#status').textContent = `failed:${boundedError(error)}`;
  });
} else if (isDirectNodeEntry()) {
  void browserDriver().catch(error => {
    const diagnostic = String(error?.stack ?? error).replace(/calibration_pair_[A-Za-z0-9_-]+/g, '[redacted]').slice(0, 16000);
    process.stderr.write(`browser fixture failed: ${diagnostic}\n`);
    process.exitCode = 1;
  });
}
