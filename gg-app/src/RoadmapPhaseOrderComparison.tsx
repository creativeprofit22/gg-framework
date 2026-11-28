import type {
  RoadmapPhaseOrderEntry,
  RoadmapPhaseOrderPreview,
} from "@kenkaiiii/gg-core/roadmap-workflow";

interface RoadmapPhaseOrderComparisonProps {
  preview: RoadmapPhaseOrderPreview;
  /** Phases to tag in the After list: the moved phase or the inserted phases. */
  highlightedPhaseIds: ReadonlySet<string>;
  highlightLabel: "Moved" | "New";
}

function OrderList({
  entries,
  highlightedPhaseIds,
  highlightLabel,
}: {
  entries: readonly RoadmapPhaseOrderEntry[];
  highlightedPhaseIds: ReadonlySet<string> | null;
  highlightLabel: string;
}) {
  if (entries.length === 0) return <span className="roadmap-edit-empty">No phases</span>;
  return (
    <ol className="roadmap-order-list">
      {entries.map((entry) => {
        const highlighted = highlightedPhaseIds?.has(entry.phaseId) ?? false;
        return (
          <li key={entry.phaseId} className={highlighted ? "is-changed" : undefined}>
            <span>{entry.title}</span>
            {highlighted && <span className="roadmap-edit-tag">{highlightLabel}</span>}
          </li>
        );
      })}
    </ol>
  );
}

/** Before → After Roadmap order for an approval card; Before stacks above After. */
export function RoadmapPhaseOrderComparison({
  preview,
  highlightedPhaseIds,
  highlightLabel,
}: RoadmapPhaseOrderComparisonProps) {
  return (
    <section className="roadmap-edit-field roadmap-order-comparison" aria-label="Roadmap order">
      <h4>Roadmap order</h4>
      <div className="roadmap-edit-value is-before">
        <span className="roadmap-edit-value-label">Before</span>
        <OrderList entries={preview.before} highlightedPhaseIds={null} highlightLabel="" />
      </div>
      <div className="roadmap-edit-value is-after">
        <span className="roadmap-edit-value-label">After</span>
        <OrderList
          entries={preview.after}
          highlightedPhaseIds={highlightedPhaseIds}
          highlightLabel={highlightLabel}
        />
      </div>
    </section>
  );
}
