// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createChatLayoutMotion } from "./chat-layout-motion";

function harness(count = 8, scale = 1) {
  const transcript = document.createElement("div");
  const surface = document.createElement("div");
  document.body.append(transcript, surface);
  let viewportHeight = 300;
  let surfaceTop = 300;
  const rect = (top: number, height: number) =>
    ({
      top: top * scale,
      bottom: (top + height) * scale,
      left: 0,
      width: 400 * scale,
      height: height * scale,
    }) as DOMRect;
  Object.defineProperties(transcript, {
    clientHeight: { get: () => viewportHeight },
    clientWidth: { value: 400 },
    scrollHeight: { get: () => count * 100 },
  });
  transcript.getBoundingClientRect = () => rect(0, viewportHeight);
  const started: { node: HTMLElement; frames: Keyframe[]; animation: Animation }[] = [];
  const setupAnimation = (node: HTMLElement) => {
    node.animate = vi.fn((frames: Keyframe[] | PropertyIndexedKeyframes | null) => {
      const animation = { cancel: vi.fn(), onfinish: null, oncancel: null } as unknown as Animation;
      started.push({ node, frames: frames as Keyframe[], animation });
      return animation;
    });
    Object.defineProperty(node, "offsetWidth", { value: 400 });
  };
  const rows = Array.from({ length: count }, (_, i) => {
    const node = document.createElement("div");
    transcript.append(node);
    Object.defineProperty(node, "offsetTop", { value: i * 100 });
    node.getBoundingClientRect = vi.fn(() => rect(i * 100 - transcript.scrollTop, 100));
    setupAnimation(node);
    return node;
  });
  surface.getBoundingClientRect = () => rect(surfaceTop, 100);
  setupAnimation(surface);
  transcript.scrollTop = count * 100 - viewportHeight;
  const motion = createChatLayoutMotion(() => ({ transcript, surfaces: [surface] }));
  const follow = vi.fn(() => {
    transcript.scrollTop = transcript.scrollHeight - transcript.clientHeight;
  });
  return {
    transcript,
    surface,
    rows,
    started,
    motion,
    follow,
    resize(height: number) {
      viewportHeight = height;
      surfaceTop = height;
    },
  };
}

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe("chat layout transaction", () => {
  it.each([0.5, 0.95, 1, 1.25, 1.5, 2])(
    "pins final geometry before translating existing rows at zoom %s",
    (scale) => {
      const h = harness(8, scale);
      h.motion.capture();
      h.resize(200);
      const newcomer = document.createElement("div");
      newcomer.animate = vi.fn();
      h.transcript.append(newcomer);
      h.motion.commit(true, h.follow);
      expect(h.follow).toHaveBeenCalledOnce();
      expect(h.transcript.scrollTop).toBe(600);
      expect(h.started).toHaveLength(4);
      for (const { frames } of h.started) {
        expect(frames).toEqual([{ translate: "0px 100px" }, { translate: "0px 0px" }]);
      }
      expect(newcomer.animate).not.toHaveBeenCalled();
      // The observer for this exact commit must not re-pin/cancel a frame later.
      expect(h.motion.resized()).toBe(false);
      for (const { animation } of h.started)
        animation.onfinish?.call(animation, {} as AnimationPlaybackEvent);
      expect(h.transcript.scrollTop).toBe(600);
      h.motion.cancel();
      for (const { animation } of h.started) expect(animation.cancel).not.toHaveBeenCalled();
    },
  );

  it("holds an unpinned reader's row and offset without following", () => {
    const h = harness();
    h.transcript.scrollTop = 230;
    h.motion.capture();
    h.resize(400);
    h.transcript.scrollTop = 220; // model an intervening browser anchor adjustment
    h.motion.commit(false, h.follow);
    expect(h.transcript.scrollTop).toBe(230);
    expect(h.follow).not.toHaveBeenCalled();
    expect(h.started.map((s) => s.node)).toEqual([h.surface]);
  });

  it("rebases a reversal from what is visible, not the old destination", () => {
    const h = harness();
    h.motion.capture();
    h.resize(200);
    h.motion.commit(true, h.follow);
    const old = [...h.started];
    // 75ms into the surface movement it is displayed at y=260.
    h.surface.getBoundingClientRect = () =>
      ({ left: 0, top: 260, width: 400, height: 100 }) as DOMRect;
    h.motion.capture();
    for (const { animation } of old) expect(animation.cancel).toHaveBeenCalledOnce();
    h.resize(300);
    h.surface.getBoundingClientRect = () =>
      ({ left: 0, top: 300, width: 400, height: 100 }) as DOMRect;
    h.motion.commit(true, h.follow);
    expect(h.started[h.started.length - 1]?.frames).toEqual([
      { translate: "0px -40px" },
      { translate: "0px 0px" },
    ]);
    h.motion.cancel();
    expect(h.started[h.started.length - 1]?.animation.cancel).toHaveBeenCalledOnce();
  });

  it("coalesces captures, cancels on resize/manual input and discards uncommitted snapshots", () => {
    const h = harness();
    h.motion.capture();
    h.resize(250);
    h.motion.capture();
    h.motion.commit(true, h.follow);
    expect(h.started[0]?.frames[0]).toEqual({ translate: "0px 50px" });
    h.resize(200);
    expect(h.motion.resized()).toBe(true);
    for (const { animation } of h.started) expect(animation.cancel).toHaveBeenCalledOnce();
    h.motion.capture();
    h.motion.cancel();
    h.motion.commit(true, h.follow);
    expect(h.follow).toHaveBeenCalledOnce();
  });

  it.each(["reduced", "missing", "unmounted"])("settles without motion when %s", (environment) => {
    const h = harness();
    if (environment === "reduced") vi.stubGlobal("matchMedia", () => ({ matches: true }));
    if (environment === "missing") {
      for (const node of [...h.rows, h.surface]) Reflect.deleteProperty(node, "animate");
    }
    h.motion.capture();
    h.resize(200);
    if (environment === "unmounted") h.transcript.remove();
    h.motion.commit(true, h.follow);
    expect(h.started).toEqual([]);
    expect(h.follow).toHaveBeenCalledTimes(environment === "unmounted" ? 0 : 1);
  });

  it("expires an uncommitted capture once and cancels its expiry on teardown", () => {
    let expire: FrameRequestCallback | undefined;
    const request = vi.fn((callback: FrameRequestCallback) => {
      expire = callback;
      return 7;
    });
    const cancel = vi.fn();
    vi.stubGlobal("requestAnimationFrame", request);
    vi.stubGlobal("cancelAnimationFrame", cancel);
    const h = harness();
    h.motion.capture();
    expire?.(16);
    expect(h.motion.commit(true, h.follow)).toBe(false);
    expect(h.follow).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledOnce();
    h.motion.capture();
    h.motion.cancel();
    expect(cancel).toHaveBeenCalledWith(7);
  });

  it("bounds reads to the visible tail rather than measuring all history", () => {
    const h = harness(500);
    h.motion.capture();
    const reads = h.rows.reduce(
      (sum, row) => sum + vi.mocked(row.getBoundingClientRect).mock.calls.length,
      0,
    );
    expect(reads).toBeLessThan(16); // binary search + three visible rows
    h.motion.cancel();
  });
});
