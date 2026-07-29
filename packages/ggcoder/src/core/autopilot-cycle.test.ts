import { describe, it, expect, vi } from "vitest";
import {
  driveAutopilotCycle,
  buildPlanRevisionPrompt,
  frameAutopilotInjection,
  AUTOPILOT_INJECTION_PREAMBLE,
  AUTOPILOT_PLAN_DRAFTING_REASON,
  type AutopilotCycleDeps,
  type AutopilotCycleEmit,
} from "./autopilot-cycle.js";
import type { AutopilotVerdict } from "./autopilot-verdict.js";

/** Build a full deps object with sane defaults; tests override what they probe.
 *  `verdicts` feeds the WORK review queue; `planVerdicts` feeds the PLAN review
 *  queue. Running out returns null (review failure). */
function makeDeps(
  verdicts: Array<AutopilotVerdict | null>,
  overrides: Partial<AutopilotCycleDeps> = {},
  planVerdicts: Array<AutopilotVerdict | null> = [],
): AutopilotCycleDeps & {
  emitted: AutopilotCycleEmit[];
  injected: Array<{ body: string; round: number }>;
  ran: string[];
  counters: { implemented: number; accepted: number };
  resetReviewer: ReturnType<typeof vi.fn<() => Promise<void>>>;
  review: ReturnType<typeof vi.fn<() => Promise<AutopilotVerdict | null>>>;
  reviewPlan: ReturnType<typeof vi.fn<() => Promise<AutopilotVerdict | null>>>;
} {
  const emitted: AutopilotCycleEmit[] = [];
  const injected: Array<{ body: string; round: number }> = [];
  const ran: string[] = [];
  const queue = [...verdicts];
  const planQueue = [...planVerdicts];
  const counters = { implemented: 0, accepted: 0 };
  const deps = {
    maxRounds: 3,
    isCancelled: () => false,
    isPlanMode: () => false,
    planPending: () => false,
    resetReviewer: vi.fn(async () => {}),
    review: vi.fn(async () => queue.shift() ?? null),
    reviewPlan: vi.fn(async () => planQueue.shift() ?? null),
    acceptPlan: async () => {
      counters.accepted++;
      return true;
    },
    runImplement: async () => {
      counters.implemented++;
    },
    runPrompt: async (body: string) => {
      ran.push(body);
    },
    persistReviewDecision: vi.fn(async () => true),
    onInjected: (body: string, round: number) => {
      injected.push({ body, round });
    },
    emit: (event: AutopilotCycleEmit) => {
      emitted.push(event);
    },
    ...overrides,
  };
  // Overrides may swap the vi.fn defaults for plain functions; every test that
  // asserts on mock calls passes a vi.fn itself, so the cast is safe.
  return Object.assign(deps, { emitted, injected, ran, counters }) as AutopilotCycleDeps & {
    emitted: AutopilotCycleEmit[];
    injected: Array<{ body: string; round: number }>;
    ran: string[];
    counters: { implemented: number; accepted: number };
    resetReviewer: ReturnType<typeof vi.fn<() => Promise<void>>>;
    review: ReturnType<typeof vi.fn<() => Promise<AutopilotVerdict | null>>>;
    reviewPlan: ReturnType<typeof vi.fn<() => Promise<AutopilotVerdict | null>>>;
  };
}

/** planPending() driven by a mutable flag the plan deps flip, mirroring the
 *  sidecar (acceptPlan / injection clear pending; exit_plan re-sets it). */
function pendingFlag(initial = true): { get: () => boolean; set: (v: boolean) => void } {
  let value = initial;
  return { get: () => value, set: (v) => (value = v) };
}

describe("frameAutopilotInjection", () => {
  it("prepends the autopilot preamble and preserves the body verbatim", () => {
    const framed = frameAutopilotInjection("Add a test for the login flow.");
    expect(framed.startsWith(AUTOPILOT_INJECTION_PREAMBLE)).toBe(true);
    expect(framed.endsWith("Add a test for the login flow.")).toBe(true);
    expect(framed).toContain("no human is watching");
  });

  it("is deterministic so the run and the digest match-string stay in sync", () => {
    expect(frameAutopilotInjection("do x")).toBe(frameAutopilotInjection("do x"));
  });
});

