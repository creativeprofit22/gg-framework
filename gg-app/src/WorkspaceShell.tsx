import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { disposePaneSession, windowLabel } from "./agent";
import { type AgentPaneProps, type PaneInputActions, type PaneSnapshot } from "./AgentPane";
import { PANE_DRAG_MIME } from "./PaneDropOverlay";
import {
  focusWorkspacePane,
  loadWorkspaceLayout,
  MAX_WORKSPACE_PANES,
  moveWorkspacePane,
  removeWorkspacePane,
  saveWorkspaceLayout,
  splitWorkspacePane,
  updateWorkspaceSplitRatio,
  workspaceLayoutLeafIds,
  type PaneMoveRequest,
  type PanePlacement,
  type SplitDirection,
  type WorkspaceLayout,
  type WorkspaceLayoutPath,
  type WorkspacePaneId,
} from "./workspace-layout";
import { WorkspaceNode } from "./WorkspaceNode";

const KEYBOARD_RESIZE_STEP = 5;
const PANE_DRAG_INSTRUCTIONS_ID = "pane-rearrangement-instructions";

interface ActivePaneDrag {
  sourcePaneId: WorkspacePaneId;
  handle: HTMLButtonElement;
  generation: number;
}

function sameSnapshotTarget(
  descriptor: WorkspaceLayout["panes"][string],
  snapshot: PaneSnapshot,
): boolean {
  if (!snapshot.projectBound || !snapshot.cwd) return descriptor === null;
  return Boolean(
    descriptor &&
    descriptor.mode === snapshot.mode &&
    descriptor.chatAgent === snapshot.chatAgent &&
    descriptor.cwd === snapshot.cwd &&
    descriptor.sessionPath === snapshot.sessionPath,
  );
}

export interface WorkspaceShellProps {
  renderPane?: (props: AgentPaneProps) => React.ReactNode;
}

