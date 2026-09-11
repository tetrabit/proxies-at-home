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

/**
 * Selects one existing common transport. Local is deliberate default and makes no
 * web or IPC probe; linked modes are an explicit caller choice for the future
 * common coordinator, not an independent cache or preference-sync sidecar.
 */
export function selectMpcCalibrationTransport(options: MpcCalibrationTransportSelectionOptions): MpcCalibrationTransport {
  const target = options.target ?? "local";
  switch (target) {
    case "local":
      return options.local;
    case "linked-web":
      return (options.createWebTransport ?? createMpcCalibrationWebTransport)();
    case "linked-electron":
      return createMpcCalibrationElectronTransport({ bridge: options.electronBridge });
    default:
      throw new TypeError("Invalid calibration transport target");
  }
}
