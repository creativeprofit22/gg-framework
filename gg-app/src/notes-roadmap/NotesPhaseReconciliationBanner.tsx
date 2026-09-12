import { useState, type ReactElement } from "react";
import type { NotesPhase, PhaseExecutionReconciliationOutcome } from "../notes-types";
import { useNotesPhaseDetail } from "./NotesPhaseDetailState";

type ReconciliationWorkspace = NonNullable<
  NonNullable<NotesPhase["execution"]>["pendingCompletion"]
>["workspace"];

export function NotesPhaseReconciliationBanner(): ReactElement | null {
  const {
    phase,
    expectedProjectKey,
    expectedRevision,
    onReconcilePhaseExecution,
    onReconciliationSuccess,
  } = useNotesPhaseDetail();
  const [pending, setPending] = useState(false);
  const [outcome, setOutcome] = useState<PhaseExecutionReconciliationOutcome | null>(null);
  const [transportError, setTransportError] = useState("");
  const historicalReconciliation = phase.execution?.state === "needs-reconciliation";
  const workspace = latestReconciliationWorkspace(phase);
  const succeeded = outcome?.status === "reconciled" || outcome?.status === "duplicate";

  if (!historicalReconciliation && !succeeded) return null;

  const unavailable =
    expectedProjectKey === null ||
    expectedRevision === null ||
    !phase.execution?.plan ||
    !phase.execution.repository ||
    !workspace;

  const reconcile = async (): Promise<void> => {
    const execution = phase.execution;
    if (
      pending ||
      !execution?.plan ||
      !execution.repository ||
      !workspace ||
      expectedProjectKey === null ||
      expectedRevision === null
    ) {
      return;
    }
    setPending(true);
    setOutcome(null);
    setTransportError("");
    try {
      const result = await onReconcilePhaseExecution({
        version: 3,
        action: "reconcile-execution",
        phaseId: phase.id,
        expectedProjectKey,
        expectedRevision,
        operationId: crypto.randomUUID(),
        repository: execution.repository,
        plan: {
          planId: execution.plan.planId,
          contentHash: execution.plan.contentHash,
          snapshotPath: execution.plan.snapshotPath,
          approvedAt: execution.plan.approvedAt,
          approvedRevision: execution.plan.approvedRevision,
          baseCommit: execution.plan.baseCommit,
        },
        workspace,
      });
      setOutcome(result);
      if (result.status === "reconciled" || result.status === "duplicate") {
        onReconciliationSuccess();
      }
    } catch (error) {
      setTransportError(
        error instanceof Error ? error.message : "Reconciliation could not be requested.",
      );
    } finally {
      setPending(false);
    }
  };

  return (
    <section
      className={`notes-phase-reconciliation${succeeded ? " is-success" : ""}`}
      aria-labelledby={`notes-phase-reconciliation-${phase.id}`}
    >
      <div>
        <p className="notes-phase-reconciliation-kicker">
          {succeeded ? "Context updated" : "Historical execution context"}
        </p>
        <h4 id={`notes-phase-reconciliation-${phase.id}`}>
          {succeeded ? "Stored progress was preserved" : "Review saved context if needed"}
        </h4>
        <p>
          {succeeded
            ? `${outcome.preservedStepIds.length} stored steps retained. This update did not verify the current code.`
            : "This optional context update is not required to audit, resume, or report this phase."}
        </p>
        {outcome && !succeeded && (
          <p className="notes-phase-reconciliation-error" role="alert">
            Reconciliation denied: {outcome.status}.
          </p>
        )}
        {transportError && (
          <p className="notes-phase-reconciliation-error" role="alert">
            {transportError}
          </p>
        )}
        {historicalReconciliation && unavailable && (
          <p className="notes-phase-reconciliation-error" role="alert">
            This optional update is unavailable without a saved workspace snapshot.
          </p>
        )}
      </div>
      {historicalReconciliation && (
        <button
          type="button"
          className="notes-roadmap-primary"
          disabled={pending || unavailable}
          onClick={() => void reconcile()}
        >
          {pending ? "Reconciling…" : "Reconcile"}
        </button>
      )}
    </section>
  );
}

function latestReconciliationWorkspace(phase: NotesPhase): ReconciliationWorkspace | null {
  const execution = phase.execution;
  if (!execution) return null;
  const candidates = [
    ...(execution.plan?.steps.flatMap((step) =>
      step.workspace && step.completedAt
        ? [{ timestamp: step.completedAt, workspace: step.workspace }]
        : [],
    ) ?? []),
    ...execution.evidence.map((evidence) => ({
      timestamp: evidence.observedAt,
      workspace: evidence.workspace,
    })),
    ...(execution.pendingCompletion
      ? [{ timestamp: phase.updatedAt, workspace: execution.pendingCompletion.workspace }]
      : []),
  ];
  candidates.sort((left, right) => left.timestamp.localeCompare(right.timestamp));
  return candidates[candidates.length - 1]?.workspace ?? null;
}
