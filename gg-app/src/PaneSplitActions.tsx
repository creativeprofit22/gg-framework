import { PanelRight, PanelBottom } from "lucide-react";

export interface PaneSplitActionsProps {
  canSplit: boolean;
  onSplitRight: () => void;
  onSplitDown: () => void;
}

export function PaneSplitActions({
  canSplit,
  onSplitRight,
  onSplitDown,
}: PaneSplitActionsProps): React.ReactElement {
  return (
    <div className="pane-split-actions">
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
