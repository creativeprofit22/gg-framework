import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { NotesPhase } from "../notes-types";

/**
 * Single owner for Roadmap phase navigation: which phase is selected, where the list
 * was scrolled when it was selected, and which control keyboard focus returns to.
 *
 * Presentation stays in NotesRoadmap/NotesPhaseDetail and mutation authority stays in
 * the existing controllers; this hook only knows about selection and return context.
 * Modeled on the selection/focus handling in NotesReferences.tsx.
 */
export interface RoadmapPhaseNavigationOptions {
  /** Phases currently rendered in the list, in display order. */
  phases: NotesPhase[];
  initialSelectedPhaseId?: string | null;
  /**
   * Monotonic token identifying an incoming navigation request. When it changes after
   * mount, `initialSelectedPhaseId` is treated as a request to select that phase rather
   * than a mount-time default.
   */
  selectionRequest?: number;
  /** Called once when the selected phase disappears (deleted, archived, project switch). */
  onSelectionMissing?(): void;
}

export interface RoadmapPhaseNavigation {
  selectedId: string | null;
  selectedPhase: NotesPhase | null;
  /** Attach to the Roadmap root so the scroll container can be resolved. */
  rootRef: React.RefObject<HTMLDivElement | null>;
  /**
   * Focus fallback when the originating phase title no longer exists. It may itself be
   * disabled during a mutation, in which case focus lands on the Roadmap heading instead.
   */
  fallbackRef: React.RefObject<HTMLButtonElement | null>;
  registerPhaseTitle(phaseId: string, element: HTMLButtonElement | null): void;
  selectPhase(phaseId: string): void;
  togglePhase(phaseId: string): void;
  closeDetail(): void;
  /** Clear selection and send focus to a specific surviving phase (or the fallback). */
  clearSelection(focusPhaseId: string | null): void;
  /** Request focus without changing selection (used by the create form). */
  focusAfterDetail(phaseId: string | null): void;
}

/**
 * `HTMLElement.focus()` on a disabled or detached control is a silent no-op, so a focus
 * request has to resolve to a control that can actually accept focus. Phase titles and the
 * New phase button are both disabled while a phase mutation is in flight, which is exactly
 * when a phase disappears.
 */
function canAcceptFocus(element: HTMLElement | null | undefined): element is HTMLElement {
  if (!element || !element.isConnected) return false;
  if ((element as Partial<HTMLButtonElement>).disabled === true) return false;
  return element.closest("[hidden], [inert]") === null;
}

interface FocusRequest {
  phaseId: string | null;
  scrollTop: number | null;
}

export function useRoadmapPhaseNavigation({
  phases,
  initialSelectedPhaseId = null,
  selectionRequest = 0,
  onSelectionMissing,
}: RoadmapPhaseNavigationOptions): RoadmapPhaseNavigation {
  const [selectedId, setSelectedId] = useState<string | null>(initialSelectedPhaseId);
  const [focusRequest, setFocusRequest] = useState<FocusRequest | null>(null);
  const phaseTitleRefs = useRef(new Map<string, HTMLButtonElement>());
  const fallbackRef = useRef<HTMLButtonElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const returnScrollTop = useRef<number | null>(null);
  const missingHandler = useRef(onSelectionMissing);

  const handledRequest = useRef(selectionRequest);

  const selectedPhase = phases.find((phase) => phase.id === selectedId) ?? null;

  const scrollContainer = useCallback(
    (): HTMLElement | null => rootRef.current?.closest<HTMLElement>(".notes-panel") ?? null,
    [],
  );

  const requestFocus = useCallback((phaseId: string | null, scrollTop: number | null): void => {
    // A fresh object identity is what re-runs the focus effect, including repeated
    // requests for the same phase.
    setFocusRequest({ phaseId, scrollTop });
  }, []);

  const focusAfterDetail = useCallback(
    (phaseId: string | null): void => requestFocus(phaseId, null),
    [requestFocus],
  );

  useLayoutEffect(() => {
    if (!focusRequest) return;
    const title = focusRequest.phaseId
      ? phaseTitleRefs.current.get(focusRequest.phaseId)
      : undefined;
    // Last resort: the Roadmap heading is never disabled, so the user lands inside the
    // Roadmap rather than on document.body when every control is guarded.
    const lastResort =
      rootRef.current?.querySelector<HTMLElement>("[data-roadmap-focus-last-resort]") ?? null;
    const target = [title, fallbackRef.current, lastResort].find(canAcceptFocus) ?? null;
    target?.focus({ preventScroll: true });
    if (focusRequest.scrollTop !== null) {
      const container = scrollContainer();
      if (container) container.scrollTop = focusRequest.scrollTop;
    }
  }, [focusRequest, scrollContainer]);

  // Callers pass a new inline callback on every render, so the handler is kept in a ref
  // instead of in the missing-selection effect's deps (which would re-announce). The
  // assignment has to commit — a ref written during render can come from a discarded
  // render pass — and this effect must stay above the reader below so the ref is current
  // on the same commit.
  useEffect(() => {
    missingHandler.current = onSelectionMissing;
  }, [onSelectionMissing]);

  useEffect(() => {
    if (selectedId === null || selectedPhase) return;
    const active = document.activeElement;
    const focusLost =
      !(active instanceof HTMLElement) || !active.isConnected || active === document.body;
    const scrollTop = returnScrollTop.current;
    returnScrollTop.current = null;
    setSelectedId(null);
    missingHandler.current?.();
    if (focusLost) requestFocus(null, scrollTop);
  }, [requestFocus, selectedId, selectedPhase]);

  const registerPhaseTitle = useCallback((phaseId: string, element: HTMLButtonElement | null) => {
    if (element) phaseTitleRefs.current.set(phaseId, element);
    else phaseTitleRefs.current.delete(phaseId);
  }, []);

  const selectPhase = useCallback(
    (phaseId: string): void => {
      returnScrollTop.current = scrollContainer()?.scrollTop ?? null;
      setSelectedId(phaseId);
    },
    [scrollContainer],
  );

  // A later request (reminder navigation while the Roadmap is already mounted) selects the
  // requested phase through the same path as a click, so scroll capture and the existing
  // missing-selection recovery both still apply.
  useEffect(() => {
    if (selectionRequest === handledRequest.current) return;
    handledRequest.current = selectionRequest;
    if (!initialSelectedPhaseId) return;
    selectPhase(initialSelectedPhaseId);
  }, [initialSelectedPhaseId, selectPhase, selectionRequest]);

  const closeDetail = useCallback((): void => {
    const phaseId = selectedId;
    const scrollTop = returnScrollTop.current;
    returnScrollTop.current = null;
    setSelectedId(null);
    requestFocus(phaseId, scrollTop);
  }, [requestFocus, selectedId]);

  const togglePhase = useCallback(
    (phaseId: string): void => {
      if (phaseId === selectedId) {
        closeDetail();
        return;
      }
      selectPhase(phaseId);
    },
    [closeDetail, selectPhase, selectedId],
  );

  const clearSelection = useCallback(
    (focusPhaseId: string | null): void => {
      const scrollTop = returnScrollTop.current;
      returnScrollTop.current = null;
      setSelectedId(null);
      requestFocus(focusPhaseId, scrollTop);
    },
    [requestFocus],
  );

  return {
    selectedId,
    selectedPhase,
    rootRef,
    fallbackRef,
    registerPhaseTitle,
    selectPhase,
    togglePhase,
    closeDetail,
    clearSelection,
    focusAfterDetail,
  };
}
