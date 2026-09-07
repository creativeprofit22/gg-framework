import { describe, expect, it, vi } from "vitest";
import { RunBusyError, RunLifecycle } from "./run-lifecycle.js";
import { createRunEndPayload, type RunOutcome } from "@kenkaiiii/gg-core/desktop-session-ux";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("RunLifecycle", () => {
  it.each<RunOutcome>(["completed", "failed", "aborted", "unverified"])(
    "projects journal outcome %s into the terminal transport without conflating failure and verification",
    (outcome) => {
      const journal = { started: vi.fn(), finished: vi.fn() };
      const lifecycle = new RunLifecycle(undefined, journal);
      const { generation } = lifecycle.begin(() => {});
      lifecycle.settle(generation, outcome);
      expect(journal.finished).toHaveBeenCalledWith(generation, outcome);
      expect(createRunEndPayload(outcome, lifecycle.state)).toEqual({
        outcome: outcome === "aborted" ? "cancelled" : outcome,
        ...(outcome === "aborted" ? { cancelled: true } : {}),
        ...(outcome === "unverified" ? { unverified: true } : {}),
        runState: "idle",
      });
    },
  );

  it("retains an injected round's failure when the outer cycle settles successfully", () => {
    const journal = { started: vi.fn(), finished: vi.fn() };
    const lifecycle = new RunLifecycle(undefined, journal);
    const { generation } = lifecycle.begin(() => {});
    lifecycle.recordOutcome(generation + 1, "aborted");
    lifecycle.recordOutcome(generation, "failed");
    lifecycle.recordOutcome(generation, "completed");
    lifecycle.settle(generation, "unverified");
    expect(journal.finished).toHaveBeenCalledWith(generation, "failed");
  });

  it("lets outer cancellation override an injected failure", async () => {
    const journal = { started: vi.fn(), finished: vi.fn() };
    const lifecycle = new RunLifecycle(undefined, journal);
    const { generation } = lifecycle.begin(() => {});
    lifecycle.recordOutcome(generation, "failed");
    const cancelled = lifecycle.cancel(1000);
    lifecycle.settle(generation);
    await expect(cancelled).resolves.toMatchObject({ status: "cancelled" });
    expect(journal.finished).toHaveBeenCalledWith(generation, "aborted");
    expect(createRunEndPayload("aborted", lifecycle.state)).toEqual({ outcome: "cancelled", cancelled: true, runState: "idle" });
  });
  it("waits for provider-backed ownership to settle before acknowledging cancel", async () => {
    const abort = vi.fn();
    const lifecycle = new RunLifecycle();
    const lease = lifecycle.begin(abort);
    let acknowledged = false;
    const cancellation = lifecycle.cancel(1000).then((result) => {
      acknowledged = true;
      return result;
    });

    await Promise.resolve();
    expect(abort).toHaveBeenCalledTimes(1);
    expect(acknowledged).toBe(false);
    expect(lifecycle.state).toBe("cancelling");

    expect(lifecycle.settle(lease.generation)).toEqual({ settled: true, cancelled: true });
    await expect(cancellation).resolves.toEqual({
      status: "cancelled",
      generation: lease.generation,
    });
    expect(lifecycle.state).toBe("idle");
  });

  it("shares duplicate cancellation and aborts once", async () => {
    const abort = vi.fn();
    const lifecycle = new RunLifecycle();
    const lease = lifecycle.begin(abort);
    const first = lifecycle.cancel(1000);
    const second = lifecycle.cancel(1000);
    expect(second).toBe(first);
    expect(abort).toHaveBeenCalledTimes(1);
    lifecycle.settle(lease.generation);
    await expect(first).resolves.toMatchObject({ status: "cancelled" });
  });

  it("times out visibly, retains ownership, blocks replacement, then recovers on settlement", async () => {
    const lifecycle = new RunLifecycle();
    const lease = lifecycle.begin(() => {});
    await expect(lifecycle.cancel(10)).resolves.toEqual({
      status: "failed",
      generation: lease.generation,
      reason: "timeout",
    });
    expect(lifecycle.state).toBe("running");
    expect(() => lifecycle.begin(() => {})).toThrow(RunBusyError);

    lifecycle.settle(lease.generation);
    expect(lifecycle.state).toBe("idle");
    expect(() => lifecycle.begin(() => {})).not.toThrow();
  });

  it("ignores stale generation settlement", async () => {
    const lifecycle = new RunLifecycle();
    const first = lifecycle.begin(() => {});
    expect(lifecycle.settle(first.generation + 1).settled).toBe(false);
    expect(lifecycle.state).toBe("running");
    lifecycle.settle(first.generation);
    const second = lifecycle.begin(() => {});
    expect(second.generation).toBeGreaterThan(first.generation);
    expect(lifecycle.settle(first.generation).settled).toBe(false);
    expect(lifecycle.state).toBe("running");
    lifecycle.settle(second.generation);
    await delay(0);
  });
});
