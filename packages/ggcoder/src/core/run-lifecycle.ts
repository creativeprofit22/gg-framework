import type { RunOutcome } from "./session-manager.js";

export type RunState = "idle" | "running" | "cancelling";

/**
 * Durable record of run boundaries. `RunLifecycle` already owns generation
 * identity, so hanging the journal off it makes the on-disk pair inherit that
 * generation-safety for free — a stale run cannot close a newer one's entry.
 *
 * Both hooks are fire-and-forget: journalling must never delay a run or fail
 * one. Implementations swallow their own write errors.
 */
export interface RunJournalWriter {
  started(generation: number): void;
  finished(generation: number, outcome: RunOutcome): void;
}

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

  constructor(
    private readonly onStateChange?: (state: RunState) => void,
    private readonly journal?: RunJournalWriter,
  ) {}

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
    this.journal?.started(generation);
    return { generation };
  }

  isCancellationRequested(generation: number): boolean {
    return this.active?.generation === generation && this.active.cancelRequested;
  }

  /**
   * Settle only the matching owner; stale generations cannot release a new run.
   *
   * `outcome` defaults to `completed`; a cancelled run always records `aborted`
   * regardless, since cancellation is the authoritative signal here.
   */
  settle(
    generation: number,
    outcome: RunOutcome = "completed",
  ): { settled: boolean; cancelled: boolean } {
    const active = this.active;
    if (!active || active.generation !== generation) {
      return { settled: false, cancelled: false };
    }
    const cancelled = active.cancelRequested;
    this.active = undefined;
    this.setState("idle");
    active.resolveSettlement();
    this.journal?.finished(generation, cancelled ? "aborted" : outcome);
    return { settled: true, cancelled };
  }

  /** Abort once, then acknowledge only after the owning operation settles. */
  cancel(timeoutMs: number): Promise<CancelResult> {
    const active = this.active;
    if (!active) {
      return Promise.resolve({ status: "idle", generation: this.nextGeneration });
    }
    if (active.cancelPromise) return active.cancelPromise;

    active.cancelRequested = true;
    this.setState("cancelling");
    try {
      active.abort();
    } catch {
      // Settlement remains authoritative even if one abort hook throws.
    }

    active.cancelPromise = new Promise<CancelResult>((resolve) => {
      const timer = setTimeout(
        () => {
          if (this.active?.generation === active.generation) this.setState("running");
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
    return active.cancelPromise;
  }

  private setState(state: RunState): void {
    if (this.currentState === state) return;
    this.currentState = state;
    this.onStateChange?.(state);
  }
}
