import type { ReactElement } from "react";
import { NotesTabList } from "../NotesTabList";

export const PHASE_VIEWS = [
  { id: "overview", label: "Overview" },
  { id: "completion", label: "Completion" },
  { id: "references", label: "References" },
  { id: "activity", label: "Activity" },
  { id: "more", label: "More" },
] as const;

export type PhaseView = (typeof PHASE_VIEWS)[number]["id"];

interface NotesPhaseViewNavigationProps {
  phaseId: string;
  phaseTitle: string;
  activeView: PhaseView;
  setActiveView(view: PhaseView): void;
}

/** Phase sub-views as one scrollable tablist at every width. */
export function NotesPhaseViewNavigation({
  phaseId,
  phaseTitle,
  activeView,
  setActiveView,
}: NotesPhaseViewNavigationProps): ReactElement {
  return (
    <NotesTabList
      label={`${phaseTitle} views`}
      tabs={PHASE_VIEWS}
      activeId={activeView}
      onSelect={setActiveView}
      tabId={(view) => `notes-phase-view-tab-${phaseId}-${view}`}
      panelId={(view) => `notes-phase-view-panel-${phaseId}-${view}`}
      className="notes-phase-views"
      scrollClassName="notes-phase-views-scroll"
    />
  );
}
