import type { StreamEvent, StreamResponse } from "../types.js";

/**
 * Push-based async iterable. Producers push events, consumers
 * iterate with `for await`. Also supports thenable so you can
 * `await stream(...)` directly to get the final response.
 */
export class EventStream<T = StreamEvent> implements AsyncIterable<T> {
  private queue: T[] = [];
  private resolve: (() => void) | null = null;
  private done = false;
  private error: Error | null = null;

  push(event: T): void {
    // Safety valve: if queue grows beyond 10k unconsumed events, drop oldest
    // to prevent OOM when consumer is blocked/slow
    if (this.queue.length > 10_000) {
      this.queue.splice(0, this.queue.length - 5_000);
    }
    this.queue.push(event);
    this.resolve?.();
    this.resolve = null;
  }

  close(): void {
    this.done = true;
    this.resolve?.();
    this.resolve = null;
  }

  abort(error: Error): void {
    this.error = error;
    this.done = true;
    this.resolve?.();
    this.resolve = null;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    let index = 0;
    while (true) {
      while (index < this.queue.length) {
        yield this.queue[index++]!;
      }
      // Reset to avoid holding references to already-yielded events
      this.queue.splice(0, index);
      index = 0;
      if (this.error) throw this.error;
      if (this.done) return;
      await new Promise<void>((r) => {
        this.resolve = r;
      });
    }
  }
}

/**
 * Pull-based stream result. Wraps an async generator that yields
 * StreamEvents and returns a StreamResponse. Also thenable so:
 *
 *   const msg = await stream({...})          // awaits response
 *   for await (const e of stream({...})) {}  // iterates events
 *
 * While the result is being read or awaited, the generator is pumped
 * eagerly — events flow into an internal buffer regardless of whether
 * a consumer is iterating. This avoids the push-based EventStream's
 * stall bugs (lost wakeups, single resolve field, iterator starvation).
 *
 * Leaving a `for await` loop before the stream ends (break, return or
 * throw) cancels the provider request, drops buffered events, and makes
 * `response` reject with an `AbortError`; to get the final response,
 * read to the end or `await` the result instead. A stream paused by
 * backpressure also rejects with an `AbortError` when `signal` fires.
 */
export class StreamResult implements AsyncIterable<StreamEvent> {
  readonly response: Promise<StreamResponse>;
  private buffer: StreamEvent[] = [];
  private done = false;
  private error: Error | null = null;
  private resolveResponse!: (r: StreamResponse) => void;
  private rejectResponse!: (e: Error) => void;
  private resolveWait: (() => void) | null = null;
  /**
   * High-water mark: when the buffer exceeds this many unconsumed events,
   * the pump pauses until the consumer drains below the low-water mark.
   * Prevents unbounded memory growth when a consumer is slow.
   * Only active when someone IS iterating — if nobody iterates (the `then()`
   * path), backpressure is skipped so the pump can complete and resolve.
   */
  private static readonly HIGH_WATER = 5_000;
  private static readonly LOW_WATER = 1_000;
  private iterating = false;
  private paused = false;
  private resolveDrain: (() => void) | null = null;
  private readonly generator: AsyncGenerator<StreamEvent, StreamResponse>;
  private readerStopped = false;

  constructor(generator: AsyncGenerator<StreamEvent, StreamResponse>, signal?: AbortSignal) {
    this.generator = generator;
    this.response = new Promise<StreamResponse>((resolve, reject) => {
      this.resolveResponse = resolve;
      this.rejectResponse = reject;
    });
    this.pump(generator, signal);
  }

  private throwIfReaderStopped(): void {
    if (this.readerStopped) throw new DOMException("Stream reader stopped", "AbortError");
  }

