import { ExternalLink, PanelBottom, PanelRight } from "lucide-react";

export interface PaneSplitActionsProps {
  canOpenInNewWindow: boolean;
  canSplit: boolean;
  openingInNewWindow: boolean;
  openInNewWindowPending: boolean;
  onOpenInNewWindow: () => void;
  onSplitRight: () => void;
  onSplitDown: () => void;
}

export function PaneSplitActions({
  canOpenInNewWindow,
  canSplit,
  openingInNewWindow,
  openInNewWindowPending,
  onOpenInNewWindow,
  onSplitRight,
  onSplitDown,
}: PaneSplitActionsProps): React.ReactElement {
  return (
    <div className="pane-split-actions">
      <button
        type="button"
        className="pane-split-action"
        aria-label="Open in new window"
        aria-busy={openingInNewWindow}
        title="Open in new window"
        disabled={!canOpenInNewWindow || openInNewWindowPending}
        onClick={onOpenInNewWindow}
      >
        <ExternalLink aria-hidden="true" size={14} />
      </button>
      <button
        type="button"
        className="pane-split-action"
        aria-label="Split Right"
        title="Split Right"
        disabled={!canSplit}
        onClick={onSplitRight}
      >
        <PanelRight aria-hidden="true" size={14} />
      </button>
      <button
        type="button"
        className="pane-split-action"
        aria-label="Split Down"
        title="Split Down"
        disabled={!canSplit}
        onClick={onSplitDown}
      >
        <PanelBottom aria-hidden="true" size={14} />
      </button>
    </div>
  );
}
