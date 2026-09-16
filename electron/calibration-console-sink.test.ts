import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createRendererConsoleSink,
  registerRendererConsoleSink,
  type CreateRendererConsoleSinkOptions,
} from "./calibration-console-sink.js";

type Timers = Array<Readonly<{ stop(): void }>>;

function manualTimers(): {
  options: Pick<CreateRendererConsoleSinkOptions, "timerFactory">;
  tick: () => void;
} {
  const callbacks: Array<() => void> = [];
  const timers: Timers = callbacks.map(() => ({
    stop: vi.fn(),
  }));
  return {
    options: {
      timerFactory: (
        _intervalMs: number,
        callback: () => void,
      ): Readonly<{ stop(): void }> => {
        callbacks.push(callback);
        return timers[callbacks.length - 1]!;
      },
    },
    tick: () => callbacks.forEach((callback) => callback()),
  };
}

describe("createRendererConsoleSink", () => {
  let directory: string;

  beforeAll(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "proxxied-console-sink-"));
  });

  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("appends level and message to the log file", async () => {
    const timers = manualTimers();
    const sink = createRendererConsoleSink({
      logDirectory: directory,
      fileName: "basic.log",
      ...timers.options,
    });
    sink.append("info", "[mpc-calibration] hydration outcome status=ok");
    sink.append("error", "boom");
    await sink.dispose();

    const content = await readFile(path.join(directory, "basic.log"), "utf8");
    expect(content).toContain("[info] [mpc-calibration] hydration outcome status=ok");
    expect(content).toContain("[error] boom");
  });

  it("flushes on the interval timer without an explicit flush", async () => {
    const timers = manualTimers();
    const sink = createRendererConsoleSink({
      logDirectory: directory,
      fileName: "timed.log",
      ...timers.options,
    });
    sink.append("warning", "queued");
    timers.tick();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await sink.dispose();

    const content = await readFile(path.join(directory, "timed.log"), "utf8");
    expect(content).toContain("[warning] queued");
  });

  it("truncates oversized lines", async () => {
    const timers = manualTimers();
    const sink = createRendererConsoleSink({
      logDirectory: directory,
      fileName: "truncated.log",
      maxLineBytes: 32,
      ...timers.options,
    });
    sink.append("info", "x".repeat(100));
    await sink.dispose();

    const content = await readFile(path.join(directory, "truncated.log"), "utf8");
    expect(content).toContain("x".repeat(32));
    expect(content).not.toContain("x".repeat(33));
    expect(content).toContain("…");
  });

  it("strips newlines from levels and messages", async () => {
    const timers = manualTimers();
    const sink = createRendererConsoleSink({
      logDirectory: directory,
      fileName: "newline.log",
      ...timers.options,
    });
    sink.append("info\nevil", "line1\nline2");
    await sink.dispose();

    const lines = (await readFile(path.join(directory, "newline.log"), "utf8"))
      .trim()
      .split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("line1 line2");
  });

  it("rotates the log when the byte limit is exceeded", async () => {
    const timers = manualTimers();
    const sink = createRendererConsoleSink({
      logDirectory: directory,
      fileName: "rotate.log",
      maxBytes: 120,
      maxBufferBytes: 10,
      ...timers.options,
    });
    sink.append("info", "first-generation payload ".repeat(4));
    await sink.flush();
    sink.append("info", "second-generation payload ".repeat(4));
    await sink.flush();
    await sink.dispose();

    const current = await readFile(path.join(directory, "rotate.log"), "utf8");
    const backup = await readFile(path.join(directory, "rotate.log.1"), "utf8");
    expect(backup).toContain("first-generation payload");
    expect(current).toContain("second-generation payload");
    expect(current).not.toContain("first-generation payload");
  });

  it("keeps only one backup on repeated rotations", async () => {
    const timers = manualTimers();
    const sink = createRendererConsoleSink({
      logDirectory: directory,
      fileName: "multi-rotate.log",
      maxBytes: 80,
      maxBufferBytes: 10,
      ...timers.options,
    });
    for (let generation = 1; generation <= 3; generation += 1) {
      sink.append("info", `generation ${generation} payload`.repeat(3));
      await sink.flush();
    }
    await sink.dispose();

    const backup = await readFile(path.join(directory, "multi-rotate.log.1"), "utf8");
    expect(backup).toContain("generation 2");
    expect(backup).not.toContain("generation 1");
  });

  it("never throws when the log directory cannot be created", async () => {
    const timers = manualTimers();
    const sink = createRendererConsoleSink({
      logDirectory: path.join(directory, "blocked", "impossible"),
      fileName: "nowhere.log",
      ...timers.options,
    });
    const blocker = await mkdtemp(path.join(directory, "blocked-"));
    // Replace the directory path component with an existing file so mkdir fails.
    const fileInWay = path.join(directory, "blocked");
    const { writeFile } = await import("node:fs/promises");
    await rm(fileInWay, { recursive: true, force: true });
    await writeFile(fileInWay, "blocker");
    expect(() => sink.append("info", "dropped")).not.toThrow();
    await expect(sink.flush()).resolves.toBeUndefined();
    await sink.dispose();
    await rm(blocker, { recursive: true, force: true });
  });

  it("flushes immediately when the buffer exceeds maxBufferBytes", async () => {
    const timers = manualTimers();
    const sink = createRendererConsoleSink({
      logDirectory: directory,
      fileName: "buffer.log",
      maxBufferBytes: 20,
      ...timers.options,
    });
    sink.append("info", "a payload that exceeds the tiny buffer limit");
    await new Promise((resolve) => setTimeout(resolve, 20));
    await sink.dispose();

    const content = await readFile(path.join(directory, "buffer.log"), "utf8");
    expect(content).toContain("a payload that exceeds the tiny buffer limit");
  });
});

