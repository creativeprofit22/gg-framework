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
import { ConfirmModal } from "./ConfirmModal";
import { PRODUCT_DISPLAY_NAME } from "./brand";
import { PRIMARY_PANE_ID, SECONDARY_PANE_ID } from "./pane-routing";
import { ProjectNotes } from "./ProjectNotes";
import { RankBadge } from "./RankBadge";
import { ScorecardModal } from "./ScorecardModal";
import { playSound } from "./sounds";
import { theme } from "./theme";
import { toast } from "./toast";
import { Toaster } from "./Toaster";
import { TerminalPane } from "./TerminalPane";
import { useAppUpdate } from "./update";
import { useProgress } from "./useProgress";
import {
  clampStoredTerminalDockHeightPx,
  loadWorkspaceLayout,
  preserveRejectedRecursiveWorkspaceLayout,
  preserveRejectedWorkspaceLayout,
  WORKSPACE_LAYOUT_VERSION,
  resolveWorkspaceLayoutTargets,
  saveWorkspaceLayout,
  type WorkspaceLayout,
  type WorkspaceLayoutNode,
  type WorkspacePaneId,
} from "./workspace-layout";

const PANE_IDS = [PRIMARY_PANE_ID, SECONDARY_PANE_ID] as const;
const DIVIDER_WIDTH_PX = 9;
const MIN_PANE_WIDTH_PX = 280;
const KEYBOARD_RESIZE_STEP_PX = 24;
const MIN_DOCK_HEIGHT_PX = 140;
const MAX_DOCK_HEIGHT_PX = 2_000;
const MAX_DOCK_HEIGHT_RATIO = 0.6;
const MALFORMED_LAYOUT_WARNING = "Saved workspace layout was invalid. A safe layout was restored.";
const LAYOUT_LOAD_ERROR_WARNING =
  "Saved workspace layout could not be loaded. A safe layout was restored.";
const STALE_TARGET_WARNING =
  "Some saved workspace panes were unavailable. A safe layout was restored.";
const MISSING_TERMINAL_OWNER_WARNING =
  "Saved terminal project was unavailable. The terminal stayed closed.";
const INVALID_TERMINAL_SIZE_WARNING =
  "Saved terminal size was unavailable. A safe size was restored.";

interface TerminalDock {
  ownerPaneId: WorkspacePaneId;
  cwd: string;
}

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

