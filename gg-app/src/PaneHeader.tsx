import type { ReactNode } from "react";

export interface PaneHeaderProps {
  title: string;
  collapsed: boolean;
  onToggle: () => void;
  usage?: ReactNode;
  meta?: ReactNode;
  children?: ReactNode;
}

/** Compact header owned by one agent pane. */
export function PaneHeader({
  title,
  collapsed,
  onToggle,
  usage,
  meta,
  children,
}: PaneHeaderProps): React.ReactElement {
  return (
    <div className="chat-head">
      <div className="chat-head-strip" data-tauri-drag-region>
        <span className="chat-head-title" data-tauri-drag-region>
          {title}
        </span>
        {usage}
        {meta}
        <button
          className="nav-toggle"
          title={collapsed ? "Show nav buttons" : "Hide nav buttons"}
          aria-label={collapsed ? "Show nav buttons" : "Hide nav buttons"}
          onClick={onToggle}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ display: "block" }}
          >
            <polyline points={collapsed ? "6 9 12 15 18 9" : "6 15 12 9 18 15"} />
          </svg>
        </button>
      </div>
      {!collapsed && (
        <div className="chat-head-nav" data-tauri-drag-region>
          {children}
        </div>
      )}
    </div>
  );
}