export function WorkspaceShell({ renderPane }: WorkspaceShellProps): React.ReactElement {
  const [layout, setLayout] = useState<WorkspaceLayout>(
    () => loadWorkspaceLayout(localStorage, windowLabel).layout,
  );
  const [snapshots, setSnapshots] = useState<Record<string, PaneSnapshot>>({});
  const [windowFocused, setWindowFocused] = useState(document.hasFocus());
  const [rearrangementEnabled, setRearrangementEnabled] = useState(false);
  const [activePaneDrag, setActivePaneDrag] = useState<ActivePaneDrag | null>(null);
  const [hoveredPaneDrop, setHoveredPaneDrop] = useState<{
    targetPaneId: WorkspacePaneId;
    placement: PanePlacement;
  } | null>(null);
  const [rearrangementAnnouncement, setRearrangementAnnouncement] = useState("");
  const inputActionsRef = useRef(new Map<string, PaneInputActions>());
  const layoutRef = useRef(layout);
  const activePaneDragRef = useRef<ActivePaneDrag | null>(null);
  const dragGenerationRef = useRef(0);
  const paneToFocusAfterMoveRef = useRef<WorkspacePaneId | null>(null);
  const leafIds = useMemo(() => workspaceLayoutLeafIds(layout.root), [layout.root]);

  useEffect(() => {
    layoutRef.current = layout;
  }, [layout]);

  const focusPaneDragHandle = useCallback((paneId: WorkspacePaneId): void => {
    requestAnimationFrame(() => {
      const handle = Array.from(
        document.querySelectorAll<HTMLButtonElement>("[data-pane-drag-handle]"),
      ).find((candidate) => candidate.dataset.paneDragHandle === paneId);
      handle?.focus();
    });
  }, []);

  const clearPaneDrag = useCallback((): ActivePaneDrag | null => {
    const active = activePaneDragRef.current;
    activePaneDragRef.current = null;
    setActivePaneDrag(null);
    setHoveredPaneDrop(null);
    return active;
  }, []);

  const cancelPaneDrag = useCallback(
    (announce = true): void => {
      const active = clearPaneDrag();
      if (!active) return;
      if (announce) setRearrangementAnnouncement("Pane move cancelled.");
      requestAnimationFrame(() => {
        if (active.handle.isConnected) active.handle.focus();
        else focusPaneDragHandle(active.sourcePaneId);
      });
    },
    [clearPaneDrag, focusPaneDragHandle],
  );

  useEffect(() => {
    const onFocus = (): void => setWindowFocused(true);
    const onBlur = (): void => {
      setWindowFocused(false);
      cancelPaneDrag();
    };
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
    };
  }, [cancelPaneDrag]);

  useEffect(() => {
    if (leafIds.some((paneId) => !snapshots[paneId]?.restoreChecked)) return;
    saveWorkspaceLayout(localStorage, windowLabel, layout);
  }, [layout, leafIds, snapshots]);

  useEffect(() => {
    requestAnimationFrame(() => {
      if (paneToFocusAfterMoveRef.current === layout.focusedPaneId) {
        paneToFocusAfterMoveRef.current = null;
        focusPaneDragHandle(layout.focusedPaneId);
        return;
      }
      inputActionsRef.current.get(layout.focusedPaneId)?.focus();
    });
  }, [focusPaneDragHandle, layout.focusedPaneId, leafIds]);

  const focusPane = useCallback((paneId: WorkspacePaneId): void => {
    const next = focusWorkspacePane(layoutRef.current, paneId);
    layoutRef.current = next;
    setLayout(next);
  }, []);

  const updateSnapshot = useCallback((snapshot: PaneSnapshot): void => {
    if (!workspaceLayoutLeafIds(layoutRef.current.root).includes(snapshot.paneId)) return;
    setSnapshots((previous) => ({ ...previous, [snapshot.paneId]: snapshot }));
    if (!snapshot.restoreChecked) return;
    setLayout((previous) => {
      const descriptor = previous.panes[snapshot.paneId];
      if (sameSnapshotTarget(descriptor, snapshot)) return previous;
      const next: WorkspaceLayout = {
        ...previous,
        panes: {
          ...previous.panes,
          [snapshot.paneId]:
            snapshot.projectBound && snapshot.cwd
              ? {
                  kind: "agent",
                  mode: snapshot.mode,
                  ...(snapshot.mode === "chat"
                    ? { chatAgent: snapshot.chatAgent ?? "general" }
                    : {}),
                  cwd: snapshot.cwd,
                  sessionPath: snapshot.sessionPath,
                }
              : null,
        },
      };
      layoutRef.current = next;
      return next;
    });
  }, []);

  const registerInput = useCallback((paneId: string, actions: PaneInputActions | null): void => {
    if (actions) inputActionsRef.current.set(paneId, actions);
    else inputActionsRef.current.delete(paneId);
  }, []);

  const startPaneDrag = useCallback(
    (paneId: WorkspacePaneId, handle: HTMLButtonElement): void => {
      if (!rearrangementEnabled || !workspaceLayoutLeafIds(layoutRef.current.root).includes(paneId))
        return;
      cancelPaneDrag(false);
      const active = {
        sourcePaneId: paneId,
        handle,
        generation: ++dragGenerationRef.current,
      };
      activePaneDragRef.current = active;
      setActivePaneDrag(active);
      setHoveredPaneDrop(null);
      setRearrangementAnnouncement(`Moving pane ${paneId}. Choose a direction.`);
    },
    [cancelPaneDrag, rearrangementEnabled],
  );

  const finishPaneDrag = useCallback(
    (paneId: WorkspacePaneId): void => {
      const active = activePaneDragRef.current;
      if (active?.sourcePaneId === paneId && active.generation === dragGenerationRef.current)
        cancelPaneDrag();
    },
    [cancelPaneDrag],
  );

  const hoverPaneDrop = useCallback(
    (targetPaneId: WorkspacePaneId, placement: PanePlacement | null): void => {
      const active = activePaneDragRef.current;
      if (!active || !placement || targetPaneId === active.sourcePaneId) {
        setHoveredPaneDrop(null);
        return;
      }
      if (!workspaceLayoutLeafIds(layoutRef.current.root).includes(targetPaneId)) {
        cancelPaneDrag();
        return;
      }
      setHoveredPaneDrop({ targetPaneId, placement });
    },
    [cancelPaneDrag],
  );

  const commitPaneDrop = useCallback(
    (request: PaneMoveRequest): void => {
      const active = activePaneDragRef.current;
      if (
        !active ||
        active.generation !== dragGenerationRef.current ||
        active.sourcePaneId !== request.sourcePaneId ||
        request.sourcePaneId === request.targetPaneId
      ) {
        cancelPaneDrag();
        return;
      }
      const previous = layoutRef.current;
      const visible = new Set(workspaceLayoutLeafIds(previous.root));
      if (!visible.has(request.sourcePaneId) || !visible.has(request.targetPaneId)) {
        cancelPaneDrag();
        return;
      }
      const next = moveWorkspacePane(previous, request);
      if (next === previous) {
        cancelPaneDrag();
        return;
      }
      clearPaneDrag();
      paneToFocusAfterMoveRef.current = request.sourcePaneId;
      layoutRef.current = next;
      setLayout(next);
      saveWorkspaceLayout(localStorage, windowLabel, next);
      setRearrangementAnnouncement(
        `Pane ${request.sourcePaneId} moved ${request.placement} of ${request.targetPaneId}.`,
      );
      focusPaneDragHandle(request.sourcePaneId);
    },
    [cancelPaneDrag, clearPaneDrag, focusPaneDragHandle],
  );

  const toggleRearrangement = useCallback((): void => {
    const next = !rearrangementEnabled;
    if (!next) cancelPaneDrag();
    setRearrangementEnabled(next);
    setRearrangementAnnouncement(
      next ? "Pane rearrangement enabled." : "Pane rearrangement disabled.",
    );
  }, [cancelPaneDrag, rearrangementEnabled]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && activePaneDragRef.current) {
        event.preventDefault();
        cancelPaneDrag();
        return;
      }
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
      const index = /^[1-4]$/.test(event.key) ? Number(event.key) - 1 : -1;
      const paneId = leafIds[index];
      if (!paneId) return;
      event.preventDefault();
      focusPane(paneId);
      inputActionsRef.current.get(paneId)?.focus();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [cancelPaneDrag, focusPane, leafIds]);

  useEffect(() => {
    const onPointerCancel = (): void => cancelPaneDrag();
    const onOutsideDrop = (event: DragEvent): void => {
      if (
        activePaneDragRef.current &&
        event.dataTransfer &&
        Array.from(event.dataTransfer.types ?? []).includes(PANE_DRAG_MIME)
      ) {
        event.preventDefault();
        cancelPaneDrag();
      }
    };
    window.addEventListener("pointercancel", onPointerCancel);
    window.addEventListener("drop", onOutsideDrop);
    return () => {
      window.removeEventListener("pointercancel", onPointerCancel);
      window.removeEventListener("drop", onOutsideDrop);
    };
  }, [cancelPaneDrag]);

  useEffect(() => {
    const active = activePaneDragRef.current;
    if (!active) return;
    const visible = new Set(leafIds);
    if (
      !visible.has(active.sourcePaneId) ||
      (hoveredPaneDrop && !visible.has(hoveredPaneDrop.targetPaneId))
    )
      cancelPaneDrag();
  }, [cancelPaneDrag, hoveredPaneDrop, leafIds]);

  useEffect(() => {
    if (leafIds.length > 1 || !rearrangementEnabled) return;
    cancelPaneDrag();
    setRearrangementEnabled(false);
    setRearrangementAnnouncement("Pane rearrangement disabled.");
  }, [cancelPaneDrag, leafIds.length, rearrangementEnabled]);

  const splitPane = useCallback((paneId: WorkspacePaneId, direction: SplitDirection): void => {
    const next = splitWorkspacePane(layoutRef.current, paneId, direction);
    layoutRef.current = next;
    setLayout(next);
  }, []);

  const closePane = useCallback(
    (paneId: WorkspacePaneId): void => {
      cancelPaneDrag(false);
      void disposePaneSession(paneId).catch(() => {});
      inputActionsRef.current.delete(paneId);
      setSnapshots((previous) => {
        const next = { ...previous };
        delete next[paneId];
        return next;
      });
      const next = removeWorkspacePane(layoutRef.current, paneId);
      layoutRef.current = next;
      setLayout(next);
      requestAnimationFrame(() => inputActionsRef.current.get(next.focusedPaneId)?.focus());
    },
    [cancelPaneDrag],
  );

  const resizeByKeyboard = useCallback(
    (
      event: React.KeyboardEvent<HTMLDivElement>,
      path: WorkspaceLayoutPath,
      direction: SplitDirection,
      ratio: number,
    ): void => {
      const negative = direction === "horizontal" ? "ArrowLeft" : "ArrowUp";
      const positive = direction === "horizontal" ? "ArrowRight" : "ArrowDown";
      let nextRatio: number | null = null;
      if (event.key === "Home") nextRatio = 10;
      else if (event.key === "End") nextRatio = 90;
      else if (event.key === negative) nextRatio = ratio - KEYBOARD_RESIZE_STEP;
      else if (event.key === positive) nextRatio = ratio + KEYBOARD_RESIZE_STEP;
      if (nextRatio === null) return;
      event.preventDefault();
      setLayout((previous) => {
        const next = updateWorkspaceSplitRatio(previous, path, nextRatio!);
        layoutRef.current = next;
        return next;
      });
    },
    [],
  );

  const startPointerResize = useCallback(
    (
      event: React.PointerEvent<HTMLDivElement>,
      path: WorkspaceLayoutPath,
      direction: SplitDirection,
      ratio: number,
    ): void => {
      if (event.button !== 0) return;
      event.preventDefault();
      const bounds = event.currentTarget.parentElement?.getBoundingClientRect();
      const size = direction === "horizontal" ? (bounds?.width ?? 0) : (bounds?.height ?? 0);
      if (size <= 0) return;
      const start = direction === "horizontal" ? event.clientX : event.clientY;
      const pointerId = event.pointerId;
      const onMove = (moveEvent: PointerEvent): void => {
        if (moveEvent.pointerId !== pointerId) return;
        const current = direction === "horizontal" ? moveEvent.clientX : moveEvent.clientY;
        const nextRatio = ratio + ((current - start) / size) * 100;
        setLayout((previous) => {
          const next = updateWorkspaceSplitRatio(previous, path, nextRatio);
          layoutRef.current = next;
          return next;
        });
      };
      const stop = (endEvent: PointerEvent): void => {
        if (endEvent.pointerId !== pointerId) return;
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", stop);
        window.removeEventListener("pointercancel", stop);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", stop);
      window.addEventListener("pointercancel", stop);
    },
    [],
  );

  const canRearrange = leafIds.length > 1;

  return (
    <main className={`workspace-shell${activePaneDrag ? " pane-drag-active" : ""}`}>
      <div className="workspace-toolbar" data-tauri-drag-region>
        <button
          type="button"
          className="workspace-rearrangement-toggle"
          disabled={!canRearrange}
          aria-pressed={rearrangementEnabled}
          aria-label="Rearrange panes"
          title="Enable pane drag handles"
          onClick={toggleRearrangement}
        >
          Rearrange
        </button>
      </div>
      <p id={PANE_DRAG_INSTRUCTIONS_ID} className="visually-hidden">
        Drag this handle onto the left, right, top, or bottom edge of another workspace pane. Press
        Escape to cancel.
      </p>
      <div className="visually-hidden" aria-live="polite" aria-atomic="true">
        {rearrangementAnnouncement}
      </div>
      <div className="workspace-grid" data-pane-count={leafIds.length}>
        <WorkspaceNode
          node={layout.root}
          focusedPaneId={layout.focusedPaneId}
          panes={layout.panes}
          windowFocused={windowFocused}
          canSplit={leafIds.length < MAX_WORKSPACE_PANES}
          rearrangementEnabled={rearrangementEnabled}
          activePaneDragSourceId={activePaneDrag?.sourcePaneId ?? null}
          hoveredPaneDrop={hoveredPaneDrop}
          dragInstructionsId={PANE_DRAG_INSTRUCTIONS_ID}
          renderPane={renderPane}
          onFocusPane={focusPane}
          onSnapshot={updateSnapshot}
          registerInput={registerInput}
          onSplitPane={splitPane}
          onClosePane={closePane}
          onPaneDragStart={startPaneDrag}
          onPaneDragEnd={finishPaneDrag}
          onPaneDropHover={hoverPaneDrop}
          onPaneDrop={commitPaneDrop}
          onPaneDropReject={cancelPaneDrag}
          onResizeByKeyboard={resizeByKeyboard}
          onStartPointerResize={startPointerResize}
        />
      </div>
    </main>
  );
}
