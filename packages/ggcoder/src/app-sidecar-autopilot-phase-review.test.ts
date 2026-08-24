import { describe, expect, it } from "vitest";
import {
  boundPhaseForAutopilotReview,
  classifyAppSidecarFinalReviewAttempt,
  phaseCompletionVerdict,
} from "./app-sidecar-autopilot-phase-review.js";
import type { AppSidecarFinalReviewAttempt } from "./app-sidecar-roadmap-tool-host.js";
import { createAppSidecarRoadmapReviewTrigger } from "./app-sidecar-roadmap-review-scheduler.js";
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
    unmetGateCodes?: string[];
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
            unmetGateCodes: options.unmetGateCodes ?? [],
          }
        : { result, phaseId: reviewPhase.id, revision: reviewPhase.revision },
  } as AppSidecarFinalReviewAttempt;
}

describe("Autopilot phase completion review", () => {
  it("throws when text claims ALL_CLEAR without a final_review attempt", () => {
    expect(() => phaseCompletionVerdict(reviewPhase, [], { kind: "all_clear" })).toThrowError(
      "Autopilot completion review failed for phase phase-review: no relevant roadmap_status final_review call was recorded.",
    );
  });

  it("classifies the latest stale attempt for one fresh-snapshot retry", () => {
    const stale = attempt({ result: "stale-revision" });
    expect(classifyAppSidecarFinalReviewAttempt(reviewPhase.id, [attempt(), stale])).toEqual({
      status: "stale-revision",
      attempt: stale,
    });
  });

  it.each(["stale-revision", "completion-checkpoint-blocked"] as const)(
    "throws when the final_review result does not commit: %s",
    (result) => {
      expect(() =>
        phaseCompletionVerdict(reviewPhase, [attempt({ result })], { kind: "all_clear" }),
      ).toThrowError(
        `Autopilot completion review failed for phase phase-review: final_review did not commit or duplicate (result: ${result}).`,
      );
    },
  );

  it.each([
    ["completion-review-committed", "stale-revision"],
    ["completion-review-duplicate", "completion-checkpoint-blocked"],
  ] as const)(
    "throws using the latest result when an earlier attempt succeeded: %s then %s",
    (earlierResult, latestResult) => {
      expect(() =>
        phaseCompletionVerdict(
          reviewPhase,
          [attempt({ result: earlierResult }), attempt({ result: latestResult })],
          { kind: "all_clear" },
        ),
      ).toThrowError(
        `Autopilot completion review failed for phase phase-review: final_review did not commit or duplicate (result: ${latestResult}).`,
      );
    },
  );

  it("throws when an accepted final_review leaves the completion gate in Review", () => {
    expect(() =>
      phaseCompletionVerdict(
        reviewPhase,
        [attempt({ gateOutcome: "review", unmetGateCodes: ["verification-evidence-missing"] })],
        { kind: "all_clear" },
      ),
    ).toThrowError(
      "Autopilot completion review failed for phase phase-review: accepted final_review left the completion gate in Review (verification-evidence-missing).",
    );
  });

  it("advances committed and duplicate reviews only when the completion gate reports Done", () => {
    expect(
      phaseCompletionVerdict(reviewPhase, [attempt()], { kind: "human", reason: "text drift" }),
    ).toEqual({ kind: "all_clear" });
    expect(
      phaseCompletionVerdict(reviewPhase, [attempt({ result: "completion-review-duplicate" })], {
        kind: "ignore",
      }),
    ).toEqual({ kind: "all_clear" });
  });

  it("routes a committed rejected final review through the existing correction loop", () => {
    expect(
      phaseCompletionVerdict(reviewPhase, [attempt({ decision: "rejected" })], {
        kind: "all_clear",
      }),
    ).toEqual({ kind: "prompt", body: "Fix the failing edge case." });
  });

  it("trusts the parsed text verdict for phases outside Review", () => {
    const activePhase = { ...reviewPhase, status: "in-progress" as const };
    const textVerdict = { kind: "human", reason: "Needs a product decision." } as const;

    expect(phaseCompletionVerdict(activePhase, [], textVerdict)).toEqual(textVerdict);
  });

  it("ignores manual Ken attempts when requiring an Autopilot final_review", () => {
    expect(() =>
      phaseCompletionVerdict(reviewPhase, [attempt({ actor: "ken" })], { kind: "all_clear" }),
    ).toThrowError("no relevant roadmap_status final_review call was recorded");
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

    const trigger = createAppSidecarRoadmapReviewTrigger(reviewPhase.id, "verification-1");
    expect(boundPhaseForAutopilotReview(snapshot, reviewPhase.id, trigger)).toEqual({
      id: reviewPhase.id,
      revision: 7,
      goal: "Persist the final review",
      completionCriteria: ["Gate says Done"],
      status: "review",
      finalReviewClaim: { triggerId: trigger.triggerId, reviewId: trigger.reviewId },
      latestVerification: {
        id: "verification-1",
        result: "passed",
        reason: null,
        timestamp: "2026-08-05T00:00:00.000Z",
        evidence: ["pnpm test passed"],
      },
    });
    expect(boundPhaseForAutopilotReview(snapshot, reviewPhase.id)).toBeNull();
    expect(
      boundPhaseForAutopilotReview(
        snapshot,
        reviewPhase.id,
        createAppSidecarRoadmapReviewTrigger(reviewPhase.id, "verification-stale"),
      ),
    ).toBeNull();
  });
});
