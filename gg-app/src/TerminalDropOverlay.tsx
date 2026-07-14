import type { DragEvent } from "react";
import type { TerminalPaneMoveRequest, TerminalPanePlacement } from "./workspace-layout";

export const TERMINAL_PANE_DRAG_MIME = "application/x-gg-terminal-pane";

const PLACEMENTS: readonly TerminalPanePlacement[] = ["left", "right", "up", "down"];

export interface TerminalDropOverlayProps {
  enabled: boolean;
  sourcePaneId: string;
  targetPaneId: string;
  hoveredPlacement: TerminalPanePlacement | null;
  onHover: (targetPaneId: string, placement: TerminalPanePlacement | null) => void;
  onDrop: (request: TerminalPaneMoveRequest) => void;
  onReject: () => void;
}

function hasInternalMarker(dataTransfer: DataTransfer): boolean {
  return Array.from(dataTransfer.types ?? []).includes(TERMINAL_PANE_DRAG_MIME);
}

export function TerminalDropOverlay({
  enabled,
  sourcePaneId,
  targetPaneId,
  hoveredPlacement,
  onHover,
  onDrop,
  onReject,
}: TerminalDropOverlayProps): React.ReactElement {
  const validTarget = enabled && sourcePaneId !== targetPaneId;

  const accepts = (event: DragEvent<HTMLElement>): boolean =>
    validTarget && hasInternalMarker(event.dataTransfer);

  const enter = (event: DragEvent<HTMLDivElement>, placement: TerminalPanePlacement): void => {
    if (!accepts(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    onHover(targetPaneId, placement);
  };

  const leave = (event: DragEvent<HTMLDivElement>, placement: TerminalPanePlacement): void => {
    if (!accepts(event)) return;
    const next = event.relatedTarget;
    if (next instanceof Node && event.currentTarget.contains(next)) return;
    if (hoveredPlacement === placement) onHover(targetPaneId, null);
  };

  const drop = (event: DragEvent<HTMLDivElement>, placement: TerminalPanePlacement): void => {
    if (!accepts(event)) {
      if (hasInternalMarker(event.dataTransfer)) {
        event.preventDefault();
        event.stopPropagation();
        onReject();
      }
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    onDrop({ terminalPaneId: sourcePaneId, targetPaneId, placement });
  };

  return (
    <div
      className={`terminal-drop-overlay${validTarget ? "" : " terminal-drop-overlay-inert"}`}
      data-hovered-placement={validTarget ? (hoveredPlacement ?? undefined) : undefined}
      aria-hidden="true"
    >
      {PLACEMENTS.map((placement) => (
        <div
          key={placement}
          className={`terminal-drop-zone terminal-drop-zone-${placement}`}
          data-placement={placement}
          onDragEnter={(event) => enter(event, placement)}
          onDragOver={(event) => enter(event, placement)}
          onDragLeave={(event) => leave(event, placement)}
          onDrop={(event) => drop(event, placement)}
        />
      ))}
    </div>
  );
}
