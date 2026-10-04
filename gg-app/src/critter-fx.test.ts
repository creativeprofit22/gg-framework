// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { discard } from "./critter-fx";
import { createCritterFloor } from "./critter-floor";
import { homeRoster } from "./home-roster";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe("discard", () => {
  // WebKit keeps a detached node's fill-forwards/infinite animations on the
  // page timeline forever; only cancel() releases them. Removing without
  // cancelling leaked ~20% idle CPU per long-lived critter window.
  it("cancels the node's and its children's animations before removing it", () => {
    const parent = document.createElement("div");
    const node = document.createElement("div");
    parent.appendChild(node);
    const cancel = vi.fn();
    const getAnimations = vi.fn(() => [{ cancel }, { cancel }] as unknown as Animation[]);
    node.getAnimations = getAnimations;

    discard(node);

    expect(getAnimations).toHaveBeenCalledWith({ subtree: true });
    expect(cancel).toHaveBeenCalledTimes(2);
    expect(node.isConnected).toBe(false);
    expect(parent.childElementCount).toBe(0);
  });

  it("ignores a missing node", () => {
    expect(() => discard(null)).not.toThrow();
  });
});

describe("critter floor frame loop", () => {
  it("runs only while the window is focused, and resumes on focus", () => {
    vi.useFakeTimers();
    Element.prototype.animate = vi.fn(
      () =>
        ({
          finished: Promise.resolve(),
          cancel: () => undefined,
          onfinish: null,
        }) as unknown as Animation,
    ) as unknown as Element["animate"];
    Element.prototype.getAnimations = vi.fn(() => []) as unknown as Element["getAnimations"];
    let focused = true;
    vi.spyOn(document, "hasFocus").mockImplementation(() => focused);
    const raf = vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 1);
    const caf = vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    const lane = document.createElement("div");
    document.body.appendChild(lane);
    const floor = createCritterFloor(lane, { reducedMotion: true, ambient: true });

    floor.sync(homeRoster());
    vi.advanceTimersByTime(2000);
    expect(raf).toHaveBeenCalled();

    focused = false;
    window.dispatchEvent(new Event("blur"));
    expect(caf).toHaveBeenCalled();
    raf.mockClear();
    vi.advanceTimersByTime(5000);
    expect(raf).not.toHaveBeenCalled();

    focused = true;
    window.dispatchEvent(new Event("focus"));
    expect(raf).toHaveBeenCalledTimes(1);

    floor.destroy();
  });
});
