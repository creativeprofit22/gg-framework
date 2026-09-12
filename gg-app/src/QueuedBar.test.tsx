// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueuedBar } from "./QueuedBar";

afterEach(cleanup);

const ONE = [{ id: "q1", text: "check the railway logs" }];
const THREE = [
  { id: "q1", text: "check the railway logs" },
  { id: "q2", text: "run the test suite" },
  { id: "q3", text: "update the docs" },
];

describe("QueuedBar", () => {
  it("renders nothing when the queue is empty", () => {
    const { container } = render(<QueuedBar messages={[]} onCancel={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });

  describe("exit animation", () => {
    it("holds the last message on screen so the exit can play", () => {
      // Unmounting the instant the queue empties leaves nothing to animate, so
      // the bar keeps its final snapshot and marks itself leaving.
      vi.useFakeTimers();
      try {
        const { rerender } = render(<QueuedBar messages={ONE} onCancel={vi.fn()} />);
        rerender(<QueuedBar messages={[]} onCancel={vi.fn()} />);

        const bar = document.querySelector(".queued-bar");
        expect(bar).toBeTruthy();
        expect(bar?.className).toContain("leaving");
        expect(screen.getByText("check the railway logs")).toBeTruthy();
      } finally {
        vi.useRealTimers();
      }
    });

    it("unmounts once the exit transition has run", () => {
      vi.useFakeTimers();
      try {
        const { rerender } = render(<QueuedBar messages={ONE} onCancel={vi.fn()} />);
        rerender(<QueuedBar messages={[]} onCancel={vi.fn()} />);
        act(() => {
          vi.advanceTimersByTime(400);
        });
        expect(document.querySelector(".queued-bar")).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it("cancels a pending exit if a new message arrives first", () => {
      vi.useFakeTimers();
      try {
        const { rerender } = render(<QueuedBar messages={ONE} onCancel={vi.fn()} />);
        rerender(<QueuedBar messages={[]} onCancel={vi.fn()} />);
        rerender(<QueuedBar messages={THREE} onCancel={vi.fn()} />);
        act(() => {
          vi.advanceTimersByTime(400);
        });
        // The queue refilled mid-exit, so the bar must stay and drop `leaving`.
        const bar = document.querySelector(".queued-bar");
        expect(bar).toBeTruthy();
        expect(bar?.className).not.toContain("leaving");
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("a single queued message", () => {
    it("shows its text with an inline cancel", () => {
      render(<QueuedBar messages={ONE} onCancel={vi.fn()} />);
      expect(screen.getByText("check the railway logs")).toBeTruthy();
      expect(screen.getByRole("button", { name: "Cancel queued message" })).toBeTruthy();
    });

    it("cancels by id in one click, with no disclosure step", () => {
      const onCancel = vi.fn();
      render(<QueuedBar messages={ONE} onCancel={onCancel} />);
      fireEvent.click(screen.getByRole("button", { name: "Cancel queued message" }));
      expect(onCancel).toHaveBeenCalledWith("q1");
    });

    it("says the message lands next turn, not after the run", () => {
      // Queued steering drains at the agent's mid-loop steering hook. "after
      // this run" would imply waiting for the final response, which is wrong.
      render(<QueuedBar messages={ONE} onCancel={vi.fn()} />);
      expect(screen.getByText(/next turn/)).toBeTruthy();
      expect(screen.queryByText(/after this run/)).toBeNull();
    });
  });

  describe("several queued messages", () => {
    it("shows the count and hides the list until asked", () => {
      render(<QueuedBar messages={THREE} onCancel={vi.fn()} />);
      expect(screen.getByText("3 messages queued for the next turn")).toBeTruthy();
      expect(document.querySelector(".queued-list")).toBeNull();
    });

    it("offers no bare cancel while collapsed, since which one is ambiguous", () => {
      render(<QueuedBar messages={THREE} onCancel={vi.fn()} />);
      expect(screen.queryByRole("button", { name: /^Cancel queued message/ })).toBeNull();
    });

    it("expands to a cancellable list", () => {
      render(<QueuedBar messages={THREE} onCancel={vi.fn()} />);
      fireEvent.click(screen.getByRole("button", { name: /cancel/ }));
      expect(document.querySelectorAll(".queued-list-item")).toHaveLength(3);
      expect(screen.getByText("run the test suite")).toBeTruthy();
    });

    it("cancels the specific row clicked", () => {
      const onCancel = vi.fn();
      render(<QueuedBar messages={THREE} onCancel={onCancel} />);
      fireEvent.click(screen.getByRole("button", { name: /cancel/ }));
      fireEvent.click(screen.getByRole("button", { name: "Cancel queued message 2" }));
      expect(onCancel).toHaveBeenCalledWith("q2");
    });

    it("collapses again on request", () => {
      render(<QueuedBar messages={THREE} onCancel={vi.fn()} />);
      fireEvent.click(screen.getByRole("button", { name: /cancel/ }));
      fireEvent.click(screen.getByRole("button", { name: "hide" }));
      expect(document.querySelector(".queued-list")).toBeNull();
    });
  });

  it("collapses when the queue drains down to one message", () => {
    // Otherwise the expanded panel lingers as a stale single-row list after the
    // agent consumes the rest.
    const { rerender } = render(<QueuedBar messages={THREE} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /cancel/ }));
    expect(document.querySelector(".queued-list")).toBeTruthy();

    rerender(<QueuedBar messages={ONE} onCancel={vi.fn()} />);
    expect(document.querySelector(".queued-list")).toBeNull();
  });

  it("truncates a long message but keeps the full text as a tooltip", () => {
    const long = "a".repeat(200);
    render(<QueuedBar messages={[{ id: "q1", text: long }]} onCancel={vi.fn()} />);
    const cell = document.querySelector(".queued-bar-text");
    expect(cell?.textContent?.length).toBeLessThan(70);
    expect(cell?.getAttribute("title")).toBe(long);
  });
});
