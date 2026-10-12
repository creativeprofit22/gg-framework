// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FloorAgent } from "./critter-floor";
import type { KenSaid } from "./goal-ken-talk";
import { KenDialogue } from "./KenDialogue";

beforeAll(() => {
  // No canvas in jsdom: the portrait is decoration.
  HTMLCanvasElement.prototype.getContext = (() => null) as never;
});
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const said = (messageId: number, text: string): KenSaid => ({ messageId, face: "happy", text });
const worker = (status: FloorAgent["status"]): FloorAgent => ({
  key: "w1",
  agentName: "builder",
  label: "Builder",
  status,
  activity: undefined,
  tokens: null,
  durationMs: undefined,
  toolUseCount: 3,
});
// Step the clock in small acts: React runs a state change's effects (which
// start the next timer) only when an act ends.
const wait = (ms: number): void => {
  for (let t = 0; t < ms; t += 50) act(() => vi.advanceTimersByTime(50));
};
const phase = (container: HTMLElement): string | null =>
  container.querySelector(".ken-dialogue")?.getAttribute("data-phase") ?? null;

describe("KenDialogue", () => {
  it("keeps quiet about what was already said when the farm opened", () => {
    const { container } = render(
      <KenDialogue said={said(1, "Old news.")} workers={[]} paused={false} reducedMotion />,
    );
    wait(2000);
    expect(phase(container)).toBe("hidden");
  });

  it("says Ken's new line, then leaves on its own", () => {
    const props = { workers: [], paused: false, reducedMotion: true } as const;
    const { container, rerender } = render(<KenDialogue said={null} {...props} />);
    rerender(<KenDialogue said={said(2, "Images done.")} {...props} />);
    wait(1000);
    expect(phase(container)).toBe("talking");
    expect(screen.getByRole("button", { name: /Ken: Images done\./ })).toBeTruthy();
    wait(10_000);
    expect(phase(container)).toBe("hidden");
  });

  it("says when a worker finishes, but not while the question sign is up", () => {
    const { container, rerender } = render(
      <KenDialogue said={null} workers={[worker("running")]} paused reducedMotion />,
    );
    rerender(<KenDialogue said={null} workers={[worker("done")]} paused reducedMotion />);
    wait(2000);
    expect(phase(container)).toBe("hidden");
    rerender(<KenDialogue said={null} workers={[worker("done")]} paused={false} reducedMotion />);
    wait(1000);
    expect(screen.getByRole("button", { name: /Builder/ })).toBeTruthy();
  });

  it("finishes typing on a click, and goes on the next", () => {
    const props = { workers: [], paused: false, reducedMotion: false } as const;
    const { container, rerender } = render(<KenDialogue said={null} {...props} />);
    rerender(
      <KenDialogue said={said(3, "A fairly long line that takes a while to type.")} {...props} />,
    );
    // The queue is checked every 500ms, then the 600ms entrance runs.
    wait(1300);
    const box = screen.getByRole("button", { name: /Show all/ });
    fireEvent.click(box);
    expect(container.querySelector(".ken-dialogue-text")?.textContent).toBe(
      "A fairly long line that takes a while to type.",
    );
    fireEvent.click(screen.getByRole("button", { name: /Dismiss/ }));
    expect(phase(container)).toBe("leaving");
  });
});
