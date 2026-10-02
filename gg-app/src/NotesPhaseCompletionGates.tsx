import type { ReactElement } from "react";
import type {
  NotesCompletionUnmetGateCode,
  NotesPhase,
  NotesRoadmapStatusUpdate,
} from "./notes-types";

export type NotesCompletionGateTone = "neutral" | "positive" | "warning" | "negative" | "protected";
type Summary = { label: string; detail: string | null; tone: NotesCompletionGateTone };
export interface NotesCompletionGateOverview {
  implementation: Summary;
  verification: Summary;
  settlement: Summary;
  outcome: string;
  blocker: string | null;
  tone: NotesCompletionGateTone;
}

function latestReport(phase: NotesPhase): NotesRoadmapStatusUpdate | undefined {
  return [...phase.roadmapEvents]
    .reverse()
    .find((event): event is NotesRoadmapStatusUpdate => event.type === "status-update");
}

export function notesCompletionGateOverview(phase: NotesPhase): NotesCompletionGateOverview {
  const report = latestReport(phase);
  const tone: NotesCompletionGateTone = phase.status === "done" ? "positive" : "neutral";
  const status = phase.status === "done" ? "Done" : phase.status.replace(/-/g, " ");
  const blocker =
    phase.status === "needs-attention" || phase.status === "waiting-for-approval"
      ? phase.attentionReason
      : null;
  return {
    implementation: {
      label: "Progress",
      detail: report?.progress ?? "No progress report yet",
      tone: "neutral",
    },
    verification: {
      label: report?.verification
        ? `Reported ${report.verification.replace(/-/g, " ")}`
        : "Not reported",
      detail: report?.verificationReason ?? null,
      tone: report?.verification === "failed" ? "negative" : "neutral",
    },
    settlement: {
      label: status,
      detail: "Explicit status; historical evidence was not rechecked.",
      tone,
    },
    outcome: status,
    blocker: phase.overrides.status !== null ? "User-selected status is protected." : blocker,
    tone: phase.overrides.status !== null ? "protected" : tone,
  };
}

export function NotesPhaseCompletionGates({ phase }: { phase: NotesPhase }): ReactElement {
  const overview = notesCompletionGateOverview(phase);
  const report = latestReport(phase);
  return (
    <section
      className="notes-completion-gates"
      aria-labelledby={`notes-completion-gates-${phase.id}`}
    >
      <h4 id={`notes-completion-gates-${phase.id}`}>Status and last report</h4>
      <p>{overview.outcome}</p>
      {overview.blocker && <p>{overview.blocker}</p>}
      {report ? (
        <>
          <p>{report.progress}</p>
          <p>{overview.verification.label}</p>
          {report.verificationReason && <p>{report.verificationReason}</p>}
          <ul>
            {report.evidence.map((item, index) => (
              <li key={`${report.id}-${index}`}>{item}</li>
            ))}
          </ul>
          <p>
            Reported{" "}
            <time dateTime={report.timestamp}>{new Date(report.timestamp).toLocaleString()}</time>;
            not rechecked on opening.
          </p>
        </>
      ) : (
        <p>No progress report yet.</p>
      )}
      {!!phase.execution?.evidence.length && (
        <details>
          <summary>Historical command reports</summary>
          <p>These stored outcomes were not rechecked on opening.</p>
          <ul>
            {phase.execution.evidence.map((evidence, index) => (
              <li key={`${evidence.commandHash}-${index}`}>
                <code>{evidence.commandDisplay}</code> — recorded exit {evidence.exitCode}
                {" at "}
                <time dateTime={evidence.observedAt}>
                  {new Date(evidence.observedAt).toLocaleString()}
                </time>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

/** Decode old gate codes for the history view only; these do not gate status updates. */
export function completionGateRecovery(code: NotesCompletionUnmetGateCode): string {
  return `Historical completion policy: ${code.replace(/-/g, " ")}.`;
}
