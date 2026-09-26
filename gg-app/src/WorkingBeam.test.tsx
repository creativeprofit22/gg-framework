// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  it("mounts the real package only while active, at the requested strength", async () => {
    const { container, rerender } = render(<WorkingBeam active={false} />);
    expect(container.querySelector("[data-beam]")).toBeNull();

    rerender(<WorkingBeam active />);
    await waitFor(() => expect(container.querySelector("[data-beam]")).not.toBeNull());
    const beam = container.querySelector<HTMLElement>("[data-beam]");
    expect(beam?.hasAttribute("data-active")).toBe(true);
    expect(beam?.getAttribute("aria-hidden")).toBe("true");
    expect(beam?.style.getPropertyValue("--beam-strength")).toBe("0.7");
    expect(beam?.classList.contains("working-beam-md")).toBe(true);

    rerender(<WorkingBeam active={false} />);
    expect(container.querySelector("[data-beam]")).toBeNull();
    expect(container.querySelector("style")).toBeNull();
  });

  it("keeps the draft, focus, and stop control intact across work transitions", async () => {
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
    await waitFor(() =>
      expect(container.querySelector(".working-beam-sm[data-active]")).not.toBeNull(),
    );
    expect(screen.getByRole("textbox")).toBe(input);
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe("Keep my draft");
    expect(container.querySelector(".working-beam-sm[data-active]")).not.toBeNull();
    expect(container.querySelector("[data-beam] [data-beam]")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(onStop).toHaveBeenCalledOnce();
    rerender(composer(false));
    expect(screen.getByRole("textbox")).toBe(input);
    expect(container.querySelector("[data-beam]")).toBeNull();
  });
});
