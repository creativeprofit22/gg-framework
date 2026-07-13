import { AgentPane, type AgentPaneProps, type PaneSnapshot } from "./AgentPane";
import { PRIMARY_PANE_ID } from "./pane-routing";
import { PaneSplitActions } from "./PaneSplitActions";
import { TerminalPane } from "./TerminalPane";
import {
  MAX_SPLIT_RATIO,
  MIN_SPLIT_RATIO,
  workspaceLayoutLeafIds,
  type SplitDirection,
  type WorkspaceLayoutNode,
  type WorkspaceLayoutPath,
  type WorkspacePaneId,
  type WorkspacePaneTarget,
  type WorkspacePaneValue,
} from "./workspace-layout";

const DIVIDER_WIDTH_PX = 9;

export interface WorkspaceNodeProps {
  node: WorkspaceLayoutNode;
  path?: WorkspaceLayoutPath;
  focusedPaneId: WorkspacePaneId;
  panes: Record<string, WorkspacePaneValue>;
  layoutReady: boolean;
  layoutManaged: boolean;
  windowFocused: boolean;
  snapshots: Record<string, PaneSnapshot>;
  canSplit: boolean;
  openingPaneId: WorkspacePaneId | null;
  renderPane?: (props: AgentPaneProps) => React.ReactNode;
  onFocusPane: (paneId: WorkspacePaneId) => void;
  onSnapshot: (snapshot: PaneSnapshot) => void;
  onUserTargetChange: () => void;
  registerInput: AgentPaneProps["registerInput"];
  onRequestTerminalPaneClose: (paneId: WorkspacePaneId, running: boolean) => void;
  onRestartTerminalPane: (paneId: WorkspacePaneId, target: WorkspacePaneTarget) => Promise<void>;
  onOpenPaneWindow: (paneId: WorkspacePaneId) => void;
  onSplitFocusedPane: (direction: SplitDirection) => void;
  onRequestPaneClose: (paneId: WorkspacePaneId) => void;
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

export function WorkspaceNode({ path = [], ...props }: WorkspaceNodeProps): React.ReactElement {
  const { node } = props;
  if (node.type === "leaf") {
    const descriptor = props.panes[node.paneId];
    if (descriptor?.kind === "terminal") {
      return (
        <div
          className={`workspace-pane-slot${props.focusedPaneId === node.paneId ? " pane-focused" : ""}`}
          data-pane-id={node.paneId}
          id={`workspace-pane-${node.paneId}`}
          onPointerDownCapture={() => props.onFocusPane(node.paneId)}
          onFocusCapture={() => props.onFocusPane(node.paneId)}
        >
          <div className="workspace-pane-body">
            <TerminalPane
              key={`${node.paneId}:${descriptor.cwd}:${descriptor.sessionPath ?? ""}`}
              paneId={node.paneId}
              initiallyStopped
              onRestart={() => props.onRestartTerminalPane(node.paneId, descriptor)}
              onRequestClose={(running) => props.onRequestTerminalPaneClose(node.paneId, running)}
            />
          </div>
          {props.focusedPaneId === node.paneId && (
            <PaneSplitActions
              canOpenInNewWindow={
                descriptor.stopped === true &&
                typeof descriptor.cwd === "string" &&
                Boolean(descriptor.cwd.trim()) &&
                (descriptor.sessionPath === null || typeof descriptor.sessionPath === "string")
              }
              canSplit={props.canSplit}
              openingInNewWindow={props.openingPaneId === node.paneId}
              openInNewWindowPending={props.openingPaneId !== null}
              onOpenInNewWindow={() => props.onOpenPaneWindow(node.paneId)}
              onSplitRight={() => props.onSplitFocusedPane("horizontal")}
              onSplitDown={() => props.onSplitFocusedPane("vertical")}
            />
          )}
        </div>
      );
    }
    return <WorkspaceAgentLeaf paneId={node.paneId} {...props} />;
  }
  const horizontal = node.direction === "horizontal";
  const pathKey = path.join("/") || "root";
  const firstIds = workspaceLayoutLeafIds(node.first);
  const secondIds = workspaceLayoutLeafIds(node.second);
  return (
    <div
      key={pathKey}
      className={`workspace-split workspace-split-${node.direction}`}
      data-direction={node.direction}
      data-split-ratio={node.ratio}
      style={
        horizontal
          ? { gridTemplateColumns: `${node.ratio}fr ${DIVIDER_WIDTH_PX}px ${100 - node.ratio}fr` }
          : { gridTemplateRows: `${node.ratio}fr ${DIVIDER_WIDTH_PX}px ${100 - node.ratio}fr` }
      }
    >
      <WorkspaceNode {...props} node={node.first} path={[...path, "first"]} />
      <div
        aria-controls={[...firstIds, ...secondIds]
          .map((paneId) => `workspace-pane-${paneId}`)
          .join(" ")}
        aria-label={`Resize ${node.direction === "horizontal" ? "horizontal" : "vertical"} workspace panes`}
        aria-orientation={node.direction === "horizontal" ? "vertical" : "horizontal"}
        aria-valuemax={MAX_SPLIT_RATIO}
        aria-valuemin={MIN_SPLIT_RATIO}
        aria-valuenow={Math.round(node.ratio)}
        className={`workspace-divider workspace-divider-${node.direction}`}
        onKeyDown={(event) => props.onResizeByKeyboard(event, path, node.direction, node.ratio)}
        onPointerDown={(event) =>
          props.onStartPointerResize(event, path, node.direction, node.ratio)
        }
        role="separator"
        tabIndex={0}
      >
        <span className="workspace-divider-line" />
      </div>
      <WorkspaceNode {...props} node={node.second} path={[...path, "second"]} />
    </div>
  );
}

function WorkspaceAgentLeaf({
  paneId,
  focusedPaneId,
  panes,
  layoutReady,
  layoutManaged,
  windowFocused,
  snapshots,
  canSplit,
  openingPaneId,
  renderPane,
  onFocusPane,
  onSnapshot,
  onUserTargetChange,
  registerInput,
  onOpenPaneWindow,
  onSplitFocusedPane,
  onRequestPaneClose,
}: Omit<WorkspaceNodeProps, "node" | "path"> & {
  paneId: WorkspacePaneId;
}): React.ReactElement {
  const focused = focusedPaneId === paneId;
  const paneProps: AgentPaneProps = {
    paneId,
    kind: paneId === PRIMARY_PANE_ID ? "primary" : "auxiliary",
    focused,
    windowFocused,
    initialTarget:
      layoutManaged ||
      paneId.startsWith("pane-") ||
      (paneId !== PRIMARY_PANE_ID && panes[paneId] !== null)
        ? panes[paneId]
        : undefined,
    onFocus: onFocusPane,
    onSnapshot,
    onUserTargetChange,
    registerInput,
  };

  return (
    <div
      className={`workspace-pane-slot${focused ? " pane-focused" : ""}`}
      data-pane-id={paneId}
      id={`workspace-pane-${paneId}`}
      key={paneId}
      onPointerDownCapture={() => onFocusPane(paneId)}
      onFocusCapture={() => onFocusPane(paneId)}
    >
      <div className="workspace-pane-body">
        {layoutReady && <>{renderPane ? renderPane(paneProps) : <AgentPane {...paneProps} />}</>}
      </div>
      {focused && (
        <PaneSplitActions
          canOpenInNewWindow={Boolean(
            snapshots[paneId]?.restoreChecked &&
            snapshots[paneId]?.projectBound &&
            snapshots[paneId]?.cwd,
          )}
          canSplit={canSplit}
          openingInNewWindow={openingPaneId === paneId}
          openInNewWindowPending={openingPaneId !== null}
          onOpenInNewWindow={() => onOpenPaneWindow(paneId)}
          onSplitRight={() => onSplitFocusedPane("horizontal")}
          onSplitDown={() => onSplitFocusedPane("vertical")}
        />
      )}
      {paneId !== PRIMARY_PANE_ID && (
        <button
          className="workspace-pane-close"
          aria-label={`Close ${paneId} pane`}
          title={`Close ${paneId} pane`}
          onClick={() => onRequestPaneClose(paneId)}
        >
          <span aria-hidden="true">×</span>
        </button>
      )}
    </div>
  );
}
