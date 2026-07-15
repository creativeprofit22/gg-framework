import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
  arrangeAllWindows,
  disposePaneSession,
  focusWindowByOffset,
  newWindow,
  onWindowOrder,
  openPaneInNewWindow,
  openTerminalInNewWindow,
  registerStoppedTerminalTarget,
  setWindowTitle,
  validateWorkspaceTarget,
  windowLabel,
} from "./agent";
import { type AgentPaneProps, type PaneInputActions, type PaneSnapshot } from "./AgentPane";
import { Confetti } from "./Confetti";
import { ConfirmModal } from "./ConfirmModal";
import { PRODUCT_DISPLAY_NAME } from "./brand";
import { PRIMARY_PANE_ID } from "./pane-routing";
import { ProjectNotes } from "./ProjectNotes";
import { RankBadge } from "./RankBadge";
import { ScorecardModal } from "./ScorecardModal";
import { playSound } from "./sounds";
import { theme } from "./theme";
import { toast } from "./toast";
import { Toaster } from "./Toaster";
import { useAppUpdate } from "./update";
import { useProgress } from "./useProgress";
import { PANE_DRAG_MIME } from "./PaneDropOverlay";
import {
  addTerminalWorkspacePane,
  bootstrapDefaultTerminalWorkspacePane,
  loadWorkspaceLayout,
  MAX_WORKSPACE_LAYOUT_LEAVES,
  MAX_WORKSPACE_PANES,
  moveWorkspacePane,
  preserveRejectedRecursiveWorkspaceLayout,
  preserveRejectedWorkspaceLayout,
  removeWorkspacePane,
  resolveWorkspaceLayoutTargets,
  saveWorkspaceLayout,
  splitWorkspacePane,
  updateWorkspaceSplitRatio,
  workspaceLayoutLeafIds,
  WORKSPACE_LAYOUT_VERSION,
  type SplitDirection,
  type PaneMoveRequest,
  type PanePlacement,
  type WorkspaceLayout,
  type WorkspaceLayoutPath,
  type WorkspacePaneId,
  type WorkspacePaneTarget,
} from "./workspace-layout";
import { WorkspaceNode } from "./WorkspaceNode";

const DIVIDER_WIDTH_PX = 9;
const MIN_PANE_SIZE_PX = 280;
const KEYBOARD_RESIZE_STEP_PX = 24;
const MALFORMED_LAYOUT_WARNING = "Saved workspace layout was invalid. A safe layout was restored.";
const LAYOUT_LOAD_ERROR_WARNING =
  "Saved workspace layout could not be loaded. A safe layout was restored.";
const STALE_TARGET_WARNING =
  "Some saved workspace panes were unavailable. A safe layout was restored.";
const PANE_DRAG_INSTRUCTIONS_ID = "pane-rearrangement-instructions";

interface ActivePaneDrag {
  sourcePaneId: WorkspacePaneId;
  handle: HTMLButtonElement;
  generation: number;
}

function ratioBounds(containerSize: number): { min: number; max: number } {
  const available = Math.max(0, containerSize - DIVIDER_WIDTH_PX);
  if (available === 0) return { min: 50, max: 50 };
  const effectiveMinimum = Math.min(MIN_PANE_SIZE_PX, available / 2);
  const min = (effectiveMinimum / available) * 100;
  return { min, max: 100 - min };
}

