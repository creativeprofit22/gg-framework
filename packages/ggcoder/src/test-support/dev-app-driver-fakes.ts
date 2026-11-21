import type { DriverClock } from "../dev-app-driver/clock.js";
import type { ControlClient } from "../dev-app-driver/control-client.js";
import type { PageState } from "../dev-app-driver/observe.js";

interface Timer {
  wake: number;
  order: number;
  resolve: () => void;
}

/** Virtual time: sleeps only finish when `settle` advances to them, so no test waits for real. */
export class FakeClock implements DriverClock {
  time = 0;
  private timers: Timer[] = [];
  private order = 0;

  now(): number {
    return this.time;
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      if (signal?.aborted) {
        resolve();
        return;
      }
      const timer: Timer = { wake: this.time + Math.max(0, ms), order: this.order++, resolve };
      this.timers.push(timer);
      signal?.addEventListener(
        "abort",
        () => {
          this.timers = this.timers.filter((entry) => entry !== timer);
          resolve();
        },
        { once: true },
      );
    });
  }

  /** Runs `promise` to completion, jumping time to each pending sleep while it is idle. */
  async settle<T>(promise: Promise<T>): Promise<T> {
    let done = false;
    const watched = promise.finally(() => {
      done = true;
    });
    watched.catch(() => {});
    for (let step = 0; step < 100_000; step += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (done) return watched;
      const next = [...this.timers].sort((a, b) => a.wake - b.wake || a.order - b.order)[0];
      if (!next) throw new Error("FakeClock: promise is pending with no timers left");
      this.timers = this.timers.filter((entry) => entry !== next);
      this.time = Math.max(this.time, next.wake);
      next.resolve();
    }
    throw new Error("FakeClock: too many steps");
  }

  /** Runs `effect` once virtual time reaches `at`. */
  at(at: number, effect: () => void): void {
    void this.sleep(at - this.time).then(effect);
  }
}

export function pageState(overrides: Partial<PageState> = {}): PageState {
  return {
    paneFound: true,
    paneId: "pane-a",
    draft: "",
    composerDisabled: false,
    menuOpen: false,
    modalOpen: false,
    status: "Ready",
    phase: null,
    queued: 0,
    focused: { tag: "textarea", paneId: "pane-a", label: "" },
    ...overrides,
  };
}

export interface SentInput {
  method: string;
  params: Record<string, unknown>;
}

/** A page in memory: reads return `page`/`probe`; inputs are recorded and passed to `onInput`. */
export class FakeControlClient implements ControlClient {
  page: PageState = pageState();
  probe: unknown = null;
  sent: SentInput[] = [];
  reads = 0;
  goneReason: string | null = null;
  closed = false;
  readonly whenGone: Promise<string>;
  onInput: (input: SentInput) => void = () => {};
  /** Answers non-read scripts (focus, click measurement). */
  onScript: (script: string) => unknown = (script) =>
    script.includes(".focus()") ? "focused" : undefined;
  /** Replaces a read's answer; return a promise that never settles to simulate a stuck page. */
  readOverride: ((count: number) => Promise<unknown> | undefined) | null = null;
  private markGone: (reason: string) => void = () => {};

  constructor() {
    this.whenGone = new Promise((resolve) => {
      this.markGone = resolve;
    });
  }

  gone(reason = "dev fixture debugging target detached"): void {
    this.goneReason = reason;
    this.markGone(reason);
  }

  async send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (this.goneReason) throw new Error(this.goneReason);
    const input = { method, params };
    this.sent.push(input);
    this.onInput(input);
    return {};
  }

  async evaluate(expression: string): Promise<unknown> {
    if (this.goneReason) throw new Error(this.goneReason);
    if (!expression.startsWith("(async () => ({ page:")) return this.onScript(expression);
    this.reads += 1;
    const override = this.readOverride?.(this.reads);
    if (override) return override;
    return { page: structuredClone(this.page), probe: this.probe };
  }

  close(): void {
    this.closed = true;
  }

  inputs(method: string): SentInput[] {
    return this.sent.filter((entry) => entry.method === method);
  }
}
