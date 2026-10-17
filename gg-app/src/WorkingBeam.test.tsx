// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkingBeam } from "./WorkingBeam";

beforeEach(() => {
  vi.stubGlobal("matchMedia", (media: string) => ({
    matches: false,
    media,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("WorkingBeam", () => {
  it("mounts a decorative overlay only while active, without runtime stylesheets", () => {
    const { container, rerender } = render(<WorkingBeam active={false} />);
    expect(container.querySelector(".working-beam")).toBeNull();

    rerender(<WorkingBeam active />);
    const beam = container.querySelector<HTMLElement>(".working-beam");
    expect(beam).not.toBeNull();
    expect(beam?.getAttribute("aria-hidden")).toBe("true");
    expect(beam?.classList.contains("working-beam-md")).toBe(true);
    // Both the stroke and the inner glow carry a rotating sweep.
    expect(beam?.querySelectorAll(".working-beam-ring > .working-beam-sweep")).toHaveLength(1);
    expect(beam?.querySelectorAll(".working-beam-glow > .working-beam-sweep")).toHaveLength(1);
    // Static CSS only: nothing for the window's style nonce to authorize.
    expect(container.querySelector("style")).toBeNull();

    rerender(<WorkingBeam active={false} />);
    expect(container.querySelector(".working-beam")).toBeNull();
  });

  it("keeps the draft, focus, and stop control intact across work transitions", () => {
    const onStop = vi.fn();
    const composer = (active: boolean) => (
      <div className="inputwrap">
        <WorkingBeam active={active} />
        <textarea aria-label="Message" defaultValue="Keep my draft" />
        <div className="inputactions-trailing">
          <WorkingBeam active={active} size="sm" />
          <button onClick={onStop}>Stop</button>
        </div>
      </div>
    );
    const { container, rerender } = render(composer(false));
    const input = screen.getByRole("textbox") as HTMLTextAreaElement;
    input.focus();
    rerender(composer(true));
    expect(container.querySelector(".working-beam-sm")).not.toBeNull();
    expect(screen.getByRole("textbox")).toBe(input);
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe("Keep my draft");
    expect(container.querySelectorAll(".working-beam")).toHaveLength(2);
    expect(container.querySelector(".working-beam .working-beam")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(onStop).toHaveBeenCalledOnce();
    rerender(composer(false));
    expect(screen.getByRole("textbox")).toBe(input);
    expect(container.querySelector(".working-beam")).toBeNull();
  });
});
