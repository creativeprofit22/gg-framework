/* eslint-disable react-hooks/refs -- The stable lifecycle dispatcher reads its ref only when a child invokes it outside render. */
import { useCallback, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { CopyPlus, GripVertical, PanelBottom, PanelRight } from "lucide-react";
import { AgentPane, type AgentPaneProps } from "./AgentPane";
import { PaneDropOverlay, PANE_DRAG_MIME } from "./PaneDropOverlay";
import { PRIMARY_PANE_ID } from "./pane-routing";
import { PaneSwapButton } from "./PaneSwapButton";
import {
  PANE_SWAP_HELP_ID,
  PANE_SWAP_CLOSING_REASON,
  type WorkspacePaneSwaps,
} from "./useWorkspacePaneSwaps";
import {
  MAX_SPLIT_RATIO,
  MIN_SPLIT_RATIO,
  type PaneMoveRequest,
  type PanePlacement,
  type SplitDirection,
  type WorkspaceLayoutNode,
  type WorkspaceLayoutPath,
  type WorkspacePaneId,
  type WorkspacePaneValue,
} from "./workspace-layout";

import { workspaceGeometry, rectStyle, dividerStyle } from "./workspace-geometry";

export interface WorkspaceNodeProps {
  node: WorkspaceLayoutNode;
  swaps?: WorkspacePaneSwaps;
  path?: WorkspaceLayoutPath;
  focusedPaneId: WorkspacePaneId;
  panes: Record<string, WorkspacePaneValue>;
  windowFocused: boolean;
  canSplit: boolean;
  rearrangementEnabled: boolean;
  activePaneDragSourceId: WorkspacePaneId | null;
  hoveredPaneDrop: { targetPaneId: WorkspacePaneId; placement: PanePlacement } | null;
  dragInstructionsId: string;
  renderPane?: (props: AgentPaneProps) => React.ReactNode;
  onFocusPane: (paneId: WorkspacePaneId) => void;
  onSnapshot: NonNullable<AgentPaneProps["onSnapshot"]>;
  onGenerationChange: (paneId: WorkspacePaneId, generation: number) => void;
  onLifecycleError: (paneId: WorkspacePaneId, error: unknown) => void;
  registerInput: NonNullable<AgentPaneProps["registerInput"]>;
  onSplitPane: (paneId: WorkspacePaneId, direction: SplitDirection) => void;
  onCopyPane: (paneId: WorkspacePaneId) => void;
  copyingPaneId: WorkspacePaneId | null;
  closingPaneIds: ReadonlySet<WorkspacePaneId>;
  onClosePane: (paneId: WorkspacePaneId) => void;
  onPaneDragStart: (paneId: WorkspacePaneId, handle: HTMLButtonElement) => void;
  onPaneDragEnd: (paneId: WorkspacePaneId) => void;
  onPaneDropHover: (targetPaneId: WorkspacePaneId, placement: PanePlacement | null) => void;
  onPaneDrop: (request: PaneMoveRequest) => void;
  onPaneDropReject: () => void;
  onResizeByKeyboard: (
    event: React.KeyboardEvent<HTMLDivElement>,
    path: WorkspaceLayoutPath,
    direction: SplitDirection,
    ratio: number,
  ) => void;
  onStartPointerResize: (
    event: React.PointerEvent<HTMLDivElement>,
    path: WorkspaceLayoutPath,
    direction: SplitDirection,
    ratio: number,
  ) => void;
}

function isPaneDragHandle(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(".pane-drag-handle") !== null;
}

export function WorkspaceNode({ path = [], ...props }: WorkspaceNodeProps): React.ReactElement {
  const { paneGeometry, dividerGeometry } = workspaceGeometry(props.node, path);

  return (
    <>
      {Object.keys(props.panes).map((paneId) => {
        const geometry = paneGeometry.get(paneId);
        return geometry ? (
          <WorkspaceAgentLeaf
            key={`pane:${paneId}`}
            paneId={paneId}
            style={rectStyle(geometry.rect)}
            {...props}
          />
        ) : null;
      })}
      {dividerGeometry.map((divider) => {
        const horizontal = divider.direction === "horizontal";
        return (
          <div
            key={`divider:${divider.key}`}
            className={`workspace-split workspace-split-${divider.direction}`}
            data-direction={divider.direction}
            data-split-ratio={divider.ratio}
            style={rectStyle(divider.rect)}
          >
            <div
              aria-controls={divider.controlledPaneIds
                .map((paneId) => `workspace-pane-${paneId}`)
                .join(" ")}
              aria-label={`Resize ${divider.direction} workspace panes`}
              aria-orientation={horizontal ? "vertical" : "horizontal"}
              aria-valuemax={MAX_SPLIT_RATIO}
              aria-valuemin={MIN_SPLIT_RATIO}
              aria-valuenow={Math.round(divider.ratio)}
              className={`workspace-divider workspace-divider-${divider.direction}`}
              onKeyDown={(event) =>
                props.onResizeByKeyboard(event, divider.path, divider.direction, divider.ratio)
              }
              onPointerDown={(event) =>
                props.onStartPointerResize(event, divider.path, divider.direction, divider.ratio)
              }
              role="separator"
              style={dividerStyle(divider.direction, divider.ratio)}
              tabIndex={0}
            >
              <span className="workspace-divider-line" />
            </div>
          </div>
        );
      })}
    </>
  );
}

function WorkspaceAgentLeaf({
  paneId,
  style,
  swaps,
  focusedPaneId,
  panes,
  windowFocused,
  canSplit,
  rearrangementEnabled,
  activePaneDragSourceId,
  hoveredPaneDrop,
  dragInstructionsId,
  renderPane,
  onFocusPane,
  onSnapshot,
  onGenerationChange,
  onLifecycleError,
  registerInput,
  onSplitPane,
  onCopyPane,
  copyingPaneId,
  closingPaneIds,
  onClosePane,
  onPaneDragStart,
  onPaneDragEnd,
  onPaneDropHover,
  onPaneDrop,
  onPaneDropReject,
}: Omit<WorkspaceNodeProps, "node" | "path"> & {
  paneId: WorkspacePaneId;
  style: CSSProperties;
}): React.ReactElement {
  const focused = focusedPaneId === paneId;
  const lifecycleErrorContextRef = useRef({ paneId, onLifecycleError });
  useLayoutEffect(() => {
    lifecycleErrorContextRef.current = { paneId, onLifecycleError };
  }, [paneId, onLifecycleError]);
  const dispatchLifecycleError = useCallback((error: unknown): void => {
    const current = lifecycleErrorContextRef.current;
    current.onLifecycleError(current.paneId, error);
  }, []);
  const [initialTarget] = useState(() => {
    const descriptor = panes[paneId];
    if (!descriptor) return null;
    return {
      mode: descriptor.mode,
      cwd: descriptor.cwd,
      sessionPath: descriptor.sessionPath,
      ...(descriptor.mode === "chat" ? { chatAgent: descriptor.chatAgent ?? "general" } : {}),
    };
  });
  const paneProps: AgentPaneProps = {
    paneId,
    kind: paneId === PRIMARY_PANE_ID ? "primary" : "auxiliary",
    focused,
    windowFocused,
    initialTarget,
    onFocus: onFocusPane,
    onSnapshot,
    onGenerationChange: (generation) => onGenerationChange(paneId, generation),
    onLifecycleError: dispatchLifecycleError,
    workspaceOwnsSessionLifecycle: true,
    registerInput,
    registerSwapViewState: swaps?.registerViewState,
    preserveWorkspaceFocus: swaps?.preserveFocus,
  };

  const registerHost = swaps?.registerHost;
  const registerButton = swaps?.registerButton;
  const hostRef = useCallback(
    (el: HTMLElement | null) => registerHost?.(paneId, el),
    [paneId, registerHost],
  );
  const buttonRef = useCallback(
    (el: HTMLButtonElement | null) => registerButton?.(paneId, el),
    [paneId, registerButton],
  );
  const leftSwapRef = useCallback(
    (el: HTMLButtonElement | null) => registerButton?.(`${paneId}:left`, el),
    [paneId, registerButton],
  );
  const rightSwapRef = useCallback(
    (el: HTMLButtonElement | null) => registerButton?.(`${paneId}:right`, el),
    [paneId, registerButton],
  );
  const swapRow = swaps?.rows.get(paneId);
  return (
    <section
      ref={hostRef}
      tabIndex={-1}
      aria-label={`Conversation ${paneId}`}
      className={`workspace-pane-slot${focused ? " pane-focused" : ""}`}
      data-pane-id={paneId}
      id={`workspace-pane-${paneId}`}
      style={style}
      onPointerDownCapture={(event) => {
        if (!isPaneDragHandle(event.target)) onFocusPane(paneId);
      }}
      onFocusCapture={(event) => {
        if (!isPaneDragHandle(event.target)) onFocusPane(paneId);
      }}
    >
      <div className="workspace-pane-body">
        {renderPane ? renderPane(paneProps) : <AgentPane {...paneProps} />}
      </div>
      {rearrangementEnabled && (
        <button
          type="button"
          className="pane-drag-handle pane-drag-handle-agent"
          draggable
          data-pane-drag-handle={paneId}
          aria-label={`Move pane ${paneId}`}
          aria-describedby={dragInstructionsId}
          title="Drag to move this pane"
          onDragStart={(event) => {
            event.dataTransfer.setData(PANE_DRAG_MIME, paneId);
            event.dataTransfer.setData("text/plain", paneId);
            event.dataTransfer.effectAllowed = "move";
            onPaneDragStart(paneId, event.currentTarget);
          }}
          onDragEnd={() => onPaneDragEnd(paneId)}
        >
          <GripVertical size={15} aria-hidden="true" />
        </button>
      )}
      {activePaneDragSourceId && (
        <PaneDropOverlay
          enabled={rearrangementEnabled}
          sourcePaneId={activePaneDragSourceId}
          targetPaneId={paneId}
          hoveredPlacement={
            hoveredPaneDrop?.targetPaneId === paneId ? hoveredPaneDrop.placement : null
          }
          onHover={onPaneDropHover}
          onDrop={onPaneDrop}
          onReject={onPaneDropReject}
        />
      )}
      <div className="workspace-pane-actions" aria-label="Pane actions">
        {focused && (
          <>
            <button
              type="button"
              aria-label="Copy to New Window"
              title="Copy to New Window"
              disabled={copyingPaneId !== null}
              onClick={() => onCopyPane(paneId)}
            >
              <CopyPlus size={15} aria-hidden="true" />
            </button>
            <button
              type="button"
              aria-label="Split Right"
              title="Split Right"
              disabled={!canSplit}
              onClick={() => onSplitPane(paneId, "horizontal")}
            >
              <PanelRight size={15} aria-hidden="true" />
            </button>
            <button
              type="button"
              aria-label="Split Down"
              title="Split Down"
              disabled={!canSplit}
              onClick={() => onSplitPane(paneId, "vertical")}
            >
              <PanelBottom size={15} aria-hidden="true" />
            </button>
          </>
        )}
        {swaps &&
          swapRow?.available &&
          !closingPaneIds.has(paneId) &&
          (swapRow.middleId !== paneId ? (
            <PaneSwapButton
              paneId={paneId}
              label={`conversation ${paneId}`}
              helpId={PANE_SWAP_HELP_ID}
              unavailableReason={
                closingPaneIds.has(swapRow.middleId) ? PANE_SWAP_CLOSING_REASON : undefined
              }
              buttonRef={buttonRef}
              onSwap={swaps.swap}
            />
          ) : (
            <>
              {swapRow.paneIds.indexOf(paneId) > 0 && (
                <PaneSwapButton
                  paneId={paneId}
                  direction="left"
                  label={`conversation ${paneId}`}
                  helpId={PANE_SWAP_HELP_ID}
                  buttonRef={leftSwapRef}
                  unavailableReason={
                    closingPaneIds.has(swapRow.paneIds[swapRow.paneIds.indexOf(paneId) - 1])
                      ? PANE_SWAP_CLOSING_REASON
                      : undefined
                  }
                  onSwap={(id, _button, keyboard) => swaps.swapFromMiddle(id, "left", keyboard)}
                />
              )}
              {swapRow.paneIds.indexOf(paneId) < swapRow.paneIds.length - 1 && (
                <PaneSwapButton
                  paneId={paneId}
                  direction="right"
                  label={`conversation ${paneId}`}
                  helpId={PANE_SWAP_HELP_ID}
                  buttonRef={rightSwapRef}
                  unavailableReason={
                    closingPaneIds.has(swapRow.paneIds[swapRow.paneIds.indexOf(paneId) + 1])
                      ? PANE_SWAP_CLOSING_REASON
                      : undefined
                  }
                  onSwap={(id, _button, keyboard) => swaps.swapFromMiddle(id, "right", keyboard)}
                />
              )}
            </>
          ))}
      </div>
      {paneId !== PRIMARY_PANE_ID && (
        <button
          type="button"
          className="workspace-pane-close"
          aria-label={
            closingPaneIds.has(paneId) ? `Closing ${paneId} pane` : `Close ${paneId} pane`
          }
          title={closingPaneIds.has(paneId) ? `Closing ${paneId} pane` : `Close ${paneId} pane`}
          disabled={closingPaneIds.has(paneId)}
          onClick={() => onClosePane(paneId)}
        >
          <span aria-hidden="true">×</span>
        </button>
      )}
    </section>
  );
}
