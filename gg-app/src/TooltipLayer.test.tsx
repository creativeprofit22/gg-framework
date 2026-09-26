// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { placeTooltip, TooltipLayer } from "./TooltipLayer";

describe("placeTooltip", () => {
  const viewport = { width: 800, height: 600 };
  const tip = { width: 100, height: 30 };

  it.each([
    {
      name: "centres above an anchor with room",
      anchor: { left: 350, top: 300, width: 100, height: 20 },
      want: { left: 350, top: 264, side: "top" },
    },
    {
      name: "flips below an anchor hugging the top edge",
      anchor: { left: 350, top: 10, width: 100, height: 20 },
      want: { left: 350, top: 36, side: "bottom" },
    },
    {
      name: "clamps inside the left edge",
      anchor: { left: 0, top: 300, width: 20, height: 20 },
      want: { left: 8, top: 264, side: "top" },
    },
    {
      name: "clamps inside the right edge",
      anchor: { left: 780, top: 300, width: 20, height: 20 },
      want: { left: 692, top: 264, side: "top" },
    },
  ])("$name", ({ anchor, want }) => {
    expect(placeTooltip(anchor, tip, viewport)).toEqual(want);
  });
});

describe("TooltipLayer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  function setup(): { icon: HTMLElement; labelled: HTMLElement } {
    render(
      <>
        <TooltipLayer />
        <button type="button" title="Export chat">
          <svg />
        </button>
        <button type="button" title="Installs and restarts">
          Update
        </button>
        <p>plain text</p>
      </>,
    );
    return {
      icon: screen.getByRole("button", { name: "Export chat" }),
      labelled: screen.getByRole("button", { name: "Update" }),
    };
  }

  /** A real hover: the pointer enters the control, then moves on it. */
  function hover(el: HTMLElement): void {
    fireEvent.pointerOver(el);
    fireEvent.pointerMove(el);
  }

  it("shows after a hover delay and suppresses the native title meanwhile", () => {
    const { labelled } = setup();

    hover(labelled);
    expect(labelled.hasAttribute("title")).toBe(false);
    expect(screen.queryByRole("tooltip")).toBeNull();

    act(() => {
      vi.advanceTimersByTime(450);
    });
    const tip = screen.getByRole("tooltip");
    expect(tip.textContent).toBe("Installs and restarts");
    expect(labelled.getAttribute("aria-describedby")).toBe(tip.id);
  });

  it("restores the title and its own attributes when the pointer moves away", () => {
    const { labelled } = setup();
    hover(labelled);
    act(() => {
      vi.advanceTimersByTime(450);
    });

    fireEvent.pointerOver(screen.getByText("plain text"));

    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(labelled.getAttribute("title")).toBe("Installs and restarts");
    expect(labelled.hasAttribute("aria-describedby")).toBe(false);
  });

  it("keeps an icon-only control named while its title is set aside", () => {
    const { icon } = setup();

    fireEvent.pointerOver(icon);

    expect(icon.hasAttribute("title")).toBe(false);
    expect(icon.getAttribute("aria-label")).toBe("Export chat");
    fireEvent.pointerOver(screen.getByText("plain text"));
    expect(icon.hasAttribute("aria-label")).toBe(false);
  });

  it("shows immediately when moving between titled controls (warm)", () => {
    const { icon, labelled } = setup();
    hover(icon);
    act(() => {
      vi.advanceTimersByTime(450);
    });

    fireEvent.pointerOver(labelled);

    expect(screen.getByRole("tooltip").textContent).toBe("Installs and restarts");
  });

  it("hides on click and stays hidden while the pointer remains on that control", () => {
    const { labelled } = setup();
    hover(labelled);
    act(() => {
      vi.advanceTimersByTime(450);
    });

    fireEvent.pointerDown(labelled);
    hover(labelled);
    act(() => {
      vi.advanceTimersByTime(1000);
    });

    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("stays quiet when a control appears under a cursor that isn't moving", () => {
    const { labelled } = setup();

    // pointerover with no pointermove: the view changed under a resting cursor.
    fireEvent.pointerOver(labelled);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.queryByRole("tooltip")).toBeNull();

    fireEvent.pointerMove(labelled);
    act(() => {
      vi.advanceTimersByTime(450);
    });
    expect(screen.getByRole("tooltip").textContent).toBe("Installs and restarts");
  });

  it("shows at once on keyboard focus and Escape dismisses only the tooltip", () => {
    const { labelled } = setup();
    const outer = vi.fn();
    document.addEventListener("keydown", outer);

    fireEvent.keyDown(document, { key: "Tab" });
    act(() => {
      labelled.focus();
    });
    expect(screen.getByRole("tooltip").textContent).toBe("Installs and restarts");
    outer.mockClear();

    fireEvent.keyDown(labelled, { key: "Escape" });

    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(outer).not.toHaveBeenCalled();
    document.removeEventListener("keydown", outer);
  });

  it("does not show on pointer-initiated focus", () => {
    const { labelled } = setup();

    fireEvent.pointerDown(labelled);
    act(() => {
      labelled.focus();
    });

    expect(screen.queryByRole("tooltip")).toBeNull();
  });
});
