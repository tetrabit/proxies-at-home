import type { IpcMain } from "electron";
import type {
  CalibrationHarnessConfigLoadResult,
} from "./calibration-harness-config.js";
import {
  createCalibrationHarnessBroker,
  type CalibrationHarnessBroker,
} from "./calibration-harness-broker.js";
import { loadCalibrationHarnessConfig } from "./calibration-harness-config.js";
import type {
  CalibrationHarnessIpcErrorCode,
  CalibrationHarnessIpcOperation,
  CalibrationHarnessIpcResult,
} from "../shared/calibrationHarnessIpc.js";

export const CALIBRATION_HARNESS_IPC_CHANNEL = "calibration-harness:execute" as const;

type WebContentsLike = Readonly<{
  mainFrame: Readonly<{ url: string }>;
  isDestroyed(): boolean;
  on(event: "did-start-navigation", listener: (event: unknown, url: string, isInPlace: boolean, isMainFrame: boolean) => void): unknown;
  on(event: "destroyed", listener: () => void): unknown;
  removeListener(event: "did-start-navigation", listener: (event: unknown, url: string, isInPlace: boolean, isMainFrame: boolean) => void): unknown;
  removeListener(event: "destroyed", listener: () => void): unknown;
}>;
type IpcEventLike = Readonly<{ sender: unknown; senderFrame: unknown }>;
type IpcMainLike = Pick<IpcMain, "handle" | "removeHandler">;

type RegisterOptions = Readonly<{
  ipcMain: IpcMainLike;
  getMainWebContents: () => WebContentsLike | null;
  expectedRendererUrl: () => string;
  configPath: () => string;
  loadConfig?: (filename: string) => Promise<CalibrationHarnessConfigLoadResult>;
  createBroker?: (
    config: CalibrationHarnessConfigLoadResult,
    options: Readonly<{ signal: AbortSignal }>,
  ) => CalibrationHarnessBroker;
}>;

export type CalibrationHarnessIpcDisposer = () => Promise<void>;

function trustedDocument(event: IpcEventLike, options: RegisterOptions): boolean {
  try {
    const current = options.getMainWebContents();
    if (current === null || current.isDestroyed()
      || event.sender !== current || event.senderFrame !== current.mainFrame) return false;
    const expected = new URL(options.expectedRendererUrl());
    const actual = new URL(current.mainFrame.url);
    if (expected.protocol === "file:") {
      return actual.protocol === "file:"
        && actual.hostname === expected.hostname
        && actual.pathname === expected.pathname
        && actual.search === expected.search;
    }
    return (expected.protocol === "http:" || expected.protocol === "https:")
      && actual.protocol === expected.protocol
      && actual.origin === expected.origin
      && actual.pathname === expected.pathname
      && actual.search === expected.search;
  } catch {
    return false;
  }
}

function failure(error: unknown): CalibrationHarnessIpcResult {
  const candidate = error !== null && typeof error === "object" ? error as { code?: unknown; status?: unknown } : {};
  const codes: readonly CalibrationHarnessIpcErrorCode[] = [
    "not-configured", "invalid-operation", "http", "offline", "timeout", "aborted",
    "redirect", "response-too-large", "invalid-response",
  ];
  const code = typeof candidate.code === "string" && codes.includes(candidate.code as CalibrationHarnessIpcErrorCode)
    ? candidate.code as CalibrationHarnessIpcErrorCode
    : "not-configured";
  const status = code === "http" && typeof candidate.status === "number"
    && Number.isSafeInteger(candidate.status) && candidate.status >= 100 && candidate.status <= 599
    ? candidate.status
    : undefined;
  return status === undefined
    ? { ok: false, error: { code } }
    : { ok: false, error: { code, status } };
}

/** Registers the sole renderer-to-main calibration transport and returns its idempotent async disposer. */
export function registerCalibrationHarnessIpcHandlers(options: RegisterOptions): CalibrationHarnessIpcDisposer {
  const controllers = new Set<AbortController>();
  const inFlight = new Set<Promise<void>>();
  let disposed = false;
  let cleanup: Promise<void> | undefined;
  const loadConfig = options.loadConfig ?? loadCalibrationHarnessConfig;
  const createBroker = options.createBroker ?? createCalibrationHarnessBroker;

  options.ipcMain.handle(CALIBRATION_HARNESS_IPC_CHANNEL, async (event, operation: CalibrationHarnessIpcOperation) => {
    if (disposed || !trustedDocument(event as IpcEventLike, options)) return failure({ code: "invalid-operation" });
    const sender = event.sender as WebContentsLike;
    const controller = new AbortController();
    const abortForNavigation = (_event: unknown, _url: string, isInPlace: boolean, isMainFrame: boolean): void => {
      if (isMainFrame && !isInPlace) controller.abort();
    };
    const abortForDestruction = (): void => { controller.abort(); };

    const run = async (): Promise<CalibrationHarnessIpcResult> => {
      controllers.add(controller);
      try {
        sender.on("did-start-navigation", abortForNavigation);
        sender.on("destroyed", abortForDestruction);
        const config = await loadConfig(options.configPath());
        if (disposed || controller.signal.aborted || !trustedDocument(event as IpcEventLike, options)) {
          return failure({ code: "aborted" });
        }
        const value = await createBroker(config, { signal: controller.signal }).execute(operation);
        if (disposed || controller.signal.aborted || !trustedDocument(event as IpcEventLike, options)) {
          return failure({ code: "aborted" });
        }
        return { ok: true, value } as CalibrationHarnessIpcResult;
      } catch (error) {
        return controller.signal.aborted ? failure({ code: "aborted" }) : failure(error);
      } finally {
        controllers.delete(controller);
        try {
          sender.removeListener("did-start-navigation", abortForNavigation);
          sender.removeListener("destroyed", abortForDestruction);
        } catch {
          // Sender destruction cannot make IPC errors observable to the renderer.
        }
      }
    };

    const result = run();
    const settlement = result.then(() => undefined, () => undefined);
    inFlight.add(settlement);
    void settlement.then(() => { inFlight.delete(settlement); });
    return result;
  });

  return () => {
    if (cleanup !== undefined) return cleanup;
    disposed = true;
    for (const controller of controllers) controller.abort();
    options.ipcMain.removeHandler(CALIBRATION_HARNESS_IPC_CHANNEL);
    cleanup = Promise.allSettled([...inFlight]).then(() => undefined);
    return cleanup;
  };
}
