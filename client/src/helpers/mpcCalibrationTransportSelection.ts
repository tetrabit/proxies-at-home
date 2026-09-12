import {
  createMpcCalibrationElectronTransport,
  type MpcCalibrationElectronBridge,
} from "./mpcCalibrationElectronTransport";
import type { MpcCalibrationTransport } from "./mpcCalibrationTransport";
import { createMpcCalibrationWebTransport } from "./mpcCalibrationWebTransport";

/** The caller, not runtime bridge detection, chooses whether linked sync is active. */
export type MpcCalibrationTransportTarget = "local" | "linked-web" | "linked-electron";

export type MpcCalibrationTransportSelectionOptions = Readonly<{
  local: MpcCalibrationTransport;
  target?: MpcCalibrationTransportTarget;
  /** Narrow test seam; production has no caller-configured web request inputs. */
  createWebTransport?: () => MpcCalibrationTransport;
  /** Narrow test seam; production reads the preload bridge only for linked Electron. */
  electronBridge?: MpcCalibrationElectronBridge;
}>;

/** Explicit linked callers do not need to fabricate an unused local transport. */
export type MpcCalibrationLinkedTransportSelectionOptions = Readonly<{
  target: Exclude<MpcCalibrationTransportTarget, "local">;
  /** Retained only for callers migrating from the general selection shape. */
  local?: MpcCalibrationTransport;
  createWebTransport?: () => MpcCalibrationTransport;
  electronBridge?: MpcCalibrationElectronBridge;
}>;

/**
 * Selects one existing common transport. Local is deliberate default and makes no
 * web or IPC probe; linked modes are an explicit caller choice for the future
 * common coordinator, not an independent cache or preference-sync sidecar.
 */
export function selectMpcCalibrationTransport(options: MpcCalibrationTransportSelectionOptions): MpcCalibrationTransport;
export function selectMpcCalibrationTransport(options: MpcCalibrationLinkedTransportSelectionOptions): MpcCalibrationTransport;
export function selectMpcCalibrationTransport(
  options: MpcCalibrationTransportSelectionOptions | MpcCalibrationLinkedTransportSelectionOptions
): MpcCalibrationTransport {
  const rawTarget = options.target;
  const target = rawTarget === undefined ? "local" : rawTarget;
  switch (target) {
    case "local": {
      const local = options.local;
      if (local === undefined || local === null) throw new TypeError("Local calibration transport is required");
      return local;
    }
    case "linked-web":
      return (options.createWebTransport ?? createMpcCalibrationWebTransport)();
    case "linked-electron":
      return createMpcCalibrationElectronTransport({ bridge: options.electronBridge });
    default:
      throw new TypeError("Invalid calibration transport target");
  }
}
