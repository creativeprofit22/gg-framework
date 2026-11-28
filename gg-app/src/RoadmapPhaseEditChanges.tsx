import { RoadmapDependencyList } from "./RoadmapDependencyList";
import type {
  RoadmapDependencyPhaseEntry,
  RoadmapPhaseFieldChange,
} from "@kenkaiiii/gg-core/roadmap-workflow";

const FIELD_LABELS: Record<RoadmapPhaseFieldChange["field"], string> = {
  title: "Title",
  goal: "Goal",
  doneWhen: "Done when",
  sourcePrompt: "Saved phase prompt",
  dependsOn: "Depends on",
};

function EmptyValue() {
  return <span className="roadmap-edit-empty">Empty</span>;
}

function TextValue({ value, prompt }: { value: string; prompt: boolean }) {
  if (value.length === 0) return <EmptyValue />;
  return <p className={prompt ? "roadmap-edit-text is-prompt" : "roadmap-edit-text"}>{value}</p>;
}

function CriteriaValue({
  items,
  other,
  tag,
}: {
  items: readonly string[];
  other: readonly string[];
  tag: "Added" | "Removed";
}) {
  if (items.length === 0) return <EmptyValue />;
  const otherItems = new Set(other);
  return (
    <ul className="roadmap-edit-criteria">
      {items.map((item, index) => (
        <li key={`${index}:${item}`}>
          <span>{item}</span>
          {!otherItems.has(item) && <span className="roadmap-edit-tag">{tag}</span>}
        </li>
      ))}
    </ul>
  );
}

function ChangeValues({
  change,
  side,
  dependencyPhases,
}: {
  change: RoadmapPhaseFieldChange;
  side: "before" | "after";
  dependencyPhases: readonly RoadmapDependencyPhaseEntry[] | undefined;
}) {
  if (change.field === "dependsOn") {
    const items = change[side];
    if (items.length === 0) return <EmptyValue />;
    return (
      <RoadmapDependencyList
        phaseIds={items}
        knownPhases={dependencyPhases}
        compareWith={side === "before" ? change.after : change.before}
        changeTag={side === "before" ? "Removed" : "Added"}
      />
    );
  }
  if (change.field === "doneWhen") {
    return side === "before" ? (
      <CriteriaValue items={change.before} other={change.after} tag="Removed" />
    ) : (
      <CriteriaValue items={change.after} other={change.before} tag="Added" />
    );
  }
  return <TextValue value={change[side]} prompt={change.field === "sourcePrompt"} />;
}

/** One phase's changed fields as labelled Before → After blocks, shared by single and batch edits. */
export function RoadmapPhaseEditChanges({
  headingId,
  phaseTitle,
  changes,
  dependencyPhases,
  listLabel,
}: {
  headingId: string;
  phaseTitle: string;
  changes: readonly RoadmapPhaseFieldChange[];
  dependencyPhases: readonly RoadmapDependencyPhaseEntry[] | undefined;
  /** Accessible name of the field list; batches name each phase so the lists stay distinct. */
  listLabel: string;
}) {
  return (
    <article className="roadmap-edit-phase" aria-labelledby={headingId}>
      <h3 id={headingId}>{phaseTitle}</h3>
      <ul className="roadmap-edit-changes" aria-label={listLabel}>
        {changes.map((change) => (
          <li className="roadmap-edit-field" key={change.field}>
            <h4>{FIELD_LABELS[change.field]}</h4>
            <div className="roadmap-edit-value is-before">
              <span className="roadmap-edit-value-label">Before</span>
              <ChangeValues change={change} side="before" dependencyPhases={dependencyPhases} />
            </div>
            <div className="roadmap-edit-value is-after">
              <span className="roadmap-edit-value-label">After</span>
              <ChangeValues change={change} side="after" dependencyPhases={dependencyPhases} />
            </div>
          </li>
        ))}
      </ul>
    </article>
  );
}
