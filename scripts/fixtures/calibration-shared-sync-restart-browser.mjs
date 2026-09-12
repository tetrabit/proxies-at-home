const bytes = new Uint8Array([81, 50, 82, 83, 84, 85]);
const mimeType = 'application/octet-stream';
const bindingId = 'mpc-calibration-cache-binding';

function failure(error) {
  return String(error instanceof Error ? error.message : error).replace(/calibration_pair_[A-Za-z0-9_-]+/g, '[credential]').slice(0, 240);
}

async function digest(value) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', value)), byte => byte.toString(16).padStart(2, '0')).join('');
}

function candidate(identifier) {
  return {
    identifier,
    name: `Candidate ${identifier}`,
    rawName: `Candidate ${identifier}`,
    smallThumbnailUrl: `https://example.invalid/${identifier}-small.jpg`,
    mediumThumbnailUrl: `https://example.invalid/${identifier}-medium.jpg`,
    imageUrl: `https://example.invalid/${identifier}.jpg`,
    dpi: 300,
    tags: ['calibration'],
    sourceName: 'Q2 fixture',
    source: 'q2-fixture',
    extension: 'jpg',
    size: 6,
  };
}

async function imports() {
  return Promise.all([
    import('/client/src/db.ts'),
    import('/client/src/helpers/mpcCalibrationWebTransport.ts'),
    import('/client/src/helpers/mpcCalibrationElectronTransport.ts'),
    import('/client/src/helpers/mpcCalibrationWebPairing.ts'),
    import('/client/src/helpers/mpcCalibrationInitialAdmission.ts'),
    import('/client/src/helpers/mpcCalibrationMutations.ts'),
    import('/client/src/helpers/mpcCalibrationQueueRecoveryController.ts'),
    import('/client/src/helpers/mpcCalibrationOperationScope.ts'),
    import('/client/src/helpers/mpcCalibrationSyncState.ts'),
    import('/shared/calibrationHarness.ts'),
  ]);
}

async function waitFor(check, label) {
  for (let index = 0; index < 160; index += 1) {
    const result = await check();
    if (result !== undefined) return result;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`${label} timed out`);
}

async function waitForQueueStart() {
  const credentialInput = document.querySelector('#credential');
  const start = document.querySelector('#q2-start');
  if (!(credentialInput instanceof HTMLInputElement) || !(start instanceof HTMLButtonElement)) {
    throw new Error('Q2 browser queue controls are unavailable');
  }
  return new Promise(resolve => {
    const begin = () => {
      start.removeEventListener('click', begin);
      resolve({
        take: () => credentialInput.value,
        clear: () => { credentialInput.value = ''; },
      });
    };
    start.addEventListener('click', begin, { once: true });
    window.__q2ModuleReady = true;
  });
}

function matchingIdentity(left, right) {
  return left !== undefined && right !== undefined &&
    left.ownerId === right.ownerId && left.harnessId === right.harnessId && left.connectionId === right.connectionId;
}

function cleanBase(state) {
  return state?.base !== null && state?.base !== undefined && state.queued === null && state.inFlight === null;
}

async function actualSnapshot(database) {
  const [datasets, cases, assets, runs] = await Promise.all([
    database.mpcCalibrationDatasets.toArray(),
    database.mpcCalibrationCases.toArray(),
    database.mpcCalibrationAssets.toArray(),
    database.mpcCalibrationRuns.toArray(),
  ]);
  const serializedAssets = [];
  for (const asset of assets) {
    const { blob, sha256: _storedSha256, byteLength: _storedByteLength, ...metadata } = asset;
    serializedAssets.push({
      ...metadata,
      mimeType: blob.type,
      byteLength: blob.size,
      sha256: await digest(await blob.arrayBuffer()),
    });
  }
  return { version: 1, datasets, cases, assets: serializedAssets, runs };
}

