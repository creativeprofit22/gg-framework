// @vitest-environment jsdom
/**
 * Regression: growing the composer past ~3 line breaks used to un-pin the
 * transcript, so the input box covered the newest messages instead of pushing
 * them up (the first few breaks looked fine, which is what made it confusing).
 *
 * Cause: `height: auto` collapses the textarea to one row for one layout pass,
 * handing its pixels back to the transcript. The browser then clamps the
 * transcript's scrollTop to the smaller max scroll, and the scroll event that
 * follows reads as "the user scrolled up" — dropping App's stick-to-bottom pin.
 *
 * jsdom has no layout, so this models the two browser behaviours that produce
 * the bug: the shell splits a fixed height between composer and transcript, and
 * scrollTop is clamped to `scrollHeight - clientHeight` whenever that shrinks.
 * With real numbers taken from a headless-Chromium repro at 900×700.
 */
import { describe, expect, it } from "vitest";
import { autosizeComposer } from "./composer-autosize";

const SHELL = 700; // window height
const CHROME = 123; // chat head + live region + footer + composer padding
const ROW = 21; // 14px × 1.5 line-height
const CONTENT = 541; // transcript scrollHeight: just taller than the viewport
const PIN_THRESHOLD = 48; // must match App's onTranscriptScroll

/** A transcript whose viewport is whatever the composer leaves it. */
function makeShell() {
  const transcript = document.createElement("div");
  let composerHeight = ROW;
  let scrollTop = 0;
  const clientHeight = () => SHELL - CHROME - composerHeight;
  const maxScroll = () => Math.max(0, CONTENT - clientHeight());
  const scrollEvents: number[] = [];

  Object.defineProperty(transcript, "scrollHeight", { get: CONTENT.valueOf.bind(CONTENT) });
  Object.defineProperty(transcript, "clientHeight", { get: clientHeight });
  Object.defineProperty(transcript, "scrollTop", {
    get: () => scrollTop,
    set: (v: number) => {
      const next = Math.min(Math.max(0, v), maxScroll());
      if (next === scrollTop) return;
      scrollTop = next;
      scrollEvents.push(next);
    },
  });

  return {
    transcript,
    scrollEvents,
    maxScroll,
    /** Browser behaviour: a taller viewport clamps an out-of-range scrollTop. */
    setComposerHeight(px: number) {
      composerHeight = px;
      if (scrollTop > maxScroll()) {
        scrollTop = maxScroll();
        scrollEvents.push(scrollTop);
      }
    },
    distanceFromBottom: () => CONTENT - scrollTop - clientHeight(),
  };
}

/** A textarea that reports `rows` worth of content and drives the shell. */
function makeComposer(shell: ReturnType<typeof makeShell>, rows: () => number) {
  const el = document.createElement("textarea");
  document.body.append(el);
  Object.defineProperty(el, "scrollHeight", { get: () => rows() * ROW });
  const style = el.style;
  Object.defineProperty(style, "height", {
    get: () => "",
    set: (v: string) => {
      // `auto` = the rows=1 intrinsic height, NOT the content height.
      shell.setComposerHeight(v === "auto" ? ROW : parseFloat(v));
    },
  });
  return el;
}

/** Type `breaks` newlines, re-pinning after each grow the way App does. */
function typeLineBreaks(breaks: number) {
  const shell = makeShell();
  let rows = 1;
  const el = makeComposer(shell, () => rows);
  // App's stick-to-bottom pin, updated by every scroll event exactly as
  // onTranscriptScroll does.
  let pinned = true;
  const observeScrolls = () => {
    while (shell.scrollEvents.length) {
      shell.scrollEvents.shift();
      pinned = shell.distanceFromBottom() <= PIN_THRESHOLD;
    }
  };

  shell.transcript.scrollTop = CONTENT; // start pinned to the newest message
  observeScrolls();
  const offBottomAfterAutosize: number[] = [];

  for (let n = 0; n < breaks; n++) {
    rows += 1;
    const wasPinned = pinned;
    autosizeComposer(el, shell.transcript, pinned); // useLayoutEffect on `input`
    observeScrolls();
    // A pinned composer must already be at the bottom by the time the
    // ResizeObserver runs; anything left for the RO to correct is a frame of
    // visible bounce while typing.
    if (wasPinned) offBottomAfterAutosize.push(shell.distanceFromBottom());
    if (pinned) shell.transcript.scrollTop = CONTENT; // ResizeObserver re-pin
    observeScrolls();
  }
  return { pinned, shell, el, offBottomAfterAutosize };
}

describe("autosizeComposer", () => {
  it("sizes the textarea to its content", () => {
    const shell = makeShell();
    const el = makeComposer(shell, () => 4);
    autosizeComposer(el, shell.transcript);
    expect(shell.transcript.clientHeight).toBe(SHELL - CHROME - 4 * ROW);
    expect(el.style.overflowY).toBe("hidden");
  });

  it("keeps the transcript pinned through the first breaks", () => {
    const { pinned, shell } = typeLineBreaks(3);
    expect(pinned).toBe(true);
    expect(shell.transcript.scrollTop).toBe(shell.maxScroll());
  });

  // The regression itself: without the scrollTop snapshot/restore inside
  // autosizeComposer the pin is lost here and never comes back, so the composer
  // overlaps the newest messages from the 4th break on.
  it("keeps the transcript pinned past 3 line breaks", () => {
    const { pinned, shell } = typeLineBreaks(6);
    expect(pinned).toBe(true);
    expect(shell.transcript.scrollTop).toBe(shell.maxScroll());
    expect(shell.distanceFromBottom()).toBe(0);
  });

  it("survives a composer that is already tall (no measurement flicker)", () => {
    const { pinned, shell } = typeLineBreaks(12);
    expect(pinned).toBe(true);
    expect(shell.distanceFromBottom()).toBe(0);
  });

  // Second regression: the pin was restored a frame LATE (the ResizeObserver
  // did it), so every keystroke that wrapped a line showed the transcript sit a
  // row off the bottom and then settle — the jitter Ken saw while typing.
  it("lands at the bottom in the same pass, leaving nothing for the observer", () => {
    const { offBottomAfterAutosize } = typeLineBreaks(6);
    expect(offBottomAfterAutosize).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it("leaves a reader who scrolled up exactly where they were", () => {
    const shell = makeShell();
    let rows = 8; // tall enough that the transcript can actually scroll
    const el = makeComposer(shell, () => rows);
    autosizeComposer(el, shell.transcript, false);
    shell.transcript.scrollTop = 100; // scrolled up, un-pinned
    rows = 9;
    autosizeComposer(el, shell.transcript, false);
    expect(shell.transcript.scrollTop).toBe(100);
  });

  it("does nothing without a transcript", () => {
    const shell = makeShell();
    const el = makeComposer(shell, () => 2);
    expect(() => autosizeComposer(el, null)).not.toThrow();
    expect(() => autosizeComposer(null, shell.transcript)).not.toThrow();
  });
});
