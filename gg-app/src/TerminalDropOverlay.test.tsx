// @vitest-environment jsdom

import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  TERMINAL_PANE_DRAG_MIME,
  TerminalDropOverlay,
  type TerminalDropOverlayProps,
} from "./TerminalDropOverlay";
import type { TerminalPanePlacement } from "./workspace-layout";

function transfer(types: string[]): DataTransfer {
  return { types, dropEffect: "none" } as unknown as DataTransfer;
}

function renderOverlay(overrides: Partial<TerminalDropOverlayProps> = {}) {
  const props: TerminalDropOverlayProps = {
    enabled: true,
    sourcePaneId: "terminal-1",
    targetPaneId: "primary",
    hoveredPlacement: null,
    onHover: vi.fn(),
    onDrop: vi.fn(),
    onReject: vi.fn(),
    ...overrides,
  };
  const view = render(<TerminalDropOverlay {...props} />);
  const zone = (placement: TerminalPanePlacement): HTMLElement =>
    view.container.querySelector(`[data-placement="${placement}"]`)!;
  return { ...view, props, zone };
}

describe("TerminalDropOverlay", () => {
  it.each(["left", "right", "up", "down"] as const)(
    "accepts the internal marker in the %s zone",
    (placement) => {
      const { props, zone } = renderOverlay();
      const dataTransfer = transfer([TERMINAL_PANE_DRAG_MIME]);

      expect(fireEvent.dragOver(zone(placement), { dataTransfer })).toBe(false);
      expect(props.onHover).toHaveBeenCalledWith("primary", placement);

      fireEvent.drop(zone(placement), { dataTransfer });
      expect(props.onDrop).toHaveBeenCalledOnce();
      expect(props.onDrop).toHaveBeenCalledWith({
        terminalPaneId: "terminal-1",
        targetPaneId: "primary",
        placement,
      });
    },
  );

  it("keeps hover transient until a drop", () => {
    const { props, zone } = renderOverlay({ hoveredPlacement: "left" });
    const dataTransfer = transfer([TERMINAL_PANE_DRAG_MIME]);

    fireEvent.dragEnter(zone("right"), { dataTransfer });
    fireEvent.dragLeave(zone("left"), { dataTransfer, relatedTarget: document.body });

    expect(props.onHover).toHaveBeenNthCalledWith(1, "primary", "right");
    expect(props.onHover).toHaveBeenNthCalledWith(2, "primary", null);
    expect(props.onDrop).not.toHaveBeenCalled();
  });

  it("keeps a self-target inert and rejects its internal drop", () => {
    const { props, zone, container } = renderOverlay({ targetPaneId: "terminal-1" });
    const dataTransfer = transfer([TERMINAL_PANE_DRAG_MIME]);

    expect(container.firstElementChild?.classList.contains("terminal-drop-overlay-inert")).toBe(
      true,
    );
    expect(fireEvent.dragOver(zone("left"), { dataTransfer })).toBe(true);
    fireEvent.drop(zone("left"), { dataTransfer });

    expect(props.onHover).not.toHaveBeenCalled();
    expect(props.onDrop).not.toHaveBeenCalled();
    expect(props.onReject).toHaveBeenCalledOnce();
  });

  it.each([{ types: ["Files"] }, { types: ["text/plain"] }, { types: [] }])(
    "ignores non-internal payload types $types",
    ({ types }) => {
      const { props, zone } = renderOverlay();
      const dataTransfer = transfer(types);

      expect(fireEvent.dragOver(zone("down"), { dataTransfer })).toBe(true);
      fireEvent.drop(zone("down"), { dataTransfer });

      expect(props.onHover).not.toHaveBeenCalled();
      expect(props.onDrop).not.toHaveBeenCalled();
      expect(props.onReject).not.toHaveBeenCalled();
    },
  );

  it("dispatches exactly once for one valid drop", () => {
    const { props, zone } = renderOverlay();
    fireEvent.drop(zone("up"), { dataTransfer: transfer([TERMINAL_PANE_DRAG_MIME]) });
    expect(props.onDrop).toHaveBeenCalledTimes(1);
  });
});