async function rowsMatchSnapshot(database, snapshot, canonicalHarnessJson) {
  const actual = await actualSnapshot(database);
  // Canonical tables are keyed collections. Match production C3's unordered
  // row comparison without reordering any candidate or other nested arrays.
  return ['datasets', 'cases', 'assets', 'runs'].every(table => {
    const rows = value => value.map(row => canonicalHarnessJson(row)).sort();
    return JSON.stringify(rows(actual[table])) === JSON.stringify(rows(snapshot[table]));
  });
}

async function assertExactAssets({ database, transport, snapshot, signal }) {
  const localAssets = await database.mpcCalibrationAssets.toArray();
  if (localAssets.length !== snapshot.assets.length) throw new Error('Q2 local asset cardinality differs from snapshot');
  for (const expected of snapshot.assets) {
    const local = localAssets.find(asset => asset.id === expected.id);
    if (local === undefined || local.blob.size !== expected.byteLength || local.blob.type !== expected.mimeType ||
      await digest(await local.blob.arrayBuffer()) !== expected.sha256) {
      throw new Error(`Q2 local asset digest differs for ${expected.id}`);
    }
    const remote = await transport.getBlob(expected.sha256, { signal });
    if (remote.byteLength !== expected.byteLength || await digest(remote) !== expected.sha256) {
      throw new Error(`Q2 remote asset digest differs for ${expected.id}`);
    }
  }
}

/** C3 may block a remote revision equal to a clean current base. That is not a
 * success shortcut: only this exact authenticated physical cache and exact C4/C6
 * observation can be retained by the renderer. */
export async function admitOrReuseExactCurrent({ admitted, database, stateStore, transport, operation, canonicalHarnessJson, phase }) {
  if (admitted.kind === 'hydrated' && 'identity' in admitted) return admitted;
  if (admitted.kind === 'needs-reconciliation' && phase === 'recover' && 'identity' in admitted) {
    const state = await stateStore.load(admitted.identity);
    const binding = await database.mpcCalibrationCacheBindings.get(bindingId);
    if (state?.base === null || state?.base === undefined || state.queued === null || state.inFlight === null ||
      state.queued.generation !== state.inFlight.generation || !matchingIdentity(binding, admitted.identity) ||
      binding.revision !== state.base.revision ||
      canonicalHarnessJson(state.queued.snapshot) !== canonicalHarnessJson(state.inFlight.snapshot) ||
      !await rowsMatchSnapshot(database, state.queued.snapshot, canonicalHarnessJson)) {
      throw new Error('Q2 recovery admission lacks its exact durable queued producer');
    }
    return { ...admitted, identity: admitted.identity, durableRecovery: true };
  }
  if (admitted.kind !== 'blocked' || !('identity' in admitted)) {
    throw new Error(`Q2 admission failed: ${admitted.kind}`);
  }
  const identity = admitted.identity;
  const [state, binding, remote] = await Promise.all([
    stateStore.load(identity),
    database.mpcCalibrationCacheBindings.get(bindingId),
    transport.getSnapshot({ signal: operation.signal }),
  ]);
  if (!cleanBase(state) || !matchingIdentity(binding, identity) || binding.revision > state.base.revision ||
    remote === null || remote.revision !== state.base.revision ||
    canonicalHarnessJson(remote.snapshot) !== canonicalHarnessJson(state.base.snapshot) ||
    !await rowsMatchSnapshot(database, state.base.snapshot, canonicalHarnessJson)) {
    throw new Error(`Q2 blocked admission is not an exact clean current reuse: ${JSON.stringify({ clean: cleanBase(state), bindingRevision: binding?.revision, baseRevision: state?.base?.revision, remoteRevision: remote?.revision, sameRemote: remote !== null && canonicalHarnessJson(remote.snapshot) === canonicalHarnessJson(state?.base?.snapshot), rowsMatch: state?.base !== null && state?.base !== undefined && await rowsMatchSnapshot(database, state.base.snapshot, canonicalHarnessJson) })}`);
  }
  await assertExactAssets({ database, transport, snapshot: state.base.snapshot, signal: operation.signal });
  return { ...admitted, identity, reusedCurrent: true };
}

