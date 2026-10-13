// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { KenStatus as Status } from "./goal-ken-status";
import { KenStatus, formatFor } from "./KenStatus";

beforeAll(() => {
  // No canvas in jsdom: the portrait is decoration.
  HTMLCanvasElement.prototype.getContext = (() => null) as never;
});
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const reading: Status = {
  key: "tool:1",
  tone: "work",
  icon: "read",
  face: "focused",
  headline: "Reading search.ts",
  detail: "In server/rag",
  mark: null,
  opens: false,
  thinking: false,
  timed: true,
};
const wait = (ms: number): void => {
  for (let t = 0; t < ms; t += 50) act(() => vi.advanceTimersByTime(50));
};

describe("KenStatus", () => {
  it("opens on hover to show its extra line without re-rendering any text", () => {
    const onHoverChange = vi.fn();
    const { container } = render(
      <KenStatus status={reading} away={false} reducedMotion onHoverChange={onHoverChange} />,
    );
    const root = container.querySelector(".ken-status") as HTMLElement;
    const card = container.querySelector(".ken-status-card") as HTMLElement;
    const headline = container.querySelector(".ken-status-headline") as HTMLElement;
    const textNode = headline.firstChild;
    let mutations = 0;
    const observer = new MutationObserver((list) => {
      for (const r of list) if (r.type !== "attributes") mutations++;
    });
    observer.observe(container.querySelector(".ken-status-main") as Node, {
      childList: true,
      characterData: true,
      subtree: true,
    });
    expect(root.hasAttribute("data-open")).toBe(false);
    fireEvent.pointerEnter(card);
    wait(200);
    expect(root.hasAttribute("data-open")).toBe(true);
    expect(onHoverChange).toHaveBeenLastCalledWith(true);
    fireEvent.pointerLeave(card);
    wait(400);
    expect(root.hasAttribute("data-open")).toBe(false);
    expect(onHoverChange).toHaveBeenLastCalledWith(false);
    // Opening and closing resized the pill only: the same text, untouched.
    expect(headline.firstChild).toBe(textNode);
    expect(headline.textContent).toBe("Reading search.ts");
    observer.disconnect();
    expect(mutations).toBe(0);
  });

  it("doesn't open on hover when there's nothing more to say, but opens by itself for a problem", () => {
    const { container, rerender } = render(
      <KenStatus status={{ ...reading, detail: null }} away={false} reducedMotion />,
    );
    const root = container.querySelector(".ken-status") as HTMLElement;
    fireEvent.pointerEnter(container.querySelector(".ken-status-card") as HTMLElement);
    wait(200);
    expect(root.hasAttribute("data-open")).toBe(false);
    rerender(
      <KenStatus
        status={{
          ...reading,
          key: "stopped",
          tone: "error",
          icon: "error",
          headline: "Stopped",
          detail: "Overloaded",
          opens: true,
        }}
        away={false}
        reducedMotion
      />,
    );
    wait(200);
    expect(root.hasAttribute("data-open")).toBe(true);
    expect(container.querySelector(".ken-status-detail")?.textContent).toBe("Overloaded");
  });

  it("notes a long think after a minute and a half", () => {
    const thinking: Status = {
      ...reading,
      key: "think:1",
      icon: "think",
      headline: "Thinking",
      detail: null,
      thinking: true,
    };
    const { container } = render(<KenStatus status={thinking} away={false} reducedMotion />);
    const root = container.querySelector(".ken-status") as HTMLElement;
    wait(60_000);
    expect(root.hasAttribute("data-slow")).toBe(false);
    wait(31_000);
    expect(root.hasAttribute("data-slow")).toBe(true);
    expect(container.querySelector(".ken-status-time")?.textContent).toBe("1m 31s");
  });
});

describe("formatFor", () => {
  it("reads as seconds, then minutes and seconds, then minutes", () => {
    expect(formatFor(8_000)).toBe("8s");
    expect(formatFor(88_000)).toBe("1m 28s");
    expect(formatFor(754_000)).toBe("12m");
  });
});
