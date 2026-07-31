export type RunState = "idle" | "running" | "cancelling";

export type CancelResult =
  | { status: "cancelled"; generation: number }
  | { status: "idle"; generation: number }
  | { status: "failed"; generation: number; reason: "timeout" };

export interface RunLease {
  generation: number;
}

interface ActiveRun {
  generation: number;
  abort: () => void;
  cancelRequested: boolean;
  settlement: Promise<void>;
  resolveSettlement: () => void;
  cancelPromise?: Promise<CancelResult>;
}

export class RunBusyError extends Error {
  constructor(state: RunState) {
    super(`A run is already owned (${state}).`);
    this.name = "RunBusyError";
  }
}

/** Generation-safe ownership and acknowledged bounded cancellation. */
export class RunLifecycle {
  private currentState: RunState = "idle";
  private nextGeneration = 0;
  private active?: ActiveRun;

  constructor(private readonly onStateChange?: (state: RunState) => void) {}

  get state(): RunState {
    return this.currentState;
  }

  get running(): boolean {
    return this.currentState !== "idle";
  }

  get generation(): number {
    return this.active?.generation ?? this.nextGeneration;
  }

  begin(abort: () => void): RunLease {
    if (this.active) throw new RunBusyError(this.currentState);
    let resolveSettlement!: () => void;
    const settlement = new Promise<void>((resolve) => {
      resolveSettlement = resolve;
    });
    const generation = ++this.nextGeneration;
    this.active = {
      generation,
      abort,
      cancelRequested: false,
      settlement,
      resolveSettlement,
    };
    this.setState("running");
    return { generation };
  }

  isCancellationRequested(generation: number): boolean {
    return this.active?.generation === generation && this.active.cancelRequested;
  }

  /** Settle only the matching owner; stale generations cannot release a new run. */
  settle(generation: number): { settled: boolean; cancelled: boolean } {
    const active = this.active;
    if (!active || active.generation !== generation) {
      return { settled: false, cancelled: false };
    }
    const cancelled = active.cancelRequested;
    this.active = undefined;
    this.setState("idle");
    active.resolveSettlement();
    return { settled: true, cancelled };
  }

  /** Abort once, then acknowledge only after the owning operation settles. */
  cancel(timeoutMs: number): Promise<CancelResult> {
    const active = this.active;
    if (!active) {
      return Promise.resolve({ status: "idle", generation: this.nextGeneration });
    }
    if (active.cancelPromise) return active.cancelPromise;

    if (!active.cancelRequested) {
      active.cancelRequested = true;
      try {
        active.abort();
      } catch {
        // Settlement remains authoritative even if one abort hook throws.
      }
    }
    this.setState("cancelling");

    const cancelPromise = new Promise<CancelResult>((resolve) => {
      const timer = setTimeout(
        () => {
          if (this.active?.generation === active.generation) {
            if (active.cancelPromise === cancelPromise) active.cancelPromise = undefined;
            this.setState("running");
          }
          resolve({ status: "failed", generation: active.generation, reason: "timeout" });
        },
        Math.max(0, timeoutMs),
      );
      timer.unref();
      void active.settlement.then(() => {
        clearTimeout(timer);
        resolve({ status: "cancelled", generation: active.generation });
      });
    });
    active.cancelPromise = cancelPromise;
    return cancelPromise;
  }

  private setState(state: RunState): void {
    if (this.currentState === state) return;
    this.currentState = state;
    this.onStateChange?.(state);
  }
}
