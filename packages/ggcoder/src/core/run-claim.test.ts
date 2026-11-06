/**
 * The concurrency property the sidecar's `/prompt` handler depends on: two
 * prompts arriving back-to-back must produce ONE run plus one queued message,
 * never two concurrent runs against the same session.
 */
import { describe, expect, it } from "vitest";
import { RunClaim } from "./run-claim.js";

describe("RunClaim", () => {
  it("grants the first claim", () => {
    const claim = new RunClaim();
    expect(claim.claim()).toBe(true);
    expect(claim.active).toBe(true);
  });

  it("refuses a second claim while one is held", () => {
    const claim = new RunClaim();
    claim.claim();
    expect(claim.claim()).toBe(false);
  });

  it("grants again after release", () => {
    const claim = new RunClaim();
    claim.claim();
    claim.release();
    expect(claim.active).toBe(false);
    expect(claim.claim()).toBe(true);
  });

  it("tolerates release without a claim, so it can sit in a finally", () => {
    const claim = new RunClaim();
    expect(() => claim.release()).not.toThrow();
    expect(claim.active).toBe(false);
  });
});

/**
 * Reproduces the `/prompt` handler's control flow: check the guard, then await
 * before the run actually starts and flips `running`. The awaits stand in for
 * attachment preparation and `loadWorkflowCommandSpecs()`.
 */
describe("concurrent POST /prompt", () => {
  interface Harness {
    post: (text: string) => Promise<void>;
    started: string[];
    queued: string[];
    maxConcurrent: number;
  }

  function makeHarness(useClaim: boolean): Harness {
    let running = false;
    let concurrent = 0;
    const claim = new RunClaim();
    const h: Harness = { started: [], queued: [], maxConcurrent: 0, post: async () => {} };

    // Mirrors runAgent: `running` only becomes true once the run begins.
    const runAgent = async (text: string): Promise<void> => {
      running = true;
      concurrent += 1;
      h.maxConcurrent = Math.max(h.maxConcurrent, concurrent);
      h.started.push(text);
      await new Promise((resolve) => setTimeout(resolve, 5));
      concurrent -= 1;
      running = false;
    };

    h.post = async (text: string): Promise<void> => {
      let claimed = false;
      try {
        if (running || (useClaim && claim.active)) {
          h.queued.push(text);
          return;
        }
        if (useClaim) claimed = claim.claim();
        // The yield that opens the race: `running` is still false here.
        await Promise.resolve();
        await new Promise((resolve) => setTimeout(resolve, 0));
        await runAgent(text);
      } finally {
        if (claimed) claim.release();
      }
    };
    return h;
  }

  it("queues the second prompt instead of running it concurrently", async () => {
    const h = makeHarness(true);
    await Promise.all([h.post("first"), h.post("second")]);

    expect(h.started).toEqual(["first"]);
    expect(h.queued).toEqual(["second"]);
    expect(h.maxConcurrent).toBe(1);
  });

  it("holds across several simultaneous prompts", async () => {
    const h = makeHarness(true);
    await Promise.all([h.post("a"), h.post("b"), h.post("c"), h.post("d")]);

    expect(h.started).toEqual(["a"]);
    expect(h.queued).toEqual(["b", "c", "d"]);
    expect(h.maxConcurrent).toBe(1);
  });

  it("frees the claim so a later prompt still starts its own run", async () => {
    const h = makeHarness(true);
    await Promise.all([h.post("first"), h.post("second")]);
    await h.post("third");

    expect(h.started).toEqual(["first", "third"]);
    expect(h.maxConcurrent).toBe(1);
  });

  it("demonstrates the bug without the claim", async () => {
    // Guarding on `running` alone lets both prompts through, because neither
    // has reached runAgent when the other checks. This is the regression the
    // claim prevents; if this ever stops failing, the harness has drifted from
    // the handler it models.
    const h = makeHarness(false);
    await Promise.all([h.post("first"), h.post("second")]);

    expect(h.started).toEqual(["first", "second"]);
    expect(h.queued).toEqual([]);
    expect(h.maxConcurrent).toBe(2);
  });
});
