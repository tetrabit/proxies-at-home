const EXPECTED = Object.freeze({ datasets: 1, cases: 124, assets: 7227, runs: 25, uniqueBlobs: 5817, revision: 1 });

function fail(message) {
  throw new Error(`Q3 readonly browser fixture: ${message}`);
}

async function digest(blob) {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const result = await crypto.subtle.digest('SHA-256', buffer);
  return {
    byteLength: bytes.byteLength,
    sha256: Array.from(new Uint8Array(result), value => value.toString(16).padStart(2, '0')).join(''),
  };
}

/** Derive and fail-close on the known sealed snapshot cardinalities before local Blob inspection. */
export function canonicalCounts(snapshot) {
  if (snapshot === null || typeof snapshot !== 'object' || !Array.isArray(snapshot.datasets) || !Array.isArray(snapshot.cases)
    || !Array.isArray(snapshot.assets) || !Array.isArray(snapshot.runs)) fail('invalid remote snapshot');
  const uniqueBlobs = new Set(snapshot.assets.map(asset => asset?.sha256)).size;
  const counts = { datasets: snapshot.datasets.length, cases: snapshot.cases.length, assets: snapshot.assets.length, runs: snapshot.runs.length, uniqueBlobs };
  if (Object.entries(EXPECTED).some(([key, expected]) => key !== 'revision' && counts[key] !== expected)) fail('unexpected snapshot counts');
  return Object.freeze(counts);
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().filter(key => value[key] !== undefined)
      .map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Verify the C3 copy retained every snapshot metadata field, not merely row counts. */
export function assertExactRows(localRows, remoteRows, label) {
  if (!Array.isArray(localRows) || !Array.isArray(remoteRows) || localRows.length !== remoteRows.length) fail(`${label} rows differ`);
  const local = new Map(localRows.map(row => [row?.id, row]));
  const remote = new Map(remoteRows.map(row => [row?.id, row]));
  if (local.size !== localRows.length || remote.size !== remoteRows.length || local.size !== remote.size) fail(`${label} row identities differ`);
  for (const [id, remoteRow] of remote) {
    const localRow = local.get(id);
    if (localRow === undefined || stableJson(localRow) !== stableJson(remoteRow)) fail(`${label} row metadata differs`);
  }
}

/** Sequentially re-hash the production C3/Dexie blobs without retaining an all-asset byte fan-out. */
export async function validateHydratedCache(database, revision) {
  if (!Number.isSafeInteger(revision?.revision) || revision.revision !== EXPECTED.revision) fail('unexpected snapshot revision');
  const snapshot = revision.snapshot;
  const counts = canonicalCounts(snapshot);
  const [datasets, cases, assets, runs, binding, staging] = await Promise.all([
    database.mpcCalibrationDatasets.toArray(), database.mpcCalibrationCases.toArray(), database.mpcCalibrationAssets.toArray(),
    database.mpcCalibrationRuns.toArray(), database.mpcCalibrationCacheBindings.get('mpc-calibration-cache-binding'),
    database.mpcCalibrationHydrationStaging.count(),
  ]);
  if (datasets.length !== counts.datasets || cases.length !== counts.cases || assets.length !== counts.assets || runs.length !== counts.runs) {
    fail('Dexie table counts differ from remote snapshot');
  }
  if (binding === undefined || binding.revision !== EXPECTED.revision || staging !== 0) fail('C3 binding or staging completion differs');
  assertExactRows(datasets, snapshot.datasets, 'dataset');
  assertExactRows(cases, snapshot.cases, 'case');
  assertExactRows(runs, snapshot.runs, 'run');
  assertExactRows(assets.map(({ blob, ...metadata }) => metadata), snapshot.assets, 'asset');
  const remoteById = new Map(snapshot.assets.map(asset => [asset.id, asset]));
  let validatedAssets = 0;
  const localHashes = new Set();
  for (const local of assets) {
    const remote = remoteById.get(local.id);
    if (remote === undefined || !(local.blob instanceof Blob) || typeof remote.sha256 !== 'string' || typeof remote.byteLength !== 'number'
      || typeof remote.mimeType !== 'string') fail('local asset metadata differs');
    const proof = await digest(local.blob);
    if (proof.byteLength !== remote.byteLength || proof.sha256 !== remote.sha256 || local.blob.type !== remote.mimeType) {
      fail('local asset bytes differ');
    }
    localHashes.add(proof.sha256);
    validatedAssets += 1;
  }
  if (validatedAssets !== EXPECTED.assets || localHashes.size !== EXPECTED.uniqueBlobs) fail('local Blob validation count differs');
  return Object.freeze({ status: 'PASS', revision: revision.revision, counts, validatedAssets, uniqueBlobsValidated: localHashes.size });
}

function errorText(error) {
  return String(error instanceof Error ? error.message : error).replace(/calibration_pair_[A-Za-z0-9_-]+/g, '[REDACTED]').slice(0, 200);
}

async function installFixture() {
  const [{ ProxxiedDexie }, { createMpcCalibrationWebTransport }, { createMpcCalibrationElectronTransport }, { pairMpcCalibrationWeb }, { runMpcCalibrationInitialAdmissionWithIdentity }, { createMpcCalibrationOperationScope }] = await Promise.all([
    import('/src/db.ts'), import('/src/helpers/mpcCalibrationWebTransport.ts'), import('/src/helpers/mpcCalibrationElectronTransport.ts'),
    import('/src/helpers/mpcCalibrationWebPairing.ts'), import('/src/helpers/mpcCalibrationInitialAdmission.ts'), import('/src/helpers/mpcCalibrationOperationScope.ts'),
  ]);
  const root = document.createElement('section');
  root.id = 'q3-readonly-fixture';
  root.innerHTML = '<label>Pair credential <input id="q3-credential" type="password" autocomplete="off"></label><button id="q3-admit" type="button">Pair and read canonical dataset</button><output id="q3-status"></output>';
  document.body.append(root);
  const output = root.querySelector('#q3-status');
  const input = root.querySelector('#q3-credential');
  const button = root.querySelector('#q3-admit');
  if (!(output instanceof HTMLOutputElement) || !(input instanceof HTMLInputElement) || !(button instanceof HTMLButtonElement)) fail('fixture controls unavailable');

  async function admit(role) {
    const database = new ProxxiedDexie(`q3-canonical-readonly-${role}-${crypto.randomUUID()}`);
    const target = role === 'browser' ? 'linked-web' : 'linked-electron';
    const transport = role === 'browser' ? createMpcCalibrationWebTransport() : createMpcCalibrationElectronTransport();
    let pairedIdentity = null;
    if (role === 'browser') {
      const pairScope = createMpcCalibrationOperationScope({ target, identity: null });
      try {
        const paired = await pairMpcCalibrationWeb({
          database, target, operation: pairScope.captureUiOperation(), createWebTransport: () => transport,
          transientCredential: { take: () => input.value, clear: () => { input.value = ''; } },
        });
        if (paired.kind !== 'paired') fail(`pairing result ${paired.kind}`);
        pairedIdentity = paired.identity;
      } finally {
        input.value = '';
        pairScope.dispose();
      }
    }
    const admissionScope = createMpcCalibrationOperationScope({ target, identity: pairedIdentity });
    try {
      const admitted = await runMpcCalibrationInitialAdmissionWithIdentity({
        database, target, operation: admissionScope.captureAppOperation(), ...(role === 'browser' ? { createWebTransport: () => transport } : {}),
      });
      if (admitted.kind !== 'hydrated' || admitted.revision !== EXPECTED.revision || !('identity' in admitted)) fail(`C3 admission result ${admitted.kind}`);
      const remote = await transport.getSnapshot({ signal: admissionScope.captureAppOperation().signal });
      if (remote === null) fail('C3 admitted without a snapshot');
      return await validateHydratedCache(database, remote);
    } finally {
      admissionScope.dispose();
      database.close();
    }
  }

  button.addEventListener('click', () => {
    void admit('browser').then(result => {
      window.__q3CanonicalReadonlyResult = result;
      output.value = `PASS ${result.counts.cases}/${result.counts.assets}/${result.counts.runs}`;
    }).catch(error => {
      const failure = errorText(error);
      window.__q3CanonicalReadonlyFailure = failure;
      output.value = `FAIL ${failure}`;
    });
  });
  window.__q3CanonicalReadonly = Object.freeze({
    startElectron: async () => {
      const result = await admit('electron');
      window.__q3CanonicalReadonlyResult = result;
      output.value = `PASS ${result.counts.cases}/${result.counts.assets}/${result.counts.runs}`;
      return result;
    },
  });
}

if (typeof window !== 'undefined') {
  void installFixture().then(() => { window.__q3CanonicalReadonlyReady = true; }).catch(error => {
    window.__q3CanonicalReadonlyFailure = errorText(error);
  });
}
