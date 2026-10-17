import type { ReactElement } from "react";
import { referenceRepositoryLabel, referenceSourceLabel } from "../notes-reference";
import { useNotesPhaseDetail } from "./NotesPhaseDetailState";
import { formatDateTime, roadmapActorLabel, roadmapProposalLabel } from "./roadmap-presentation";

export function NotesPhaseReferencesView(): ReactElement {
  const {
    phase,
    references,
    pendingProposals,
    pendingRoadmapAction,
    openingSourceKey,
    controlsDisabled,
    onLinkReference,
    onUnlinkReference,
    onCreateReference,
    acceptReferenceProposal,
    rejectReferenceProposal,
    resumeAutomaticReferences,
    openReferenceSource,
  } = useNotesPhaseDetail();

  return (
    <>
      {pendingProposals.length > 0 && (
        <section
          className="notes-roadmap-proposals"
          aria-labelledby={`notes-roadmap-proposals-${phase.id}`}
        >
          <h4 id={`notes-roadmap-proposals-${phase.id}`}>Suggested references</h4>
          <ul>
            {pendingProposals.map(({ proposal, report }) => {
              const proposalPending = pendingRoadmapAction === `proposal:${proposal.id}`;
              const sourceKey = `proposal:${proposal.id}`;
              const sourceOpening = openingSourceKey === sourceKey;
              return (
                <li key /* Stable proposal identity. */={proposal.id}>
                  <div>
                    <strong>{roadmapProposalLabel(proposal)}</strong>
                    <small>
                      {proposal.owner}/{proposal.repo} · {roadmapActorLabel(report.actor)} ·{" "}
                      <time dateTime={report.timestamp}>{formatDateTime(report.timestamp)}</time>
                    </small>
                    <span>{proposal.canonicalUrl}</span>
                    <p>{proposal.relevance || "No relevance note."}</p>
                  </div>
                  <div className="notes-roadmap-proposal-actions">
                    <button
                      type="button"
                      disabled={controlsDisabled || openingSourceKey !== null}
                      onClick={() =>
                        openReferenceSource(
                          sourceKey,
                          proposal.canonicalUrl,
                          roadmapProposalLabel(proposal),
                        )
                      }
                    >
                      {sourceOpening ? "Opening…" : "Open source"}
                    </button>
                    <button
                      type="button"
                      disabled={controlsDisabled}
                      onClick={() => acceptReferenceProposal(proposal.id)}
                    >
                      {proposalPending ? "Saving…" : "Accept"}
                    </button>
                    <button
                      type="button"
                      disabled={controlsDisabled}
                      onClick={() => rejectReferenceProposal(proposal.id)}
                    >
                      Reject
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <section
        className="notes-phase-references"
        aria-labelledby={`notes-phase-references-${phase.id}`}
      >
        <div className="notes-phase-references-heading">
          <div>
            <h4 id={`notes-phase-references-${phase.id}`}>Attached references</h4>
            <p>
              {phase.referenceIds.length === 1
                ? "1 source attached"
                : `${phase.referenceIds.length} sources attached`}
            </p>
          </div>
          {phase.overrides.referenceIds && (
            <button type="button" disabled={controlsDisabled} onClick={resumeAutomaticReferences}>
              {pendingRoadmapAction === "resume-references"
                ? "Resuming…"
                : "Resume automatic references"}
            </button>
          )}
        </div>
        {references.length === 0 ? (
          <div className="notes-phase-references-empty">
            <p>Create a structured reference before attaching source context.</p>
            <button type="button" disabled={controlsDisabled} onClick={onCreateReference}>
              Create a reference
            </button>
          </div>
        ) : (
          <ul className="notes-phase-reference-options">
            {references.map((reference) => {
              const checked = phase.referenceIds.includes(reference.id);
              const sourceKey = `reference:${reference.id}`;
              const sourceOpening = openingSourceKey === sourceKey;
              return (
                <li
                  key /* Stable reference identity. */={reference.id}
                  className={checked ? "is-attached" : undefined}
                >
                  <div className="notes-phase-reference-option">
                    <label>
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={controlsDisabled}
                        onChange={(event) => {
                          if (event.target.checked) onLinkReference(reference.id);
                          else onUnlinkReference(reference.id);
                        }}
                      />
                      <span>
                        <strong>{referenceSourceLabel(reference)}</strong>
                        <small>{referenceRepositoryLabel(reference)}</small>
                        <span>{reference.relevance || "No relevance note."}</span>
                      </span>
                    </label>
                    {checked && (
                      <button
                        type="button"
                        disabled={controlsDisabled || openingSourceKey !== null}
                        onClick={() =>
                          openReferenceSource(
                            sourceKey,
                            reference.canonicalUrl,
                            referenceSourceLabel(reference),
                          )
                        }
                      >
                        {sourceOpening ? "Opening…" : "Open source"}
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </>
  );
}
