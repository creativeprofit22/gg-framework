import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
  arrangeAllWindows,
  focusWindowByOffset,
  newWindow,
  onWindowOrder,
  setWindowTitle,
  validateWorkspaceTarget,
  windowLabel,
} from "./agent";
import {
  AgentPane,
  type AgentPaneProps,
  type PaneInputActions,
  type PaneSnapshot,
} from "./AgentPane";
import { Confetti } from "./Confetti";
import { PRODUCT_DISPLAY_NAME } from "./brand";
import { PRIMARY_PANE_ID, SECONDARY_PANE_ID } from "./pane-routing";
import { ProjectNotes } from "./ProjectNotes";
import { RankBadge } from "./RankBadge";
import { ScorecardModal } from "./ScorecardModal";
import { playSound } from "./sounds";
import { theme } from "./theme";
import { toast } from "./toast";
import { Toaster } from "./Toaster";
import { useAppUpdate } from "./update";
import { useProgress } from "./useProgress";
import {
  loadWorkspaceLayout,
  preserveRejectedWorkspaceLayout,
  resolveWorkspaceLayoutTargets,
  saveWorkspaceLayout,
  type WorkspaceLayout,
} from "./workspace-layout";

const PANE_IDS = [PRIMARY_PANE_ID, SECONDARY_PANE_ID] as const;
const DIVIDER_WIDTH_PX = 9;
const MIN_PANE_WIDTH_PX = 280;
const KEYBOARD_RESIZE_STEP_PX = 24;

function ratioBounds(containerWidth: number): { min: number; max: number } {
  const availableWidth = Math.max(0, containerWidth - DIVIDER_WIDTH_PX);
  if (availableWidth === 0) return { min: 50, max: 50 };
  const effectiveMinimum = Math.min(MIN_PANE_WIDTH_PX, availableWidth / 2);
  const min = (effectiveMinimum / availableWidth) * 100;
  return { min, max: 100 - min };
}

function clampRatio(ratio: number, containerWidth: number): number {
  const { min, max } = ratioBounds(containerWidth);
  return Math.min(max, Math.max(min, ratio));
}

export interface WorkspaceShellProps {
  renderPane?: (props: AgentPaneProps) => React.ReactNode;
}

function PaneContent({
  renderPane,
  paneProps,
}: {
  renderPane?: WorkspaceShellProps["renderPane"];
  paneProps: AgentPaneProps;
}): React.ReactElement {
  return <>{renderPane ? renderPane(paneProps) : <AgentPane {...paneProps} />}</>;
}

function canRestorePaneInput(): boolean {
  const active = document.activeElement;
  if (document.querySelector(".modal-backdrop") || window.getSelection()?.toString()) return false;
  if (active && active !== document.body && active.tagName === "BUTTON") return false;
  return !(
    active instanceof HTMLElement &&
    (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.isContentEditable)
  );
}

