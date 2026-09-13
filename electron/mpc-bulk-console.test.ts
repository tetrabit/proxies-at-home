import { describe, expect, it, vi } from "vitest";
import { formatMpcBulkLogEvent, MPC_BULK_LOG_MAX_LENGTH } from "../shared/mpcBulkUpgradeLogging.js";
import { registerMpcBulkConsoleForwarding } from "./mpc-bulk-console.js";

type ConsoleDetails = Readonly<{
  message: string;
  level: "info" | "warning" | "error" | "debug";
  frame: object;
}>;

class WebContentsMock {
  readonly mainFrame = {
    url: "http://localhost:5173/?serverPort=4555",
    frames: [] as object[],
  };
  destroyed = false;
  private readonly listeners = new Map<string, Set<(...args: never[]) => void>>();

  on(event: string, listener: (...args: never[]) => void): this {
    const eventListeners = this.listeners.get(event) ?? new Set();
    eventListeners.add(listener);
    this.listeners.set(event, eventListeners);
    return this;
  }

  removeListener(event: string, listener: (...args: never[]) => void): this {
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  emitConsole(details: ConsoleDetails): void {
    for (const listener of this.listeners.get("console-message") ?? []) {
      listener(details as never);
    }
  }

  emitDestroyed(): void {
    this.destroyed = true;
    for (const listener of this.listeners.get("destroyed") ?? []) listener();
  }

  listenerCount(event: string): number {
    return this.listeners.get(event)?.size ?? 0;
  }
}

function setup() {
  const current = new WebContentsMock();
  const sink = vi.fn();
  const registration = registerMpcBulkConsoleForwarding({
    webContents: current,
    getMainWebContents: () => current,
    expectedRendererUrl: () => "http://localhost:5173?serverPort=4555",
    sink,
  });
  return { current, sink, registration };
}

const validMessage = () =>
  formatMpcBulkLogEvent({
    event: "phase-started",
    runId: "run-42",
    elapsedMs: 42,
    phase: "fetch https://example.test/secret Bearer top-secret",
  });

describe("registerMpcBulkConsoleForwarding", () => {
  it("forwards a recognized info record through a re-formatted sanitized line", () => {
    const { current, sink } = setup();

    current.emitConsole({
      message: validMessage(),
      level: "info",
      frame: current.mainFrame,
    });

    expect(sink).toHaveBeenCalledOnce();
    expect(sink).toHaveBeenCalledWith(
      formatMpcBulkLogEvent({
        event: "phase-started",
        runId: "run-42",
        elapsedMs: 42,
        phase: "fetch [redacted-url] [redacted]",
      })
    );
  });

  it("discards unrelated, malformed, oversized, unknown-key, and non-info records", () => {
    const { current, sink } = setup();
    const inputs = [
      "ordinary renderer output",
      "[MPC Bulk Upgrade] {bad-json",
      "[MPC Bulk Upgrade] " + JSON.stringify({ event: "started", runId: "run-42", elapsedMs: 1, payload: "secret" }),
      "[MPC Bulk Upgrade] " + "x".repeat(MPC_BULK_LOG_MAX_LENGTH),
    ];
    for (const message of inputs) {
      current.emitConsole({ message, level: "info", frame: current.mainFrame });
    }
    current.emitConsole({ message: validMessage(), level: "error", frame: current.mainFrame });

    expect(sink).not.toHaveBeenCalled();
  });

  it("rejects foreign frames, foreign documents, stale windows, and destroyed contents", () => {
    const { current, sink } = setup();
    const details = { message: validMessage(), level: "info" as const, frame: current.mainFrame };

    current.emitConsole({ ...details, frame: {} });
    current.mainFrame.url = "https://foreign.example/?serverPort=4555";
    current.emitConsole(details);
    current.mainFrame.url = "http://localhost:5173/?serverPort=4555";
    current.mainFrame.frames.push({});
    current.emitConsole(details);
    current.mainFrame.frames.pop();
    const stale = new WebContentsMock();
    const staleSink = vi.fn();
    registerMpcBulkConsoleForwarding({
      webContents: stale,
      getMainWebContents: () => current,
      expectedRendererUrl: () => "http://localhost:5173?serverPort=4555",
      sink: staleSink,
    });
    stale.emitConsole({ message: validMessage(), level: "info", frame: stale.mainFrame });
    current.emitDestroyed();
    current.emitConsole(details);

    expect(sink).not.toHaveBeenCalled();
    expect(staleSink).not.toHaveBeenCalled();
  });

  it("normalizes the trusted development slash and exact packaged file document", () => {
    const { current, sink, registration } = setup();
    current.emitConsole({ message: validMessage(), level: "info", frame: current.mainFrame });
    expect(sink).toHaveBeenCalledOnce();
    registration.dispose();

    const packaged = new WebContentsMock();
    packaged.mainFrame.url = "file:///opt/Proxxied/client/dist/index.html?serverPort=4555";
    const packagedSink = vi.fn();
    registerMpcBulkConsoleForwarding({
      webContents: packaged,
      getMainWebContents: () => packaged,
      expectedRendererUrl: () => "file:///opt/Proxxied/client/dist/index.html?serverPort=4555",
      sink: packagedSink,
    });
    packaged.emitConsole({ message: validMessage(), level: "info", frame: packaged.mainFrame });
    packaged.mainFrame.url = "file:///tmp/untrusted.html?serverPort=4555";
    packaged.emitConsole({ message: validMessage(), level: "info", frame: packaged.mainFrame });

    expect(packagedSink).toHaveBeenCalledOnce();
  });

  it("has one listener per window, cleans up on disposal or destruction, and contains sink exceptions", () => {
    const { current, sink, registration } = setup();
    const secondRegistration = registerMpcBulkConsoleForwarding({
      webContents: current,
      getMainWebContents: () => current,
      expectedRendererUrl: () => "http://localhost:5173?serverPort=4555",
      sink,
    });
    expect(current.listenerCount("console-message")).toBe(1);

    sink.mockImplementationOnce(() => {
      throw new Error("terminal unavailable");
    });
    expect(() => current.emitConsole({ message: validMessage(), level: "info", frame: current.mainFrame })).not.toThrow();
    expect(sink).toHaveBeenCalledOnce();
    registration.dispose();
    secondRegistration.dispose();
    expect(current.listenerCount("console-message")).toBe(0);

    const destroyed = new WebContentsMock();
    registerMpcBulkConsoleForwarding({
      webContents: destroyed,
      getMainWebContents: () => destroyed,
      expectedRendererUrl: () => "http://localhost:5173?serverPort=4555",
      sink: vi.fn(),
    });
    expect(destroyed.listenerCount("console-message")).toBe(1);
    destroyed.emitDestroyed();
    expect(destroyed.listenerCount("console-message")).toBe(0);
  });
});
