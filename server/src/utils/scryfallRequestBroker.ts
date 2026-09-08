/**
 * Serializes every physical direct-Scryfall request that is submitted to it.
 *
 * A retry is a new physical request: callers must submit each retry with a
 * separate `enqueue` call so it receives its own FIFO slot and dispatch delay.
 */

export type ScryfallRequestOperation<T> = (signal: AbortSignal) => PromiseLike<T> | T;

export interface ScryfallRequestOptions {
  /** Cancels queued work or aborts the operation's supplied signal after dispatch. */
  signal?: AbortSignal;
}

interface QueuedRequest {
  operation: ScryfallRequestOperation<unknown>;
  resolve(value: unknown): void;
  reject(reason?: unknown): void;
  controller: AbortController;
  callerSignal?: AbortSignal;
  abortListener?: () => void;
  started: boolean;
  cancelled: boolean;
}

function createAbortError(): Error {
  const error = new Error("Scryfall request was aborted");
  error.name = "AbortError";
  return error;
}

/**
 * FIFO broker for physical direct-Scryfall requests.
 *
 * Only one operation runs at a time. Dispatches are at least 100ms apart and
 * an active operation retains its lease until its returned promise settles,
 * including after caller cancellation.
 */
export class ScryfallRequestBroker {
  private readonly minimumDispatchSpacingMs: number;
  private readonly queue: QueuedRequest[] = [];
  private activeRequest: QueuedRequest | undefined;
  private dispatchTimer: ReturnType<typeof setTimeout> | undefined;
  private lastDispatchAt: number | undefined;

  constructor(minimumDispatchSpacingMs = 100) {
    if (!Number.isFinite(minimumDispatchSpacingMs) || minimumDispatchSpacingMs < 100) {
      throw new RangeError("Direct Scryfall request spacing must be at least 100ms");
    }
    this.minimumDispatchSpacingMs = minimumDispatchSpacingMs;
  }

  enqueue<T>(
    operation: ScryfallRequestOperation<T>,
    options: ScryfallRequestOptions = {}
  ): Promise<T> {
    let request!: QueuedRequest;
    const promise = new Promise<T>((resolve, reject) => {
      request = {
        operation: operation as ScryfallRequestOperation<unknown>,
        resolve: (value) => resolve(value as T),
        reject,
        controller: new AbortController(),
        callerSignal: options.signal,
        started: false,
        cancelled: false,
      };
    });

    if (options.signal?.aborted) {
      request.cancelled = true;
      request.reject(createAbortError());
      return promise;
    }

    if (options.signal) {
      request.abortListener = () => this.cancel(request);
      options.signal.addEventListener("abort", request.abortListener, { once: true });
    }

    this.queue.push(request);
    this.pump();
    return promise;
  }

  private cancel(request: QueuedRequest): void {
    if (request.cancelled) return;
    request.cancelled = true;
    request.controller.abort();
    request.reject(createAbortError());

    if (!request.started) {
      const index = this.queue.indexOf(request);
      if (index >= 0) this.queue.splice(index, 1);
      this.removeAbortListener(request);
      this.clearIdleTimer();
      this.pump();
    }
  }

  private pump(): void {
    if (this.activeRequest || this.queue.length === 0) return;

    const now = Date.now();
    const waitMs = this.lastDispatchAt === undefined
      ? 0
      : Math.max(0, this.minimumDispatchSpacingMs - (now - this.lastDispatchAt));

    if (waitMs > 0) {
      if (!this.dispatchTimer) {
        this.dispatchTimer = setTimeout(() => {
          this.dispatchTimer = undefined;
          this.pump();
        }, waitMs);
      }
      return;
    }

    const request = this.queue.shift();
    if (!request) return;
    if (request.cancelled) {
      this.removeAbortListener(request);
      this.pump();
      return;
    }

    request.started = true;
    this.activeRequest = request;

    let physicalRequest: Promise<unknown>;
    try {
      physicalRequest = Promise.resolve(request.operation(request.controller.signal));
    } catch (error) {
      physicalRequest = Promise.reject(error);
    }
    // Reserve from after synchronous invocation so its overhead cannot shorten
    // the interval measured between actual transport invocations.
    this.lastDispatchAt = Date.now();

    void physicalRequest
      .then(
        (value) => request.resolve(value),
        (error: unknown) => request.reject(error)
      )
      .finally(() => {
        this.activeRequest = undefined;
        this.removeAbortListener(request);
        this.pump();
      });
  }

  private clearIdleTimer(): void {
    if (this.queue.length !== 0 || !this.dispatchTimer) return;
    clearTimeout(this.dispatchTimer);
    this.dispatchTimer = undefined;
  }

  private removeAbortListener(request: QueuedRequest): void {
    if (request.callerSignal && request.abortListener) {
      request.callerSignal.removeEventListener("abort", request.abortListener);
      request.abortListener = undefined;
    }
  }
}

/** Shared broker for future direct-Scryfall call-site migrations. */
export const scryfallRequestBroker = new ScryfallRequestBroker();
