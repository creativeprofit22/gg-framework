import { describe, expect, it, vi } from "vitest";
import {
  AppSidecarPlanGate,
  hashPlanContent,
  type PersistedPlanReviewCheckpoint,
} from "./app-sidecar-plan-gate.js";
import {
  executePlanRevisionRequest,
  isPlanRevisionSessionBusy,
  parsePlanRevisionBody,
} from "./app-sidecar-plan-revision.js";

const NOW = "2026-08-10T12:00:00.000Z";

function checkpoint(): PersistedPlanReviewCheckpoint {
  const content = "# Durable plan\n\n1. Ship it.";
  return {
    version: 1,
    checkpointId: "checkpoint-1",
    generation: 1,
    planPath: "/project/.gg/plans/durable.md",
    content,
    contentHash: hashPlanContent(content),
    state: "pending-review",
    reviewStatus: "ready",
    actor: "gg-coder",
    timestamp: NOW,
    feedback: null,
  };
}

function marker(value: PersistedPlanReviewCheckpoint) {
  return { kind: "plan_gate", data: value as unknown as Record<string, unknown> };
}

const request = {
  checkpointId: "checkpoint-1",
  generation: 1,
  actor: "user" as const,
  feedback: "Add crash recovery coverage",
};

describe("parsePlanRevisionBody", () => {
  it.each([
    { length: 31_999, accepted: true },
    { length: 32_000, accepted: true },
    { length: 32_001, accepted: false },
  ])("validates $length-character feedback", ({ length, accepted }) => {
    const feedback = "x".repeat(length);
    const result = parsePlanRevisionBody(
      JSON.stringify({ checkpointId: "checkpoint-1", generation: 1, feedback }),
    );

    if (accepted) {
      expect(result).toEqual({ checkpointId: "checkpoint-1", generation: 1, feedback });
    } else {
      expect(result).toBeNull();
    }
  });

  it("trims accepted feedback before returning the route request", () => {
    expect(
      parsePlanRevisionBody(
        JSON.stringify({
          checkpointId: "checkpoint-1",
          generation: 1,
          feedback: "  Add crash recovery coverage  ",
        }),
      ),
    ).toEqual({
      checkpointId: "checkpoint-1",
      generation: 1,
      feedback: "Add crash recovery coverage",
    });
  });
});

describe("executePlanRevisionRequest", () => {
  it("resumes a crash-persisted request using the persisted feedback identity", async () => {
    const submitted = checkpoint();
    const persisted: PersistedPlanReviewCheckpoint[] = [];
    const beforeCrash = new AppSidecarPlanGate([marker(submitted)], async (value) => {
      persisted.push(structuredClone(value));
    });
    await beforeCrash.requestRevision(
      request.checkpointId,
      request.generation,
      request.actor,
      request.feedback,
    );

    const retryPersist = vi.fn(async () => undefined);
    const restarted = new AppSidecarPlanGate(persisted.map(marker), retryPersist);
    const run = vi.fn(async () => undefined);
    const onCommitted = vi.fn();
    await expect(
      executePlanRevisionRequest(request, {
        requestRevision: restarted.requestRevision.bind(restarted),
        onCommitted,
        run,
      }),
    ).resolves.toMatchObject({ status: "committed" });

    expect(retryPersist).not.toHaveBeenCalled();
    expect(onCommitted).toHaveBeenCalledWith(
      expect.objectContaining({ state: "revision-requested", feedback: request.feedback }),
    );
    expect(run).toHaveBeenCalledWith(
      expect.stringContaining(request.feedback),
      expect.objectContaining({ checkpointId: request.checkpointId, generation: 1 }),
    );
  });

  it("retries after provider failure, submits generation two, and rejects stale identity", async () => {
    const persist = vi.fn<(value: PersistedPlanReviewCheckpoint) => Promise<void>>(
      async () => undefined,
    );
    const gate = new AppSidecarPlanGate(
      [marker(checkpoint())],
      persist,
      () => "checkpoint-2",
      () => NOW,
    );
    const providerRun = vi
      .fn<(prompt: string, checkpoint: PersistedPlanReviewCheckpoint) => Promise<void>>()
      .mockRejectedValueOnce(new Error("provider failed"))
      .mockImplementationOnce(async () => {
        await gate.submit("/project/.gg/plans/durable.md", "# Revised plan");
      });
    const dependencies = {
      requestRevision: gate.requestRevision.bind(gate),
      onCommitted: vi.fn(),
      run: providerRun,
    };

    await expect(executePlanRevisionRequest(request, dependencies)).rejects.toThrow(
      "provider failed",
    );
    expect(gate.current()).toMatchObject({
      state: "revision-requested",
      feedback: request.feedback,
    });

    await expect(executePlanRevisionRequest(request, dependencies)).resolves.toMatchObject({
      status: "committed",
    });
    expect(gate.current()).toMatchObject({
      checkpointId: "checkpoint-2",
      generation: 2,
      state: "pending-review",
    });

    await expect(executePlanRevisionRequest(request, dependencies)).resolves.toMatchObject({
      status: "conflict",
    });
    expect(providerRun).toHaveBeenCalledTimes(2);
    const revisionMarkers = persist.mock.calls.filter(
      ([value]) => value.state === "revision-requested",
    );
    expect(revisionMarkers).toHaveLength(1);
  });

  it("lets a manual revision supersede an in-flight Autopilot review exactly once", async () => {
    expect(
      isPlanRevisionSessionBusy({
        running: true,
        autopilotActive: true,
        autopilotReviewing: true,
      }),
    ).toBe(false);
    expect(
      isPlanRevisionSessionBusy({
        running: true,
        autopilotActive: false,
        autopilotReviewing: false,
      }),
    ).toBe(true);
    let finishReview!: () => void;
    const reviewSettled = new Promise<void>((resolve) => {
      finishReview = resolve;
    });
    const gate = new AppSidecarPlanGate([marker(checkpoint())], async () => undefined);
    const order: string[] = [];
    const abortReview = vi.fn(() => order.push("abort-review"));
    const run = vi.fn(async () => {
      order.push("revision-run");
    });
    const supersedeAutopilot = vi.fn(async () => {
      abortReview();
      await reviewSettled;
      order.push("review-settled");
    });

    const revision = executePlanRevisionRequest(request, {
      requestRevision: gate.requestRevision.bind(gate),
      supersedeAutopilot,
      onCommitted: () => order.push("committed"),
      run,
    });

    await vi.waitFor(() => expect(abortReview).toHaveBeenCalledOnce());
    expect(gate.current()).toMatchObject({
      checkpointId: request.checkpointId,
      generation: request.generation,
      state: "revision-requested",
      actor: "user",
      feedback: request.feedback,
    });
    expect(run).not.toHaveBeenCalled();

    finishReview();
    await expect(revision).resolves.toMatchObject({ status: "committed" });
    expect(supersedeAutopilot).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledOnce();
    expect(order).toEqual(["abort-review", "review-settled", "committed", "revision-run"]);
  });
});
