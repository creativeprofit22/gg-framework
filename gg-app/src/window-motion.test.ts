// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { installMotionAttribute, readMotionLevel, subscribeMotion } from "./window-motion";

afterEach(() => {
  vi.restoreAllMocks();
  delete document.documentElement.dataset.motion;
});

function fakeWindow(initial: { focused: boolean; hidden: boolean }) {
  const state = { ...initial };
  vi.spyOn(document, "hasFocus").mockImplementation(() => state.focused);
  vi.spyOn(document, "hidden", "get").mockImplementation(() => state.hidden);
  return {
    blur() {
      state.focused = false;
      window.dispatchEvent(new Event("blur"));
    },
    focus() {
      state.focused = true;
      window.dispatchEvent(new Event("focus"));
    },
    hide() {
      state.hidden = true;
      state.focused = false;
      document.dispatchEvent(new Event("visibilitychange"));
    },
    show() {
      state.hidden = false;
      document.dispatchEvent(new Event("visibilitychange"));
    },
  };
}

describe("readMotionLevel", () => {
  it("is full when focused, still when only visible, off when hidden", () => {
    const win = fakeWindow({ focused: true, hidden: false });
    expect(readMotionLevel()).toBe("full");
    win.blur();
    expect(readMotionLevel()).toBe("still");
    win.hide();
    expect(readMotionLevel()).toBe("off");
  });
});

describe("subscribeMotion", () => {
  it("reports each change once and stops after unsubscribe", () => {
    const win = fakeWindow({ focused: true, hidden: false });
    const seen: string[] = [];
    const stop = subscribeMotion((level) => seen.push(level));

    win.blur();
    win.blur();
    win.hide();
    win.show();
    win.focus();
    expect(seen).toEqual(["still", "off", "still", "full"]);

    stop();
    win.blur();
    expect(seen).toHaveLength(4);
  });
});

describe("installMotionAttribute", () => {
  it("mirrors the level onto <html data-motion> for the stylesheets", () => {
    const win = fakeWindow({ focused: false, hidden: false });
    const stop = installMotionAttribute();
    expect(document.documentElement.dataset.motion).toBe("still");
    win.focus();
    expect(document.documentElement.dataset.motion).toBe("full");
    win.hide();
    expect(document.documentElement.dataset.motion).toBe("off");
    stop();
  });
});
