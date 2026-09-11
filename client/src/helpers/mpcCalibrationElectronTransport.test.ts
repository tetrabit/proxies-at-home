import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createMpcCalibrationElectronTransport,
  type MpcCalibrationElectronBridge,
} from "./mpcCalibrationElectronTransport";
import type { CalibrationHarnessSnapshot } from "../../../shared/calibrationHarness";

const hashA = "a".repeat(64);
const hashB = "b".repeat(64);
const emptySnapshot: CalibrationHarnessSnapshot = {
  version: 1,
  datasets: [],
  cases: [],
  assets: [],
  runs: [],
};

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes.slice().buffer as ArrayBuffer);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

function bridge(
  execute: MpcCalibrationElectronBridge["calibrationHarnessExecute"],
): MpcCalibrationElectronBridge {
  return { calibrationHarnessExecute: execute };
}

describe("Electron calibration transport", () => {
  afterEach(() => vi.restoreAllMocks());

  it("captures the original put signal before digest and skips late IPC dispatch", async () => {
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
    const transport = createMpcCalibrationElectronTransport({ bridge: bridge(async () => {
      dispatches += 1;
      return { ok: true, value: { sha256: digest, byteLength: bytes.byteLength, inserted: true } };
    }) });
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

  it("uses the captured bridge receiver and fixed six-operation DTOs without forwarding pair credentials", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const digest = await sha256(bytes);
    const calls: unknown[] = [];
    const receiver = {
      marker: "captured-receiver",
      calibrationHarnessExecute(this: { marker: string }, operation: unknown) {
        expect(this.marker).toBe("captured-receiver");
        calls.push(operation);
        const kind = (operation as { kind: string }).kind;
        switch (kind) {
          case "getSession": return Promise.resolve({ ok: true as const, value: { ownerId: "owner-a", harnessId: "harness-a" } });
          case "getSnapshot": return Promise.resolve({ ok: true as const, value: { revision: 7, snapshot: emptySnapshot } });
          case "publishSnapshot": return Promise.resolve({ ok: true as const, value: { revision: 8, snapshot: emptySnapshot } });
          case "getBlob": return Promise.resolve({ ok: true as const, value: bytes });
          case "putBlob": return Promise.resolve({ ok: true as const, value: { sha256: digest, byteLength: 3, inserted: true } });
          case "missingBlobs": return Promise.resolve({ ok: true as const, value: { missing: [hashA] } });
          default: throw new Error("unexpected operation");
        }
      },
    };
    const transport = createMpcCalibrationElectronTransport({ bridge: receiver });
    receiver.calibrationHarnessExecute = () => Promise.resolve({ ok: false as const, error: { code: "invalid-operation" } }) as never;

    await expect(transport.pair(`calibration_pair_${"a".repeat(43)}`)).rejects.toMatchObject({ code: "invalid-operation" });
    await expect(transport.unpair()).rejects.toMatchObject({ code: "invalid-operation" });
    await expect(transport.getSession()).resolves.toEqual({ ownerId: "owner-a", harnessId: "harness-a" });
    await expect(transport.getSnapshot()).resolves.toEqual({ revision: 7, snapshot: emptySnapshot });
    await expect(transport.publishSnapshot(emptySnapshot, 7)).resolves.toEqual({ revision: 8, snapshot: emptySnapshot });
    await expect(transport.getBlob(digest)).resolves.toEqual(bytes);
    await expect(transport.putBlob(digest, bytes)).resolves.toEqual({ sha256: digest, byteLength: 3, inserted: true });
    await expect(transport.missingBlobs([hashA, hashB])).resolves.toEqual({ missing: [hashA] });

    expect(calls).toEqual([
      { kind: "getSession" },
      { kind: "getSnapshot" },
      { kind: "publishSnapshot", snapshot: emptySnapshot, expectedRevision: 7 },
      { kind: "getBlob", sha256: digest },
      { kind: "putBlob", sha256: digest, bytes },
      { kind: "missingBlobs", hashes: [hashA, hashB] },
    ]);
  });

  it("maps fixed bridge failures precisely and rejects malformed tagged responses", async () => {
    let response: unknown = { ok: false, error: { code: "not-configured" } };
    const transport = createMpcCalibrationElectronTransport({ bridge: bridge(async () => response as never) });

    await expect(transport.getSession()).rejects.toMatchObject({ code: "unpaired" });
    response = { ok: false, error: { code: "http", status: 401 } };
    await expect(transport.getSession()).rejects.toMatchObject({ code: "authentication", status: 401 });
    response = { ok: false, error: { code: "http", status: 403 } };
    await expect(transport.getSession()).rejects.toMatchObject({ code: "authentication", status: 403 });
    response = { ok: false, error: { code: "http", status: 404 } };
    await expect(transport.getSnapshot()).resolves.toBeNull();
    await expect(transport.getSession()).rejects.toMatchObject({ code: "http", status: 404 });
    response = { ok: false, error: { code: "http", status: 412 } };
    await expect(transport.publishSnapshot(emptySnapshot, 7)).rejects.toMatchObject({ code: "http", status: 412 });
    response = { ok: false, error: { code: "offline" } };
    await expect(transport.getSession()).rejects.toMatchObject({ code: "offline" });
    response = { ok: false, error: { code: "not-configured", status: 503 } };
    await expect(transport.getSession()).rejects.toMatchObject({ code: "invalid-response" });
    response = { ok: true, value: { ownerId: "owner-a", harnessId: "harness-a", extra: true } };
    await expect(transport.getSession()).rejects.toMatchObject({ code: "invalid-response" });
    response = { ok: false, error: { code: "http", status: 700 } };
    await expect(transport.getSession()).rejects.toMatchObject({ code: "invalid-response" });
  });

  it("enforces exact snapshot acknowledgements and bounded digest-verified binary and missing-hash receipts", async () => {
    const bytes = new Uint8Array([7, 8, 9]);
    const digest = await sha256(bytes);
    let response: unknown = { ok: true, value: { revision: 7, snapshot: emptySnapshot } };
    const transport = createMpcCalibrationElectronTransport({ bridge: bridge(async () => response as never) });

    await expect(transport.publishSnapshot(emptySnapshot, 7)).rejects.toMatchObject({ code: "invalid-response" });
    response = { ok: true, value: { revision: 8, snapshot: { ...emptySnapshot, runs: [{ unexpected: true }] } } };
    await expect(transport.publishSnapshot(emptySnapshot, 7)).rejects.toMatchObject({ code: "invalid-response" });
    response = { ok: true, value: new Uint8Array(32 * 1024 * 1024 + 1) };
    await expect(transport.getBlob(hashA)).rejects.toMatchObject({ code: "invalid-response" });
    response = { ok: true, value: new Uint8Array([1, 2, 3]) };
    await expect(transport.getBlob(digest)).rejects.toMatchObject({ code: "invalid-response" });
    response = { ok: true, value: { sha256: digest, byteLength: 2, inserted: true } };
    await expect(transport.putBlob(digest, bytes)).rejects.toMatchObject({ code: "invalid-response" });
    response = { ok: true, value: { missing: [hashA, hashA] } };
    await expect(transport.missingBlobs([hashA, hashB])).rejects.toMatchObject({ code: "invalid-response" });
    response = { ok: true, value: { missing: [hashB] } };
    await expect(transport.missingBlobs([hashA, hashB])).resolves.toEqual({ missing: [hashB] });
  });

  it("settles locally on abort without dispatching pre-aborted IPC or delivering late bridge results", async () => {
    let dispatches = 0;
    let resolveBridge!: (value: unknown) => void;
    const pending = new Promise<unknown>(resolve => { resolveBridge = resolve; });
    const transport = createMpcCalibrationElectronTransport({ bridge: bridge(async () => {
      dispatches += 1;
      return pending as never;
    }) });
    const preAborted = new AbortController();
    preAborted.abort();
    await expect(transport.getSession({ signal: preAborted.signal })).rejects.toMatchObject({ code: "aborted" });
    expect(dispatches).toBe(0);

    const controller = new AbortController();
    const request = transport.getSession({ signal: controller.signal });
    expect(dispatches).toBe(1);
    controller.abort();
    await expect(request).rejects.toMatchObject({ code: "aborted" });
    resolveBridge({ ok: true, value: { ownerId: "owner-a", harnessId: "harness-a" } });
    await Promise.resolve();
  });
});
