export class CalibrationAdmissionQueueFullError extends Error {
  constructor(maxQueued: number) {
    super(`Printer calibration process queue is full (max queued: ${maxQueued}).`);
    this.name = "CalibrationAdmissionQueueFullError";
  }
}

export class CalibrationAdmissionTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Printer calibration command timed out after ${timeoutMs}ms.`);
    this.name = "CalibrationAdmissionTimeoutError";
  }
}

export type CalibrationProcessAdmissionOptions = {
  maxActive: number;
  maxQueued: number;
  now?: () => number;
};

type EnqueueOptions = {
  signal?: AbortSignal;
  /** Total budget, including time spent waiting for an admission slot. */
  timeoutMs?: number;
};

type QueuedCommand<T> = {
  operation: () => Promise<T> | T;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
  signal?: AbortSignal;
  deadline: number | null;
  timeoutMs: number | undefined;
  deadlineTimer: ReturnType<typeof setTimeout> | null;
  abortListener: (() => void) | null;
};

function abortError(): Error {
  const error = new Error("Printer calibration command was aborted.");
  error.name = "AbortError";
  return error;
}

function assertLimit(name: string, value: number, minimum: number): void {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < minimum) {
    throw new Error(`${name} must be a finite integer greater than or equal to ${minimum}.`);
  }
}

/**
 * A small FIFO admission queue for subprocesses. A slot remains owned until the
 * supplied operation settles; callers that kill a child must therefore wait for
 * its close event before settling their operation.
 */
export function createCalibrationProcessAdmission(options: CalibrationProcessAdmissionOptions) {
  assertLimit("maxActive", options.maxActive, 1);
  assertLimit("maxQueued", options.maxQueued, 0);

  const now = options.now ?? Date.now;
  const queue: Array<QueuedCommand<unknown>> = [];
  let active = 0;

  const cleanupQueuedCommand = (command: QueuedCommand<unknown>) => {
    if (command.deadlineTimer) clearTimeout(command.deadlineTimer);
    command.deadlineTimer = null;
    if (command.signal && command.abortListener) {
      command.signal.removeEventListener("abort", command.abortListener);
    }
    command.abortListener = null;
  };

  const removeQueuedCommand = (command: QueuedCommand<unknown>, error: Error) => {
    const index = queue.indexOf(command);
    if (index < 0) return false;
    queue.splice(index, 1);
    cleanupQueuedCommand(command);
    command.reject(error);
    return true;
  };

  const dispatch = () => {
    while (active < options.maxActive && queue.length > 0) {
      const command = queue.shift();
      if (!command) return;
      cleanupQueuedCommand(command);

      if (command.signal?.aborted) {
        command.reject(abortError());
        continue;
      }
      if (command.deadline !== null && now() >= command.deadline) {
        command.reject(new CalibrationAdmissionTimeoutError(command.timeoutMs ?? 0));
        continue;
      }

      active += 1;
      let result: Promise<unknown> | unknown;
      try {
        result = command.operation();
      } catch (error) {
        active -= 1;
        command.reject(error);
        continue;
      }
      Promise.resolve(result).then(
        (value) => command.resolve(value),
        (error) => command.reject(error)
      ).finally(() => {
        active -= 1;
        dispatch();
      });
    }
  };

  return {
    enqueue<T>(operation: () => Promise<T> | T, enqueueOptions: EnqueueOptions = {}): Promise<T> {
      if (enqueueOptions.signal?.aborted) return Promise.reject(abortError());
      if (queue.length >= options.maxQueued && active >= options.maxActive) {
        throw new CalibrationAdmissionQueueFullError(options.maxQueued);
      }

      const timeoutMs = enqueueOptions.timeoutMs;
      const deadline = timeoutMs === undefined ? null : now() + timeoutMs;
      let command!: QueuedCommand<T>;
      const promise = new Promise<T>((resolve, reject) => {
        command = {
          operation,
          resolve,
          reject,
          signal: enqueueOptions.signal,
          deadline,
          timeoutMs,
          deadlineTimer: null,
          abortListener: null,
        };
      });

      if (enqueueOptions.signal) {
        command.abortListener = () => {
          removeQueuedCommand(command as QueuedCommand<unknown>, abortError());
        };
        enqueueOptions.signal.addEventListener("abort", command.abortListener, { once: true });
      }
      if (deadline !== null) {
        const delay = Math.max(0, deadline - now());
        command.deadlineTimer = setTimeout(() => {
          removeQueuedCommand(
            command as QueuedCommand<unknown>,
            new CalibrationAdmissionTimeoutError(timeoutMs ?? 0)
          );
        }, delay);
      }

      queue.push(command as QueuedCommand<unknown>);
      dispatch();
      return promise;
    },
    stats() {
      return { active, queued: queue.length };
    },
  };
}
