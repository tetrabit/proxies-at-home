import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { setImmediate } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { parseCalibrationHarnessConfig } from "./calibration-harness-config.js";
import {
  createCalibrationHarnessBroker,
} from "./calibration-harness-broker.js";

const credential = `calibration_pair_${"b".repeat(43)}`;
const config = () => parseCalibrationHarnessConfig({
  version: 1,
  backendOrigin: "https://calibration.example.test",
  harnessId: "harness-a",
  credential,
});
const snapshot = { version: 1, datasets: [], cases: [], assets: [], runs: [] };
const response = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), {
  status: 200,
  headers: { "content-type": "application/json", ...init.headers },
  ...init,
});

type LoopbackRedirectFixture = Readonly<{
  destination: Server;
  origin: Server;
  destinationPort: number;
  originPort: number;
  redirectedRequests(): number;
}>;

type CloseListener = (server: Server) => Promise<void>;

async function listenOnLoopback(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    const ready = () => {
      server.off("error", failed);
      resolve();
    };
    const failed = (error: Error) => {
      server.off("listening", ready);
      reject(error);
    };
    server.once("listening", ready);
    server.once("error", failed);
    try {
      server.listen(0, "127.0.0.1");
    } catch (error) {
      failed(error instanceof Error ? error : new Error("loopback listen failed"));
    }
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("loopback listener has no TCP port");
  return address.port;
}

async function closeOwnedListener(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    try {
      server.close(error => error === undefined ? resolve() : reject(error));
    } catch (error) {
      reject(error);
    }
  });
}

