import type { RoadmapDependencyPhaseEntry } from "@kenkaiiii/gg-core/roadmap-workflow";

interface DraftSibling {
  phaseId: string;
  title: string;
}

interface RoadmapDependencyListProps {
  phaseIds: readonly string[];
  knownPhases?: readonly RoadmapDependencyPhaseEntry[];
  draftPhases?: readonly DraftSibling[];
  /** With `changeTag`, items absent from this list get the tag (edit before/after). */
  compareWith?: readonly string[];
  changeTag?: "Added" | "Removed";
  label?: string;
}

const SHORT_ID_LENGTH = 8;

function describeDependency(
  phaseId: string,
  knownPhases: readonly RoadmapDependencyPhaseEntry[],
  draftPhases: readonly DraftSibling[],
): { title: string; isNew: boolean; missing: boolean } {
  const sibling = draftPhases.find((phase) => phase.phaseId === phaseId);
  if (sibling) return { title: sibling.title, isNew: true, missing: false };
  const known = knownPhases.find((phase) => phase.phaseId === phaseId);
  if (known) {
    return {
      title: known.archived ? `${known.title} (archived)` : known.title,
      isNew: false,
      missing: false,
    };
  }
  return { title: "Missing phase", isNew: false, missing: true };
}

export function RoadmapDependencyList({
  phaseIds,
  knownPhases = [],
  draftPhases = [],
  compareWith,
  changeTag,
  label,
}: RoadmapDependencyListProps) {
  const other = new Set(compareWith ?? []);
  return (
    <ul className="roadmap-edit-criteria roadmap-dependency-list" aria-label={label}>
      {phaseIds.map((phaseId) => {
        const dependency = describeDependency(phaseId, knownPhases, draftPhases);
        return (
          <li key={phaseId}>
            <span>
              {dependency.title}
              {dependency.missing && (
                <code className="roadmap-dependency-id" title={phaseId}>
                  {phaseId.slice(0, SHORT_ID_LENGTH)}
                </code>
              )}
            </span>
            {dependency.isNew && <span className="roadmap-edit-tag">New</span>}
            {changeTag && compareWith && !other.has(phaseId) && (
              <span className="roadmap-edit-tag">{changeTag}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
