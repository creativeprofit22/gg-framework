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
