import { roadmapProgressLabel, selectNotesRoadmapProgress } from "./notes-status";
import type { NotesPhase } from "./notes-types";
import { basename } from "./tool-format";

/**
 * Supporting header line for the Notes modal: which project, and how far along
 * its Roadmap is. Progress comes only from the shared selector (one linear pass).
 * The folder name is never truncated (it wraps), so the visible text and the
 * dialog's accessible description both carry the full name; the full path is
 * the tooltip. Returns null when there is nothing to say, so Modal keeps its
 * plain title-only header.
 */
export function notesModalDescription(
  projectPath: string | null,
  phases: readonly NotesPhase[],
): React.ReactElement | null {
  const progress = roadmapProgressLabel(selectNotesRoadmapProgress(phases));
  const projectName = projectPath ? basename(projectPath) : "";
  if (!projectName && !progress) return null;
  return (
    <span className="notes-modal-meta">
      {projectName ? (
        <>
          {/* Sibling, not child: the visible name stays a text-only leaf. */}
          <span className="sr-only">Project: </span>
          <span className="notes-modal-project" title={projectPath ?? undefined}>
            {projectName}
          </span>
        </>
      ) : null}
      {projectName && progress ? (
        // No-break space before the dot: a wrap never starts a line with "·".
        <span className="notes-modal-meta-separator" aria-hidden="true">
          {"\u00a0· "}
        </span>
      ) : null}
      {progress ? <span className="notes-modal-progress">{progress}</span> : null}
    </span>
  );
}
