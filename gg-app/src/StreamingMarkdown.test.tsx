// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { Activity } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./agent", () => ({
  openProjectPath: vi.fn(),
  openUrl: vi.fn(),
  sendPrompt: vi.fn(),
}));

import { StreamingMarkdown } from "./StreamingMarkdown";

// The reveal runs on requestAnimationFrame and reads performance.now(); fake
// timers drive both, so advancing time plays the stream forward.
const wait = async (ms: number): Promise<void> => {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
};

/** The word spans the streamed words fade in through. */
const words = (root: HTMLElement): Element[] => [...root.querySelectorAll(".md-word")];

const originalAnimations = Object.getOwnPropertyDescriptor(Element.prototype, "getAnimations");

describe("StreamingMarkdown", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    cleanup();
    if (originalAnimations)
      Object.defineProperty(Element.prototype, "getAnimations", originalAnimations);
    else Reflect.deleteProperty(Element.prototype, "getAnimations");
    vi.useRealTimers();
  });

  it("keeps each word's element through a pause mid-reply, so no word fades in twice", async () => {
    const { container, rerender } = render(<StreamingMarkdown text="" streaming />);
    // Ends on a space: the last word is complete (a half-arrived last word is
    // held back while streaming, see useSmoothText).
    rerender(<StreamingMarkdown text="The loader reads the manifest " streaming />);
    await wait(600);
    const before = words(container);
    expect(before.map((w) => w.textContent)).toEqual(["The", "loader", "reads", "the", "manifest"]);

    // The model goes quiet mid-sentence for longer than the reveal's settle.
    await wait(1500);
    // Still streaming: the words keep their spans (dropping them, then putting
    // them back with the next chunk, made every word on screen fade in again).
    expect(words(container)).toEqual(before);

    rerender(<StreamingMarkdown text="The loader reads the manifest once " streaming />);
    await wait(600);
    const after = words(container);
    // Same elements for the words already shown: none of them re-fades.
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after.map((w) => w.textContent)).toContain("once");
  });

  it("shows unfinished markdown formatted mid-stream, then exactly as written once done", async () => {
    const { container, rerender } = render(<StreamingMarkdown text="" streaming />);
    rerender(<StreamingMarkdown text="**Here's the " streaming />);
    await wait(600);
    // Bold before its closing ** arrives, never the raw asterisks.
    expect(container.querySelector("strong")?.textContent?.trim()).toBe("Here's the");
    expect(container.textContent).not.toContain("**");

    rerender(<StreamingMarkdown text="**Here's the fix.** Done." streaming={false} />);
    await wait(2000);
    expect(container.querySelector("strong")?.textContent).toBe("Here's the fix.");
    expect(container.textContent).toBe("Here's the fix. Done.");
    // Finished: the word spans come off, leaving plain markup.
    expect(words(container)).toHaveLength(0);
  });

  it("settles an interrupted reveal and hidden words on Activity return, then reveals new growth", async () => {
    const cancelled = new Set<Element>();
    Object.defineProperty(Element.prototype, "getAnimations", {
      configurable: true,
      value: function (this: Element) {
        return [{ cancel: () => cancelled.add(this) }];
      },
    });
    const body = (text: string, hidden = false) => (
      <Activity mode={hidden ? "hidden" : "visible"}>
        <StreamingMarkdown text={text} streaming />
      </Activity>
    );
    const view = render(body(""));
    const initial = "A long fictional response with enough words to interrupt before it finishes ";
    view.rerender(body(initial));
    await wait(75);
    expect(view.container.textContent).not.toBe(initial);
    view.rerender(body(initial, true));
    const hidden = `${initial}These words arrived while hidden. `;
    view.rerender(body(hidden, true));
    view.rerender(body(hidden));
    expect(view.container.textContent).toBe(hidden.trimEnd());
    expect(words(view.container).every((word) => cancelled.has(word))).toBe(true);
    const visible = `${hidden}Visible growth still fades. `;
    view.rerender(body(visible));
    await wait(600);
    expect(view.container.textContent).toBe(visible.trimEnd());
    const latest = words(view.container);
    expect(latest.length).toBeGreaterThan(0);
    expect([...cancelled]).not.toContain(latest[latest.length - 1]);
  });

  it("keeps the first live chunk eligible for word feedback", () => {
    const cancel = vi.fn();
    Object.defineProperty(Element.prototype, "getAnimations", {
      configurable: true,
      value: () => [{ cancel }],
    });
    const { container } = render(<StreamingMarkdown text="A new visible chunk " streaming />);
    expect(words(container).length).toBeGreaterThan(0);
    expect(cancel).not.toHaveBeenCalled();
  });

  it("renders a finished reply as plain markup with no fade", () => {
    // History and finished replies mount settled: nothing animates.
    const { container } = render(<StreamingMarkdown text="Already **done**." />);
    expect(words(container)).toHaveLength(0);
    expect(container.querySelector("strong")?.textContent).toBe("done");
  });
});
