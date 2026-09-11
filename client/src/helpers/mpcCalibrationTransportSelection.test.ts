import { afterEach, describe, expect, it, vi } from "vitest";

import { MpcCalibrationTransportError, type MpcCalibrationTransport } from "./mpcCalibrationTransport";
import {
  selectMpcCalibrationTransport,
  type MpcCalibrationTransportTarget,
} from "./mpcCalibrationTransportSelection";

function transport(name: string): MpcCalibrationTransport {
  const fail = async <T>(): Promise<T> => { throw new Error(`${name} was not expected`); };
  return {
    pair: fail,
    unpair: async () => undefined,
    getSession: fail,
    getSnapshot: fail,
    publishSnapshot: fail,
    getBlob: fail,
    putBlob: fail,
    missingBlobs: fail,
  };
}

describe("calibration transport selection", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("defaults explicitly to the supplied local transport without bridge probing, fetch, or legacy preference calls", async () => {
    const local = transport("local");
    const bridge = { calibrationHarnessExecute: vi.fn() };
    const webFactory = vi.fn(() => transport("web"));
    const selected = selectMpcCalibrationTransport({
      local,
      electronBridge: bridge,
      createWebTransport: webFactory,
    });

    expect(selected).toBe(local);
    expect(bridge.calibrationHarnessExecute).not.toHaveBeenCalled();
    expect(webFactory).not.toHaveBeenCalled();
  });

  it("selects linked web only when requested and returns its common transport interface unchanged", () => {
    const local = transport("local");
    const linkedWeb = transport("web");
    const webFactory = vi.fn(() => linkedWeb);

    const selected = selectMpcCalibrationTransport({
      target: "linked-web",
      local,
      createWebTransport: webFactory,
    });

    expect(selected).toBe(linkedWeb);
    expect(webFactory).toHaveBeenCalledOnce();
  });

  it("selects linked Electron only when requested, fails closed without the narrow bridge, and rejects invalid targets", async () => {
    const local = transport("local");
    const webFactory = vi.fn(() => transport("web"));
    const selected = selectMpcCalibrationTransport({
      target: "linked-electron",
      local,
      createWebTransport: webFactory,
    });

    await expect(selected.getSession()).rejects.toEqual(new MpcCalibrationTransportError("invalid-operation"));
    expect(webFactory).not.toHaveBeenCalled();
    expect(() => selectMpcCalibrationTransport({
      target: "automatic" as MpcCalibrationTransportTarget,
      local,
    })).toThrow(TypeError);
  });

  it("drives the actual linked Electron adapter without fetch or legacy preference calls", async () => {
    const local = transport("local");
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const legacyLoad = vi.fn();
    const legacySave = vi.fn();
    const execute = vi.fn(async () => ({ ok: true as const, value: { ownerId: "owner-a", harnessId: "harness-a" } }));
    const electronBridge = {
      calibrationHarnessExecute: execute,
      loadMpcPreferences: legacyLoad,
      saveMpcPreferences: legacySave,
    };
    const selected = selectMpcCalibrationTransport({ target: "linked-electron", local, electronBridge });

    await expect(selected.getSession()).resolves.toEqual({ ownerId: "owner-a", harnessId: "harness-a" });
    expect(execute).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith({ kind: "getSession" });
    expect(fetch).not.toHaveBeenCalled();
    expect(legacyLoad).not.toHaveBeenCalled();
    expect(legacySave).not.toHaveBeenCalled();
  });
});
