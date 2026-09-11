import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MpcCalibrationTransportError,
  createMpcCalibrationWebTransport,
} from "./mpcCalibrationWebTransport";
import type { CalibrationHarnessSnapshot } from "../../../shared/calibrationHarness";

const pairCredential = `calibration_pair_${"a".repeat(43)}`;
const hashA = "a".repeat(64);
const hashB = "b".repeat(64);
const emptySnapshot: CalibrationHarnessSnapshot = {
  version: 1,
  datasets: [],
  cases: [],
  assets: [],
  runs: [],
};

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...init.headers },
  });
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes.slice().buffer as ArrayBuffer);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

describe("same-origin calibration web transport", () => {
  afterEach(() => vi.restoreAllMocks());

  it("captures the original put signal before digest and skips late fetch dispatch", async () => {
    const bytes = new Uint8Array([4, 5, 6]);
    const digest = await sha256(bytes);
    let dispatches = 0;
    let enterDigest!: () => void;
    let releaseDigest!: () => void;
    const digestEntered = new Promise<void>(resolve => { enterDigest = resolve; });
    const digestReleased = new Promise<void>(resolve => { releaseDigest = resolve; });
    const originalDigest = crypto.subtle.digest.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, "digest").mockImplementation((...args) => {
      enterDigest();
      return digestReleased.then(() => originalDigest(...args));
    });
    const transport = createMpcCalibrationWebTransport({ fetch: async (_url, init) => {
      dispatches += 1;
      return init?.method === "POST"
        ? json({ ownerId: "owner-a", harnessId: "harness-a" })
        : json({ sha256: digest, byteLength: bytes.byteLength, inserted: true }, { status: 201 });
    } });
    await transport.pair(pairCredential);
    dispatches = 0;
    const controller = new AbortController();
    const requestOptions: { signal: AbortSignal } = { signal: controller.signal };
    const completion = transport.putBlob(digest, bytes, requestOptions);

    await digestEntered;
    controller.abort();
    requestOptions.signal = new AbortController().signal;
    releaseDigest();

    await expect(completion).rejects.toMatchObject({ code: "aborted" });
    expect(dispatches).toBe(0);
  });

  it("pairs only through the fixed relative route then uses browser cookie policy without retaining authorization", async () => {
    const calls: Array<{ url: RequestInfo | URL; init?: RequestInit }> = [];
    const transport = createMpcCalibrationWebTransport({
      fetch: async (url, init) => {
        calls.push({ url, init });
        return calls.length === 1
          ? json({ ownerId: "owner-a", harnessId: "harness-a" })
          : json({ ownerId: "owner-a", harnessId: "harness-a" });
      },
    });

    await expect(transport.pair(pairCredential)).resolves.toEqual({ ownerId: "owner-a", harnessId: "harness-a" });
    await expect(transport.getSession()).resolves.toEqual({ ownerId: "owner-a", harnessId: "harness-a" });

    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      url: "/api/calibration-harness/pair",
      init: {
        method: "POST",
        headers: { accept: "application/json", authorization: `Bearer ${pairCredential}` },
        credentials: "include",
        cache: "no-store",
        redirect: "error",
      },
    });
    expect(calls[1]).toMatchObject({
      url: "/api/calibration-harness/session",
      init: {
        method: "GET",
        headers: { accept: "application/json" },
        credentials: "include",
        cache: "no-store",
        redirect: "error",
      },
    });
    expect(calls[1]!.init!.headers).not.toHaveProperty("authorization");
    expect(JSON.stringify(transport)).not.toContain(pairCredential);
  });

  it("uses session discovery to bootstrap a browser cookie, keeps other operations guarded, clears state after unpair or authentication invalidation, and never dispatches pre-aborted work", async () => {
    let dispatches = 0;
    let sessionDiscovery = true;
    const transport = createMpcCalibrationWebTransport({
      fetch: async (url) => {
        dispatches += 1;
        if (String(url) === "/api/calibration-harness/pair") return json({ ownerId: "owner-a", harnessId: "harness-a" });
        if (String(url) === "/api/calibration-harness/unpair") return new Response(null, { status: 204 });
        if (sessionDiscovery) return json({ ownerId: "owner-a", harnessId: "harness-a" });
        return new Response(null, { status: 401 });
      },
    });
    await expect(transport.getSnapshot()).rejects.toMatchObject({ code: "unpaired" });
    await expect(transport.getSession()).resolves.toEqual({ ownerId: "owner-a", harnessId: "harness-a" });
    sessionDiscovery = false;
    await expect(transport.getSession()).rejects.toMatchObject({ code: "authentication", status: 401 });
    await expect(transport.getSnapshot()).rejects.toMatchObject({ code: "unpaired" });
    await transport.pair(pairCredential);
    await expect(transport.unpair()).resolves.toBeUndefined();
    await expect(transport.getSnapshot()).rejects.toMatchObject({ code: "unpaired" });
    const controller = new AbortController();
    controller.abort();
    await expect(transport.pair(pairCredential, { signal: controller.signal })).rejects.toMatchObject({ code: "aborted" });
    expect(dispatches).toBe(4);
  });

  it("uses all six wire operations with exact paths, headers, canonical preconditions, and bounded missing negotiation", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const digest = await sha256(bytes);
    const calls: Array<{ url: RequestInfo | URL; init?: RequestInit }> = [];
    const transport = createMpcCalibrationWebTransport({
      fetch: async (url, init) => {
        calls.push({ url, init });
        switch (String(url)) {
          case "/api/calibration-harness/pair": return json({ ownerId: "owner-a", harnessId: "harness-a" });
          case "/api/calibration-harness/snapshot":
            return init?.method === "GET"
              ? json({ revision: 7, snapshot: emptySnapshot }, { headers: { etag: "\"7\"" } })
              : json({ revision: 8, snapshot: emptySnapshot }, { headers: { etag: "\"8\"" } });
          case `/api/calibration-harness/blobs/${digest}`:
            return init?.method === "GET"
              ? new Response(bytes, { headers: { "content-type": "application/octet-stream", "content-length": "3" } })
              : json({ sha256: digest, byteLength: 3, inserted: true }, { status: 201 });
          case "/api/calibration-harness/blobs/missing": return json({ missing: [hashA] });
          default: throw new Error(`unexpected URL ${String(url)}`);
        }
      },
    });

    await transport.pair(pairCredential);
    await expect(transport.getSnapshot()).resolves.toEqual({ revision: 7, snapshot: emptySnapshot });
    await expect(transport.publishSnapshot(emptySnapshot, 7)).resolves.toEqual({ revision: 8, snapshot: emptySnapshot });
    await expect(transport.getBlob(digest)).resolves.toEqual(bytes);
    await expect(transport.putBlob(digest, bytes)).resolves.toEqual({ sha256: digest, byteLength: 3, inserted: true });
    await expect(transport.missingBlobs([hashA, hashB])).resolves.toEqual({ missing: [hashA] });

    expect(calls.slice(1).map(call => String(call.url))).toEqual([
      "/api/calibration-harness/snapshot",
      "/api/calibration-harness/snapshot",
      `/api/calibration-harness/blobs/${digest}`,
      `/api/calibration-harness/blobs/${digest}`,
      "/api/calibration-harness/blobs/missing",
    ]);
    expect(calls[2]!.init).toMatchObject({ method: "PUT", headers: {
      accept: "application/json", "content-type": "application/json", "if-match": "\"7\"",
    }});
    expect(calls[4]!.init).toMatchObject({ method: "PUT", headers: {
      accept: "application/json", "content-type": "application/octet-stream",
    }, body: bytes });
    expect(calls[5]!.init).toMatchObject({ method: "POST", headers: {
      accept: "application/json", "content-type": "application/json",
    }, body: JSON.stringify({ hashes: [hashA, hashB] }) });
    for (const call of calls.slice(1)) {
      expect(call.init!.headers).not.toHaveProperty("authorization");
      expect(call.init).toMatchObject({ credentials: "include", cache: "no-store", redirect: "error" });
    }
  });

  it("defines a missing snapshot as null while preserving safe HTTP status distinctions and invalid response failures", async () => {
    let response: Response = json({ ownerId: "owner-a", harnessId: "harness-a" });
    const transport = createMpcCalibrationWebTransport({ fetch: async () => response });
    await transport.pair(pairCredential);
    response = json({ error: "not_found" }, { status: 404 });
    await expect(transport.getSnapshot()).resolves.toBeNull();
    response = json({ error: "precondition_failed" }, { status: 412 });
    await expect(transport.publishSnapshot(emptySnapshot, 1)).rejects.toMatchObject({ code: "http", status: 412 });
    response = json({ error: "storage_unavailable" }, { status: 503 });
    await expect(transport.missingBlobs([])).rejects.toMatchObject({ code: "http", status: 503 });
    response = json({ revision: 1, snapshot: emptySnapshot }, { headers: { etag: "W/\"1\"" } });
    await expect(transport.getSnapshot()).rejects.toMatchObject({ code: "invalid-response" });

    let online = true;
    const offlineTransport = createMpcCalibrationWebTransport({
      fetch: async () => {
        if (online) return json({ ownerId: "owner-a", harnessId: "harness-a" });
        throw new Error(pairCredential);
      },
    });
    await offlineTransport.pair(pairCredential);
    online = false;
    await expect(offlineTransport.getSession()).rejects.toMatchObject({ code: "offline" });
    await expect(offlineTransport.getSession()).rejects.not.toThrow(pairCredential);
  });

  it("rejects malformed or hostile caller data before fetch without invoking getters, iterators, or toJSON", async () => {
    let dispatches = 0;
    let hooks = 0;
    const transport = createMpcCalibrationWebTransport({
      fetch: async () => { dispatches += 1; return json({ ownerId: "owner-a", harnessId: "harness-a" }); },
    });
    await transport.pair(pairCredential);
    const hostile = [hashA] as string[];
    Object.defineProperty(hostile, "0", { enumerable: true, get() { hooks += 1; return hashA; } });
    Object.defineProperty(hostile, "toJSON", { value() { hooks += 1; return []; } });
    await expect(transport.missingBlobs(hostile)).rejects.toMatchObject({ code: "invalid-operation" });
    await expect(transport.publishSnapshot({ ...emptySnapshot, unknown: { get x() { hooks += 1; return "x"; } } } as never, null)).rejects.toMatchObject({ code: "invalid-operation" });
    await expect(transport.putBlob(hashA, new Uint8Array(1))).rejects.toMatchObject({ code: "invalid-operation" });
    expect(hooks).toBe(0);
    expect(dispatches).toBe(1);
  });

  it("cancels rejected, redirected, over-limit, interrupted, and rejecting response bodies without leaving reader locks", async () => {
    let cancelled = 0;
    const rejected = new ReadableStream<Uint8Array>({ cancel() { cancelled += 1; return Promise.reject(new Error("fixture cancellation")); } });
    const transport = createMpcCalibrationWebTransport({
      fetch: async (_url, init) => init?.method === "POST"
        ? json({ ownerId: "owner-a", harnessId: "harness-a" })
        : new Response(rejected, { status: 503 }),
    });
    await transport.pair(pairCredential);
    await expect(transport.getSession()).rejects.toMatchObject({ code: "http", status: 503 });
    expect(cancelled).toBe(1);
    expect(rejected.locked).toBe(false);

    const tooLarge = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(new Uint8Array(4)); } });
    const blobTransport = createMpcCalibrationWebTransport({ fetch: async (_url, init) => init?.method === "POST"
      ? json({ ownerId: "owner-a", harnessId: "harness-a" })
      : new Response(tooLarge, { headers: { "content-type": "application/octet-stream", "content-length": String(32 * 1024 * 1024 + 1) } }) });
    await blobTransport.pair(pairCredential);
    await expect(blobTransport.getBlob(hashA)).rejects.toMatchObject({ code: "response-too-large" });
    expect(tooLarge.locked).toBe(false);

    let timeoutCancelled = false;
    const stalled = new ReadableStream<Uint8Array>({ cancel() { timeoutCancelled = true; } });
    const timeoutTransport = createMpcCalibrationWebTransport({
      timeoutMs: 5,
      fetch: async (_url, init) => init?.method === "POST" ? json({ ownerId: "owner-a", harnessId: "harness-a" }) : new Response(stalled, { headers: { "content-type": "application/octet-stream" } }),
    });
    await timeoutTransport.pair(pairCredential);
    await expect(timeoutTransport.getBlob(hashA)).rejects.toMatchObject({ code: "timeout" });
    expect(timeoutCancelled).toBe(true);
    expect(stalled.locked).toBe(false);

    const redirectTransport = createMpcCalibrationWebTransport({
      fetch: async (_url, init) => init?.method === "POST"
        ? json({ ownerId: "owner-a", harnessId: "harness-a" })
        : new Response(null, { status: 302, headers: { location: "https://attacker.invalid" } }),
    });
    await redirectTransport.pair(pairCredential);
    await expect(redirectTransport.getSession()).rejects.toMatchObject({ code: "redirect" });

    const abortController = new AbortController();
    let abortCancelled = false;
    const abortBody = new ReadableStream<Uint8Array>({ cancel() { abortCancelled = true; } });
    const abortTransport = createMpcCalibrationWebTransport({
      fetch: async (_url, init) => init?.method === "POST"
        ? json({ ownerId: "owner-a", harnessId: "harness-a" })
        : new Response(abortBody, { headers: { "content-type": "application/octet-stream" } }),
    });
    await abortTransport.pair(pairCredential);
    const aborted = abortTransport.getBlob(hashA, { signal: abortController.signal });
    for (let step = 0; step < 10 && !abortBody.locked; step += 1) await Promise.resolve();
    abortController.abort();
    await expect(aborted).rejects.toMatchObject({ code: "aborted" });
    expect(abortCancelled).toBe(true);
    expect(abortBody.locked).toBe(false);
  });

  it("does not use browser persistence APIs or any caller-selected route, origin, or headers", async () => {
    const calls: string[] = [];
    const transport = createMpcCalibrationWebTransport({
      fetch: async url => { calls.push(String(url)); return json({ ownerId: "owner-a", harnessId: "harness-a" }); },
    });
    await transport.pair(pairCredential);
    expect(calls).toEqual(["/api/calibration-harness/pair"]);
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
    expect(window.caches).toBeUndefined();
    expect(transport).toBeInstanceOf(Object);
  });

  it("exposes typed errors without echoing credentials", () => {
    const error = new MpcCalibrationTransportError("http", 401);
    expect(error).toMatchObject({ name: "MpcCalibrationTransportError", code: "http", status: 401 });
    expect(error.message).not.toContain("calibration_pair_");
  });
});
