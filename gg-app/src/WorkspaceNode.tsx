import { useState } from "react";
import { AgentPane, type AgentPaneProps } from "./AgentPane";
import { PRIMARY_PANE_ID } from "./pane-routing";
import {
  MAX_SPLIT_RATIO,
  MIN_SPLIT_RATIO,
  type SplitDirection,
  type WorkspaceLayoutNode,
  type WorkspaceLayoutPath,
  type WorkspacePaneId,
  type WorkspacePaneValue,
} from "./workspace-layout";

const DIVIDER_SIZE_PX = 7;

export interface WorkspaceNodeProps {
  node: WorkspaceLayoutNode;
  path?: WorkspaceLayoutPath;
  focusedPaneId: WorkspacePaneId;
  panes: Record<string, WorkspacePaneValue>;
  windowFocused: boolean;
  canSplit: boolean;
  renderPane?: (props: AgentPaneProps) => React.ReactNode;
  onFocusPane: (paneId: WorkspacePaneId) => void;
  onSnapshot: NonNullable<AgentPaneProps["onSnapshot"]>;
  registerInput: NonNullable<AgentPaneProps["registerInput"]>;
  onSplitPane: (paneId: WorkspacePaneId, direction: SplitDirection) => void;
  onClosePane: (paneId: WorkspacePaneId) => void;
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
  if (node.type === "leaf") return <WorkspaceAgentLeaf paneId={node.paneId} {...props} />;

  const horizontal = node.direction === "horizontal";
  return (
    <div
      className={`workspace-split workspace-split-${node.direction}`}
      data-split-ratio={node.ratio}
      style={
        horizontal
          ? { gridTemplateColumns: `${node.ratio}fr ${DIVIDER_SIZE_PX}px ${100 - node.ratio}fr` }
          : { gridTemplateRows: `${node.ratio}fr ${DIVIDER_SIZE_PX}px ${100 - node.ratio}fr` }
      }
    >
      <WorkspaceNode {...props} node={node.first} path={[...path, "first"]} />
      <div
        aria-label={`Resize ${node.direction} workspace panes`}
        aria-orientation={horizontal ? "vertical" : "horizontal"}
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
  windowFocused,
  canSplit,
  renderPane,
  onFocusPane,
  onSnapshot,
  registerInput,
  onSplitPane,
  onClosePane,
}: Omit<WorkspaceNodeProps, "node" | "path"> & {
  paneId: WorkspacePaneId;
}): React.ReactElement {
  const focused = focusedPaneId === paneId;
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
    workspaceOwnsSessionLifecycle: true,
    registerInput,
  };

  return (
    <section
      className={`workspace-pane-slot${focused ? " pane-focused" : ""}`}
      data-pane-id={paneId}
      id={`workspace-pane-${paneId}`}
      onPointerDownCapture={() => onFocusPane(paneId)}
      onFocusCapture={() => onFocusPane(paneId)}
    >
      <div className="workspace-pane-body">
        {renderPane ? renderPane(paneProps) : <AgentPane {...paneProps} />}
      </div>
      {focused && (
        <div className="workspace-pane-actions" aria-label="Pane actions">
          <button
            type="button"
            aria-label="Split Right"
            title="Split Right"
            disabled={!canSplit}
            onClick={() => onSplitPane(paneId, "horizontal")}
          >
            ↔
          </button>
          <button
            type="button"
            aria-label="Split Down"
            title="Split Down"
            disabled={!canSplit}
            onClick={() => onSplitPane(paneId, "vertical")}
          >
            ↕
          </button>
        </div>
      )}
      {paneId !== PRIMARY_PANE_ID && (
        <button
          type="button"
          className="workspace-pane-close"
          aria-label={`Close ${paneId} pane`}
          title={`Close ${paneId} pane`}
          onClick={() => onClosePane(paneId)}
        >
          ×
        </button>
      )}
    </section>
  );
}
