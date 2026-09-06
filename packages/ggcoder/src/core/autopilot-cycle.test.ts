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
import {
  CORPUS_UNVERIFIED_REASON,
  parseAutopilotVerdict,
  type AutopilotVerdict,
} from "./autopilot-verdict.js";

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
  counters: { ready: number; revisions: number };
  resetReviewer: ReturnType<typeof vi.fn<() => Promise<void>>>;
  review: ReturnType<typeof vi.fn<() => Promise<AutopilotVerdict | null>>>;
  reviewPlan: ReturnType<typeof vi.fn<() => Promise<AutopilotVerdict | null>>>;
} {
  const emitted: AutopilotCycleEmit[] = [];
  const injected: Array<{ body: string; round: number }> = [];
  const ran: string[] = [];
  const queue = [...verdicts];
  const planQueue = [...planVerdicts];
  const counters = { ready: 0, revisions: 0 };
  const deps = {
    maxRounds: 3,
    isCancelled: () => false,
    verificationProblem: () => null,
    isPlanMode: () => false,
    planPending: () => false,
    resetReviewer: vi.fn(async () => {}),
    review: vi.fn(async () => queue.shift() ?? null),
    reviewPlan: vi.fn(async () => planQueue.shift() ?? null),
    markPlanReady: async () => {
      counters.ready++;
      return { checkpointId: "checkpoint-1", generation: 1 };
    },
    requestPlanRevision: async () => {
      counters.revisions++;
      return true;
    },
    runPrompt: async (body: string) => {
      ran.push(body);
    },
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
    counters: { ready: number; revisions: number };
    resetReviewer: ReturnType<typeof vi.fn<() => Promise<void>>>;
    review: ReturnType<typeof vi.fn<() => Promise<AutopilotVerdict | null>>>;
    reviewPlan: ReturnType<typeof vi.fn<() => Promise<AutopilotVerdict | null>>>;
  };
}

/** planPending() driven by a mutable flag the plan deps flip, mirroring the
 *  sidecar (revision-requested clears review eligibility; exit_plan re-sets it). */
function pendingFlag(initial = true): { get: () => boolean; set: (v: boolean) => void } {
  let value = initial;
  return { get: () => value, set: (v) => (value = v) };
}

