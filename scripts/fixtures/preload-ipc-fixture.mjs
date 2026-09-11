import http from 'node:http';

const API_ROOT = '/api/calibration-harness';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

async function body(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function deferredLifecycle() {
  let resolveStarted;
  let resolveClosed;
  let rejectClosed;
  let settled = false;
  let timer;
  const observation = { requestEnded: false, requestClosed: false, responseClosed: false, socketClosed: false, writableEnded: false };
  const started = new Promise((resolve) => { resolveStarted = resolve; });
  const closed = new Promise((resolve, reject) => {
    resolveClosed = resolve;
    rejectClosed = reject;
  });
  const settle = (kind, value) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (kind === 'resolve') resolveClosed(clone(value));
    else rejectClosed(value);
  };
  timer = setTimeout(() => settle('reject', new Error('deferred HTTP cancellation timeout')), 5000);
  timer.unref?.();
  return {
    observation,
    started,
    closed,
    requestEnded() { observation.requestEnded = true; resolveStarted(); },
    resourceClosed(response) {
      observation.writableEnded = response.writableEnded;
      settle('resolve', observation);
    },
    cleanupBeforeClientCancel() { settle('reject', new Error('fixture closed before deferred client cancellation')); },
    release() { clearTimeout(timer); },
  };
}

/** A small, owned loopback fixture for IPC transport observations; it is not an auth-policy substitute. */
export function createPreloadIpcFixture({ credential, harnessId, snapshot = null } = {}) {
  if (typeof credential !== 'string' || credential.length === 0 || typeof harnessId !== 'string' || harnessId.length === 0) {
    throw new Error('fixture requires non-empty synthetic credential and harness id');
  }
  let current = snapshot === null ? null : clone(snapshot);
  let revision = current === null ? 0 : 1;
  let armedDeferred = null;
  let activeDeferred = null;
  let closing = false;
  const forced = new Map();
  const blobs = new Map();
  const sockets = new Set();
  const responses = new Set();
  const requests = [];
  const server = http.createServer(async (request, response) => {
    responses.add(response);
    response.once('close', () => responses.delete(response));
    const url = new URL(request.url ?? '/', 'http://fixture.invalid');
    const record = {
      method: request.method ?? 'GET',
      path: url.pathname,
      authorizationValid: request.headers.authorization === `Bearer ${credential}`,
      precondition: request.headers['if-match'] ?? request.headers['if-none-match'] ?? null,
      status: null,
      requestEnded: request.complete,
    };
    requests.push(record);
    const finish = (status, value, headers = {}) => {
      record.status = status;
      response.writeHead(status, { 'content-type': 'application/json', ...headers });
      response.end(JSON.stringify(value));
    };
    if (!record.authorizationValid) return finish(401, { error: 'unauthorized' });
    const forcedStatus = forced.get(url.pathname);
    if (forcedStatus !== undefined) {
      forced.delete(url.pathname);
      return finish(forcedStatus, { error: 'forced' });
    }
    if (armedDeferred !== null && url.pathname === `${API_ROOT}/snapshot` && request.method === 'GET') {
      const lifecycle = armedDeferred;
      armedDeferred = null;
      activeDeferred = lifecycle;
      record.status = 'deferred';
      const observeRequestEnd = () => {
        record.requestEnded = true;
        lifecycle.requestEnded();
      };
      request.once('close', () => { lifecycle.observation.requestClosed = true; });
      response.once('close', () => {
        lifecycle.observation.responseClosed = true;
        if (!closing) lifecycle.resourceClosed(response);
      });
      request.socket.once('close', () => {
        lifecycle.observation.socketClosed = true;
        if (!closing) lifecycle.resourceClosed(response);
      });
      request.resume();
      response.writeHead(200, { 'content-type': 'application/json', etag: `"${Math.max(revision, 1)}"` });
      response.write('{"revision":');
      if (request.complete) queueMicrotask(observeRequestEnd);
      else request.once('end', observeRequestEnd);
      return;
    }
    if (url.pathname === `${API_ROOT}/session` && request.method === 'GET') return finish(200, { ownerId: 'owned-synthetic', harnessId });
    if (url.pathname === `${API_ROOT}/snapshot` && request.method === 'GET') {
      if (current === null) return finish(404, { error: 'missing' });
      return finish(200, { revision, snapshot: clone(current) }, { etag: `"${revision}"` });
    }
    if (url.pathname === `${API_ROOT}/snapshot` && request.method === 'PUT') {
      let submitted;
      try { submitted = JSON.parse((await body(request)).toString('utf8')); } catch { return finish(400, { error: 'invalid-json' }); }
      const createOnly = request.headers['if-none-match'] === '*';
      const match = request.headers['if-match'];
      const currentEtag = current === null ? null : `"${revision}"`;
      if ((createOnly && current !== null) || (!createOnly && match !== currentEtag)) {
        return finish(412, { error: 'precondition-failed' }, currentEtag === null ? {} : { etag: currentEtag });
      }
      current = clone(submitted);
      revision += 1;
      return finish(createOnly ? 201 : 200, { revision, snapshot: clone(current) }, { etag: `"${revision}"` });
    }
    if (url.pathname.startsWith(`${API_ROOT}/blobs/`) && request.method === 'PUT') {
      const hash = url.pathname.slice(`${API_ROOT}/blobs/`.length);
      const bytes = await body(request);
      const inserted = !blobs.has(hash);
      if (inserted) blobs.set(hash, bytes);
      return finish(inserted ? 201 : 200, { sha256: hash, byteLength: bytes.byteLength, inserted });
    }
    if (url.pathname.startsWith(`${API_ROOT}/blobs/`) && request.method === 'GET') {
      const hash = url.pathname.slice(`${API_ROOT}/blobs/`.length);
      const bytes = blobs.get(hash);
      if (bytes === undefined) { record.status = 404; response.writeHead(404); response.end(); return; }
      record.status = 200;
      response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(bytes.byteLength) });
      response.end(bytes);
      return;
    }
    if (url.pathname === `${API_ROOT}/blobs/missing` && request.method === 'POST') {
      let requested;
      try { requested = JSON.parse((await body(request)).toString('utf8')); } catch { return finish(400, { error: 'invalid-json' }); }
      return finish(200, { missing: requested.hashes.filter((hash) => !blobs.has(hash)) });
    }
    return finish(404, { error: 'not-found' });
  });
  server.on('connection', (socket) => sockets.add(socket));
  server.on('connection', (socket) => socket.once('close', () => sockets.delete(socket)));
  return {
    credential,
    requests,
    forceOnce(suffix, status) { forced.set(`${API_ROOT}${suffix}`, status); },
    deferNextSnapshot() {
      if (armedDeferred !== null || activeDeferred !== null) throw new Error('a deferred response is already active');
      const lifecycle = deferredLifecycle();
      armedDeferred = lifecycle;
      return { started: lifecycle.started, closed: lifecycle.closed, observation: () => ({ ...lifecycle.observation }) };
    },
    releaseDeferred() {
      armedDeferred?.release();
      activeDeferred?.release();
      armedDeferred = null;
      activeDeferred = null;
    },
    async start() {
      await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (!address || typeof address === 'string' || address.address !== '127.0.0.1') throw new Error('fixture did not bind loopback');
      return `http://127.0.0.1:${address.port}`;
    },
    async close() {
      if (closing) return;
      closing = true;
      activeDeferred?.cleanupBeforeClientCancel();
      armedDeferred?.cleanupBeforeClientCancel();
      for (const response of responses) response.destroy();
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      this.releaseDeferred();
    },
  };
}
