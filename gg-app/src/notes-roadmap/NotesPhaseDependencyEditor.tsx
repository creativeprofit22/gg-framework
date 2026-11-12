import { useState, type ReactElement } from "react";
import { notesPhaseStatusLabel } from "../notes-lifecycle-presentation";
import type { NotesPhase } from "../notes-types";
import { dependencyCandidates, dependencyEntries } from "./roadmap-dependency-presentation";

interface Props {
  phases: readonly NotesPhase[];
  phaseId: string;
  dependsOn: readonly string[];
  /** The shared validation message for the drafted links; it blocks Save. */
  error: string | null;
  disabled: boolean;
  onChange(dependsOn: string[]): void;
}

export function NotesPhaseDependencyEditor({
  phases,
  phaseId,
  dependsOn,
  error,
  disabled,
  onChange,
}: Props): ReactElement {
  const [selected, setSelected] = useState("");
  const entries = dependencyEntries(phases, dependsOn);
  const candidates = dependencyCandidates(phases, phaseId, dependsOn);
  const selectId = `notes-phase-edit-dependency-${phaseId}`;
  const choice = candidates.some((candidate) => candidate.id === selected) ? selected : "";
  return (
    <fieldset className="notes-phase-dependency-editor" disabled={disabled}>
      <legend>Depends on</legend>
      {entries.length > 0 ? (
        <ul aria-label="Prerequisite phases">
          {entries.map((entry) => (
            <li key={entry.id}>
              <span>
                {entry.title}
                {entry.deleted
                  ? " (deleted)"
                  : entry.archived
                    ? " (archived)"
                    : entry.status && ` · ${notesPhaseStatusLabel(entry.status)}`}
              </span>
              <button
                type="button"
                className="notes-btn-quiet"
                aria-label={`Remove prerequisite: ${entry.title}`}
                onClick={() => onChange(dependsOn.filter((id) => id !== entry.id))}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="notes-phase-dependency-empty">No prerequisite phases.</p>
      )}
      <div className="notes-phase-dependency-add">
        <label htmlFor={selectId}>Add a prerequisite</label>
        <select
          id={selectId}
          value={choice}
          disabled={candidates.length === 0}
          onChange={(event) => setSelected(event.target.value)}
        >
          <option value="">
            {candidates.length === 0 ? "No phases to add" : "Choose a phase"}
          </option>
          {candidates.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.archivedAt !== null ? `${candidate.title} (archived)` : candidate.title}
            </option>
          ))}
        </select>
        <button
          type="button"
          disabled={choice === ""}
          onClick={() => {
            onChange([...dependsOn, choice]);
            setSelected("");
          }}
        >
          Add
        </button>
      </div>
      {error && (
        <p className="notes-phase-action-error" role="alert">
          {error}
        </p>
      )}
    </fieldset>
  );
}