describe("host verification control", () => {
  it("blocks unverified work before spending a reviewer call", async () => {
    const deps = makeDeps([{ kind: "all_clear" }], {
      verificationProblem: () => "Unverified: current checks are missing.",
    });
    await driveAutopilotCycle(deps);
    expect(deps.review).not.toHaveBeenCalled();
    expect(deps.resetReviewer).not.toHaveBeenCalled();
    expect(deps.emitted).toEqual([
      { type: "autopilot_human", data: { reason: "Unverified: current checks are missing." } },
    ]);
  });

  it("rejects ALL_CLEAR if verification becomes stale during the review", async () => {
    let problem: string | null = null;
    const deps = makeDeps([], {
      verificationProblem: () => problem,
      review: vi.fn(async (): Promise<AutopilotVerdict> => {
        problem = "Unverified: code changed during review.";
        return { kind: "all_clear", evidenceLimitation: "corpus_unverified" };
      }),
    });
    await driveAutopilotCycle(deps);
    expect(deps.emitted).toEqual([{ type: "autopilot_human", data: { reason: problem } }]);
    expect(deps.ran).toEqual([]);
  });

  it("never approves a plan over outstanding verification", async () => {
    const pending = pendingFlag();
    const deps = makeDeps(
      [],
      {
        planPending: pending.get,
        verificationProblem: () => "Unverified: a check failed.",
      },
      [{ kind: "all_clear" }],
    );
    await driveAutopilotCycle(deps);
    expect(deps.reviewPlan).not.toHaveBeenCalled();
    expect(deps.counters.ready).toBe(0);
    expect(deps.ran).toEqual([]);
  });
});

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

  it("preserves a parsed evidence limitation in the terminal event without another run", async () => {
    const verdict = parseAutopilotVerdict(
      '{"verdict":"ALL_CLEAR","evidenceLimitation":"corpus_unverified"}',
    );
    const deps = makeDeps([verdict]);
    await driveAutopilotCycle(deps);
    expect(deps.emitted).toEqual([
      { type: "autopilot_done", data: { reason: CORPUS_UNVERIFIED_REASON } },
    ]);
    expect(deps.ran).toEqual([]);
    expect(deps.review).toHaveBeenCalledTimes(1);
  });

  it("does not approve unsupported verification exceptions", async () => {
    const deps = makeDeps([
      parseAutopilotVerdict('{"verdict":"ALL_CLEAR","evidenceLimitation":"verification_failed"}'),
    ]);
    await driveAutopilotCycle(deps);
    expect(deps.emitted[0]?.type).toBe("autopilot_human");
    expect(deps.ran).toEqual([]);
  });

  it("passes a plan's limitation to readiness without authorizing implementation", async () => {
    const pending = pendingFlag();
    const identity = { checkpointId: "checkpoint-1", generation: 1 };
    const markPlanReady = vi.fn(async () => identity);
    const deps = makeDeps([], { planPending: pending.get, markPlanReady }, [
      { kind: "all_clear", evidenceLimitation: "corpus_unverified" },
    ]);
    await driveAutopilotCycle(deps);
    expect(markPlanReady).toHaveBeenCalledWith(CORPUS_UNVERIFIED_REASON);
    expect(deps.emitted).toEqual([
      { type: "autopilot_plan_ready", data: { ...identity, reason: CORPUS_UNVERIFIED_REASON } },
    ]);
    expect(deps.ran).toEqual([]);
    expect(pending.get()).toBe(true);
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
    expect(deps.emitted).toEqual([{ type: "autopilot_done", data: {} }]);
    expect(deps.review).toHaveBeenCalledTimes(2);
  });

  it("caps only after reviewing the last permitted remediation", async () => {
    const deps = makeDeps([
      { kind: "prompt", body: "fix 1" },
      { kind: "prompt", body: "fix 2" },
      { kind: "prompt", body: "fix 3" },
      { kind: "prompt", body: "fix 4" },
    ]);
    await driveAutopilotCycle(deps);
    expect(deps.ran).toEqual(["fix 1", "fix 2", "fix 3"]);
    expect(deps.emitted).toEqual([{ type: "autopilot_capped", data: { rounds: 3 } }]);
    expect(deps.review).toHaveBeenCalledTimes(4);
  });

  it("allows terminal final review after the last permitted remediation", async () => {
    const deps = makeDeps([{ kind: "prompt", body: "final fix" }, { kind: "all_clear" }], {
      maxRounds: 1,
    });

    await driveAutopilotCycle(deps);

    expect(deps.ran).toEqual(["final fix"]);
    expect(deps.review).toHaveBeenCalledTimes(2);
    expect(deps.emitted).toEqual([{ type: "autopilot_done", data: {} }]);
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

describe("driveAutopilotCycle — durable plan gate", () => {
  it.each(["all_clear", "ignore"] as const)(
    "%s marks the plan ready but never accepts or implements it",
    async (kind) => {
      const pending = pendingFlag();
      const order: string[] = [];
      const deps = makeDeps(
        [],
        {
          planPending: pending.get,
          markPlanReady: async () => {
            order.push("ready");
            return { checkpointId: "checkpoint-1", generation: 1 };
          },
          runPrompt: async () => {
            order.push("unexpected-run");
          },
        },
        [{ kind }],
      );
      await driveAutopilotCycle(deps);
      expect(order).toEqual(["ready"]);
      expect(deps.review).not.toHaveBeenCalled();
      expect(deps.emitted).toEqual([
        {
          type: "autopilot_plan_ready",
          data: { checkpointId: "checkpoint-1", generation: 1 },
        },
      ]);
    },
  );

  it("requests revision through the gate before injecting feedback and reviews a resubmission", async () => {
    const pending = pendingFlag();
    const revisionBody = buildPlanRevisionPrompt("Swap steps 3 and 4");
    const order: string[] = [];
    const deps = makeDeps(
      [],
      {
        maxRounds: 3,
        planPending: pending.get,
        requestPlanRevision: async (feedback) => {
          expect(feedback).toBe("Swap steps 3 and 4");
          order.push("gate-revision");
          pending.set(false);
          return true;
        },
        onInjected: (body, round) => {
          order.push(`inject-${round}`);
          deps.injected.push({ body, round });
        },
        runPrompt: async (body) => {
          expect(body).toBe(revisionBody);
          order.push("revision-run");
          pending.set(true);
        },
        markPlanReady: async () => {
          order.push("ready");
          return { checkpointId: "checkpoint-2", generation: 2 };
        },
      },
      [{ kind: "prompt", body: "Swap steps 3 and 4" }, { kind: "all_clear" }],
    );
    await driveAutopilotCycle(deps);
    expect(order).toEqual(["gate-revision", "inject-1", "revision-run", "ready"]);
    expect(deps.reviewPlan).toHaveBeenCalledTimes(2);
    expect(deps.emitted).toEqual([
      {
        type: "autopilot_plan_ready",
        data: { checkpointId: "checkpoint-2", generation: 2 },
      },
    ]);
  });

  it("stops safely when revision loses a generation race", async () => {
    const deps = makeDeps([], { planPending: () => true, requestPlanRevision: async () => false }, [
      { kind: "prompt", body: "stale" },
    ]);
    await driveAutopilotCycle(deps);
    expect(deps.ran).toEqual([]);
    expect(deps.emitted).toEqual([]);
  });

  it("stops safely when ready loses a generation race", async () => {
    const deps = makeDeps([], { planPending: () => true, markPlanReady: async () => null }, [
      { kind: "all_clear" },
    ]);
    await driveAutopilotCycle(deps);
    expect(deps.emitted).toEqual([]);
  });

  it("HUMAN leaves the plan gate pending for explicit human action", async () => {
    const deps = makeDeps([], { planPending: () => true }, [
      { kind: "human", reason: "Destructive migration needs a user call" },
    ]);
    await driveAutopilotCycle(deps);
    expect(deps.counters.ready).toBe(0);
    expect(deps.emitted).toEqual([
      {
        type: "autopilot_human",
        data: { reason: "Destructive migration needs a user call" },
      },
    ]);
  });

  it("review failure and cancellation stop without mutating the gate", async () => {
    const failed = makeDeps([], { planPending: () => true }, [null]);
    await driveAutopilotCycle(failed);
    expect(failed.counters).toEqual({ ready: 0, revisions: 0 });

    let cancelled = false;
    const cancelledDeps = makeDeps([], {
      planPending: () => true,
      isCancelled: () => cancelled,
      reviewPlan: vi.fn(async () => {
        cancelled = true;
        return { kind: "all_clear" } as AutopilotVerdict;
      }),
    });
    await driveAutopilotCycle(cancelledDeps);
    expect(cancelledDeps.counters).toEqual({ ready: 0, revisions: 0 });
  });

  it("repeated revision resubmissions stop only after a post-remediation review", async () => {
    const pending = pendingFlag();
    const requestPlanRevision = vi.fn(async () => {
      pending.set(false);
      return true;
    });
    const deps = makeDeps(
      [],
      {
        maxRounds: 2,
        planPending: pending.get,
        requestPlanRevision,
        runPrompt: async () => pending.set(true),
      },
      [
        { kind: "prompt", body: "reject 1" },
        { kind: "prompt", body: "reject 2" },
        { kind: "prompt", body: "reject 3" },
      ],
    );
    await driveAutopilotCycle(deps);
    expect(deps.reviewPlan).toHaveBeenCalledTimes(3);
    expect(requestPlanRevision).toHaveBeenCalledTimes(2);
    expect(deps.emitted).toEqual([{ type: "autopilot_capped", data: { rounds: 2 } }]);
  });

  it("submitted plan review takes precedence over the drafting hold", async () => {
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
