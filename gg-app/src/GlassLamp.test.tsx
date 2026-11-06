// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { GlassLamp } from "./GlassLamp";

function mockMedia(still: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      matches: still,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
}

describe("GlassLamp", () => {
  let frames: FrameRequestCallback[];
  beforeEach(() => {
    frames = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const paths = (svg: SVGSVGElement) =>
    Array.from(svg.querySelectorAll("path"), (path) => path.getAttribute("d"));

  it("is decorative and rests without scheduling frames", () => {
    mockMedia(false);
    const { container } = render(<GlassLamp />);
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(svg.hasAttribute("data-running")).toBe(false);
    // Three ribbons, each drawn as a far and a near pass, plus two shine shapes.
    expect(svg.querySelectorAll("path")).toHaveLength(8);
    expect(frames).toHaveLength(0);
  });

  it("drifts while active and stops when the search ends", () => {
    mockMedia(false);
    const { container, rerender } = render(<GlassLamp active />);
    const svg = container.querySelector("svg")!;
    expect(svg.hasAttribute("data-running")).toBe(true);
    const before = paths(svg);
    act(() => frames.shift()?.(performance.now() + 2000));
    expect(paths(svg)).not.toEqual(before);
    rerender(<GlassLamp active={false} />);
    expect(svg.hasAttribute("data-running")).toBe(false);
    expect(paths(svg)).toEqual(before);
    expect(window.cancelAnimationFrame).toHaveBeenCalled();
  });

  it("stays still under reduced motion or forced colours", () => {
    mockMedia(true);
    const { container } = render(<GlassLamp active />);
    const svg = container.querySelector("svg")!;
    expect(svg.hasAttribute("data-active")).toBe(true);
    expect(svg.hasAttribute("data-running")).toBe(false);
    expect(frames).toHaveLength(0);
  });

  it("stays still in an unfocused window", () => {
    mockMedia(false);
    vi.mocked(document.hasFocus).mockReturnValue(false);
    const { container } = render(<GlassLamp active />);
    expect(container.querySelector("svg")!.hasAttribute("data-running")).toBe(false);
    expect(frames).toHaveLength(0);
  });
});
