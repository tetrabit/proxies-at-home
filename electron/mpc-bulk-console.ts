import type { WebContentsConsoleMessageEventParams } from "electron";
import {
  formatMpcBulkLogEvent,
  parseMpcBulkLogMessage,
} from "../shared/mpcBulkUpgradeLogging.js";

export type MpcBulkConsoleMessageDetails = Pick<
  WebContentsConsoleMessageEventParams,
  "message" | "level" | "frame"
>;

type WebContentsLike = {
  mainFrame: Readonly<{ url: string; frames: readonly unknown[] }>;
  isDestroyed(): boolean;
  on(
    event: "console-message",
    listener: (details: MpcBulkConsoleMessageDetails) => void
  ): unknown;
  on(event: "destroyed", listener: () => void): unknown;
  removeListener(
    event: "console-message",
    listener: (details: MpcBulkConsoleMessageDetails) => void
  ): unknown;
  removeListener(event: "destroyed", listener: () => void): unknown;
};

export type MpcBulkConsoleForwardingOptions = Readonly<{
  webContents: WebContentsLike;
  getMainWebContents: () => WebContentsLike | null;
  expectedRendererUrl: () => string;
  sink?: (line: string) => void;
}>;

export type MpcBulkConsoleForwardingRegistration = Readonly<{
  dispose: () => void;
}>;

const registrations = new WeakMap<
  WebContentsLike,
  MpcBulkConsoleForwardingRegistration
>();

function isTrustedRendererDocument(
  actualUrl: string,
  expectedUrl: string
): boolean {
  try {
    const expected = new URL(expectedUrl);
    const actual = new URL(actualUrl);
    if (expected.protocol === "file:") {
      return (
        actual.protocol === "file:" &&
        actual.hostname === expected.hostname &&
        actual.pathname === expected.pathname &&
        actual.search === expected.search
      );
    }
    return (
      (expected.protocol === "http:" || expected.protocol === "https:") &&
      actual.protocol === expected.protocol &&
      actual.origin === expected.origin &&
      actual.pathname === expected.pathname &&
      actual.search === expected.search
    );
  } catch {
    return false;
  }
}

/**
 * Relays only validated bulk-upgrade renderer records from the current trusted
 * main document. Electron 39 puts console-message details on its first argument.
 */
export function registerMpcBulkConsoleForwarding(
  options: MpcBulkConsoleForwardingOptions
): MpcBulkConsoleForwardingRegistration {
  const existing = registrations.get(options.webContents);
  if (existing !== undefined) return existing;

  const sink = options.sink ?? console.log;
  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    registrations.delete(options.webContents);
    try {
      options.webContents.removeListener("console-message", onConsoleMessage);
      options.webContents.removeListener("destroyed", dispose);
    } catch {
      // A tearing-down WebContents must not make window shutdown fail.
    }
  };
  const onConsoleMessage = (details: MpcBulkConsoleMessageDetails): void => {
    try {
      const current = options.getMainWebContents();
      if (
        disposed ||
        details.level !== "info" ||
        current !== options.webContents ||
        options.webContents.isDestroyed() ||
        details.frame !== options.webContents.mainFrame ||
        options.webContents.mainFrame.frames.length !== 0 ||
        !isTrustedRendererDocument(
          options.webContents.mainFrame.url,
          options.expectedRendererUrl()
        )
      ) {
        return;
      }
      const event = parseMpcBulkLogMessage(details.message);
      if (event === null) return;
      sink(formatMpcBulkLogEvent(event));
    } catch {
      // Logging must never alter renderer or main-process lifecycle behavior.
    }
  };

  const registration = Object.freeze({ dispose });
  registrations.set(options.webContents, registration);
  try {
    options.webContents.on("console-message", onConsoleMessage);
    options.webContents.on("destroyed", dispose);
  } catch {
    dispose();
  }
  return registration;
}
