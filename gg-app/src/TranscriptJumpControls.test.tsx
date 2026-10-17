// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TranscriptJumpControls } from "./TranscriptJumpControls";

afterEach(cleanup);

function setup(away: boolean, hasNew: boolean, askAt: "above" | "below" | null = null) {
  const onScrollToBottom = vi.fn();
  const onJumpToNew = vi.fn();
  const onJumpToAsk = vi.fn();
  render(
    <TranscriptJumpControls
      away={away}
      hasNew={hasNew}
      askAt={askAt}
      onScrollToBottom={onScrollToBottom}
      onJumpToNew={onJumpToNew}
      onJumpToAsk={onJumpToAsk}
    />,
  );
  // Hidden controls are aria-hidden, which also hides their accessible names,
  // so find them by what they show.
  const toBottom = screen.getByTitle("Scroll to bottom") as HTMLButtonElement;
  const pill = screen.getByText("You have new chats").closest("button") as HTMLButtonElement;
  const askPill = screen
    .getByText("You have a new question")
    .closest("button") as HTMLButtonElement;
  return { toBottom, pill, askPill, onScrollToBottom, onJumpToNew, onJumpToAsk };
}

describe("TranscriptJumpControls", () => {
  it("stays mounted but unreachable while following the newest output", () => {
    const { toBottom, pill } = setup(false, true);
    for (const button of [toBottom, pill]) {
      expect(button.className).not.toContain("visible");
      expect(button.getAttribute("aria-hidden")).toBe("true");
      expect(button.tabIndex).toBe(-1);
    }
  });

  it("offers scroll-to-bottom once scrolled up, and the pill only with new rows", () => {
    const quiet = setup(true, false);
    expect(quiet.toBottom.className).toContain("visible");
    expect(quiet.toBottom.tabIndex).toBe(0);
    expect(screen.getByRole("button", { name: "Scroll to bottom" })).toBe(quiet.toBottom);
    expect(quiet.pill.className).not.toContain("visible");
    cleanup();

    const busy = setup(true, true);
    expect(busy.pill.className).toContain("visible");
    expect(busy.pill.getAttribute("aria-hidden")).toBe("false");
  });

  it("routes each button to its jump", () => {
    const { toBottom, pill, onScrollToBottom, onJumpToNew } = setup(true, true);
    toBottom.click();
    pill.click();
    expect(onScrollToBottom).toHaveBeenCalledTimes(1);
    expect(onJumpToNew).toHaveBeenCalledTimes(1);
  });

  it("shows the question pill whenever an open question is off screen, even at the bottom", () => {
    // Following the newest output (not scrolled up): the agent kept talking
    // after asking, so the question has scrolled away above.
    const { askPill, pill, onJumpToAsk } = setup(false, false, "above");
    expect(askPill.className).toContain("visible");
    expect(askPill.tabIndex).toBe(0);
    expect(pill.className).not.toContain("visible");
    askPill.click();
    expect(onJumpToAsk).toHaveBeenCalledTimes(1);
  });

  it("puts the question ahead of new chats in the shared centre spot", () => {
    const { askPill, pill } = setup(true, true, "below");
    expect(askPill.className).toContain("visible");
    expect(pill.className).not.toContain("visible");
    expect(pill.getAttribute("aria-hidden")).toBe("true");
  });

  it("hides the question pill when the question is on screen or answered", () => {
    const { askPill } = setup(true, false, null);
    expect(askPill.className).not.toContain("visible");
    expect(askPill.getAttribute("aria-hidden")).toBe("true");
    expect(askPill.tabIndex).toBe(-1);
  });
});