function clampDockHeight(height: number, availableHeight: number): number {
  if (availableHeight <= 0) return height;
  const maximum = Math.min(MAX_DOCK_HEIGHT_PX, availableHeight * MAX_DOCK_HEIGHT_RATIO);
  return Math.max(0, Math.min(height, maximum));
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

interface WorkspaceSplitProps {
  node: Extract<WorkspaceLayoutNode, { type: "split" }>;
  renderNode: (node: WorkspaceLayoutNode) => React.ReactNode;
  divider?: React.ReactNode;
  ratio?: number;
  collapsedSecond?: boolean;
  enforcePaneMinimum?: boolean;
}

function WorkspaceSplit({
  node,
  renderNode,
  divider,
  ratio = node.ratio,
  collapsedSecond = false,
  enforcePaneMinimum = false,
}: WorkspaceSplitProps) {
  const horizontal = node.direction === "horizontal";
  return (
    <div
      className={`workspace-split workspace-split-${node.direction}`}
      data-direction={node.direction}
      data-split-ratio={ratio}
      style={
        collapsedSecond
          ? { gridTemplateColumns: "minmax(0, 1fr)" }
          : horizontal
            ? {
                gridTemplateColumns: enforcePaneMinimum
                  ? `minmax(min(${MIN_PANE_WIDTH_PX}px, calc((100% - ${DIVIDER_WIDTH_PX}px) / 2)), ${ratio}fr) ${DIVIDER_WIDTH_PX}px minmax(min(${MIN_PANE_WIDTH_PX}px, calc((100% - ${DIVIDER_WIDTH_PX}px) / 2)), ${100 - ratio}fr)`
                  : `${ratio}fr ${DIVIDER_WIDTH_PX}px ${100 - ratio}fr`,
              }
            : { gridTemplateRows: `${ratio}fr ${DIVIDER_WIDTH_PX}px ${100 - ratio}fr` }
      }
    >
      {renderNode(node.first)}
      {!collapsedSecond &&
        (divider ?? (
          <div
            className={`workspace-divider workspace-divider-${node.direction}`}
            aria-orientation={horizontal ? "vertical" : "horizontal"}
            role="separator"
          >
            <span className="workspace-divider-line" />
          </div>
        ))}
      {!collapsedSecond && renderNode(node.second)}
    </div>
  );
}

function isRenderableShellTree(root: WorkspaceLayoutNode, secondaryOpen: boolean): boolean {
  const ids: string[] = [];
  const visit = (node: WorkspaceLayoutNode): boolean => {
    if (node.type === "leaf") {
      ids.push(node.paneId);
      return node.paneId === PRIMARY_PANE_ID || node.paneId === SECONDARY_PANE_ID;
    }
    return visit(node.first) && visit(node.second);
  };
  if (!visit(root) || new Set(ids).size !== ids.length) return false;
  return secondaryOpen
    ? ids.length === 2 && ids.includes(PRIMARY_PANE_ID) && ids.includes(SECONDARY_PANE_ID)
    : (ids.length === 1 && ids[0] === PRIMARY_PANE_ID) ||
        (ids.length === 2 && ids[0] === PRIMARY_PANE_ID && ids[1] === SECONDARY_PANE_ID);
}

function fixedShellTree(secondaryOpen: boolean, ratio: number): WorkspaceLayoutNode {
  return secondaryOpen
    ? {
        type: "split",
        direction: "horizontal",
        ratio,
        first: { type: "leaf", paneId: PRIMARY_PANE_ID },
        second: { type: "leaf", paneId: SECONDARY_PANE_ID },
      }
    : { type: "leaf", paneId: PRIMARY_PANE_ID };
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
  const [focusedPaneId, setFocusedPaneId] = useState<WorkspacePaneId>(
    loadedLayout.layout.focusedPaneId,
  );
  const [secondaryOpen, setSecondaryOpen] = useState(loadedLayout.layout.secondaryOpen);
  const [confirmSecondaryClose, setConfirmSecondaryClose] = useState(false);
  const focusedPaneIdRef = useRef(focusedPaneId);
  const [windowFocused, setWindowFocused] = useState(true);
  const [snapshots, setSnapshots] = useState<Record<string, PaneSnapshot>>({});
  const [terminalDock, setTerminalDock] = useState<TerminalDock | null>(null);
  const [terminalIntent, setTerminalIntent] = useState<WorkspaceLayout["terminal"]>(
    loadedLayout.layout.terminal,
  );
  const [terminalReady, setTerminalReady] = useState(!layoutManaged);
  const terminalRestoreStartedRef = useRef(false);
  const [terminalRunning, setTerminalRunning] = useState(false);
  const [confirmTerminalClose, setConfirmTerminalClose] = useState(false);
  const inputActionsRef = useRef(new Map<string, PaneInputActions>());
  const [windowIndex, setWindowIndex] = useState<number | null>(null);
  const [windowTotal, setWindowTotal] = useState(1);
  const [showScorecard, setShowScorecard] = useState(false);
  const [confettiNonce, setConfettiNonce] = useState<string | null>(null);
  const [primaryPaneRatio, setPrimaryPaneRatio] = useState(loadedLayout.layout.splitRatio);
  const [renderRoot, setRenderRoot] = useState(loadedLayout.layout.root);
  const [workspaceWidth, setWorkspaceWidth] = useState(0);
  const loadedDockHeight = clampStoredTerminalDockHeightPx(
    "dockHeightPx" in loadedLayout.layout.terminal
      ? loadedLayout.layout.terminal.dockHeightPx
      : undefined,
  );
  const [dockHeight, setDockHeight] = useState(loadedDockHeight.value);
  const [workspaceHeight, setWorkspaceHeight] = useState(0);
  const workspaceGridRef = useRef<HTMLDivElement>(null);
  const stopPointerResizeRef = useRef<() => void>(() => undefined);
  const warnedRecoveryEventsRef = useRef(new Set<string>());
  const appUpdate = useAppUpdate();
  const { snapshot: progress, levelUp, levelUpNonce, levelUpOrigin } = useProgress();
  const focusPane = useCallback((paneId: string): void => {
    const resolvedPaneId: WorkspacePaneId =
      paneId === SECONDARY_PANE_ID ? SECONDARY_PANE_ID : PRIMARY_PANE_ID;
    focusedPaneIdRef.current = resolvedPaneId;
    setFocusedPaneId(resolvedPaneId);
  }, []);
  const markLayoutChanged = useCallback((): void => setRejectedLayoutChanged(true), []);
  const warnRecovery = useCallback((eventKey: string, message: string): void => {
    if (warnedRecoveryEventsRef.current.has(eventKey)) return;
    warnedRecoveryEventsRef.current.add(eventKey);
    toast(message, "warning", 4000, false);
  }, []);

  const updateSnapshot = useCallback((snapshot: PaneSnapshot): void => {
    setSnapshots((previous) => {
      const current = previous[snapshot.paneId];
      if (
        current?.cwd === snapshot.cwd &&
        current.sessionPath === snapshot.sessionPath &&
        current.sessionTitle === snapshot.sessionTitle &&
        current.projectBound === snapshot.projectBound &&
        current.restoreChecked === snapshot.restoreChecked &&
        current.activeWork === snapshot.activeWork
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

  const closeTerminal = useCallback((): void => {
    setConfirmTerminalClose(false);
    setTerminalRunning(false);
    setTerminalDock(null);
    setTerminalIntent((previous) => ({ ...previous, open: false, ownerPaneId: null }));
    setRejectedLayoutChanged(true);
  }, []);

  const requestTerminalClose = useCallback(
    (running: boolean): void => {
      if (running) setConfirmTerminalClose(true);
      else closeTerminal();
    },
    [closeTerminal],
  );

  const handleTerminalStartupFailure = useCallback((): void => {
    setTerminalIntent((previous) => ({ ...previous, open: false, ownerPaneId: null }));
  }, []);

  const openTerminal = useCallback((): void => {
    const snapshot = snapshots[focusedPaneId];
    if (!snapshot?.restoreChecked || !snapshot.projectBound || !snapshot.cwd || terminalDock)
      return;
    setTerminalRunning(true);
    setTerminalIntent((previous) => ({ ...previous, open: true, ownerPaneId: focusedPaneId }));
    setTerminalDock({ ownerPaneId: focusedPaneId, cwd: snapshot.cwd });
    setRejectedLayoutChanged(true);
  }, [focusedPaneId, snapshots, terminalDock]);

  useEffect(() => {
    if (!terminalDock) return;
    const owner = snapshots[terminalDock.ownerPaneId];
    if (
      !owner?.restoreChecked ||
      !owner.projectBound ||
      !owner.cwd ||
      owner.cwd !== terminalDock.cwd ||
      paneTargets[terminalDock.ownerPaneId]?.cwd !== terminalDock.cwd
    ) {
      closeTerminal();
    }
  }, [closeTerminal, paneTargets, snapshots, terminalDock]);

  useEffect(() => {
    if (
      !layoutReady ||
      !terminalReady ||
      terminalDock ||
      !terminalIntent.open ||
      terminalRestoreStartedRef.current
    )
      return;
    const ownerPaneId = terminalIntent.ownerPaneId;
    if (!ownerPaneId || (ownerPaneId === SECONDARY_PANE_ID && !secondaryOpen)) return;
    const target = paneTargets[ownerPaneId];
    const savedTarget = loadedLayout.layout.panes[ownerPaneId];
    const owner = snapshots[ownerPaneId];
    if (!owner?.restoreChecked) return;
    if (
      !target ||
      !savedTarget ||
      !owner.projectBound ||
      owner.cwd !== target.cwd ||
      owner.sessionPath !== target.sessionPath ||
      target.cwd !== savedTarget.cwd
    ) {
      setTerminalIntent((previous) => ({ ...previous, open: false, ownerPaneId: null }));
      setRejectedLayoutChanged(true);
      return;
    }
    terminalRestoreStartedRef.current = true;
    setTerminalRunning(true);
    setTerminalDock({ ownerPaneId, cwd: target.cwd });
  }, [
    layoutReady,
    loadedLayout.layout.panes,
    paneTargets,
    secondaryOpen,
    snapshots,
    terminalDock,
    terminalIntent,
    terminalReady,
  ]);

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
    const recovery = loadedLayout.terminalDockHeightRecovery;
    if (!layoutManaged || !recovery) return;
    warnRecovery(
      `invalid-terminal-size:${String(recovery.rejected)}:${recovery.resolved}`,
      INVALID_TERMINAL_SIZE_WARNING,
    );
  }, [layoutManaged, loadedLayout.terminalDockHeightRecovery, warnRecovery]);

  useEffect(() => {
    if (!layoutManaged) return;
    let cancelled = false;
    void resolveWorkspaceLayoutTargets(loadedLayout.layout, (target) =>
      validateWorkspaceTarget(target.cwd, target.sessionPath),
    )
      .then((resolved) => {
        if (cancelled) return;
        const savedTerminalOwner = loadedLayout.layout.terminal.open
          ? loadedLayout.layout.terminal.ownerPaneId
          : null;
        const terminalOwnerMissing = Boolean(
          savedTerminalOwner && !resolved.panes[savedTerminalOwner],
        );
        setPaneTargets(resolved.panes);
        setTerminalIntent(resolved.terminal);
        if (terminalOwnerMissing) {
          warnRecovery(
            `missing-terminal-owner:${savedTerminalOwner}:${JSON.stringify(
              loadedLayout.layout.panes[savedTerminalOwner!],
            )}`,
            MISSING_TERMINAL_OWNER_WARNING,
          );
        }
        const staleNonTerminalTarget = PANE_IDS.some(
          (paneId) =>
            paneId !== savedTerminalOwner &&
            JSON.stringify(resolved.panes[paneId]) !==
              JSON.stringify(loadedLayout.layout.panes[paneId]),
        );
        if (staleNonTerminalTarget) {
          warnRecovery(
            `stale:${JSON.stringify(loadedLayout.layout.panes)}:${JSON.stringify(resolved.panes)}`,
            STALE_TARGET_WARNING,
          );
        }
        setPrimaryPaneRatio(resolved.splitRatio);
        setRenderRoot(resolved.root);
        setSecondaryOpen(resolved.secondaryOpen);
        focusPane(resolved.focusedPaneId);
        setTerminalReady(true);
        setLayoutReady(true);
      })
      .catch(() => {
        if (cancelled) return;
        setPaneTargets(loadedLayout.layout.panes);
        setTerminalIntent((previous) => ({ ...previous, open: false, ownerPaneId: null }));
        setPrimaryPaneRatio(loadedLayout.layout.splitRatio);
        setRenderRoot(loadedLayout.layout.root);
        setSecondaryOpen(loadedLayout.layout.secondaryOpen);
        focusPane(loadedLayout.layout.focusedPaneId);
        setTerminalReady(true);
        setLayoutReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, [focusPane, layoutManaged, loadedLayout, warnRecovery]);

  useEffect(() => {
    if (!layoutReady || !snapshots[PRIMARY_PANE_ID]?.restoreChecked) return;
    if (secondaryOpen && !snapshots[SECONDARY_PANE_ID]?.restoreChecked) return;
    if (loadedLayout.status === "corrupt" && !rejectedLayoutChanged) return;
    saveWorkspaceLayout(localStorage, windowLabel, {
      version: WORKSPACE_LAYOUT_VERSION,
      root: secondaryOpen ? renderRoot : fixedShellTree(false, primaryPaneRatio),
      splitRatio: primaryPaneRatio,
      secondaryOpen,
      focusedPaneId,
      panes: paneTargets,
      terminal: { ...terminalIntent, dockHeightPx: dockHeight },
    });
  }, [
    dockHeight,
    focusedPaneId,
    layoutReady,
    loadedLayout.status,
    paneTargets,
    primaryPaneRatio,
    rejectedLayoutChanged,
    renderRoot,
    secondaryOpen,
    snapshots,
    terminalIntent,
    terminalReady,
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
      const inTerminal =
        event.target instanceof Element && event.target.closest(".terminal-pane") !== null;
      const reservedTerminalChord =
        (!event.shiftKey && (event.key === "1" || event.key === "2")) || event.code === "Backquote";
      if (inTerminal && !reservedTerminalChord) return;
      if (!event.shiftKey && event.key === "1") {
        event.preventDefault();
        focusPane(PRIMARY_PANE_ID);
        inputActionsRef.current.get(PRIMARY_PANE_ID)?.focus();
      } else if (!event.shiftKey && event.key === "2" && secondaryOpen) {
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
  }, [focusPane, secondaryOpen]);

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
      const bounds = workspaceGridRef.current?.getBoundingClientRect();
      setWorkspaceWidth(bounds?.width ?? 0);
      setWorkspaceHeight(bounds?.height ?? 0);
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
      const clampedRatio = clampRatio(nextRatio, containerWidth);
      setPrimaryPaneRatio(clampedRatio);
      setRenderRoot((previous) =>
        previous.type === "split" ? { ...previous, ratio: clampedRatio } : previous,
      );
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
        const clampedRatio = clampRatio(startRatio + deltaRatio, containerWidth);
        setPrimaryPaneRatio(clampedRatio);
        setRenderRoot((previous) =>
          previous.type === "split" ? { ...previous, ratio: clampedRatio } : previous,
        );
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

  const closeSecondary = useCallback((): void => {
    stopPointerResizeRef.current();
    setConfirmSecondaryClose(false);
    if (terminalDock?.ownerPaneId === SECONDARY_PANE_ID) {
      setConfirmTerminalClose(false);
      setTerminalRunning(false);
      setTerminalDock(null);
      setTerminalIntent((previous) => ({ ...previous, open: false, ownerPaneId: null }));
    }
    setRejectedLayoutChanged(true);
    setSecondaryOpen(false);
    setPaneTargets((previous) => ({ ...previous, secondary: null }));
    setSnapshots((previous) => {
      const { secondary: _secondary, ...remaining } = previous;
      return remaining;
    });
    focusPane(PRIMARY_PANE_ID);
    requestAnimationFrame(() => inputActionsRef.current.get(PRIMARY_PANE_ID)?.focus());
  }, [focusPane, terminalDock]);

  const requestSecondaryClose = useCallback((): void => {
    const ownsRunningTerminal = terminalRunning && terminalDock?.ownerPaneId === SECONDARY_PANE_ID;
    if (snapshots[SECONDARY_PANE_ID]?.activeWork || ownsRunningTerminal) {
      setConfirmSecondaryClose(true);
      return;
    }
    closeSecondary();
  }, [closeSecondary, snapshots, terminalDock, terminalRunning]);

  const reopenSecondary = useCallback((): void => {
    setRejectedLayoutChanged(true);
    setPaneTargets((previous) => ({ ...previous, secondary: null }));
    setSecondaryOpen(true);
    setRenderRoot(fixedShellTree(true, primaryPaneRatio));
    focusPane(SECONDARY_PANE_ID);
    requestAnimationFrame(() => {
      document
        .querySelector<HTMLElement>(
          "#workspace-pane-secondary button, #workspace-pane-secondary input",
        )
        ?.focus();
    });
  }, [focusPane, primaryPaneRatio]);

  const focusedSnapshot = snapshots[focusedPaneId];
  const canOpenTerminal =
    !terminalDock &&
    Boolean(focusedSnapshot?.restoreChecked && focusedSnapshot.projectBound && focusedSnapshot.cwd);
  const visiblePaneRatio = clampRatio(primaryPaneRatio, workspaceWidth);
  const visibleDockHeight = clampDockHeight(dockHeight, workspaceHeight);
  const shellRoot = isRenderableShellTree(renderRoot, secondaryOpen)
    ? renderRoot
    : fixedShellTree(secondaryOpen, primaryPaneRatio);
  const rootIsResizable =
    shellRoot.type === "split" &&
    shellRoot.direction === "horizontal" &&
    shellRoot.first.type === "leaf" &&
    shellRoot.first.paneId === PRIMARY_PANE_ID &&
    shellRoot.second.type === "leaf" &&
    shellRoot.second.paneId === SECONDARY_PANE_ID &&
    secondaryOpen;

  const renderLeaf = (paneId: WorkspacePaneId): React.ReactElement => (
    <div
      className="workspace-pane-slot"
      data-pane-id={paneId}
      id={`workspace-pane-${paneId}`}
      key={paneId}
      onPointerDownCapture={() => focusPane(paneId)}
      onFocusCapture={() => focusPane(paneId)}
    >
      <div className="workspace-pane-body">
        {layoutReady && (
          <PaneContent
            renderPane={renderPane}
            paneProps={{
              paneId,
              kind: paneId === PRIMARY_PANE_ID ? "primary" : "secondary",
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
        {terminalReady &&
          terminalDock?.ownerPaneId === paneId &&
          snapshots[paneId]?.restoreChecked &&
          snapshots[paneId]?.projectBound &&
          snapshots[paneId]?.cwd === terminalDock.cwd &&
          paneTargets[paneId]?.cwd === terminalDock.cwd && (
            <TerminalPane
              key={`${paneId}:${terminalDock.cwd}`}
              paneId={paneId}
              height={visibleDockHeight}
              onHeightChange={(height) =>
                setDockHeight(Math.min(MAX_DOCK_HEIGHT_PX, Math.max(MIN_DOCK_HEIGHT_PX, height)))
              }
              onRequestClose={requestTerminalClose}
              onRunningChange={setTerminalRunning}
              onStartupFailure={handleTerminalStartupFailure}
            />
          )}
      </div>
      {paneId === SECONDARY_PANE_ID && (
        <button
          className="workspace-secondary-close"
          aria-label="Close secondary pane"
          title="Close secondary pane"
          onClick={requestSecondaryClose}
        >
          <span aria-hidden="true">×</span>
        </button>
      )}
    </div>
  );
  const rootDivider = rootIsResizable ? (
    <div
      aria-controls="workspace-pane-primary workspace-pane-secondary"
      aria-label="Resize workspace panes"
      aria-orientation="vertical"
      aria-valuemax={Math.round(ratioBounds(workspaceWidth).max)}
      aria-valuemin={Math.round(ratioBounds(workspaceWidth).min)}
      aria-valuenow={Math.round(visiblePaneRatio)}
      className="workspace-divider workspace-divider-horizontal"
      onKeyDown={resizeByKeyboard}
      onPointerDown={startPointerResize}
      role="separator"
      tabIndex={0}
    >
      <span className="workspace-divider-line" />
    </div>
  ) : undefined;
  const renderNode = (node: WorkspaceLayoutNode): React.ReactNode =>
    node.type === "leaf" ? (
      renderLeaf(node.paneId)
    ) : (
      <WorkspaceSplit
        key={`${node.direction}:${node.first.type === "leaf" ? node.first.paneId : "split"}:${node.second.type === "leaf" ? node.second.paneId : "split"}`}
        node={node}
        renderNode={renderNode}
        divider={node === shellRoot ? rootDivider : undefined}
        ratio={node === shellRoot && rootIsResizable ? primaryPaneRatio : node.ratio}
        collapsedSecond={node === shellRoot && !secondaryOpen}
        enforcePaneMinimum={node === shellRoot && rootIsResizable}
      />
    );
  return (
    <div className="workspace-shell" style={{ background: theme.background }}>
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
          onClick={openTerminal}
        >
          Terminal
        </button>
        {!secondaryOpen && (
          <button
            className="workspace-secondary-open"
            aria-controls="workspace-pane-secondary"
            onClick={reopenSecondary}
          >
            Open secondary pane
          </button>
        )}
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
        data-pane-count={secondaryOpen ? "2" : "1"}
      >
        {renderNode(shellRoot)}
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
      {confirmTerminalClose && (
        <ConfirmModal
          title="Close Terminal"
          message="A shell is still running. Closing the terminal will stop it and its child processes."
          confirmLabel="Close Terminal"
          onConfirm={closeTerminal}
          onClose={() => setConfirmTerminalClose(false)}
        />
      )}
      {confirmSecondaryClose && (
        <ConfirmModal
          title="Close Secondary Pane"
          message="Work is active in the secondary pane. Closing it will stop that session. Close anyway?"
          confirmLabel="Close Pane"
          onConfirm={closeSecondary}
          onClose={() => setConfirmSecondaryClose(false)}
        />
      )}
      {showScorecard && progress && (
        <ScorecardModal snapshot={progress} onClose={() => setShowScorecard(false)} />
      )}
    </div>
  );
}