function clampRatio(ratio: number, containerSize: number): number {
  const { min, max } = ratioBounds(containerSize);
  return Math.min(max, Math.max(min, ratio));
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

export interface WorkspaceShellProps {
  renderPane?: (props: AgentPaneProps) => React.ReactNode;
}

export function WorkspaceShell({ renderPane }: WorkspaceShellProps): React.ReactElement {
  const [loadedLayout] = useState(() => loadWorkspaceLayout(localStorage, windowLabel));
  const layoutManaged = loadedLayout.status === "valid" || loadedLayout.status === "migrated";
  const [layout, setLayout] = useState<WorkspaceLayout>(loadedLayout.layout);
  const layoutRef = useRef(layout);
  const [layoutReady, setLayoutReady] = useState(!layoutManaged);
  const [rejectedLayoutChanged, setRejectedLayoutChanged] = useState(false);
  const focusedPaneIdRef = useRef(layout.focusedPaneId);
  const activePaneIdsRef = useRef(new Set(workspaceLayoutLeafIds(layout.root)));
  const [rearrangementEnabled, setRearrangementEnabled] = useState(false);
  const [activePaneDrag, setActivePaneDrag] = useState<ActivePaneDrag | null>(null);
  const activePaneDragRef = useRef<ActivePaneDrag | null>(null);
  const dragGenerationRef = useRef(0);
  const [hoveredPaneDrop, setHoveredPaneDrop] = useState<{
    targetPaneId: WorkspacePaneId;
    placement: PanePlacement;
  } | null>(null);
  const [rearrangementAnnouncement, setRearrangementAnnouncement] = useState("");
  const [windowFocused, setWindowFocused] = useState(true);
  const [snapshots, setSnapshots] = useState<Record<string, PaneSnapshot>>({});
  const [confirmTerminalCloseId, setConfirmTerminalCloseId] = useState<WorkspacePaneId | null>(
    null,
  );
  const [confirmPaneCloseId, setConfirmPaneCloseId] = useState<WorkspacePaneId | null>(null);
  const inputActionsRef = useRef(new Map<string, PaneInputActions>());
  const [windowIndex, setWindowIndex] = useState<number | null>(null);
  const [windowTotal, setWindowTotal] = useState(1);
  const [showScorecard, setShowScorecard] = useState(false);
  const [confettiNonce, setConfettiNonce] = useState<string | null>(null);
  const [openingPaneId, setOpeningPaneId] = useState<WorkspacePaneId | null>(null);
  const openingPaneIdRef = useRef<WorkspacePaneId | null>(null);
  const resizeCleanupRef = useRef(new Map<string, () => void>());
  const nextGeneratedPaneOrdinalRef = useRef(
    Math.max(
      0,
      ...Object.keys(loadedLayout.layout.panes).map((paneId) => {
        const match = /^pane-(\d+)$/.exec(paneId);
        return match ? Number(match[1]) : 0;
      }),
    ),
  );
  const warnedRecoveryEventsRef = useRef(new Set<string>());
  const appUpdate = useAppUpdate();
  const { snapshot: progress, levelUp, levelUpNonce, levelUpOrigin } = useProgress();
  const leafIds = useMemo(() => workspaceLayoutLeafIds(layout.root), [layout.root]);

  useEffect(() => {
    layoutRef.current = layout;
  }, [layout]);

  const markLayoutChanged = useCallback((): void => setRejectedLayoutChanged(true), []);
  const focusPaneDragHandle = useCallback((paneId: WorkspacePaneId): void => {
    requestAnimationFrame(() => {
      document
        .querySelector<HTMLButtonElement>(
          `[data-pane-drag-handle="${CSS.escape(paneId)}"], [data-terminal-drag-handle="${CSS.escape(paneId)}"]`,
        )
        ?.focus();
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
  const focusPane = useCallback((paneId: string): void => {
    focusedPaneIdRef.current = paneId;
    setLayout((previous) =>
      workspaceLayoutLeafIds(previous.root).includes(paneId)
        ? { ...previous, focusedPaneId: paneId }
        : previous,
    );
  }, []);
  const warnRecovery = useCallback((eventKey: string, message: string): void => {
    if (warnedRecoveryEventsRef.current.has(eventKey)) return;
    warnedRecoveryEventsRef.current.add(eventKey);
    toast(message, "warning", 4000, false);
  }, []);

  const updateSnapshot = useCallback(
    (snapshot: PaneSnapshot): void => {
      if (!activePaneIdsRef.current.has(snapshot.paneId)) return;
      setSnapshots((previous) => {
        const current = previous[snapshot.paneId];
        if (
          current?.cwd === snapshot.cwd &&
          current.sessionPath === snapshot.sessionPath &&
          current.sessionTitle === snapshot.sessionTitle &&
          current.projectBound === snapshot.projectBound &&
          current.restoreChecked === snapshot.restoreChecked &&
          current.activeWork === snapshot.activeWork
        )
          return previous;
        return { ...previous, [snapshot.paneId]: snapshot };
      });
      setLayout((previous) => {
        const hydrated = {
          ...previous,
          panes: {
            ...previous.panes,
            [snapshot.paneId]:
              snapshot.projectBound && snapshot.cwd
                ? { cwd: snapshot.cwd, sessionPath: snapshot.sessionPath }
                : snapshot.restoreChecked
                  ? null
                  : previous.panes[snapshot.paneId],
          },
        };
        const bootstrapped =
          snapshot.paneId === PRIMARY_PANE_ID &&
          snapshot.restoreChecked &&
          snapshot.projectBound &&
          Boolean(snapshot.cwd?.trim())
            ? bootstrapDefaultTerminalWorkspacePane(hydrated)
            : hydrated;
        if (bootstrapped !== hydrated) {
          focusedPaneIdRef.current = bootstrapped.focusedPaneId;
          activePaneIdsRef.current = new Set(workspaceLayoutLeafIds(bootstrapped.root));
          markLayoutChanged();
        }
        return bootstrapped;
      });
    },
    [markLayoutChanged],
  );

  const registerInput = useCallback((paneId: string, actions: PaneInputActions | null): void => {
    if (actions) inputActionsRef.current.set(paneId, actions);
    else inputActionsRef.current.delete(paneId);
  }, []);

  const addTerminalLeaf = useCallback((): void => {
    const paneId = layout.focusedPaneId;
    const snapshot = snapshots[paneId];
    const descriptor = layout.panes[paneId];
    if (
      descriptor?.kind === "terminal" ||
      !descriptor?.cwd ||
      !snapshot?.restoreChecked ||
      !snapshot.projectBound ||
      snapshot.cwd !== descriptor.cwd ||
      snapshot.sessionPath !== descriptor.sessionPath
    )
      return;
    setLayout((previous) => {
      const next = addTerminalWorkspacePane(previous, paneId);
      if (next === previous) return previous;
      focusedPaneIdRef.current = next.focusedPaneId;
      activePaneIdsRef.current = new Set(workspaceLayoutLeafIds(next.root));
      return next;
    });
    markLayoutChanged();
  }, [layout.focusedPaneId, layout.panes, markLayoutChanged, snapshots]);

  const startPaneDrag = useCallback(
    (paneId: WorkspacePaneId, handle: HTMLButtonElement): void => {
      const current = layoutRef.current;
      if (!rearrangementEnabled || !workspaceLayoutLeafIds(current.root).includes(paneId)) return;
      cancelPaneDrag(false);
      const active = { sourcePaneId: paneId, handle, generation: ++dragGenerationRef.current };
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
      if (!active || targetPaneId === active.sourcePaneId || !placement) {
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
      const next = moveWorkspacePane(previous, request);
      if (next === previous) {
        cancelPaneDrag();
        return;
      }
      clearPaneDrag();
      layoutRef.current = next;
      focusedPaneIdRef.current = next.focusedPaneId;
      activePaneIdsRef.current = new Set(workspaceLayoutLeafIds(next.root));
      setLayout(next);
      markLayoutChanged();
      setRearrangementAnnouncement(
        `Pane ${request.sourcePaneId} moved ${request.placement} of ${request.targetPaneId}.`,
      );
      focusPaneDragHandle(request.sourcePaneId);
    },
    [cancelPaneDrag, clearPaneDrag, focusPaneDragHandle, markLayoutChanged],
  );

  const toggleRearrangement = useCallback((): void => {
    setRearrangementEnabled((enabled) => {
      const next = !enabled;
      if (!next) cancelPaneDrag();
      setRearrangementAnnouncement(
        next ? "Pane rearrangement enabled." : "Pane rearrangement disabled.",
      );
      return next;
    });
  }, [cancelPaneDrag]);

  useEffect(() => {
    if (loadedLayout.status === "load-error") {
      warnRecovery("load-error", LAYOUT_LOAD_ERROR_WARNING);
      return;
    }
    if (
      loadedLayout.status !== "corrupt" ||
      loadedLayout.rejectedRaw === undefined ||
      loadedLayout.rejectedSource === undefined
    )
      return;
    const preserveRejected =
      loadedLayout.rejectedSource === "recursive"
        ? preserveRejectedRecursiveWorkspaceLayout
        : preserveRejectedWorkspaceLayout;
    preserveRejected(localStorage, windowLabel, loadedLayout.rejectedRaw);
    warnRecovery(`malformed:${loadedLayout.rejectedRaw}`, MALFORMED_LAYOUT_WARNING);
  }, [loadedLayout, warnRecovery]);

  useEffect(() => {
    if (!layoutManaged) return;
    let cancelled = false;
    void resolveWorkspaceLayoutTargets(loadedLayout.layout, (target) =>
      validateWorkspaceTarget(target.cwd, target.sessionPath),
    )
      .then((resolved) => {
        if (cancelled) return;
        if (
          Object.keys(loadedLayout.layout.panes).some(
            (paneId) =>
              JSON.stringify(resolved.panes[paneId]) !==
              JSON.stringify(loadedLayout.layout.panes[paneId]),
          )
        )
          warnRecovery(
            `stale:${JSON.stringify(loadedLayout.layout.panes)}:${JSON.stringify(resolved.panes)}`,
            STALE_TARGET_WARNING,
          );
        activePaneIdsRef.current = new Set(workspaceLayoutLeafIds(resolved.root));
        setLayout(resolved);
        focusedPaneIdRef.current = resolved.focusedPaneId;
        setLayoutReady(true);
      })
      .catch(() => {
        if (cancelled) return;
        activePaneIdsRef.current = new Set(workspaceLayoutLeafIds(loadedLayout.layout.root));
        setLayout(loadedLayout.layout);
        focusedPaneIdRef.current = loadedLayout.layout.focusedPaneId;
        setLayoutReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, [layoutManaged, loadedLayout, warnRecovery]);

  useEffect(() => {
    if (!layoutReady) return;
    if (
      leafIds.some(
        (paneId) => layout.panes[paneId]?.kind !== "terminal" && !snapshots[paneId]?.restoreChecked,
      )
    )
      return;
    if (loadedLayout.status === "corrupt" && !rejectedLayoutChanged) return;
    saveWorkspaceLayout(localStorage, windowLabel, {
      ...layout,
      version: WORKSPACE_LAYOUT_VERSION,
    });
  }, [layout, layoutReady, leafIds, loadedLayout.status, rejectedLayoutChanged, snapshots]);

  useEffect(() => {
    focusedPaneIdRef.current = layout.focusedPaneId;
    const focused = snapshots[layout.focusedPaneId];
    setWindowTitle(
      focused?.projectBound && focused.sessionTitle ? focused.sessionTitle : PRODUCT_DISPLAY_NAME,
    );
  }, [layout.focusedPaneId, snapshots]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && activePaneDragRef.current) {
        event.preventDefault();
        cancelPaneDrag();
        return;
      }
      const meta = event.metaKey || event.ctrlKey;
      if (!meta || event.altKey) return;
      const paneNumber = /^[1-4]$/.test(event.key) ? Number(event.key) : null;
      const inTerminal =
        event.target instanceof Element && event.target.closest(".terminal-pane") !== null;
      const reserved = (!event.shiftKey && paneNumber !== null) || event.code === "Backquote";
      if (inTerminal && !reserved) return;
      const paneId = paneNumber === null ? undefined : leafIds[paneNumber - 1];
      if (!event.shiftKey && paneId) {
        event.preventDefault();
        focusPane(paneId);
        inputActionsRef.current.get(paneId)?.focus();
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
  }, [cancelPaneDrag, focusPane, leafIds]);

  useEffect(() => {
    const restoreFocusedInput = (): void => {
      setWindowFocused(true);
      if (canRestorePaneInput()) inputActionsRef.current.get(focusedPaneIdRef.current)?.focus();
    };
    const onBlur = (): void => {
      setWindowFocused(false);
      cancelPaneDrag();
    };
    window.addEventListener("focus", restoreFocusedInput);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("focus", restoreFocusedInput);
      window.removeEventListener("blur", onBlur);
    };
  }, [cancelPaneDrag]);

  useEffect(() => {
    const onPointerCancel = (): void => cancelPaneDrag();
    const onOutsideDrop = (event: DragEvent): void => {
      if (
        activePaneDragRef.current &&
        event.dataTransfer &&
        Array.from(event.dataTransfer.types).includes(PANE_DRAG_MIME)
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
  }, [cancelPaneDrag, leafIds, rearrangementEnabled]);

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

  useEffect(
    () => () => {
      for (const stop of resizeCleanupRef.current.values()) stop();
      resizeCleanupRef.current.clear();
    },
    [],
  );

  const splitFocusedPane = useCallback(
    (direction: SplitDirection): void => {
      let newFocused: WorkspacePaneId | null = null;
      const requestedPaneId = `pane-${++nextGeneratedPaneOrdinalRef.current}`;
      setLayout((previous) => {
        const next = splitWorkspacePane(
          previous,
          previous.focusedPaneId,
          direction,
          requestedPaneId,
        );
        if (next === previous) return previous;
        newFocused = next.focusedPaneId;
        focusedPaneIdRef.current = next.focusedPaneId;
        activePaneIdsRef.current = new Set(workspaceLayoutLeafIds(next.root));
        return next;
      });
      markLayoutChanged();
      requestAnimationFrame(() => {
        if (!newFocused) return;
        document
          .querySelector<HTMLElement>(
            `#workspace-pane-${CSS.escape(newFocused)} button, #workspace-pane-${CSS.escape(newFocused)} input`,
          )
          ?.focus();
      });
    },
    [markLayoutChanged],
  );

  const closePane = useCallback(
    (paneId: WorkspacePaneId): void => {
      if (paneId === PRIMARY_PANE_ID || !leafIds.includes(paneId)) return;
      void disposePaneSession(paneId).catch(() => {});
      for (const stop of resizeCleanupRef.current.values()) stop();
      setConfirmPaneCloseId(null);
      setConfirmTerminalCloseId(null);
      inputActionsRef.current.delete(paneId);
      setSnapshots((previous) => {
        const next = { ...previous };
        delete next[paneId];
        return next;
      });
      let nextFocus: WorkspacePaneId | null = null;
      setLayout((previous) => {
        const next = removeWorkspacePane(previous, paneId);
        nextFocus = next.focusedPaneId;
        focusedPaneIdRef.current = next.focusedPaneId;
        activePaneIdsRef.current = new Set(workspaceLayoutLeafIds(next.root));
        return next;
      });
      markLayoutChanged();
      requestAnimationFrame(() => {
        if (nextFocus) inputActionsRef.current.get(nextFocus)?.focus();
      });
    },
    [leafIds, markLayoutChanged],
  );

  const requestPaneClose = useCallback(
    (paneId: WorkspacePaneId): void => {
      if (snapshots[paneId]?.activeWork) setConfirmPaneCloseId(paneId);
      else closePane(paneId);
    },
    [closePane, snapshots],
  );

  const requestTerminalPaneClose = useCallback(
    (paneId: WorkspacePaneId, running: boolean): void => {
      if (running) setConfirmTerminalCloseId(paneId);
      else closePane(paneId);
    },
    [closePane],
  );

  const restartTerminalPane = useCallback(
    async (paneId: WorkspacePaneId, target: WorkspacePaneTarget): Promise<void> => {
      const descriptor = layout.panes[paneId];
      if (descriptor?.kind !== "terminal") throw new Error("terminal pane target is unavailable");
      if (descriptor.cwd !== target.cwd || descriptor.sessionPath !== target.sessionPath) {
        throw new Error("terminal pane target changed before restart");
      }
      await registerStoppedTerminalTarget(paneId, descriptor.cwd, descriptor.sessionPath);
    },
    [layout.panes],
  );

  const resizeByKeyboard = useCallback(
    (
      event: React.KeyboardEvent<HTMLDivElement>,
      path: WorkspaceLayoutPath,
      direction: SplitDirection,
      ratio: number,
    ): void => {
      const bounds = event.currentTarget.parentElement?.getBoundingClientRect();
      const size = direction === "horizontal" ? (bounds?.width ?? 0) : (bounds?.height ?? 0);
      const available = Math.max(0, size - DIVIDER_WIDTH_PX);
      let nextRatio: number | null = null;
      if (event.key === "Home") nextRatio = ratioBounds(size).min;
      else if (event.key === "End") nextRatio = ratioBounds(size).max;
      else {
        const negative = direction === "horizontal" ? "ArrowLeft" : "ArrowUp";
        const positive = direction === "horizontal" ? "ArrowRight" : "ArrowDown";
        if (event.key === negative || event.key === positive) {
          const sign = event.key === negative ? -1 : 1;
          const step = event.shiftKey ? KEYBOARD_RESIZE_STEP_PX * 4 : KEYBOARD_RESIZE_STEP_PX;
          nextRatio = ratio + sign * (available > 0 ? (step / available) * 100 : 0);
        }
      }
      if (nextRatio === null) return;
      event.preventDefault();
      markLayoutChanged();
      setLayout((previous) =>
        updateWorkspaceSplitRatio(previous, path, clampRatio(nextRatio!, size)),
      );
    },
    [markLayoutChanged],
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
      event.currentTarget.focus();
      const key = path.join("/") || "root";
      resizeCleanupRef.current.get(key)?.();
      const pointerId = event.pointerId;
      const startPosition = direction === "horizontal" ? event.clientX : event.clientY;
      const bounds = event.currentTarget.parentElement?.getBoundingClientRect();
      const size = direction === "horizontal" ? (bounds?.width ?? 0) : (bounds?.height ?? 0);
      const available = Math.max(0, size - DIVIDER_WIDTH_PX);
      const previousCursor = document.body.style.cursor;
      const previousUserSelect = document.body.style.userSelect;
      document.body.style.cursor = direction === "horizontal" ? "col-resize" : "row-resize";
      document.body.style.userSelect = "none";
      const stop = (): void => {
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", onPointerEnd);
        window.removeEventListener("pointercancel", onPointerEnd);
        document.body.style.cursor = previousCursor;
        document.body.style.userSelect = previousUserSelect;
        resizeCleanupRef.current.delete(key);
      };
      const onPointerMove = (moveEvent: PointerEvent): void => {
        if (moveEvent.pointerId !== pointerId || available === 0) return;
        const current = direction === "horizontal" ? moveEvent.clientX : moveEvent.clientY;
        markLayoutChanged();
        setLayout((previous) =>
          updateWorkspaceSplitRatio(
            previous,
            path,
            clampRatio(ratio + ((current - startPosition) / available) * 100, size),
          ),
        );
      };
      const onPointerEnd = (endEvent: PointerEvent): void => {
        if (endEvent.pointerId === pointerId) stop();
      };
      resizeCleanupRef.current.set(key, stop);
      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerEnd);
      window.addEventListener("pointercancel", onPointerEnd);
    },
    [markLayoutChanged],
  );

  const openPaneWindow = useCallback(
    async (paneId: WorkspacePaneId): Promise<void> => {
      if (openingPaneIdRef.current !== null) return;
      const descriptor = layout.panes[paneId];
      if (!descriptor) return;
      const validTarget =
        typeof descriptor.cwd === "string" &&
        Boolean(descriptor.cwd.trim()) &&
        (descriptor.sessionPath === null || typeof descriptor.sessionPath === "string");
      const terminalTarget =
        descriptor.kind === "terminal" && descriptor.stopped === true && validTarget
          ? { cwd: descriptor.cwd, sessionPath: descriptor.sessionPath }
          : null;
      const validAgent =
        (descriptor.kind === undefined || descriptor.kind === "agent") && validTarget;
      if (!terminalTarget && !validAgent) return;
      openingPaneIdRef.current = paneId;
      setOpeningPaneId(paneId);
      try {
        if (terminalTarget) await openTerminalInNewWindow(terminalTarget);
        else await openPaneInNewWindow(paneId);
      } catch (error) {
        toast(
          `Couldn't open pane in a new window: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      } finally {
        if (openingPaneIdRef.current === paneId) {
          openingPaneIdRef.current = null;
          setOpeningPaneId(null);
        }
      }
    },
    [layout.panes],
  );

  const focusedSnapshot = snapshots[layout.focusedPaneId];
  const focusedDescriptor = layout.panes[layout.focusedPaneId];
  const canOpenTerminal =
    leafIds.length < MAX_WORKSPACE_LAYOUT_LEAVES &&
    focusedDescriptor?.kind !== "terminal" &&
    Boolean(
      focusedDescriptor?.cwd &&
      focusedSnapshot?.restoreChecked &&
      focusedSnapshot.projectBound &&
      focusedSnapshot.cwd === focusedDescriptor.cwd &&
      focusedSnapshot.sessionPath === focusedDescriptor.sessionPath,
    );
  const canSplit =
    leafIds.length < MAX_WORKSPACE_LAYOUT_LEAVES &&
    (focusedDescriptor?.kind === "terminal" ||
      leafIds.filter((paneId) => layout.panes[paneId]?.kind !== "terminal").length <
        MAX_WORKSPACE_PANES);
  const canRearrange = leafIds.length > 1;

  return (
    <div
      className={`workspace-shell${activePaneDrag ? " pane-drag-active" : ""}`}
      style={{ background: theme.background }}
    >
      {confettiNonce && <Confetti key={confettiNonce} />}
      <Toaster />
      <div className="workspace-toolbar" data-tauri-drag-region>
        <RankBadge snapshot={progress} onClick={() => setShowScorecard(true)} />
        <ProjectNotes cwd={focusedSnapshot?.cwd ?? null} />
        <button
          type="button"
          className="workspace-terminal-open"
          disabled={!canOpenTerminal}
          aria-label="Open terminal in focused pane"
          title="Runs your default shell with your user permissions"
          onClick={addTerminalLeaf}
        >
          Terminal
        </button>
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
        {windowTotal > 1 && windowIndex !== null && (
          <span
            className="window-index"
            data-tauri-drag-region
          >{`${windowIndex}/${windowTotal}`}</span>
        )}
      </div>
      <p id={PANE_DRAG_INSTRUCTIONS_ID} className="visually-hidden">
        Drag this handle onto the left, right, top, or bottom edge of another workspace pane. Press
        Escape to cancel.
      </p>
      <div className="visually-hidden" aria-live="polite" aria-atomic="true">
        {rearrangementAnnouncement}
      </div>
      <div className="workspace-grid" data-pane-count={String(leafIds.length)}>
        <WorkspaceNode
          node={layout.root}
          focusedPaneId={layout.focusedPaneId}
          panes={layout.panes}
          layoutReady={layoutReady}
          layoutManaged={layoutManaged}
          windowFocused={windowFocused}
          snapshots={snapshots}
          canSplit={canSplit}
          openingPaneId={openingPaneId}
          rearrangementEnabled={rearrangementEnabled}
          activePaneDragSourceId={activePaneDrag?.sourcePaneId ?? null}
          hoveredPaneDrop={hoveredPaneDrop}
          dragInstructionsId={PANE_DRAG_INSTRUCTIONS_ID}
          renderPane={renderPane}
          onFocusPane={focusPane}
          onSnapshot={updateSnapshot}
          onUserTargetChange={markLayoutChanged}
          registerInput={registerInput}
          onRequestTerminalPaneClose={requestTerminalPaneClose}
          onRestartTerminalPane={restartTerminalPane}
          onOpenPaneWindow={(paneId) => void openPaneWindow(paneId)}
          onSplitFocusedPane={splitFocusedPane}
          onRequestPaneClose={requestPaneClose}
          onPaneDragStart={startPaneDrag}
          onPaneDragEnd={finishPaneDrag}
          onPaneDropHover={hoverPaneDrop}
          onPaneDrop={commitPaneDrop}
          onPaneDropReject={cancelPaneDrag}
          onResizeByKeyboard={resizeByKeyboard}
          onStartPointerResize={startPointerResize}
        />
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
      {confirmTerminalCloseId && (
        <ConfirmModal
          title="Close Terminal"
          message="A shell is still running. Closing the terminal will stop it and its child processes."
          confirmLabel="Close Terminal"
          onConfirm={() => closePane(confirmTerminalCloseId)}
          onClose={() => setConfirmTerminalCloseId(null)}
        />
      )}
      {confirmPaneCloseId && (
        <ConfirmModal
          title="Close Pane"
          message="Work is active in this pane. Closing it will stop that session. Close anyway?"
          confirmLabel="Close Pane"
          onConfirm={() => closePane(confirmPaneCloseId)}
          onClose={() => setConfirmPaneCloseId(null)}
        />
      )}
      {showScorecard && progress && (
        <ScorecardModal snapshot={progress} onClose={() => setShowScorecard(false)} />
      )}
    </div>
  );
}
