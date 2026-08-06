import { describe, expect, it, vi } from "vitest";
import { RunBusyError, RunLifecycle } from "./run-lifecycle.js";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("RunLifecycle", () => {
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
