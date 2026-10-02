import { useRef, type KeyboardEvent, type ReactElement } from "react";

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

export function NotesPhaseViewNavigation({
  phaseId,
  phaseTitle,
  activeView,
  setActiveView,
}: NotesPhaseViewNavigationProps): ReactElement {
  const viewTabRefs = useRef<Record<PhaseView, HTMLButtonElement | null>>({
    overview: null,
    completion: null,
    references: null,
    activity: null,
    more: null,
  });

  const selectViewFromKeyboard = (
    event: KeyboardEvent<HTMLButtonElement>,
    view: PhaseView,
  ): void => {
    const currentIndex = PHASE_VIEWS.findIndex((candidate) => candidate.id === view);
    const pressedKey = event.key;
    let nextIndex: number | null = null;
    if (pressedKey === "ArrowRight") nextIndex = (currentIndex + 1) % PHASE_VIEWS.length;
    if (pressedKey === "ArrowLeft") {
      nextIndex = (currentIndex - 1 + PHASE_VIEWS.length) % PHASE_VIEWS.length;
    }
    if (pressedKey === "Home") nextIndex = 0;
    if (pressedKey === "End") nextIndex = PHASE_VIEWS.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    const nextView = PHASE_VIEWS[nextIndex]!.id;
    setActiveView(nextView);
    viewTabRefs.current[nextView]?.focus();
  };

  return (
    <>
      <div className="notes-phase-views" role="tablist" aria-label={`${phaseTitle} views`}>
        {PHASE_VIEWS.map((view) => (
          <button
            key /* Stable roving-focus tab identity. */={view.id}
            ref={(element) => {
              viewTabRefs.current[view.id] = element;
            }}
            id={`notes-phase-view-tab-${phaseId}-${view.id}`}
            type="button"
            role="tab"
            aria-controls={`notes-phase-view-panel-${phaseId}-${view.id}`}
            aria-selected={activeView === view.id}
            tabIndex={activeView === view.id ? 0 : -1}
            onClick={(event) => {
              setActiveView(view.id);
              event.currentTarget.focus();
            }}
            onKeyDown={(event) => selectViewFromKeyboard(event, view.id)}
          >
            {view.label}
          </button>
        ))}
      </div>
      <div className="notes-phase-view-select">
        <label htmlFor={`notes-phase-view-select-${phaseId}`}>Phase view</label>
        <select
          id={`notes-phase-view-select-${phaseId}`}
          value={activeView}
          onChange={(event) => setActiveView(event.currentTarget.value as PhaseView)}
        >
          {PHASE_VIEWS.map((view) => (
            <option key /* Stable native-option identity. */={view.id} value={view.id}>
              {view.label}
            </option>
          ))}
        </select>
      </div>
    </>
  );
}
