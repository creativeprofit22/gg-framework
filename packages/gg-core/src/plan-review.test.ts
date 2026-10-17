import { describe, expect, it } from "vitest";
import {
  isPendingPlanReview,
  isPlanMutationFailure,
  type PendingPlanReview,
  type PlanMutationFailure,
} from "./plan-review.js";

const pendingPlanReview = {
  checkpointId: "checkpoint-1",
  generation: 1,
  planPath: "/plans/checkpoint-1.md",
  content: "# Plan",
  contentHash: "sha256:plan",
  state: "pending-review",
  reviewStatus: "unreviewed",
  feedback: null,
} satisfies PendingPlanReview;

describe("plan-review contracts", () => {
  it.each([
    { error: "invalid plan approval body" },
    { error: "stale-plan-checkpoint", pendingPlanReview },
    {
      error: "session_mutation_in_progress",
      owner: { operationId: "operation-1", kind: "manual-plan-accept" },
    },
    {
      status: "failed",
      code: "phase-stage-persistence-failed",
      operationId: "operation-1",
      message: "The approved phase stage could not be saved.",
      guidance: "Fix storage, then retry approval.",
      retryable: true,
      phaseId: "phase-1",
    },
  ] satisfies PlanMutationFailure[])("accepts a discriminated failure: %o", (value) => {
    expect(isPlanMutationFailure(value)).toBe(true);
  });

  it.each([
    {},
    { error: "" },
    { error: "   " },
    { error: "bad", status: "failed" },
    {
      status: "failed",
      code: "",
      operationId: "operation-1",
      message: "bad",
      guidance: "retry",
      retryable: true,
      phaseId: "phase-1",
    },
    {
      status: "failed",
      code: "bad",
      operationId: "",
      message: "bad",
      guidance: "retry",
      retryable: true,
      phaseId: "phase-1",
    },
    {
      status: "failed",
      code: "bad",
      operationId: "operation-1",
      message: "",
      guidance: "retry",
      retryable: true,
      phaseId: "phase-1",
    },
    {
      status: "failed",
      code: "bad",
      operationId: "operation-1",
      message: "bad",
      retryable: true,
      phaseId: "phase-1",
    },
    {
      error: "stale-plan-checkpoint",
      pendingPlanReview: { ...pendingPlanReview, checkpointId: "" },
    },
  ])("rejects an empty, mixed, or malformed failure: %o", (value) => {
    expect(isPlanMutationFailure(value)).toBe(false);
  });

  it("requires non-empty pending-review identity fields", () => {
    expect(isPendingPlanReview(pendingPlanReview)).toBe(true);
    expect(isPendingPlanReview({ ...pendingPlanReview, planPath: " " })).toBe(false);
    expect(isPendingPlanReview({ ...pendingPlanReview, content: "" })).toBe(true);
  });
});
