// @vitest-environment jsdom

import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PANE_DRAG_MIME, PaneDropOverlay } from "./PaneDropOverlay";

function transfer(types = [PANE_DRAG_MIME]): DataTransfer {
  return { types, dropEffect: "none" } as unknown as DataTransfer;
}

describe("PaneDropOverlay", () => {
  it.each(["left", "right", "up", "down"] as const)(
    "dispatches one pane-neutral move from the %s zone",
    (placement) => {
      const onDrop = vi.fn();
      const view = render(
        <PaneDropOverlay
          enabled
          sourcePaneId="pane-2"
          targetPaneId="pane-1"
          hoveredPlacement={null}
          onHover={vi.fn()}
          onDrop={onDrop}
          onReject={vi.fn()}
        />,
      );
      const zone = view.container.querySelector(`[data-placement="${placement}"]`)!;

      fireEvent.drop(zone, { dataTransfer: transfer() });

      expect(onDrop).toHaveBeenCalledOnce();
      expect(onDrop).toHaveBeenCalledWith({
        sourcePaneId: "pane-2",
        targetPaneId: "pane-1",
        placement,
      });
    },
  );

  it("makes a self drop and an external payload no-ops", () => {
    const onDrop = vi.fn();
    const onReject = vi.fn();
    const view = render(
      <PaneDropOverlay
        enabled
        sourcePaneId="pane-1"
        targetPaneId="pane-1"
        hoveredPlacement={null}
        onHover={vi.fn()}
        onDrop={onDrop}
        onReject={onReject}
      />,
    );
    const zone = view.container.querySelector('[data-placement="left"]')!;

    fireEvent.drop(zone, { dataTransfer: transfer() });
    fireEvent.drop(zone, { dataTransfer: transfer(["Files"]) });

    expect(onDrop).not.toHaveBeenCalled();
    expect(onReject).toHaveBeenCalledOnce();
  });
});
