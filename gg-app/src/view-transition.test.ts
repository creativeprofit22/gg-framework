// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { withViewTransition } from "./view-transition";

type StartViewTransition = (update: () => void) => {
  ready: Promise<void>;
  finished: Promise<void>;
};

function stubStart(impl: StartViewTransition | undefined): void {
  Object.defineProperty(document, "startViewTransition", {
    configurable: true,
    writable: true,
    value: impl,
  });
}

function stubReducedMotion(matches: boolean): void {
  window.matchMedia = vi.fn().mockReturnValue({ matches }) as unknown as typeof window.matchMedia;
}

afterEach(() => {
  stubStart(undefined);
  vi.restoreAllMocks();
});

describe("withViewTransition", () => {
  it("runs the update directly when the API is missing", () => {
    stubStart(undefined);
    stubReducedMotion(false);
    const update = vi.fn();
    withViewTransition(update);
    expect(update).toHaveBeenCalledOnce();
  });

  it("skips the transition when the user prefers reduced motion", () => {
    const start = vi.fn<StartViewTransition>();
    stubStart(start);
    stubReducedMotion(true);
    const update = vi.fn();
    withViewTransition(update);
    expect(start).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledOnce();
  });

  it("does not start a nested transition inside a committing update", () => {
    const start = vi.fn<StartViewTransition>((cb) => {
      cb();
      return { ready: Promise.resolve(), finished: Promise.resolve() };
    });
    stubStart(start);
    stubReducedMotion(false);
    const child = vi.fn();
    withViewTransition(() => withViewTransition(child, true));
    expect(start).toHaveBeenCalledOnce();
    expect(child).toHaveBeenCalledOnce();
    expect(document.documentElement.hasAttribute("data-view-transition-update")).toBe(false);
  });

  it("falls back if starting the optional API throws", () => {
    stubStart(() => {
      throw new Error("unavailable");
    });
    stubReducedMotion(false);
    const update = vi.fn();
    withViewTransition(update, true);
    expect(update).toHaveBeenCalledOnce();
    expect(document.documentElement.dataset.localTransitions).toBeUndefined();
  });

  it("runs the update inside the transition and swallows a skipped animation", async () => {
    const skipped = Promise.reject(new Error("skipped"));
    const start = vi.fn<StartViewTransition>((cb) => {
      cb();
      return { ready: skipped, finished: skipped };
    });
    stubStart(start);
    stubReducedMotion(false);
    const update = vi.fn();
    withViewTransition(update);
    expect(start).toHaveBeenCalledOnce();
    expect(update).toHaveBeenCalledOnce();
    await expect(skipped).rejects.toThrow("skipped");
  });
});
