/**
 * Renderer console log sink for the Electron main process.
 *
 * Mirrors renderer `console-message` events (level + message) into a
 * rotating log file under the app log directory. Designed so the sync and
 * calibration diagnostics that only exist in the renderer console can be
 * inspected from disk after the fact (devtools is not always open).
 *
 * Guarantees:
 * - Never throws: every filesystem interaction is best-effort and failures
 *   drop the buffered lines rather than propagate.
 * - Never delays the renderer: `append` is O(1) in-memory; writes are
 *   batched and appended asynchronously.
 * - Bounded: lines are truncated, and the log file rotates at a byte limit
 *   with a single backup.
 */
import { appendFile, lstat, mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";

export type RendererConsoleSink = Readonly<{
  /** Records one console message. Synchronous and never throws. */
  append(level: string, message: string): void;
  /** Flushes pending buffered lines to disk. Resolves even on failure. */
  flush(): Promise<void>;
  /** Stops the timer, flushes, and releases resources. */
  dispose(): Promise<void>;
}>;

export type CreateRendererConsoleSinkOptions = Readonly<{
  /** Directory that will contain the log file (created if missing). */
  logDirectory: string;
  /** Log file name. Default: `renderer-console.log`. */
  fileName?: string;
  /** Rotate the log when it would grow past this many bytes. Default: 5 MiB. */
  maxBytes?: number;
  /** How often buffered lines are flushed. Default: 2000 ms. */
  flushIntervalMs?: number;
  /** Maximum characters retained per log line. Default: 2000. */
  maxLineBytes?: number;
  /** Flush immediately once the buffer exceeds this many bytes. Default: 64 KiB. */
  maxBufferBytes?: number;
  /** Injectable timer for tests. */
  timerFactory?: (
    intervalMs: number,
    callback: () => void,
  ) => Readonly<{ stop(): void }>;
}>;

type WebContentsConsoleDetails = Readonly<{
  level: string;
  message: string;
}>;

type WebContentsLike = {
  isDestroyed(): boolean;
  on(
    event: "console-message",
    listener: (details: WebContentsConsoleDetails) => void,
  ): unknown;
  on(event: "destroyed", listener: () => void): unknown;
  removeListener(
    event: "console-message",
    listener: (details: WebContentsConsoleDetails) => void,
  ): unknown;
  removeListener(event: "destroyed", listener: () => void): unknown;
};

export type RendererConsoleSinkRegistration = Readonly<{
  dispose(): void;
}>;

const DEFAULT_FILE_NAME = "renderer-console.log";
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_FLUSH_INTERVAL_MS = 2000;
const DEFAULT_MAX_LINE_BYTES = 2000;
const DEFAULT_MAX_BUFFER_BYTES = 64 * 1024;

function defaultTimerFactory(
  intervalMs: number,
  callback: () => void,
): Readonly<{ stop(): void }> {
  const handle = setInterval(callback, intervalMs);
  return { stop: () => clearInterval(handle) };
}

export function createRendererConsoleSink(
  options: CreateRendererConsoleSinkOptions,
): RendererConsoleSink {
  const fileName = options.fileName ?? DEFAULT_FILE_NAME;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
  const maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
  const maxBufferBytes = options.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;
  const timer =
    options.timerFactory?.(flushIntervalMs, () => {
      void flush();
    }) ?? defaultTimerFactory(flushIntervalMs, () => void flush());

  const logPath = path.join(options.logDirectory, fileName);
  const backupPath = `${logPath}.1`;
  let buffer: string[] = [];
  let bufferedBytes = 0;
  let disposed = false;
  // Serialize flushes so appends keep their order.
  let chain: Promise<void> = Promise.resolve();

  async function doFlush(): Promise<void> {
    if (buffer.length === 0) return;
    const payload = buffer.join("");
    buffer = [];
    bufferedBytes = 0;
    try {
      await mkdir(options.logDirectory, { recursive: true });
      const currentSize = await safeSize(logPath);
      if (currentSize + payload.length > maxBytes) {
        await rotate(currentSize);
      }
      await appendFile(logPath, payload, "utf8");
    } catch {
      // Dropped log lines must never break the main process.
    }
  }

  async function rotate(currentSize: number): Promise<void> {
    if (currentSize > 0) {
      try {
        await rm(backupPath, { force: true });
        await rename(logPath, backupPath);
      } catch {
        // If rotation fails, append anyway; the file may grow past maxBytes
        // until the next successful rotation.
      }
    }
  }

  async function safeSize(target: string): Promise<number> {
    try {
      const info = await stat(target);
      return info.size;
    } catch {
      return 0;
    }
  }

  function drain(): Promise<void> {
    const operation = chain.then(doFlush, doFlush);
    chain = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  function flush(): Promise<void> {
    if (disposed) return Promise.resolve();
    return drain();
  }

  function append(level: string, message: string): void {
    if (disposed) return;
    try {
      const safeLevel = sanitize(level);
      const truncated = message.length > maxLineBytes
        ? `${message.slice(0, maxLineBytes)}…`
        : message;
      const safeMessage = sanitizeCharacters(truncated);
      const line = `${new Date().toISOString()} [${safeLevel}] ${safeMessage}\n`;
      buffer.push(line);
      bufferedBytes += line.length;
      if (bufferedBytes >= maxBufferBytes) {
        void flush();
      }
    } catch {
      // Never throw from the console listener path.
    }
  }

  async function dispose(): Promise<void> {
    if (disposed) return;
    disposed = true;
    try {
      timer.stop();
    } catch {
      // The timer is best-effort.
    }
    // Drain after the flag so the final flush still writes pending lines
    // even though later timer-driven flushes are suppressed.
    await drain();
  }

  return { append, flush, dispose };
}

function sanitizeCharacters(value: string): string {
  return value.replace(/[\r\n\t\u0000-\u001f]/g, " ");
}

function sanitize(value: string): string {
  return sanitizeCharacters(value).slice(0, 32) || "log";
}

/**
 * Wires renderer `console-message` events into a sink. Returns a disposable
 * registration; the listener also detaches itself when the WebContents is
 * destroyed. Electron 39 passes the console-message details on the first
 * listener argument.
 */
export function registerRendererConsoleSink(
  webContents: WebContentsLike,
  sink: RendererConsoleSink,
): RendererConsoleSinkRegistration {
  let disposed = false;
  const onConsoleMessage = (details: WebContentsConsoleDetails): void => {
    if (disposed) return;
    try {
      sink.append(details.level ?? "log", details.message ?? "");
    } catch {
      // A misbehaving sink must never break renderer message delivery.
    }
  };
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    try {
      webContents.removeListener("console-message", onConsoleMessage);
      webContents.removeListener("destroyed", dispose);
    } catch {
      // A tearing-down WebContents must not make window shutdown fail.
    }
  };
  try {
    webContents.on("console-message", onConsoleMessage);
    webContents.on("destroyed", dispose);
  } catch {
    dispose();
  }
  return { dispose };
}