function controllerFor({ createMpcCalibrationQueueRecoveryController, database, operation, transport, results }) {
  return createMpcCalibrationQueueRecoveryController({ database, operation, transport, onResult: result => results.push(result) });
}

async function writeDataset(createMpcCalibrationMutationCoordinator, database, mutationScope, id) {
  const now = Date.now();
  const mutation = createMpcCalibrationMutationCoordinator(database);
  await mutation.mutate(async () => {
    await database.mpcCalibrationDatasets.put({ id, name: id, targetCaseCount: 1, createdAt: now, updatedAt: now, version: 1 });
    await database.mpcCalibrationCases.put({ id: `${id}-case`, datasetId: id, createdAt: now, updatedAt: now, source: { name: `${id} source` }, candidates: [] });
    await database.mpcCalibrationAssets.put({ id: `${id}-asset`, datasetId: id, caseId: `${id}-case`, role: 'source', mimeType, blob: new Blob([bytes], { type: mimeType }), createdAt: now });
    return { value: undefined, changed: true };
  }, mutationScope);
}

async function writeOfflineBrowserCase(createMpcCalibrationMutationCoordinator, database, mutationScope) {
  const now = Date.now();
  const id = 'offline-browser';
  const mutation = createMpcCalibrationMutationCoordinator(database);
  await mutation.mutate(async () => {
    await database.mpcCalibrationDatasets.put({ id, name: id, targetCaseCount: 1, createdAt: now, updatedAt: now, version: 1 });
    await database.mpcCalibrationCases.put({
      id: 'offline-browser-case', datasetId: id, createdAt: now, updatedAt: now,
      source: { name: 'offline browser source' }, candidates: [candidate('pick-a'), candidate('pick-b')],
    });
    await database.mpcCalibrationAssets.put({ id: `${id}-asset`, datasetId: id, caseId: 'offline-browser-case', role: 'source', mimeType, blob: new Blob([bytes], { type: mimeType }), createdAt: now });
    return { value: undefined, changed: true };
  }, mutationScope);
}

async function selectOfflineBrowserPick(createMpcCalibrationMutationCoordinator, database, mutationScope, expectedIdentifier) {
  const mutation = createMpcCalibrationMutationCoordinator(database);
  await mutation.mutate(async () => {
    const existing = await database.mpcCalibrationCases.get('offline-browser-case');
    if (existing === undefined || !existing.candidates.some(candidateEntry => candidateEntry.identifier === expectedIdentifier)) {
      throw new Error('Q2 divergent pick case is unavailable');
    }
    // Preserve all pre-existing case fields and timestamps; only the actual card choice diverges.
    await database.mpcCalibrationCases.put({ ...existing, expectedIdentifier });
    return { value: undefined, changed: true };
  }, mutationScope);
}

