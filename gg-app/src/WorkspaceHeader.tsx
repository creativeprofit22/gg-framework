import { useContext, type ReactNode, type Ref } from "react";
import { PaneIdContext } from "./pane-context";
import { openProjectPath, workspaceProductName, type WorkspaceMode } from "./agent";
import { projectAccent } from "./projectAccent";
import { formatWorkspaceTitle } from "./workspace-title";

interface WorkspaceHeaderProps {
  /** The header element: a Goal's world sits behind it and keeps clear of it. */
  ref?: Ref<HTMLDivElement>;
  workspaceMode: WorkspaceMode;
  cwd?: string;
  /** A Goal window: titled with the goal's name instead of its folder slug. */
  goalName?: string | null;
  /** Feed the title's tooltip: the full project context on hover. */
  gitBranch?: string | null;
  gitDirtyFileCount?: number;
  gitHubIssues?: number | null;
  gitHubPRs?: number | null;
  additionalRoots?: string[];
  /** A short label after the name, e.g. the chat agent ("General"). */
  subtitle?: string | null;
  /** Left of the title, after the traffic lights: the back key. */
  leading?: ReactNode;
  /** Right end: Commit, a Goal's view switch. Always visible. */
  trailing?: ReactNode;
  /** Hosts the workspace pane controls (split, copy, close) at the end of the row. */
  paneChromeSlotRef?: (el: HTMLElement | null) => void;
}

/**
 * The workspace's one-row title bar: back, the project's name (its colour mark
 * included) centred, and the actions that must stay visible at any window size
 * on the right. Everything that used to crowd a second row and the strip now
 * reads out from the deck at the bottom of the window.
 */
export function WorkspaceHeader({
  ref,
  workspaceMode,
  cwd,
  goalName = null,
  gitBranch,
  gitDirtyFileCount = 0,
  gitHubIssues = null,
  gitHubPRs = null,
  additionalRoots = [],
  subtitle = null,
  leading,
  trailing,
  paneChromeSlotRef,
}: WorkspaceHeaderProps): React.ReactElement {
  const paneId = useContext(PaneIdContext);
  const fallbackTitle = workspaceProductName(workspaceMode, goalName !== null);
  const directory = goalName ?? cwd?.split(/[\\/]/).filter(Boolean).pop();
  // Stable per-project colour, so a wall of identical windows stays tellable
  // apart at a glance.
  const accent = projectAccent(cwd);

  return (
    <div
      ref={ref}
      className="chat-head"
      // The pane's full project path (the visible title shows only its folder
      // name): native smokes prove cross-pane project isolation against it.
      data-cwd={cwd}
      style={accent ? ({ "--project-accent": accent } as React.CSSProperties) : undefined}
    >
      <div className="chat-head-strip" data-tauri-drag-region>
        <div className="chat-head-lead" data-tauri-drag-region>
          {leading}
        </div>
        {/* One tooltip for the whole title: the project's context. The folder
            button inside says what clicking does in its accessible name only,
            so hovering never stacks two tooltips. */}
        <span
          className="chat-head-title"
          data-tauri-drag-region
          title={formatWorkspaceTitle(
            cwd,
            gitBranch,
            fallbackTitle,
            gitDirtyFileCount,
            gitHubIssues,
            gitHubPRs,
            additionalRoots,
          )}
        >
          {accent && <span className="chat-head-accent-dot" aria-hidden="true" />}
          {directory ? (
            <button
              type="button"
              className="chat-head-cwd chat-head-link"
              disabled={!cwd}
              aria-label={cwd ? `${directory}. Open the folder` : undefined}
              onClick={() => cwd && void openProjectPath(cwd, paneId)}
            >
              {directory}
            </button>
          ) : (
            <span className="chat-head-cwd" data-tauri-drag-region>
              {fallbackTitle}
            </span>
          )}
          {subtitle && (
            <span className="chat-head-sub" data-tauri-drag-region>
              {subtitle}
            </span>
          )}
        </span>
        <div className="chat-head-trail" data-tauri-drag-region>
          {trailing}
          {paneChromeSlotRef && <span className="chat-head-pane-chrome" ref={paneChromeSlotRef} />}
        </div>
      </div>
    </div>
  );
}