describe("driveAutopilotCycle — work branch (unchanged behavior)", () => {
  it("ALL_CLEAR → autopilot_done, no injected run", async () => {
    const deps = makeDeps([{ kind: "all_clear" }]);
    await driveAutopilotCycle(deps);
    expect(deps.emitted).toEqual([{ type: "autopilot_done", data: {} }]);
    expect(deps.ran).toEqual([]);
    expect(deps.resetReviewer).toHaveBeenCalledTimes(1);
  });

  it("awaits accepted-review persistence before autopilot_done", async () => {
    const order: string[] = [];
    const deps = makeDeps([{ kind: "all_clear" }], {
      persistReviewDecision: vi.fn(async () => {
        order.push("persisted");
        return true;
      }),
      emit: () => order.push("emitted"),
    });
    await driveAutopilotCycle(deps);
    expect(order).toEqual(["persisted", "emitted"]);
  });

  it("forwards explicit exception acceptance unchanged to durable persistence", async () => {
    const verdict: AutopilotVerdict = {
      kind: "all_clear",
      acceptedVerificationExceptionId: "verification-exception-24",
    };
    const deps = makeDeps([verdict]);
    await driveAutopilotCycle(deps);
    expect(deps.persistReviewDecision).toHaveBeenCalledWith(verdict, 1);
    expect(deps.emitted).toEqual([{ type: "autopilot_done", data: {} }]);
  });

  it("stops without terminal emission when accepted-review persistence fails", async () => {
    const deps = makeDeps([{ kind: "all_clear" }], {
      persistReviewDecision: vi.fn(async () => false),
    });
    await driveAutopilotCycle(deps);
    expect(deps.emitted).toEqual([]);
    expect(deps.persistReviewDecision).toHaveBeenCalledWith({ kind: "all_clear" }, 1);
  });

  it("IGNORE → autopilot_ignored, no injected run", async () => {
    const deps = makeDeps([{ kind: "ignore" }]);
    await driveAutopilotCycle(deps);
    expect(deps.emitted).toEqual([{ type: "autopilot_ignored", data: {} }]);
    expect(deps.ran).toEqual([]);
  });

  it("HUMAN → autopilot_human with the verdict's reason", async () => {
    const deps = makeDeps([{ kind: "human", reason: "ambiguous requirement" }]);
    await driveAutopilotCycle(deps);
    expect(deps.emitted).toEqual([
      { type: "autopilot_human", data: { reason: "ambiguous requirement" } },
    ]);
    expect(deps.ran).toEqual([]);
  });

  it("PROMPT → records the injection BEFORE running, then re-reviews", async () => {
    const order: string[] = [];
    const deps = makeDeps([{ kind: "prompt", body: "fix the test" }, { kind: "all_clear" }], {
      onInjected: (body) => order.push(`injected:${body}`),
      runPrompt: async (body) => {
        order.push(`ran:${body}`);
      },
    });
    await driveAutopilotCycle(deps);
    // onInjected must precede runPrompt — the digest labeling depends on the
    // body being recorded before the injected run's messages exist.
    expect(order).toEqual(["injected:fix the test", "ran:fix the test"]);
    expect(deps.persistReviewDecision).toHaveBeenNthCalledWith(
      1,
      { kind: "prompt", body: "fix the test" },
      1,
    );
    expect(deps.persistReviewDecision).toHaveBeenNthCalledWith(2, { kind: "all_clear" }, 2);
    expect(deps.emitted).toEqual([{ type: "autopilot_done", data: {} }]);
    expect(deps.review).toHaveBeenCalledTimes(2);
  });

  it("persists rejected review before injection and stops when that write fails", async () => {
    const onInjected = vi.fn();
    const runPrompt = vi.fn(async () => {});
    const deps = makeDeps([{ kind: "prompt", body: "fix the test" }], {
      persistReviewDecision: vi.fn(async () => false),
      onInjected,
      runPrompt,
    });
    await driveAutopilotCycle(deps);
    expect(deps.persistReviewDecision).toHaveBeenCalledWith(
      { kind: "prompt", body: "fix the test" },
      1,
    );
    expect(onInjected).not.toHaveBeenCalled();
    expect(runPrompt).not.toHaveBeenCalled();
    expect(deps.emitted).toEqual([]);
  });

  it("caps at maxRounds PROMPT verdicts → autopilot_capped", async () => {
    const deps = makeDeps([
      { kind: "prompt", body: "fix 1" },
      { kind: "prompt", body: "fix 2" },
      { kind: "prompt", body: "fix 3" },
      // Would be round 4 — must never be reached.
      { kind: "prompt", body: "fix 4" },
    ]);
    await driveAutopilotCycle(deps);
    expect(deps.ran).toEqual(["fix 1", "fix 2", "fix 3"]);
    expect(deps.emitted).toEqual([{ type: "autopilot_capped", data: { rounds: 3 } }]);
    expect(deps.review).toHaveBeenCalledTimes(3);
  });

  it("review failure (null) → silent stop, nothing injected", async () => {
    const deps = makeDeps([null]);
    await driveAutopilotCycle(deps);
    expect(deps.emitted).toEqual([]);
    expect(deps.ran).toEqual([]);
  });

  it("cancelled before start → nothing runs, reviewer untouched", async () => {
    const deps = makeDeps([{ kind: "all_clear" }], { isCancelled: () => true });
    await driveAutopilotCycle(deps);
    expect(deps.resetReviewer).not.toHaveBeenCalled();
    expect(deps.review).not.toHaveBeenCalled();
    expect(deps.emitted).toEqual([]);
  });

  it("cancel landing during the review discards the verdict", async () => {
    let cancelled = false;
    const deps = makeDeps([], {
      review: vi.fn(async () => {
        cancelled = true; // /cancel fires while Ken is reviewing
        return { kind: "prompt", body: "fix it" } as AutopilotVerdict;
      }),
      isCancelled: () => cancelled,
    });
    await driveAutopilotCycle(deps);
    expect(deps.ran).toEqual([]);
    expect(deps.emitted).toEqual([]);
  });

  it("cancel landing during an injected run stops before the next review", async () => {
    let cancelled = false;
    const deps = makeDeps([{ kind: "prompt", body: "fix it" }, { kind: "all_clear" }], {
      runPrompt: async () => {
        cancelled = true; // /cancel fires mid-injected-run
      },
      isCancelled: () => cancelled,
    });
    await driveAutopilotCycle(deps);
    expect(deps.review).toHaveBeenCalledTimes(1);
    expect(deps.emitted).toEqual([]);
  });

  it("still INSIDE plan mode with no submitted plan → drafting hold, no review", async () => {
    const deps = makeDeps([{ kind: "all_clear" }], { isPlanMode: () => true });
    await driveAutopilotCycle(deps);
    expect(deps.review).not.toHaveBeenCalled();
    expect(deps.emitted).toEqual([
      { type: "autopilot_human", data: { reason: AUTOPILOT_PLAN_DRAFTING_REASON } },
    ]);
  });

  it("injected run entering plan mode WITHOUT submitting halts before the next review", async () => {
    let planMode = false;
    const ran: string[] = [];
    const deps = makeDeps(
      [
        { kind: "prompt", body: "restructure the module" },
        // Would be reviewed in round 2 — must never be reached.
        { kind: "prompt", body: "another fix" },
      ],
      {
        runPrompt: async (body) => {
          ran.push(body);
          planMode = true; // GG Coder called enter_plan (no exit_plan) mid-run
        },
        isPlanMode: () => planMode,
      },
    );
    await driveAutopilotCycle(deps);
    expect(ran).toEqual(["restructure the module"]);
    expect(deps.review).toHaveBeenCalledTimes(1);
    expect(deps.emitted).toEqual([
      { type: "autopilot_human", data: { reason: AUTOPILOT_PLAN_DRAFTING_REASON } },
    ]);
  });

  it("multi-round: prompt → prompt → all_clear runs both fixes then finishes", async () => {
    const deps = makeDeps([
      { kind: "prompt", body: "fix 1" },
      { kind: "prompt", body: "fix 2" },
      { kind: "all_clear" },
    ]);
    await driveAutopilotCycle(deps);
    expect(deps.ran).toEqual(["fix 1", "fix 2"]);
    expect(deps.injected.map((i) => i.round)).toEqual([1, 2]);
    expect(deps.emitted).toEqual([{ type: "autopilot_done", data: {} }]);
  });

  it("resets the reviewer exactly once per cycle, before any review", async () => {
    const order: string[] = [];
    const deps = makeDeps([{ kind: "prompt", body: "fix" }, { kind: "all_clear" }], {
      resetReviewer: vi.fn(async () => {
        order.push("reset");
      }),
      runPrompt: async () => {
        order.push("run");
      },
    });
    // Wrap review to trace ordering while preserving queue behavior.
    const innerReview = deps.review;
    deps.review = vi.fn(async () => {
      order.push("review");
      return innerReview();
    });
    await driveAutopilotCycle(deps);
    expect(order).toEqual(["reset", "review", "run", "review"]);
  });
});

