import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { disposePaneSession, windowLabel } from "./agent";
import { type AgentPaneProps, type PaneInputActions, type PaneSnapshot } from "./AgentPane";
import {
  focusWorkspacePane,
  loadWorkspaceLayout,
  MAX_WORKSPACE_PANES,
  removeWorkspacePane,
  saveWorkspaceLayout,
  splitWorkspacePane,
  updateWorkspaceSplitRatio,
  workspaceLayoutLeafIds,
  type SplitDirection,
  type WorkspaceLayout,
  type WorkspaceLayoutPath,
  type WorkspacePaneId,
} from "./workspace-layout";
import { WorkspaceNode } from "./WorkspaceNode";

const KEYBOARD_RESIZE_STEP = 5;

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
  const inputActionsRef = useRef(new Map<string, PaneInputActions>());
  const layoutRef = useRef(layout);
  const leafIds = useMemo(() => workspaceLayoutLeafIds(layout.root), [layout.root]);

  useEffect(() => {
    layoutRef.current = layout;
  }, [layout]);

  useEffect(() => {
    const onFocus = (): void => setWindowFocused(true);
    const onBlur = (): void => setWindowFocused(false);
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  useEffect(() => {
    if (leafIds.some((paneId) => !snapshots[paneId]?.restoreChecked)) return;
    saveWorkspaceLayout(localStorage, windowLabel, layout);
  }, [layout, leafIds, snapshots]);

  useEffect(() => {
    requestAnimationFrame(() => inputActionsRef.current.get(layout.focusedPaneId)?.focus());
  }, [layout.focusedPaneId, leafIds]);

  const focusPane = useCallback((paneId: WorkspacePaneId): void => {
    setLayout((previous) => focusWorkspacePane(previous, paneId));
  }, []);

  const updateSnapshot = useCallback((snapshot: PaneSnapshot): void => {
    if (!workspaceLayoutLeafIds(layoutRef.current.root).includes(snapshot.paneId)) return;
    setSnapshots((previous) => ({ ...previous, [snapshot.paneId]: snapshot }));
    if (!snapshot.restoreChecked) return;
    setLayout((previous) => {
      const descriptor = previous.panes[snapshot.paneId];
      if (sameSnapshotTarget(descriptor, snapshot)) return previous;
      return {
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
    });
  }, []);

  const registerInput = useCallback((paneId: string, actions: PaneInputActions | null): void => {
    if (actions) inputActionsRef.current.set(paneId, actions);
    else inputActionsRef.current.delete(paneId);
  }, []);

  const splitPane = useCallback((paneId: WorkspacePaneId, direction: SplitDirection): void => {
    setLayout((previous) => splitWorkspacePane(previous, paneId, direction));
  }, []);

  const closePane = useCallback((paneId: WorkspacePaneId): void => {
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
  }, []);

  const resizeByKeyboard = useCallback(
    (
      event: React.KeyboardEvent<HTMLDivElement>,
      path: WorkspaceLayoutPath,
      direction: SplitDirection,
      ratio: number,
    ): void => {
      const negative = direction === "horizontal" ? "ArrowLeft" : "ArrowUp";
      const positive = direction === "horizontal" ? "ArrowRight" : "ArrowDown";
      let next: number | null = null;
      if (event.key === "Home") next = 10;
      else if (event.key === "End") next = 90;
      else if (event.key === negative) next = ratio - KEYBOARD_RESIZE_STEP;
      else if (event.key === positive) next = ratio + KEYBOARD_RESIZE_STEP;
      if (next === null) return;
      event.preventDefault();
      setLayout((previous) => updateWorkspaceSplitRatio(previous, path, next));
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
        const next = ratio + ((current - start) / size) * 100;
        setLayout((previous) => updateWorkspaceSplitRatio(previous, path, next));
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

  return (
    <main className="workspace-shell">
      <div className="workspace-grid" data-pane-count={leafIds.length}>
        <WorkspaceNode
          node={layout.root}
          focusedPaneId={layout.focusedPaneId}
          panes={layout.panes}
          windowFocused={windowFocused}
          canSplit={leafIds.length < MAX_WORKSPACE_PANES}
          renderPane={renderPane}
          onFocusPane={focusPane}
          onSnapshot={updateSnapshot}
          registerInput={registerInput}
          onSplitPane={splitPane}
          onClosePane={closePane}
          onResizeByKeyboard={resizeByKeyboard}
          onStartPointerResize={startPointerResize}
        />
      </div>
    </main>
  );
}