async function runPhase() {
  const query = new URL(location.href).searchParams;
  const role = query.get('role');
  const phase = query.get('phase');
  if ((role !== 'browser' && role !== 'electron') || !['queue', 'recover', 'remote-disjoint', 'electron-disjoint', 'remote-conflict', 'electron-conflict'].includes(phase)) {
    throw new Error('Q2 role or phase is invalid');
  }
  const [
    { ProxxiedDexie }, { createMpcCalibrationWebTransport }, { createMpcCalibrationElectronTransport },
    { pairMpcCalibrationWeb }, { runMpcCalibrationInitialAdmissionWithIdentity }, { createMpcCalibrationMutationCoordinator },
    { createMpcCalibrationQueueRecoveryController }, { createMpcCalibrationOperationScope }, { createMpcCalibrationSyncStateStore }, { canonicalHarnessJson },
  ] = await imports();
  const database = new ProxxiedDexie(`q2-restart-sync-${role}`);
  const target = role === 'browser' ? 'linked-web' : 'linked-electron';
  const transport = role === 'browser' ? createMpcCalibrationWebTransport() : createMpcCalibrationElectronTransport();
  let pairedIdentity = null;
  if (role === 'browser' && phase === 'queue') {
    const transientCredential = await waitForQueueStart();
    const pairingScope = createMpcCalibrationOperationScope({ target, identity: null });
    try {
      const paired = await pairMpcCalibrationWeb({ database, target, operation: pairingScope.captureUiOperation(), transientCredential, createWebTransport: () => transport });
      if (paired.kind !== 'paired') throw new Error(`Q2 pairing failed: ${paired.kind}`);
      pairedIdentity = paired.identity;
    } finally { pairingScope.dispose(); }
  } else {
    window.__q2ModuleReady = true;
  }
  const scope = createMpcCalibrationOperationScope({ target, identity: pairedIdentity });
  let rawAdmission;
  try {
    rawAdmission = await runMpcCalibrationInitialAdmissionWithIdentity({ database, target, operation: scope.captureAppOperation(), ...(role === 'browser' ? { createWebTransport: () => transport } : {}) });
  } finally { /* scope owns the admission operation through this phase */ }
  const stateStore = createMpcCalibrationSyncStateStore(database);
  const provisionalIdentity = 'identity' in rawAdmission ? rawAdmission.identity : null;
  const admissionScope = createMpcCalibrationOperationScope({ target, identity: provisionalIdentity });
  const admissionOperation = admissionScope.captureAppOperation();
  let admitted;
  try {
    admitted = await admitOrReuseExactCurrent({ admitted: rawAdmission, database, stateStore, transport, operation: admissionOperation, canonicalHarnessJson, phase });
  } finally { admissionScope.dispose(); }
  const operationScope = createMpcCalibrationOperationScope({ target, identity: admitted.identity });
  const operation = operationScope.captureAppOperation();
  const results = [];
  let controller;
  try {
    if (phase === 'recover') {
      const before = await stateStore.load(admitted.identity);
      const remoteBefore = await transport.getSnapshot({ signal: operation.signal });
      if (before?.base?.revision !== 1 || before.queued?.generation !== 1 || before.inFlight?.generation !== 1 ||
        remoteBefore?.revision !== 1 || remoteBefore.snapshot.datasets.some(entry => entry.id === 'offline-browser')) {
        throw new Error('Q2 durable G1 was not retained before C5 recovery admission');
      }
      controller = controllerFor({ createMpcCalibrationQueueRecoveryController, database, operation, transport, results });
      const published = await waitFor(() => results.find(result => result.kind === 'recovery' && result.status === 'published'), 'Q2 retained G1 C5 publication');
      const remote = await transport.getSnapshot({ signal: operation.signal });
      if (remote?.revision !== 2 || !remote.snapshot.datasets.some(entry => entry.id === 'offline-browser')) throw new Error('Q2 retained G1 was not acknowledged by real C4');
      await assertExactAssets({ database, transport, snapshot: remote.snapshot, signal: operation.signal });
      return { status: 'PASS', phase, remoteBeforeRevision: remoteBefore.revision, revision: remote.revision, queuedGeneration: published.generation };
    }

    controller = controllerFor({ createMpcCalibrationQueueRecoveryController, database, operation, transport, results });
    if (role === 'electron') {
      window.__q2AdmissionReady = true;
      await waitFor(() => window.__q2RestartGo === true ? true : undefined, 'Q2 peer mutation admission');
    }

    const mutation = createMpcCalibrationMutationCoordinator(database);
    const mutationScope = await mutation.captureScope();
    if (phase === 'queue') {
      await writeOfflineBrowserCase(createMpcCalibrationMutationCoordinator, database, mutationScope);
      const failed = await waitFor(() => results.find(result => result.kind === 'recovery' && result.status === 'failed'), 'Q2 deliberate C4 disconnect');
      const state = await stateStore.load(admitted.identity);
      const remote = await transport.getSnapshot({ signal: operation.signal });
      if (state?.base?.revision !== 1 || state.queued?.generation !== 1 || state.inFlight?.generation !== 1 || remote?.revision !== 1 || remote.snapshot.datasets.some(entry => entry.id === 'offline-browser')) {
        throw new Error('Q2 offline queue did not retain G1 or remote publication leaked');
      }
      const queued = state.queued.snapshot;
      await assertExactAssets({ database, transport, snapshot: queued, signal: operation.signal });
      return { status: 'PASS', phase, baseRevision: state.base.revision, queuedGeneration: state.queued.generation, inFlightGeneration: state.inFlight.generation, remoteRevision: remote.revision };
    }

    if (phase === 'remote-disjoint') {
      await writeDataset(createMpcCalibrationMutationCoordinator, database, mutationScope, 'browser-disjoint');
    } else if (phase === 'electron-disjoint') {
      const baseBefore = await stateStore.load(admitted.identity);
      const remoteBefore = await transport.getSnapshot({ signal: operation.signal });
      if (baseBefore?.base?.revision !== 2 || remoteBefore?.revision !== 3 || !remoteBefore.snapshot.datasets.some(entry => entry.id === 'browser-disjoint')) {
        throw new Error('Q2 disjoint merge lacks local base two and remote revision three');
      }
      await writeDataset(createMpcCalibrationMutationCoordinator, database, mutationScope, 'electron-disjoint');
    } else if (phase === 'remote-conflict') {
      await selectOfflineBrowserPick(createMpcCalibrationMutationCoordinator, database, mutationScope, 'pick-a');
    } else if (phase === 'electron-conflict') {
      await selectOfflineBrowserPick(createMpcCalibrationMutationCoordinator, database, mutationScope, 'pick-b');
    }

    const expectedStatus = phase === 'electron-conflict' ? 'conflict' : 'published';
    const result = await waitFor(() => results.find(entry => entry.kind === 'recovery' && entry.status === expectedStatus), `Q2 ${phase} C5`);
    const state = await stateStore.load(admitted.identity);
    const remote = await transport.getSnapshot({ signal: operation.signal });
    if (phase === 'electron-conflict') {
      const localCase = await database.mpcCalibrationCases.get('offline-browser-case');
      const queuedCase = state?.queued?.snapshot.cases.find(entry => entry.id === 'offline-browser-case');
      const remoteCase = remote?.snapshot.cases.find(entry => entry.id === 'offline-browser-case');
      if (localCase?.expectedIdentifier !== 'pick-b' || queuedCase?.expectedIdentifier !== 'pick-b' ||
        state?.inFlight !== null || remote?.revision !== 5 || remoteCase?.expectedIdentifier !== 'pick-a') {
        throw new Error('Q2 divergent pick did not retain local pick-b and remote pick-a at revision five');
      }
      await assertExactAssets({ database, transport, snapshot: state.queued.snapshot, signal: operation.signal });
      await assertExactAssets({ database, transport, snapshot: remote.snapshot, signal: operation.signal });
    } else {
      if (state?.queued !== null || remote === null) throw new Error('Q2 published state did not settle cleanly');
      if (phase === 'electron-disjoint') {
        if (remote.revision !== 4 || !remote.snapshot.datasets.some(entry => entry.id === 'browser-disjoint') || !remote.snapshot.datasets.some(entry => entry.id === 'electron-disjoint')) {
          throw new Error('Q2 disjoint C5 did not merge both datasets at revision four');
        }
      }
      await assertExactAssets({ database, transport, snapshot: remote.snapshot, signal: operation.signal });
    }
    return { status: 'PASS', phase, revision: remote?.revision, recovery: result.status };
  } finally {
    controller?.dispose();
    operationScope.dispose();
    scope.dispose();
  }
}

if (typeof window !== 'undefined') {
  window.__q2ModuleReady = false;
  window.__q2AdmissionReady = false;
  window.__q2RestartReady = false;
  window.__q2RestartResult = undefined;
  void runPhase().then(result => {
    window.__q2RestartResult = result;
    window.__q2RestartReady = true;
    document.querySelector('#status').textContent = 'PASS';
  }).catch(error => {
    document.querySelector('#status').textContent = `failed:${failure(error)}`;
  });
}