async function closeOwnedListeners(servers: readonly (Server | undefined)[], close: CloseListener = closeOwnedListener): Promise<void> {
  const failures: unknown[] = [];
  for (const server of servers) {
    if (server === undefined) continue;
    try {
      await close(server);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, "owned loopback listener cleanup failed");
}

async function withLoopbackRedirect<T>(body: (fixture: LoopbackRedirectFixture) => Promise<T>): Promise<T> {
  let destination: Server | undefined;
  let origin: Server | undefined;
  let bodyFailure: unknown;
  let bodyFailed = false;
  let result!: T;
  let cleanupFailure: unknown;
  let cleanupFailed = false;
  try {
    let redirectedRequests = 0;
    destination = createServer((_request, reply) => { redirectedRequests += 1; reply.end("bad"); });
    const destinationPort = await listenOnLoopback(destination);
    origin = createServer((_request, reply) => {
      reply.writeHead(302, { location: `http://127.0.0.1:${destinationPort}/received` });
      reply.end();
    });
    const originPort = await listenOnLoopback(origin);
    result = await body(Object.freeze({ destination, origin, destinationPort, originPort, redirectedRequests: () => redirectedRequests }));
  } catch (error) {
    bodyFailed = true;
    bodyFailure = error;
  } finally {
    try {
      await closeOwnedListeners([origin, destination]);
    } catch (error) {
      cleanupFailed = true;
      cleanupFailure = error;
    }
  }
  if (bodyFailed && cleanupFailed) {
    throw new AggregateError([bodyFailure, cleanupFailure], "loopback test body and cleanup failed");
  }
  if (bodyFailed) throw bodyFailure;
  if (cleanupFailed) throw cleanupFailure;
  return result;
}

describe("fixed-origin calibration harness broker", () => {
  it("uses only closure-derived session URL and authorization", async () => {
    const fetchCalls: Array<[RequestInfo | URL, RequestInit | undefined]> = [];
    const broker = createCalibrationHarnessBroker(config(), {
      fetch: async (url, init) => {
        fetchCalls.push([url, init]);
        return response({ ownerId: "owner-a", harnessId: "harness-a" });
      },
    });

    await expect(broker.execute({ kind: "getSession" })).resolves.toEqual({ ownerId: "owner-a", harnessId: "harness-a" });
    expect(fetchCalls).toHaveLength(1);
    expect(String(fetchCalls[0]![0])).toBe("https://calibration.example.test/api/calibration-harness/session");
    expect(fetchCalls[0]![1]).toMatchObject({ method: "GET", credentials: "omit", redirect: "error" });
    expect(fetchCalls[0]![1]?.headers).toEqual({ accept: "application/json", authorization: `Bearer ${credential}` });
  });

  it("rejects caller-selected transport fields without a request", async () => {
    const fetch = async () => response({ ownerId: "owner-a", harnessId: "harness-a" });
    const broker = createCalibrationHarnessBroker(config(), { fetch });
    await expect(broker.execute({ kind: "getSession", url: "https://attacker.test", credential: "stolen" } as never)).rejects.toMatchObject({ code: "invalid-operation" });
    const hostile = new Proxy({}, { ownKeys() { throw new Error("raw credential must not escape"); } });
    await expect(broker.execute(hostile)).rejects.toMatchObject({ code: "invalid-operation" });
  });

  it("publishes explicit revision preconditions and validates strong response etags", async () => {
    const requests: RequestInit[] = [];
    const broker = createCalibrationHarnessBroker(config(), {
      fetch: async (_url, init) => {
        requests.push(init!);
        return response({ revision: 7, snapshot }, { headers: { etag: "\"7\"" } });
      },
    });
    await expect(broker.execute({ kind: "publishSnapshot", snapshot, expectedRevision: 6 })).resolves.toEqual({ revision: 7, snapshot });
    expect(requests[0]!.headers).toEqual({
      accept: "application/json",
      authorization: `Bearer ${credential}`,
      "content-type": "application/json",
      "if-match": "\"6\"",
    });
    await expect(broker.execute({ kind: "publishSnapshot", snapshot, expectedRevision: null })).resolves.toEqual({ revision: 7, snapshot });
    expect(requests[1]!.headers).toMatchObject({ "if-none-match": "*" });
  });

  it("preserves authentication, precondition, and offline distinctions", async () => {
    for (const status of [401, 412]) {
      const broker = createCalibrationHarnessBroker(config(), { fetch: async () => new Response(null, { status }) });
      await expect(broker.execute({ kind: "getSession" })).rejects.toMatchObject({ code: "http", status });
    }
    const broker = createCalibrationHarnessBroker(config(), { fetch: async () => { throw new Error("upstream credentials are secret"); } });
    await expect(broker.execute({ kind: "getSession" })).rejects.toMatchObject({ code: "offline" });
    await expect(broker.execute({ kind: "getSession" })).rejects.not.toThrow(credential);
  });

  it("rejects an already-aborted publication before transport dispatch", async () => {
    const controller = new AbortController();
    controller.abort();
    let dispatches = 0;
    const broker = createCalibrationHarnessBroker(config(), {
      signal: controller.signal,
      fetch: async () => {
        dispatches += 1;
        return response({ revision: 1, snapshot }, { status: 201, headers: { etag: "\"1\"" } });
      },
    });

    await expect(broker.execute({ kind: "publishSnapshot", snapshot, expectedRevision: null })).rejects.toMatchObject({ code: "aborted" });
    expect(dispatches).toBe(0);
  });

  it.each([401, 412, 500, 302])("cancels a rejected HTTP %i body before returning its typed failure", async (status) => {
    let cancellations = 0;
    const body = new ReadableStream<Uint8Array>({ cancel() { cancellations += 1; } });
    const broker = createCalibrationHarnessBroker(config(), { fetch: async () => new Response(body, { status }) });
    try {
      await expect(broker.execute({ kind: "getSession" })).rejects.toMatchObject(
        status === 302 ? { code: "redirect" } : { code: "http", status },
      );
      expect(cancellations).toBe(1);
    } finally {
      if (!body.locked) await body.cancel().catch(() => undefined);
    }
  });

  it("hashes exactly the supplied typed-array view before a binary put", async () => {
    const source = new Uint8Array([99, 1, 2, 3, 77]);
    const bytes = source.subarray(1, 4);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const sent: RequestInit[] = [];
    const broker = createCalibrationHarnessBroker(config(), {
      fetch: async (_url, init) => {
        sent.push(init!);
        return response({ sha256, byteLength: 3, inserted: true }, { status: 201 });
      },
    });
    await expect(broker.execute({ kind: "putBlob", sha256, bytes })).resolves.toEqual({ sha256, byteLength: 3, inserted: true });
    expect(sent[0]!.body).toBe(bytes);
    await expect(broker.execute({ kind: "putBlob", sha256: "0".repeat(64), bytes })).rejects.toMatchObject({ code: "invalid-operation" });
  });

  it("verifies complete blob bytes and missing-hash subset responses", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    let sequence = 0;
    const broker = createCalibrationHarnessBroker(config(), {
      fetch: async () => {
        sequence += 1;
        return sequence === 1
          ? new Response(bytes)
          : response({ missing: [sha256] });
      },
    });
    await expect(broker.execute({ kind: "getBlob", sha256 })).resolves.toEqual(bytes);
    await expect(broker.execute({ kind: "missingBlobs", hashes: [sha256] })).resolves.toEqual({ missing: [sha256] });
    await expect(broker.execute({ kind: "missingBlobs", hashes: [sha256, sha256] })).rejects.toMatchObject({ code: "invalid-operation" });
  });

  it.each(["sparse", "accessor", "iterator", "toJSON", "some", "extra", "prototype", "hidden", "symbol"])("rejects %s hash arrays without executing hooks or dispatching", async kind => {
    const hash = "a".repeat(64);
    let hooks = 0;
    let dispatches = 0;
    const hashes: string[] = kind === "sparse" ? new Array(1) : [hash];
    if (kind === "accessor") Object.defineProperty(hashes, "0", { get() { hooks++; return hash; }, enumerable: true });
    if (kind === "iterator") Object.defineProperty(hashes, Symbol.iterator, { value: function* () { hooks++; yield hash; } });
    if (kind === "toJSON") Object.defineProperty(hashes, "toJSON", { value: () => { hooks++; return [hash]; } });
    if (kind === "some") Object.defineProperty(hashes, "some", { value: () => { hooks++; return false; } });
    if (kind === "extra") Object.defineProperty(hashes, "extra", { value: true });
    if (kind === "prototype") Object.setPrototypeOf(hashes, Object.create(Array.prototype));
    if (kind === "hidden") Object.defineProperty(hashes, "0", { value: hash, enumerable: false });
    if (kind === "symbol") Object.defineProperty(hashes, Symbol("extra"), { value: true });
    const broker = createCalibrationHarnessBroker(config(), { fetch: async () => { dispatches++; return response({ missing: [] }); } });
    await expect(broker.execute({ kind: "missingBlobs", hashes })).rejects.toMatchObject({ code: "invalid-operation" });
    expect(hooks).toBe(0);
    expect(dispatches).toBe(0);
  });

  it("rejects a spoofed binary view before reading its accessor or dispatching", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const buffer = bytes.buffer;
    let getters = 0;
    let dispatches = 0;
    Object.defineProperty(bytes, "buffer", { get() { getters++; return buffer; } });
    const broker = createCalibrationHarnessBroker(config(), { fetch: async () => {
      dispatches++;
      return response({ sha256, byteLength: 3, inserted: true }, { status: 201 });
    } });
    await expect(broker.execute({ kind: "putBlob", sha256, bytes })).rejects.toMatchObject({ code: "invalid-operation" });
    expect(getters).toBe(0);
    expect(dispatches).toBe(0);
  });

  it.each(["ArrayBuffer", "Uint8Array", "Buffer"])("retains valid %s binary operations", async kind => {
    const source = new Uint8Array([1, 2, 3]);
    const bytes = kind === "ArrayBuffer" ? source.buffer : kind === "Buffer" ? Buffer.from(source) : source;
    const sha256 = createHash("sha256").update(source).digest("hex");
    const broker = createCalibrationHarnessBroker(config(), { fetch: async (_url, init) => {
      expect(init?.body).toBe(bytes);
      return response({ sha256, byteLength: 3, inserted: true }, { status: 201 });
    } });
    await expect(broker.execute({ kind: "putBlob", sha256, bytes })).resolves.toEqual({ sha256, byteLength: 3, inserted: true });
  });

  it("retains empty and full-bound dense hash queries while rejecting the next item", async () => {
    let dispatches = 0;
    const hashes = Array.from({ length: 512 }, (_, index) => index.toString(16).padStart(64, "0"));
    const broker = createCalibrationHarnessBroker(config(), { fetch: async (_url, init) => {
      dispatches++;
      return response({ missing: JSON.parse(String(init?.body)).hashes });
    } });
    await expect(broker.execute({ kind: "missingBlobs", hashes: [] })).resolves.toEqual({ missing: [] });
    await expect(broker.execute({ kind: "missingBlobs", hashes: Object.freeze(hashes) })).resolves.toEqual({ missing: hashes });
    await expect(broker.execute({ kind: "missingBlobs", hashes: [...hashes, "f".repeat(64)] })).rejects.toMatchObject({ code: "invalid-operation" });
    expect(dispatches).toBe(2);
  });

  it("cancels a chunked response that exceeds its bound", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new Uint8Array(65)); },
      cancel() { cancelled = true; },
    });
    const broker = createCalibrationHarnessBroker(config(), { fetch: async () => new Response(body) });
    await expect(broker.execute({ kind: "getBlob", sha256: "a".repeat(64) })).rejects.toMatchObject({ code: "response-too-large" });
    expect(cancelled).toBe(true);
  });

  it("cancels a stalled response reader when trusted-main aborts", async () => {
    const controller = new AbortController();
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() { cancelled = true; },
    });
    const broker = createCalibrationHarnessBroker(config(), { fetch: async () => new Response(body), signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    await expect(broker.execute({ kind: "getBlob", sha256: "a".repeat(64) })).rejects.toMatchObject({ code: "aborted" });
    expect(cancelled).toBe(true);
  });

  it.each(["aborted", "timeout"] as const)("settles a rejecting reader cancellation on %s without an unhandled promise", async (expectedCode) => {
    const unhandled: unknown[] = [];
    const observe = (reason: unknown) => { unhandled.push(reason); };
    process.on("unhandledRejection", observe);
    const controller = expectedCode === "aborted" ? new AbortController() : undefined;
    const body = new ReadableStream<Uint8Array>({
      cancel() { return Promise.reject(new Error(`fixture ${expectedCode} cancellation failed`)); },
    });
    const broker = createCalibrationHarnessBroker(config(), {
      fetch: async () => new Response(body),
      signal: controller?.signal,
      timeoutMs: expectedCode === "timeout" ? 10 : 2_000,
    });
    const outcome = broker.execute({ kind: "getBlob", sha256: "a".repeat(64) }).catch(error => error);
    try {
      for (let step = 0; step < 20 && !body.locked; step += 1) await Promise.resolve();
      expect(body.locked).toBe(true);
      controller?.abort();
      expect(await outcome).toMatchObject({ code: expectedCode });
      await setImmediate();
      expect(unhandled).toEqual([]);
      expect(body.locked).toBe(false);
    } finally {
      controller?.abort();
      await outcome;
      if (!body.locked) await body.cancel().catch(() => undefined);
      process.off("unhandledRejection", observe);
    }
  });

  it("denies a real loopback redirect before the second listener receives credentials", async () => {
    await withLoopbackRedirect(async ({ originPort, redirectedRequests }) => {
      const local = parseCalibrationHarnessConfig({ version: 1, backendOrigin: `http://127.0.0.1:${originPort}`, harnessId: "harness-a", credential });
      const broker = createCalibrationHarnessBroker(local, { timeoutMs: 2_000 });
      await expect(broker.execute({ kind: "getSession" })).rejects.toMatchObject({ code: "offline" });
      expect(redirectedRequests()).toBe(0);
    });
  });

  it("reports an injected redirect response as typed redirect without following it", async () => {
    const broker = createCalibrationHarnessBroker(config(), {
      fetch: async () => new Response(null, { status: 302, headers: { location: "https://attacker.test" } }),
    });
    await expect(broker.execute({ kind: "getSession" })).rejects.toMatchObject({ code: "redirect" });
  });

  it("closes both actual owned loopback listeners after an injected body failure", async () => {
    let origin: Server | undefined;
    let destination: Server | undefined;
    await expect(withLoopbackRedirect(async (fixture) => {
      origin = fixture.origin;
      destination = fixture.destination;
      throw new Error("injected assertion failure");
    })).rejects.toThrow("injected assertion failure");

    expect(origin?.listening).toBe(false);
    expect(destination?.listening).toBe(false);
  });

  it("attempts both actual listener cleanups when one closer reports failure", async () => {
    const first = createServer();
    const second = createServer();
    try {
      await listenOnLoopback(first);
      await listenOnLoopback(second);
      const calls: Server[] = [];
      await expect(closeOwnedListeners([first, second], async (server) => {
        calls.push(server);
        await closeOwnedListener(server);
        if (server === first) throw new Error("injected close failure");
      })).rejects.toBeInstanceOf(AggregateError);
      expect(calls).toEqual([first, second]);
      expect(first.listening).toBe(false);
      expect(second.listening).toBe(false);
    } finally {
      await closeOwnedListeners([second, first]);
    }
  });
});
