import type { ReactElement } from "react";
import { PRODUCT_DISPLAY_NAME } from "./brand";
import type {
  NotesCompletionUnmetGateCode,
  NotesImplementationRunOutcome,
  NotesPhase,
  NotesRoadmapActor,
  NotesRoadmapEvent,
  NotesRoadmapImplementationCheckpoint,
  NotesRoadmapStatusUpdate,
  NotesVerificationStatus,
} from "./notes-types";

const ROADMAP_ACTOR_LABELS = {
  "gg-coder": PRODUCT_DISPLAY_NAME,
  ken: "Legacy reviewer",
  "ken-autopilot": "Legacy Autopilot reviewer",
} as const satisfies Record<NotesRoadmapActor, string>;

const VERIFICATION_LABELS = {
  passed: "Passed",
  failed: "Failed",
  "exception-requested": "Exception requested",
} as const satisfies Record<NotesVerificationStatus, string>;

const IMPLEMENTATION_OUTCOME_LABELS = {
  succeeded: "succeeded",
  failed: "failed",
  cancelled: "was cancelled",
  interrupted: "was interrupted",
} as const satisfies Record<NotesImplementationRunOutcome, string>;

const COMPLETION_GATE_RECOVERY = {
  "missing-implementation": "Implementation evidence has not been recorded.",
  "stale-session": "Completion evidence belongs to a different phase session.",
  "run-not-successful": "The implementation run did not settle successfully.",
  "incomplete-plan": "The current run did not complete every canonical plan step.",
  "missing-verification": "Typed verification evidence has not been recorded.",
  "failed-verification": "The current verification failed.",
  "stale-verification": "Verification does not belong to the latest implementation run.",
  "verification-exception-not-accepted": "The verification exception needs manual approval.",
  "unresolved-approval": "Plan approval is still unresolved.",
  "unresolved-attention": "A question or error still needs attention.",
  "inactive-phase": "The phase is not active for automatic completion.",
} as const satisfies Record<NotesCompletionUnmetGateCode, string>;

const dateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

export type NotesCompletionGateTone = "neutral" | "positive" | "warning" | "negative" | "protected";

export interface NotesCompletionGateOverview {
  implementation: { label: string; detail: string; tone: NotesCompletionGateTone };
  verification: { label: string; detail: string | null; tone: NotesCompletionGateTone };
  settlement: { label: string; detail: string | null; tone: NotesCompletionGateTone };
  outcome: string;
  blocker: string | null;
  tone: NotesCompletionGateTone;
}

export function notesCompletionGateOverview(phase: NotesPhase): NotesCompletionGateOverview {
  const implementation = latestRoadmapEvent(
    phase,
    (event): event is NotesRoadmapImplementationCheckpoint =>
      event.type === "implementation-checkpoint",
  );
  const latestReport = latestRoadmapEvent(
    phase,
    (event): event is NotesRoadmapStatusUpdate => event.type === "status-update",
  );
  const verification = latestReport?.verification !== null ? latestReport : undefined;
  const implementationComplete =
    implementation?.runOutcome === "succeeded" &&
    implementation.completedPlanSteps.length === implementation.planStepTotal;
  const implementationSummary = implementation
    ? {
        label:
          implementation.runOutcome === "failed"
            ? "Failed"
            : implementationComplete
              ? "Complete"
              : "Open",
        detail: `${implementation.completedPlanSteps.length} of ${implementation.planStepTotal} plan steps`,
        tone:
          implementation.runOutcome === "failed"
            ? ("negative" as const)
            : implementationComplete
              ? ("positive" as const)
              : ("warning" as const),
      }
    : { label: "Missing", detail: "No evidence", tone: "neutral" as const };
  const verificationSummary = verification?.verification
    ? {
        label: verificationLabel(verification.verification),
        detail: verification.verificationReason,
        tone:
          verification.verification === "passed"
            ? ("positive" as const)
            : verification.verification === "failed"
              ? ("negative" as const)
              : ("warning" as const),
      }
    : { label: "Missing", detail: null, tone: "neutral" as const };
  const pendingIntent =
    verification?.transition === "done" && verification.statusOutcome === "completion-pending";
  const linkedSettlement =
    pendingIntent && implementation?.verificationStatusUpdateId === verification.id;
  const settlement =
    phase.status === "done"
      ? {
          label: "Settled",
          detail: "All automatic completion gates passed.",
          tone: "positive" as const,
        }
      : pendingIntent && !linkedSettlement
        ? {
            label: "Pending",
            detail: "Waiting for the owning implementation run to settle.",
            tone: "warning" as const,
          }
        : linkedSettlement
          ? {
              label: "Open",
              detail: "The current run settled without passing every completion gate.",
              tone: "warning" as const,
            }
          : { label: "Not requested", detail: null, tone: "neutral" as const };

  if (phase.overrides.status !== null) {
    return {
      implementation: implementationSummary,
      verification: verificationSummary,
      settlement,
      outcome: "Manual override protected",
      blocker: "Automatic completion cannot replace the user-selected state.",
      tone: "protected",
    };
  }
  if (phase.status === "done") {
    return {
      implementation: implementationSummary,
      verification: verificationSummary,
      settlement,
      outcome: "Done",
      blocker: null,
      tone: "positive",
    };
  }
  if (verification?.verification === "failed") {
    return {
      implementation: implementationSummary,
      verification: verificationSummary,
      settlement,
      outcome: "Verification failed",
      blocker: verification.verificationReason ?? "Verification must pass before completion.",
      tone: "negative",
    };
  }
  if (verification?.verification === "exception-requested") {
    return {
      implementation: implementationSummary,
      verification: verificationSummary,
      settlement,
      outcome: "Manual approval available",
      blocker: verification.verificationReason ?? "Approve the verification exception manually.",
      tone: "warning",
    };
  }
  if (implementation && !implementationComplete) {
    return {
      implementation: implementationSummary,
      verification: verificationSummary,
      settlement,
      outcome: "Completion open",
      blocker:
        implementation.runOutcome === "failed"
          ? "The implementation run failed."
          : implementation.runOutcome === "cancelled"
            ? "The implementation run was cancelled."
            : implementation.runOutcome === "interrupted"
              ? "The implementation run was interrupted."
              : "Complete every canonical plan step.",
      tone: implementation.runOutcome === "failed" ? "negative" : "warning",
    };
  }
  if (!implementation || !verification?.verification) {
    return {
      implementation: implementationSummary,
      verification: verificationSummary,
      settlement,
      outcome: "Evidence missing",
      blocker: !implementation
        ? "Record implementation evidence next."
        : "Record typed verification next.",
      tone: "neutral",
    };
  }
  return {
    implementation: implementationSummary,
    verification: verificationSummary,
    settlement,
    outcome: pendingIntent ? "Settlement pending" : "Completion not requested",
    blocker: pendingIntent ? settlement.detail : "Request Done after current verification passes.",
    tone: "warning",
  };
}