export function WorkspaceShell({ renderPane }: WorkspaceShellProps): React.ReactElement {
  const [loadedLayout] = useState(() => loadWorkspaceLayout(localStorage, windowLabel));
  const layoutManaged = loadedLayout.status === "valid" || loadedLayout.status === "migrated";
  const [paneTargets, setPaneTargets] = useState<WorkspaceLayout["panes"]>(
    loadedLayout.layout.panes,
  );
  const [layoutReady, setLayoutReady] = useState(!layoutManaged);
  const [rejectedLayoutChanged, setRejectedLayoutChanged] = useState(false);
  const [focusedPaneId, setFocusedPaneId] = useState<string>(PRIMARY_PANE_ID);
  const focusedPaneIdRef = useRef(focusedPaneId);
  const [windowFocused, setWindowFocused] = useState(true);
  const [snapshots, setSnapshots] = useState<Record<string, PaneSnapshot>>({});
  const inputActionsRef = useRef(new Map<string, PaneInputActions>());
  const [windowIndex, setWindowIndex] = useState<number | null>(null);
  const [windowTotal, setWindowTotal] = useState(1);
  const [showScorecard, setShowScorecard] = useState(false);
  const [confettiNonce, setConfettiNonce] = useState<string | null>(null);
  const [primaryPaneRatio, setPrimaryPaneRatio] = useState(loadedLayout.layout.splitRatio);
  const [workspaceWidth, setWorkspaceWidth] = useState(0);
  const workspaceGridRef = useRef<HTMLDivElement>(null);
  const stopPointerResizeRef = useRef<() => void>(() => undefined);
  const appUpdate = useAppUpdate();
  const { snapshot: progress, levelUp, levelUpNonce, levelUpOrigin } = useProgress();
  const focusPane = useCallback((paneId: string): void => {
    focusedPaneIdRef.current = paneId;
    setFocusedPaneId(paneId);
  }, []);
  const markLayoutChanged = useCallback((): void => setRejectedLayoutChanged(true), []);

  const updateSnapshot = useCallback((snapshot: PaneSnapshot): void => {
    setSnapshots((previous) => {
      const current = previous[snapshot.paneId];
      if (
        current?.cwd === snapshot.cwd &&
        current.sessionPath === snapshot.sessionPath &&
        current.sessionTitle === snapshot.sessionTitle &&
        current.projectBound === snapshot.projectBound &&
        current.restoreChecked === snapshot.restoreChecked
      ) {
        return previous;
      }
      return { ...previous, [snapshot.paneId]: snapshot };
    });
    if (snapshot.projectBound && snapshot.cwd) {
      setPaneTargets((previous) => ({
        ...previous,
        [snapshot.paneId]: { cwd: snapshot.cwd!, sessionPath: snapshot.sessionPath },
      }));
    } else if (snapshot.restoreChecked) {
      setPaneTargets((previous) => ({ ...previous, [snapshot.paneId]: null }));
    }
  }, []);

  const registerInput = useCallback((paneId: string, actions: PaneInputActions | null): void => {
    if (actions) inputActionsRef.current.set(paneId, actions);
    else inputActionsRef.current.delete(paneId);
  }, []);

  useEffect(() => {
    if (loadedLayout.status === "corrupt" && loadedLayout.rejectedRaw !== undefined) {
      preserveRejectedWorkspaceLayout(localStorage, windowLabel, loadedLayout.rejectedRaw);
    }
  }, [loadedLayout]);

  useEffect(() => {
    if (!layoutManaged) return;
    let cancelled = false;
    void resolveWorkspaceLayoutTargets(loadedLayout.layout, (target) =>
      validateWorkspaceTarget(target.cwd, target.sessionPath),
    )
      .then((resolved) => {
        if (cancelled) return;
        setPaneTargets(resolved.panes);
        setPrimaryPaneRatio(resolved.splitRatio);
        setLayoutReady(true);
      })
      .catch(() => {
        if (cancelled) return;
        setPaneTargets(loadedLayout.layout.panes);
        setPrimaryPaneRatio(loadedLayout.layout.splitRatio);
        setLayoutReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, [layoutManaged, loadedLayout]);

  useEffect(() => {
    if (!layoutReady || PANE_IDS.some((paneId) => !snapshots[paneId]?.restoreChecked)) return;
    if (loadedLayout.status === "corrupt" && !rejectedLayoutChanged) return;
    saveWorkspaceLayout(localStorage, windowLabel, {
      version: 1,
      splitRatio: primaryPaneRatio,
      panes: paneTargets,
    });
  }, [
    layoutReady,
    loadedLayout.status,
    paneTargets,
    primaryPaneRatio,
    rejectedLayoutChanged,
    snapshots,
  ]);

  useEffect(() => {
    focusedPaneIdRef.current = focusedPaneId;
    const focused = snapshots[focusedPaneId];
    setWindowTitle(
      focused?.projectBound && focused.sessionTitle ? focused.sessionTitle : PRODUCT_DISPLAY_NAME,
    );
  }, [focusedPaneId, snapshots]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const meta = event.metaKey || event.ctrlKey;
      if (!meta || event.altKey) return;
      if (!event.shiftKey && event.key === "1") {
        event.preventDefault();
        focusPane(PRIMARY_PANE_ID);
        inputActionsRef.current.get(PRIMARY_PANE_ID)?.focus();
      } else if (!event.shiftKey && event.key === "2") {
        event.preventDefault();
        focusPane(SECONDARY_PANE_ID);
        inputActionsRef.current.get(SECONDARY_PANE_ID)?.focus();
      } else if (!event.shiftKey && event.key.toLowerCase() === "n") {
        event.preventDefault();
        void newWindow();
      } else if (event.code === "Backquote") {
        event.preventDefault();
        void focusWindowByOffset(event.shiftKey ? -1 : 1);
      } else if (event.shiftKey && event.key.toLowerCase() === "a") {
        event.preventDefault();
        void arrangeAllWindows();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [focusPane]);

  useEffect(() => {
    const restoreFocusedInput = (): void => {
      setWindowFocused(true);
      if (canRestorePaneInput()) inputActionsRef.current.get(focusedPaneIdRef.current)?.focus();
    };
    const onBlur = (): void => setWindowFocused(false);
    window.addEventListener("focus", restoreFocusedInput);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("focus", restoreFocusedInput);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  useEffect(() => {
    const preventFileNavigation = (event: DragEvent): void => {
      if (event.dataTransfer?.types.includes("Files")) event.preventDefault();
    };
    window.addEventListener("dragover", preventFileNavigation);
    window.addEventListener("drop", preventFileNavigation);
    return () => {
      window.removeEventListener("dragover", preventFileNavigation);
      window.removeEventListener("drop", preventFileNavigation);
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        if (disposed || event.payload.type !== "drop" || event.payload.paths.length === 0) return;
        inputActionsRef.current
          .get(focusedPaneIdRef.current)
          ?.handleNativeDrop(event.payload.paths);
      })
      .then((off) => {
        if (disposed) off();
        else unlisten = off;
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void onWindowOrder((event) => {
      const index = event.order.indexOf(windowLabel);
      setWindowIndex(index >= 0 ? index + 1 : null);
      setWindowTotal(event.order.length);
    }).then((off) => {
      unlisten = off;
    });
    return () => unlisten?.();
  }, []);

  useEffect(() => {
    const interactive = "button, a, [role='button'], [role='option'], label, summary, select";
    const onClick = (event: MouseEvent): void => {
      if (event.button !== 0) return;
      const element = (event.target as Element | null)?.closest?.(interactive);
      if (
        !element ||
        element.hasAttribute("disabled") ||
        element.getAttribute("aria-disabled") === "true"
      )
        return;
      if (!element.closest("[data-suppress-click-sound]")) playSound("click");
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, []);

  useEffect(() => {
    if (!levelUp || !levelUpNonce) return;
    toast(`Rank up! → ${levelUp.rankName}`, "success", 5200);
    if (levelUpOrigin) playSound("levelUp");
    const crossedTier = Math.floor((levelUp.from - 1) / 5) !== Math.floor((levelUp.to - 1) / 5);
    if (!crossedTier) return;
    setConfettiNonce(levelUpNonce);
    const timer = window.setTimeout(() => setConfettiNonce(null), 1900);
    return () => window.clearTimeout(timer);
  }, [levelUp, levelUpNonce, levelUpOrigin]);

  useEffect(() => () => stopPointerResizeRef.current(), []);

  useLayoutEffect(() => {
    const measureWorkspace = (): void => {
      setWorkspaceWidth(workspaceGridRef.current?.getBoundingClientRect().width ?? 0);
    };
    measureWorkspace();
    window.addEventListener("resize", measureWorkspace);
    return () => window.removeEventListener("resize", measureWorkspace);
  }, []);

  const resizeByKeyboard = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>): void => {
      const containerWidth = workspaceGridRef.current?.getBoundingClientRect().width ?? 0;
      setWorkspaceWidth(containerWidth);
      const availableWidth = Math.max(0, containerWidth - DIVIDER_WIDTH_PX);
      let nextRatio: number | null = null;

      if (event.key === "Home") nextRatio = ratioBounds(containerWidth).min;
      else if (event.key === "End") nextRatio = ratioBounds(containerWidth).max;
      else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        const direction = event.key === "ArrowLeft" ? -1 : 1;
        const step = event.shiftKey ? KEYBOARD_RESIZE_STEP_PX * 4 : KEYBOARD_RESIZE_STEP_PX;
        nextRatio =
          primaryPaneRatio + direction * (availableWidth > 0 ? (step / availableWidth) * 100 : 0);
      }

      if (nextRatio === null) return;
      event.preventDefault();
      setRejectedLayoutChanged(true);
      setPrimaryPaneRatio(clampRatio(nextRatio, containerWidth));
    },
    [primaryPaneRatio],
  );

  const startPointerResize = useCallback(
    (event: React.PointerEvent<HTMLDivElement>): void => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.currentTarget.focus();
      stopPointerResizeRef.current();

      const pointerId = event.pointerId;
      const startX = event.clientX;
      const startRatio = primaryPaneRatio;
      const containerWidth = workspaceGridRef.current?.getBoundingClientRect().width ?? 0;
      setWorkspaceWidth(containerWidth);
      const availableWidth = Math.max(0, containerWidth - DIVIDER_WIDTH_PX);
      const previousCursor = document.body.style.cursor;
      const previousUserSelect = document.body.style.userSelect;
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";

      const stop = (): void => {
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", onPointerEnd);
        window.removeEventListener("pointercancel", onPointerEnd);
        document.body.style.cursor = previousCursor;
        document.body.style.userSelect = previousUserSelect;
        stopPointerResizeRef.current = () => undefined;
      };
      const onPointerMove = (moveEvent: PointerEvent): void => {
        if (moveEvent.pointerId !== pointerId || availableWidth === 0) return;
        const deltaRatio = ((moveEvent.clientX - startX) / availableWidth) * 100;
        setRejectedLayoutChanged(true);
        setPrimaryPaneRatio(clampRatio(startRatio + deltaRatio, containerWidth));
      };
      const onPointerEnd = (endEvent: PointerEvent): void => {
        if (endEvent.pointerId === pointerId) stop();
      };

      stopPointerResizeRef.current = stop;
      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerEnd);
      window.addEventListener("pointercancel", onPointerEnd);
    },
    [primaryPaneRatio],
  );

  const focusedSnapshot = snapshots[focusedPaneId];
  const visiblePaneRatio = clampRatio(primaryPaneRatio, workspaceWidth);
  return (
    <div className="workspace-shell" style={{ background: theme.background }}>
      {confettiNonce && <Confetti key={confettiNonce} />}
      <Toaster />
      <div className="workspace-toolbar" data-tauri-drag-region>
        <RankBadge snapshot={progress} onClick={() => setShowScorecard(true)} />
        <ProjectNotes cwd={focusedSnapshot?.cwd ?? null} />
        {windowTotal > 1 && windowIndex !== null && (
          <span
            className="window-index"
            data-tauri-drag-region
          >{`${windowIndex}/${windowTotal}`}</span>
        )}
      </div>
      <div
        className="workspace-grid"
        data-split-ratio={primaryPaneRatio}
        ref={workspaceGridRef}
        style={{
          gridTemplateColumns: `minmax(min(${MIN_PANE_WIDTH_PX}px, calc((100% - ${DIVIDER_WIDTH_PX}px) / 2)), ${primaryPaneRatio}fr) ${DIVIDER_WIDTH_PX}px minmax(min(${MIN_PANE_WIDTH_PX}px, calc((100% - ${DIVIDER_WIDTH_PX}px) / 2)), ${100 - primaryPaneRatio}fr)`,
        }}
      >
        {PANE_IDS.map((paneId, index) => (
          <div
            className="workspace-pane-slot"
            data-pane-id={paneId}
            id={`workspace-pane-${paneId}`}
            key={paneId}
            onPointerDownCapture={() => focusPane(paneId)}
            onFocusCapture={() => focusPane(paneId)}
          >
            {layoutReady && (
              <PaneContent
                renderPane={renderPane}
                paneProps={{
                  paneId,
                  kind: index === 0 ? "primary" : "secondary",
                  focused: focusedPaneId === paneId,
                  windowFocused,
                  initialTarget: layoutManaged ? paneTargets[paneId] : undefined,
                  onFocus: focusPane,
                  onSnapshot: updateSnapshot,
                  onUserTargetChange: markLayoutChanged,
                  registerInput,
                }}
              />
            )}
          </div>
        )).flatMap((pane, index) =>
          index === 0
            ? [
                pane,
                <div
                  aria-controls="workspace-pane-primary workspace-pane-secondary"
                  aria-label="Resize workspace panes"
                  aria-orientation="vertical"
                  aria-valuemax={Math.round(ratioBounds(workspaceWidth).max)}
                  aria-valuemin={Math.round(ratioBounds(workspaceWidth).min)}
                  aria-valuenow={Math.round(visiblePaneRatio)}
                  className="workspace-divider"
                  key="workspace-divider"
                  onKeyDown={resizeByKeyboard}
                  onPointerDown={startPointerResize}
                  role="separator"
                  tabIndex={0}
                >
                  <span className="workspace-divider-line" />
                </div>,
              ]
            : [pane],
        )}
      </div>

      {appUpdate.phase === "available" && (
        <button
          className="update-banner"
          title={appUpdate.installTitle}
          onClick={() => void appUpdate.install()}
        >
          <span className="update-banner-dot" />
          {appUpdate.localPatched
            ? `Update available (${appUpdate.version}). Click to rebase local customizations and build a patched installer.`
            : `New ${PRODUCT_DISPLAY_NAME} update (${appUpdate.version}) — click here to install`}
        </button>
      )}
      {(appUpdate.phase === "installing" ||
        appUpdate.phase === "completed" ||
        appUpdate.phase === "error") && (
        <div className={`update-banner update-banner-busy update-banner-${appUpdate.phase}`}>
          <span className="update-banner-dot" />
          <span className="update-banner-content">
            <span>
              {appUpdate.statusMessage ??
                (appUpdate.phase === "error"
                  ? "Update install failed."
                  : "Installing update… the app will restart automatically.")}
            </span>
            {appUpdate.localPatched && appUpdate.progressLines.length > 0 && (
              <span className="update-banner-log">
                {appUpdate.progressLines[appUpdate.progressLines.length - 1]}
              </span>
            )}
          </span>
        </div>
      )}
      {showScorecard && progress && (
        <ScorecardModal snapshot={progress} onClose={() => setShowScorecard(false)} />
      )}
    </div>
  );
}
