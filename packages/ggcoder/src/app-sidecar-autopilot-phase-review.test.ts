import { describe, expect, it } from "vitest";
import {
  boundPhaseForAutopilotReview,
  phaseCompletionVerdict,
} from "./app-sidecar-autopilot-phase-review.js";
import type { AppSidecarFinalReviewAttempt } from "./app-sidecar-roadmap-tool-host.js";
import type { ProjectNotesSnapshot } from "./project-notes-repository.js";

const reviewPhase = {
  id: "phase-review",
  revision: 12,
  goal: "Ship phase completion review",
  completionCriteria: ["accepted work", "verification evidence"],
  status: "review",
  latestVerification: null,
} as const;

function attempt(
  options: {
    actor?: "ken" | "ken-autopilot";
    decision?: "accepted" | "rejected";
    reason?: string | null;
    result?:
      | "completion-review-committed"
      | "completion-review-duplicate"
      | "stale-revision"
      | "completion-checkpoint-blocked";
    gateOutcome?: "done" | "review";
  } = {},
): AppSidecarFinalReviewAttempt {
  const decision = options.decision ?? "accepted";
  const result = options.result ?? "completion-review-committed";
  return {
    actor: options.actor ?? "ken-autopilot",
    input: {
      update_id: "update-1",
      phase_id: reviewPhase.id,
      expected_revision: reviewPhase.revision,
      transition: "review",
      progress: "Inspected the completed phase.",
      evidence: ["targeted tests passed"],
      verification: null,
      final_review: {
        review_id: "review-1",
        decision,
        evidence: ["targeted tests passed"],
        reason: options.reason ?? (decision === "rejected" ? "Fix the failing edge case." : null),
        accepts_verification_exception: false,
      },
      proposed_references: [],
    },
    result:
      result === "completion-review-committed" || result === "completion-review-duplicate"
        ? {
            result,
            phaseId: reviewPhase.id,
            revision: reviewPhase.revision + 1,
            statusOutcome: "applied",
            proposals: [],
            gateOutcome: options.gateOutcome ?? "done",
            unmetGateCodes: [],
          }
        : { result, phaseId: reviewPhase.id, revision: reviewPhase.revision },
  } as AppSidecarFinalReviewAttempt;
}

describe("Autopilot phase completion review", () => {
  it("advances only when the existing completion gate reports Done", () => {
    expect(
      phaseCompletionVerdict(reviewPhase, [attempt()], { kind: "human", reason: "text drift" }),
    ).toEqual({ kind: "all_clear" });
  });

  it("routes a rejected final review through the existing correction loop", () => {
    expect(
      phaseCompletionVerdict(reviewPhase, [attempt({ decision: "rejected" })], {
        kind: "all_clear",
      }),
    ).toEqual({ kind: "prompt", body: "Fix the failing edge case." });
  });

  it("leaves accepted work with missing evidence in Review", () => {
    expect(
      phaseCompletionVerdict(reviewPhase, [attempt({ gateOutcome: "review" })], {
        kind: "all_clear",
      }),
    ).toBeNull();
  });

  it("honors an idempotent duplicate but rejects stale review output", () => {
    expect(
      phaseCompletionVerdict(reviewPhase, [attempt({ result: "completion-review-duplicate" })], {
        kind: "all_clear",
      }),
    ).toEqual({ kind: "all_clear" });
    expect(
      phaseCompletionVerdict(reviewPhase, [attempt({ result: "stale-revision" })], {
        kind: "all_clear",
      }),
    ).toBeNull();
  });

  it("is restart-safe because a fresh loop trusts the persisted duplicate gate result", () => {
    const afterRestart = structuredClone(reviewPhase);
    expect(
      phaseCompletionVerdict(afterRestart, [attempt({ result: "completion-review-duplicate" })], {
        kind: "ignore",
      }),
    ).toEqual({ kind: "all_clear" });
  });

  it("leaves Review on interruption or disabled autopilot", () => {
    expect(phaseCompletionVerdict(reviewPhase, [], { kind: "all_clear" })).toBeNull();
    expect(
      phaseCompletionVerdict(reviewPhase, [attempt({ result: "completion-checkpoint-blocked" })], {
        kind: "all_clear",
      }),
    ).toBeNull();
  });

  it("ignores manual Ken attempts inside the Autopilot Ken loop", () => {
    expect(
      phaseCompletionVerdict(reviewPhase, [attempt({ actor: "ken" })], { kind: "all_clear" }),
    ).toBeNull();
  });

  it("loads the bound goal, criteria, status, and latest verification evidence", () => {
    const snapshot = {
      revision: 7,
      document: {
        phases: [
          {
            id: reviewPhase.id,
            goal: "Persist the final review",
            doneWhen: ["Gate says Done"],
            status: "review",
            roadmapEvents: [
              {
                id: "verification-1",
                type: "status-update",
                verification: "passed",
                verificationReason: null,
                timestamp: "2026-08-05T00:00:00.000Z",
                evidence: ["pnpm test passed"],
              },
            ],
          },
        ],
      },
    } as unknown as ProjectNotesSnapshot;

    expect(boundPhaseForAutopilotReview(snapshot, reviewPhase.id)).toEqual({
      id: reviewPhase.id,
      revision: 7,
      goal: "Persist the final review",
      completionCriteria: ["Gate says Done"],
      status: "review",
      latestVerification: {
        id: "verification-1",
        result: "passed",
        reason: null,
        timestamp: "2026-08-05T00:00:00.000Z",
        evidence: ["pnpm test passed"],
      },
    });
  });
});