export function NotesPhaseCompletionGates({ phase }: { phase: NotesPhase }): ReactElement {
  const overview = notesCompletionGateOverview(phase);
  const implementation = latestRoadmapEvent(
    phase,
    (event): event is NotesRoadmapImplementationCheckpoint =>
      event.type === "implementation-checkpoint",
  );
  const latestReport = latestRoadmapEvent(
    phase,
    (event): event is NotesRoadmapStatusUpdate => event.type === "status-update",
  );
  const verification = latestReport?.verification !== null ? latestReport : undefined;
  const criterionEvidence = phase.doneWhen.map((criterion, index) => ({
    criterion,
    evidence: verification?.evidence[index] ?? null,
  }));
  const intentReady =
    verification?.transition === "done" &&
    verification.verification === "passed" &&
    verification.evidence.length === phase.doneWhen.length;

  return (
    <section
      className="notes-completion-gates"
      aria-labelledby={`notes-completion-gates-${phase.id}`}
    >
      <h4 id={`notes-completion-gates-${phase.id}`}>Completion gates</h4>
      <dl>
        <div className={intentReady ? "notes-review-readiness is-ready" : "notes-review-readiness"}>
          <dt>Completion intent</dt>
          <dd>
            <strong>{intentReady ? "Ready to settle" : "Not ready"}</strong>
            <span>
              {intentReady
                ? "Every Done When criterion has current passed evidence."
                : "Passed verification and one evidence item per Done When criterion are required."}
            </span>
            {criterionEvidence.length > 0 && (
              <ul className="notes-review-readiness-evidence">
                {criterionEvidence.map(({ criterion, evidence }, index) => (
                  <li key={`${index}-${criterion}`}>
                    <span>{criterion}</span>
                    <strong>{evidence ?? "Evidence missing"}</strong>
                  </li>
                ))}
              </ul>
            )}
          </dd>
        </div>
        <div>
          <dt>Implementation</dt>
          <dd>
            {implementation ? (
              <>
                <strong>{overview.implementation.detail}</strong>
                <span>
                  Run {implementationOutcomeLabel(implementation.runOutcome)} by the bound session.
                </span>
                <time dateTime={implementation.timestamp}>
                  {formatDateTime(implementation.timestamp)}
                </time>
              </>
            ) : (
              <span>Completion evidence has not been recorded.</span>
            )}
          </dd>
        </div>
        <div>
          <dt>Verification</dt>
          <dd>
            {verification?.verification ? (
              <>
                <strong>{verificationLabel(verification.verification)}</strong>
                <span>
                  Reported by {roadmapActorLabel(verification.actor)} at{" "}
                  <time dateTime={verification.timestamp}>
                    {formatDateTime(verification.timestamp)}
                  </time>
                  .
                </span>
                {verification.verificationReason && <span>{verification.verificationReason}</span>}
                {verification.evidence.length > 0 && (
                  <ul>
                    {verification.evidence.map((item, index) => (
                      <li key={`${verification.id}-evidence-${index}`}>{item}</li>
                    ))}
                  </ul>
                )}
              </>
            ) : (
              <span>Typed verification has not been recorded.</span>
            )}
          </dd>
        </div>
        <div>
          <dt>Settlement</dt>
          <dd>
            <strong>{overview.settlement.label}</strong>
            {overview.settlement.detail && <span>{overview.settlement.detail}</span>}
            {overview.blocker && <span>{overview.blocker}</span>}
          </dd>
        </div>
      </dl>
    </section>
  );
}

function roadmapActorLabel(actor: NotesRoadmapActor): string {
  return ROADMAP_ACTOR_LABELS[actor];
}

function verificationLabel(verification: NotesVerificationStatus): string {
  return VERIFICATION_LABELS[verification];
}

function implementationOutcomeLabel(outcome: NotesImplementationRunOutcome): string {
  return IMPLEMENTATION_OUTCOME_LABELS[outcome];
}

function latestRoadmapEvent<T extends NotesRoadmapEvent>(
  phase: NotesPhase,
  predicate: (event: NotesRoadmapEvent) => event is T,
): T | null {
  return [...phase.roadmapEvents].reverse().find(predicate) ?? null;
}

export function completionGateRecovery(code: NotesCompletionUnmetGateCode): string {
  return COMPLETION_GATE_RECOVERY[code];
}

function formatDateTime(value: string): string {
  return dateTimeFormatter.format(new Date(value));
}
