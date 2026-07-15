import { PaneDropOverlay, PANE_DRAG_MIME } from "./PaneDropOverlay";
import type { PaneDropOverlayProps } from "./PaneDropOverlay";
import type { TerminalPaneMoveRequest } from "./workspace-layout";

/** @deprecated Use the pane-neutral drag marker. */
export const TERMINAL_PANE_DRAG_MIME = PANE_DRAG_MIME;
export type TerminalDropOverlayProps = Omit<PaneDropOverlayProps, "onDrop"> & {
  onDrop: (request: TerminalPaneMoveRequest) => void;
};

/** @deprecated Use PaneDropOverlay. */
export function TerminalDropOverlay(props: TerminalDropOverlayProps): React.ReactElement {
  return (
    <PaneDropOverlay
      {...props}
      onDrop={(request) =>
        props.onDrop({
          terminalPaneId: request.sourcePaneId,
          targetPaneId: request.targetPaneId,
          placement: request.placement,
        })
      }
    />
  );
}