describe("driveAutopilotCycle — plan branch", () => {
  it("plan approve → acceptPlan → runImplement → work review of the implementation", async () => {
    const pending = pendingFlag();
    const order: string[] = [];
    const deps = makeDeps(
      [{ kind: "all_clear" }],
      {
        planPending: pending.get,
        acceptPlan: async () => {
          order.push("accept");
          pending.set(false);
          return true;
        },
        runImplement: async () => {
          order.push("implement");
        },
      },
      [{ kind: "all_clear" }],
    );
    await driveAutopilotCycle(deps);
    expect(order).toEqual(["accept", "implement"]);
    expect(deps.reviewPlan).toHaveBeenCalledTimes(1);
    expect(deps.review).toHaveBeenCalledTimes(1); // post-implement work review
    expect(deps.emitted).toEqual([{ type: "autopilot_done", data: {} }]);
  });

  it("IGNORE on a plan maps to approve (no user blocker for plans)", async () => {
    const pending = pendingFlag();
    const deps = makeDeps(
      [{ kind: "all_clear" }],
      {
        planPending: pending.get,
        acceptPlan: async () => {
          pending.set(false);
          return true;
        },
      },
      [{ kind: "ignore" }],
    );
    await driveAutopilotCycle(deps);
    expect(deps.counters.implemented).toBe(1);
    expect(deps.emitted).toEqual([{ type: "autopilot_done", data: {} }]);
  });

  it("plan revision → resubmit → approve", async () => {
    const pending = pendingFlag();
    const revisionBody = buildPlanRevisionPrompt("steps 3 and 4 are in the wrong order");
    const deps = makeDeps(
      [{ kind: "all_clear" }],
      {
        maxRounds: 5,
        planPending: pending.get,
        acceptPlan: async () => {
          pending.set(false);
          return true;
        },
        runPrompt: async (body) => {
          expect(body).toBe(revisionBody);
          // Sidecar: injecting a revision clears pending; the run resubmits
          // via exit_plan, which re-sets it.
          pending.set(true);
        },
      },
      [{ kind: "prompt", body: "steps 3 and 4 are in the wrong order" }, { kind: "all_clear" }],
    );
    // The sidecar clears pending on injection BEFORE runPrompt; emulate by
    // wrapping onInjected.
    deps.onInjected = (body, round) => {
      pending.set(false);
      deps.injected.push({ body, round });
    };
    await driveAutopilotCycle(deps);
    expect(deps.injected).toEqual([{ body: revisionBody, round: 1 }]);
    expect(deps.reviewPlan).toHaveBeenCalledTimes(2);
    expect(deps.counters.implemented).toBe(1);
    expect(deps.emitted).toEqual([{ type: "autopilot_done", data: {} }]);
  });

  it("plan revision WITHOUT resubmit falls through to a normal work review", async () => {
    const pending = pendingFlag();
    const deps = makeDeps(
      [{ kind: "all_clear" }],
      {
        planPending: pending.get,
        onInjected: () => pending.set(false), // sidecar clears pending on injection
        runPrompt: async () => {
          // Run never calls exit_plan again — pending stays false.
        },
      },
      [{ kind: "prompt", body: "drop step 5" }],
    );
    await driveAutopilotCycle(deps);
    expect(deps.reviewPlan).toHaveBeenCalledTimes(1);
    expect(deps.review).toHaveBeenCalledTimes(1);
    expect(deps.counters.accepted).toBe(0);
    expect(deps.emitted).toEqual([{ type: "autopilot_done", data: {} }]);
  });

  it("HUMAN on a plan → autopilot_human, no accept, no implement", async () => {
    const deps = makeDeps([], { planPending: () => true }, [
      { kind: "human", reason: "destructive migration needs a user call" },
    ]);
    await driveAutopilotCycle(deps);
    expect(deps.counters.accepted).toBe(0);
    expect(deps.counters.implemented).toBe(0);
    expect(deps.emitted).toEqual([
      { type: "autopilot_human", data: { reason: "destructive migration needs a user call" } },
    ]);
  });

  it("acceptPlan returning false (stale generation — user acted) exits silently", async () => {
    const deps = makeDeps(
      [],
      {
        planPending: () => true,
        acceptPlan: async () => false,
      },
      [{ kind: "all_clear" }],
    );
    await driveAutopilotCycle(deps);
    expect(deps.counters.implemented).toBe(0);
    expect(deps.emitted).toEqual([]);
  });

  it("plan review failure (null) → silent stop", async () => {
    const deps = makeDeps([], { planPending: () => true }, [null]);
    await driveAutopilotCycle(deps);
    expect(deps.counters.accepted).toBe(0);
    expect(deps.emitted).toEqual([]);
  });

  it("cancel landing during the plan review discards the verdict", async () => {
    let cancelled = false;
    const deps = makeDeps([], {
      planPending: () => true,
      isCancelled: () => cancelled,
      reviewPlan: vi.fn(async () => {
        cancelled = true; // user Accept/cancel fired while Ken reviewed the plan
        return { kind: "all_clear" } as AutopilotVerdict;
      }),
    });
    await driveAutopilotCycle(deps);
    expect(deps.counters.accepted).toBe(0);
    expect(deps.emitted).toEqual([]);
  });

  it("cancel landing during the implement run stops before the next review", async () => {
    const pending = pendingFlag();
    let cancelled = false;
    const deps = makeDeps(
      [{ kind: "all_clear" }],
      {
        planPending: pending.get,
        isCancelled: () => cancelled,
        acceptPlan: async () => {
          pending.set(false);
          return true;
        },
        runImplement: async () => {
          cancelled = true; // /cancel fires mid-implementation
        },
      },
      [{ kind: "all_clear" }],
    );
    await driveAutopilotCycle(deps);
    expect(deps.review).not.toHaveBeenCalled();
    expect(deps.emitted).toEqual([]);
  });

  it("repeated plan rejections hit the round cap safely", async () => {
    const pending = pendingFlag();
    const deps = makeDeps(
      [],
      {
        maxRounds: 2,
        planPending: pending.get,
        onInjected: () => pending.set(false),
        runPrompt: async () => pending.set(true), // every revision resubmits
      },
      [
        { kind: "prompt", body: "reject 1" },
        { kind: "prompt", body: "reject 2" },
        // Would be round 3 — must never be reached.
        { kind: "prompt", body: "reject 3" },
      ],
    );
    await driveAutopilotCycle(deps);
    expect(deps.reviewPlan).toHaveBeenCalledTimes(2);
    expect(deps.emitted).toEqual([{ type: "autopilot_capped", data: { rounds: 2 } }]);
  });

  it("plan branch wins over the drafting hold when both flags are up", async () => {
    // exit_plan fired (pending) but isPlanMode is somehow still true — the
    // submitted plan takes precedence; the drafting hold is only for
    // enter-without-exit.
    const deps = makeDeps([], { planPending: () => true, isPlanMode: () => true }, [
      { kind: "human", reason: "needs a user call" },
    ]);
    await driveAutopilotCycle(deps);
    expect(deps.reviewPlan).toHaveBeenCalledTimes(1);
    expect(deps.emitted).toEqual([
      { type: "autopilot_human", data: { reason: "needs a user call" } },
    ]);
  });
});
