// @vitest-environment jsdom
import { useRef, useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAnimatedHeight } from "./animated-height";

function Fixture({ size = 300 }: { size?: number }): React.ReactElement {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const capture = useAnimatedHeight(ref, open, size);
  return (
    <>
      <button
        onClick={() => {
          capture();
          setOpen(!open);
        }}
      >
        Toggle
      </button>
      <div ref={ref} data-testid="box" style={{ height: open ? size : 100 }} />
    </>
  );
}

function animations(): {
  animate: ReturnType<typeof vi.fn>;
  runs: Animation[];
  visible: (height: number) => void;
} {
  const runs: Animation[] = [];
  let displayed: number | null = null;
  const nativeStyle = window.getComputedStyle.bind(window);
  vi.spyOn(window, "getComputedStyle").mockImplementation((el) => {
    const style = nativeStyle(el);
    if (displayed !== null) Object.defineProperty(style, "height", { value: `${displayed}px` });
    return style;
  });
  const animate = vi.fn(() => {
    const run = {
      cancel: vi.fn(() => {
        displayed = null;
      }),
      onfinish: null,
      oncancel: null,
    } as unknown as Animation;
    runs.push(run);
    return run;
  });
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: false })),
  );
  vi.stubGlobal("Animation", class {});
  Object.defineProperty(HTMLElement.prototype, "animate", { configurable: true, value: animate });
  return {
    animate,
    runs,
    visible: (value) => {
      displayed = value;
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(HTMLElement.prototype, "animate");
});

describe("owned height motion", () => {
  it("reverses from the displayed CSS height and cancels the abandoned direction", () => {
    const { animate, runs, visible } = animations();
    render(<Fixture />);
    fireEvent.click(screen.getByText("Toggle"));
    expect(animate.mock.calls[0]?.[0]).toEqual([
      { height: "100px", overflow: "hidden" },
      { height: "300px", overflow: "hidden" },
    ]);
    visible(175);
    fireEvent.click(screen.getByText("Toggle"));
    expect(runs[0]?.cancel).toHaveBeenCalledOnce();
    expect(animate.mock.calls[1]?.[0]).toEqual([
      { height: "175px", overflow: "hidden" },
      { height: "100px", overflow: "hidden" },
    ]);
  });

  it("retargets changed content without a toggle, ignores stale completion, and cancels on unmount", () => {
    const { animate, runs, visible } = animations();
    const view = render(<Fixture />);
    fireEvent.click(screen.getByText("Toggle"));
    visible(180);
    view.rerender(<Fixture size={450} />);
    expect(animate.mock.calls[1]?.[0]).toEqual([
      { height: "180px", overflow: "hidden" },
      { height: "450px", overflow: "hidden" },
    ]);
    const old = runs[0];
    old?.onfinish?.call(old, new Event("finish") as AnimationPlaybackEvent);
    view.unmount();
    expect(runs[1]?.cancel).toHaveBeenCalledOnce();
  });

  it("uses the resting size when content changes before a finished animation's cleanup", () => {
    const { animate, runs, visible } = animations();
    const view = render(<Fixture />);
    fireEvent.click(screen.getByText("Toggle"));
    Object.defineProperty(runs[0], "playState", { value: "finished" });
    visible(450);
    view.rerender(<Fixture size={450} />);
    expect(animate.mock.calls[1]?.[0]).toEqual([
      { height: "300px", overflow: "hidden" },
      { height: "450px", overflow: "hidden" },
    ]);
  });

  it.each([0.5, 0.95, 1, 1.25, 1.5, 2])("does not mix viewport pixels at zoom %s", (scale) => {
    const { animate } = animations();
    render(<Fixture />);
    const box = screen.getByTestId("box");
    box.style.zoom = String(scale);
    vi.spyOn(box, "getBoundingClientRect").mockReturnValue({ height: 100 * scale } as DOMRect);
    fireEvent.click(screen.getByText("Toggle"));
    expect(animate.mock.calls[0]?.[0]).toEqual([
      { height: "100px", overflow: "hidden" },
      { height: "300px", overflow: "hidden" },
    ]);
  });

  it("settles synchronously with reduced motion or without WAAPI", () => {
    const { animate } = animations();
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: true })),
    );
    render(<Fixture />);
    fireEvent.click(screen.getByText("Toggle"));
    expect(animate).not.toHaveBeenCalled();
    expect(screen.getByTestId("box").style.height).toBe("300px");
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: false })),
    );
    Reflect.deleteProperty(HTMLElement.prototype, "animate");
    fireEvent.click(screen.getByText("Toggle"));
    expect(screen.getByTestId("box").style.height).toBe("100px");
  });
});
