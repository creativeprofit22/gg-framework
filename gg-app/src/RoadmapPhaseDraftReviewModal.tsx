import { Check, ExternalLink, FileText, GitBranch, ListChecks, X } from "lucide-react";
import type { RoadmapPhaseDraft } from "@kenkaiiii/gg-core/roadmap-workflow";
import { Modal } from "./Modal";
import { openReferenceUrl } from "./notes-open-source";

interface RoadmapPhaseDraftReviewModalProps {
  draft: RoadmapPhaseDraft | null;
  open: boolean;
  decision: "idle" | "approving" | "rejecting";
  error: string | null;
  announcement: string;
  onClose: () => void;
  onApprove: () => void;
  onReject: () => void;
}

export function RoadmapPhaseDraftReviewModal({
  draft,
  open,
  decision,
  error,
  announcement,
  onClose,
  onApprove,
  onReject,
}: RoadmapPhaseDraftReviewModalProps) {
  if (!draft || !open) return null;
  const deciding = decision !== "idle";
  const stale = draft.status === "stale";
  const references = draft.references ?? [];
  const referenceIdsForPhase = (phase: (typeof draft.phases)[number]): string[] =>
    phase.referenceIds ?? [];
  const referencesById = new Map(references.map((reference) => [reference.id, reference]));
  const malformedLinks = draft.phases.some((phase) =>
    referenceIdsForPhase(phase).some((referenceId) => !referencesById.has(referenceId)),
  );

  return (
    <Modal onClose={onClose} title="Review Roadmap draft" className="roadmap-draft-modal">
      <div className="roadmap-draft-review">
        <div className="roadmap-draft-intro">
          <div className="roadmap-draft-kicker">
            <GitBranch size={14} aria-hidden="true" />
            Proposed from Project Notes revision {draft.basedOnRevision}
          </div>
          <p>{draft.summary}</p>
          <div className="roadmap-draft-count">
            {draft.phases.length} peer {draft.phases.length === 1 ? "phase" : "phases"} ·{" "}
            {references.length} {references.length === 1 ? "reference" : "references"} · Nothing is
            created until you approve
          </div>
        </div>

        {stale && (
          <div className="roadmap-draft-stale" role="alert">
            <strong>This draft is out of date.</strong>
            <span>Ask GG Coder to inspect Project Notes and prepare a fresh draft.</span>
          </div>
        )}

        <ol className="roadmap-draft-phase-list" aria-label="Proposed Roadmap phases">
          {draft.phases.map((phase, index) => (
            <li className="roadmap-draft-phase" key={phase.phaseId}>
              <div className="roadmap-draft-phase-index" aria-hidden="true">
                {String(index + 1).padStart(2, "0")}
              </div>
              <div className="roadmap-draft-phase-content">
                <h3>{phase.title}</h3>
                <p className="roadmap-draft-goal">{phase.goal}</p>
                <div className="roadmap-draft-criteria-heading">
                  <ListChecks size={14} aria-hidden="true" />
                  Completion criteria
                </div>
                <ul className="roadmap-draft-criteria">
                  {phase.doneWhen.map((criterion) => (
                    <li key={criterion}>{criterion}</li>
                  ))}
                </ul>
                {referenceIdsForPhase(phase).length > 0 && (
                  <div className="roadmap-draft-references">
                    <div className="roadmap-draft-criteria-heading">
                      <ExternalLink size={14} aria-hidden="true" />
                      Reviewed sources
                    </div>
                    <ul>
                      {referenceIdsForPhase(phase).map((referenceId) => {
                        const reference = referencesById.get(referenceId);
                        if (!reference) {
                          return (
                            <li className="roadmap-draft-reference-unavailable" key={referenceId}>
                              Source details unavailable
                            </li>
                          );
                        }
                        const location = reference.path
                          ? `${reference.path}${
                              reference.range
                                ? `:${reference.range.startLine}-${reference.range.endLine}`
                                : ""
                            }`
                          : null;
                        return (
                          <li key={reference.id}>
                            <div className="roadmap-draft-reference-heading">
                              <strong>{reference.provider}</strong>
                              <span>
                                {reference.owner}/{reference.repo}
                              </span>
                            </div>
                            {location && <code>{location}</code>}
                            <p>{reference.relevance}</p>
                            <button
                              type="button"
                              className="roadmap-draft-open-source"
                              onClick={() => void openReferenceUrl(reference.canonicalUrl)}
                            >
                              Open source
                              <ExternalLink size={12} aria-hidden="true" />
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                )}
                <details className="roadmap-draft-source">
                  <summary>
                    <FileText size={13} aria-hidden="true" />
                    Saved phase prompt
                  </summary>
                  <p>{phase.sourcePrompt}</p>
                </details>
              </div>
            </li>
          ))}
        </ol>

        {malformedLinks && (
          <div className="roadmap-draft-error" role="alert">
            One or more reviewed sources are unavailable. Ask GG Coder for a fresh draft before
            approving.
          </div>
        )}
        {error && (
          <div className="roadmap-draft-error" role="alert">
            {error}
          </div>
        )}
        <div className="roadmap-draft-actions">
          <button
            type="button"
            className="modal-btn roadmap-draft-reject"
            onClick={onReject}
            disabled={deciding}
          >
            <X size={15} aria-hidden="true" />
            {decision === "rejecting" ? "Rejecting…" : "Reject draft"}
          </button>
          <button
            type="button"
            className="modal-btn primary roadmap-draft-create"
            onClick={onApprove}
            disabled={deciding || stale || malformedLinks}
            data-modal-initial-focus
          >
            <Check size={15} aria-hidden="true" />
            {decision === "approving"
              ? "Creating phases…"
              : references.length > 0
                ? "Create phases with references"
                : `Create ${draft.phases.length === 1 ? "phase" : "phases"}`}
          </button>
        </div>
        <div className="visually-hidden" aria-live="polite" aria-atomic="true">
          {announcement}
        </div>
      </div>
    </Modal>
  );
}