  private waitForDrain(signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new DOMException("Aborted", "AbortError"));
        return;
      }
      const onAbort = () => {
        this.resolveDrain = null;
        reject(new DOMException("Aborted", "AbortError"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.resolveDrain = () => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      };
    });
  }

  private async pump(
    generator: AsyncGenerator<StreamEvent, StreamResponse>,
    signal?: AbortSignal,
  ): Promise<void> {
    try {
      let next = await this._nextWithAbort(generator, signal);
      // A returned generator reports done with no value; never resolve with that.
      this.throwIfReaderStopped();
      while (!next.done) {
        this.buffer.push(next.value);
        this.resolveWait?.();
        this.resolveWait = null;

        // Backpressure: only apply when a consumer IS iterating but falling
        // behind. If nobody is iterating (the `await stream()` without
        // `for await` path), skip backpressure so the pump completes and the
        // response promise resolves.
        if (this.iterating && this.buffer.length > StreamResult.HIGH_WATER) {
          this.paused = true;
          try {
            await this.waitForDrain(signal);
          } finally {
            this.paused = false;
            this.resolveDrain = null;
          }
          this.throwIfReaderStopped();
        }

        next = await this._nextWithAbort(generator, signal);
        this.throwIfReaderStopped();
      }
      this.done = true;
      this.resolveResponse(next.value);
      this.resolveWait?.();
      this.resolveWait = null;
    } catch (err) {
      // Stop the producer (open HTTP body) after abort-while-paused or reader stop.
      generator.return?.(undefined as unknown as StreamResponse).catch(() => {});
      const error = err instanceof Error ? err : new Error(String(err));
      this.error = error;
      this.done = true;
      this.rejectResponse(error);
      this.resolveWait?.();
      this.resolveWait = null;
    }
  }

  private async _nextWithAbort(
    generator: AsyncGenerator<StreamEvent, StreamResponse>,
    signal?: AbortSignal,
  ): Promise<IteratorResult<StreamEvent, StreamResponse>> {
    if (!signal) {
      return generator.next();
    }
    if (signal.aborted) {
      generator.return?.(undefined as unknown as StreamResponse).catch(() => {});
      return Promise.reject(new DOMException("Aborted", "AbortError"));
    }
    let onAbort: (() => void) | undefined;
    const abortPromise = new Promise<IteratorResult<StreamEvent, StreamResponse>>((_, reject) => {
      onAbort = () => {
        generator.return?.(undefined as unknown as StreamResponse).catch(() => {});
        reject(new DOMException("Aborted", "AbortError"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      return await Promise.race([generator.next(), abortPromise]);
    } finally {
      if (onAbort) signal.removeEventListener("abort", onAbort);
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    this.iterating = true;
    try {
      let index = 0;
      while (true) {
        while (index < this.buffer.length) {
          yield this.buffer[index++]!;
        }
        // If the pump is paused waiting for us to drain, signal it.
        if (this.paused && index > StreamResult.LOW_WATER) {
          this.resolveDrain?.();
          this.resolveDrain = null;
        }
        // Trim already-yielded events to free memory (they're consumed).
        if (index > 0 && !this.paused) {
          this.buffer.splice(0, index);
          index = 0;
        }
        if (this.error) throw this.error;
        if (this.done) return;
        await new Promise<void>((r) => {
          this.resolveWait = r;
          // Guard against race: pump may have advanced between the while-check
          // and this promise registration. Re-check and resolve immediately.
          if (this.buffer.length > index || this.done || this.error) {
            this.resolveWait = null;
            r();
          }
        });
      }
    } finally {
      // Reader left early (break/return/throw): release the pause and stop the producer.
      if (!this.done) {
        this.readerStopped = true;
        if (this.paused) {
          this.paused = false;
          this.resolveDrain?.();
          this.resolveDrain = null;
        }
        this.generator.return?.(undefined as unknown as StreamResponse).catch(() => {});
      }
      this.buffer = [];
    }
  }

  then<TResult1 = StreamResponse, TResult2 = never>(
    onfulfilled?: ((value: StreamResponse) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    // Release backpressure: if someone calls then(), they want the response
    // resolved ASAP. Clear any pending pause so the pump can complete.
    if (this.paused) {
      this.paused = false;
      this.resolveDrain?.();
      this.resolveDrain = null;
    }
    return this.response.then(onfulfilled, onrejected);
  }
}