describe("registerRendererConsoleSink", () => {
  class WebContentsMock {
    private destroyed = false;
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

    emitConsole(level: string, message: string): void {
      for (const listener of this.listeners.get("console-message") ?? []) {
        listener({ level, message } as never);
      }
    }

    emitDestroyed(): void {
      this.destroyed = true;
      for (const listener of this.listeners.get("destroyed") ?? []) {
        listener();
      }
    }

    listenerCount(event: string): number {
      return this.listeners.get(event)?.size ?? 0;
    }
  }

  it("forwards console messages into the sink", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "proxxied-console-reg-"));
    try {
      const timers = manualTimers();
      const sink = createRendererConsoleSink({
        logDirectory: directory,
        fileName: "forwarded.log",
        ...timers.options,
      });
      const webContents = new WebContentsMock();
      const registration = registerRendererConsoleSink(webContents, sink);
      webContents.emitConsole("info", "[mpc-calibration] queue recovery trigger fired");
      await sink.dispose();

      const content = await readFile(path.join(directory, "forwarded.log"), "utf8");
      expect(content).toContain("[mpc-calibration] queue recovery trigger fired");
      registration.dispose();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("stops forwarding after dispose", () => {
    const sink = {
      append: vi.fn(),
      flush: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn().mockResolvedValue(undefined),
    };
    const webContents = new WebContentsMock();
    const registration = registerRendererConsoleSink(webContents, sink);
    registration.dispose();
    webContents.emitConsole("info", "after dispose");
    expect(sink.append).not.toHaveBeenCalled();
    expect(webContents.listenerCount("console-message")).toBe(0);
  });

  it("detaches itself when the web contents is destroyed", () => {
    const sink = {
      append: vi.fn(),
      flush: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn().mockResolvedValue(undefined),
    };
    const webContents = new WebContentsMock();
    const registration = registerRendererConsoleSink(webContents, sink);
    webContents.emitDestroyed();
    expect(webContents.listenerCount("console-message")).toBe(0);
    expect(webContents.listenerCount("destroyed")).toBe(0);
    webContents.emitConsole("info", "after destroy");
    expect(sink.append).not.toHaveBeenCalled();
    registration.dispose();
  });
});
