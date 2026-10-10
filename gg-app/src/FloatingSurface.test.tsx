// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FloatingSurface } from "./FloatingSurface";
import { Dropdown } from "./Dropdown";
import { ModelSelect } from "./ModelSelect";
import { BackgroundTasksButton } from "./BackgroundTasksButton";
import { RunningSchedulesButton } from "./RunningSchedulesButton";

vi.mock("./agent", () => ({
  killTask: vi.fn(() => {
    throw new Error("Unexpected task execution in motion test");
  }),
}));

function installTransition(): {
  start: ReturnType<typeof vi.fn>;
  capture: () => void;
  finish: () => Promise<void>;
  skip: ReturnType<typeof vi.fn>;
} {
  let update: (() => void) | undefined;
  let finish: (() => void) | undefined;
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const skip = vi.fn();
  const start = vi.fn((callback: () => void) => {
    update = callback;
    return { ready: Promise.resolve(), finished, skipTransition: skip };
  });
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  Object.defineProperty(document, "startViewTransition", { configurable: true, value: start });
  return {
    start,
    skip,
    capture: () => act(() => update?.()),
    finish: async () => {
      await act(async () => {
        finish?.();
        await finished;
      });
    },
  };
}

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(document, "startViewTransition");
  delete document.documentElement.dataset.localTransitions;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("floating surface snapshots", () => {
  it("retains an inert visual only until capture, not until the animation ends", async () => {
    const transition = installTransition();
    const select = vi.fn();
    const { rerender, container } = render(
      <FloatingSurface>
        <button onClick={select}>Pick</button>
      </FloatingSurface>,
    );
    rerender(<FloatingSurface>{null}</FloatingSurface>);
    expect(screen.queryByRole("button")).toBeNull();
    const retained = container.querySelector("button");
    expect(retained).not.toBeNull();
    expect(retained?.closest("[inert]")).not.toBeNull();
    if (retained) fireEvent.click(retained);
    expect(select).not.toHaveBeenCalled();
    expect(document.documentElement.dataset.localTransitions).toBe("1");
    transition.capture();
    expect(container.querySelector("button")).toBeNull();
    await transition.finish();
    expect(document.documentElement.dataset.localTransitions).toBeUndefined();
  });

  it.each(["before capture", "during playback"])("revives when reopened %s", async (when) => {
    const transition = installTransition();
    const { rerender } = render(
      <FloatingSurface>
        <button>Old</button>
      </FloatingSurface>,
    );
    rerender(<FloatingSurface>{null}</FloatingSurface>);
    if (when === "during playback") transition.capture();
    rerender(
      <FloatingSurface>
        <button>New</button>
      </FloatingSurface>,
    );
    expect(transition.skip).toHaveBeenCalledOnce();
    transition.capture();
    expect(screen.getByRole("button", { name: "New" })).toBeTruthy();
    await transition.finish();
  });

  it("cancels pending capture on unmount", async () => {
    const transition = installTransition();
    const { rerender, unmount } = render(
      <FloatingSurface>
        <button>Pick</button>
      </FloatingSurface>,
    );
    rerender(<FloatingSurface>{null}</FloatingSurface>);
    unmount();
    transition.capture();
    expect(transition.skip).toHaveBeenCalledOnce();
    await transition.finish();
  });

  it.each([false, true])("settles immediately with fallback (reduced=%s)", (reduced) => {
    const transition = installTransition();
    vi.stubGlobal("matchMedia", () => ({ matches: reduced }));
    if (!reduced) Reflect.deleteProperty(document, "startViewTransition");
    const { rerender, container } = render(
      <FloatingSurface>
        <button>Pick</button>
      </FloatingSurface>,
    );
    rerender(<FloatingSurface>{null}</FloatingSurface>);
    expect(container.querySelector("button")).toBeNull();
    expect(transition.start).not.toHaveBeenCalled();
  });

  it.each(["dropdown", "model", "tasks", "schedules"])(
    "captures %s when its owner removes the available data",
    async (kind) => {
      const transition = installTransition();
      Element.prototype.scrollIntoView = vi.fn();
      const change = vi.fn();
      const view = (available: boolean): React.ReactElement => {
        if (kind === "dropdown")
          return (
            <Dropdown
              label="Fixture"
              value="one"
              options={available ? [{ value: "one", label: "One" }] : []}
              onChange={change}
            />
          );
        if (kind === "model")
          return (
            <ModelSelect
              title="Fixture"
              currentModel="one"
              models={available ? [{ id: "one", name: "One", provider: "openai" }] : []}
              onSelect={change}
            />
          );
        if (kind === "tasks")
          return (
            <BackgroundTasksButton
              tasks={
                available
                  ? [{ id: "one", pid: 0, command: "Fictional", startedAt: 0, exitCode: null }]
                  : []
              }
            />
          );
        return (
          <RunningSchedulesButton
            schedules={
              available
                ? [
                    {
                      id: "one",
                      prompt: "Fictional",
                      intervalMs: 60000,
                      runCount: null,
                      nextRunAt: 0,
                      runsCompleted: 0,
                    },
                  ]
                : []
            }
            onStop={change}
          />
        );
      };
      const { rerender } = render(view(true));
      fireEvent.click(screen.getByRole("button"));
      rerender(view(false));
      expect(document.querySelector(".floating-surface[data-exiting] > *")).not.toBeNull();
      expect(transition.start).toHaveBeenCalledOnce();
      transition.capture();
      await transition.finish();
      expect(document.querySelector(".floating-surface[data-exiting]")).toBeNull();
      expect(change).not.toHaveBeenCalled();
    },
  );

  it("commits dropdown selection once before capture and returns focus", async () => {
    const transition = installTransition();
    Element.prototype.scrollIntoView = vi.fn();
    const select = vi.fn();
    render(
      <Dropdown
        label="Station"
        value="one"
        options={[
          { value: "one", label: "One" },
          { value: "two", label: "Two" },
        ]}
        onChange={select}
      />,
    );
    const trigger = screen.getByRole("button", { name: "Station" });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("option", { name: "Two" }));
    expect(select).toHaveBeenCalledExactlyOnceWith("two");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger);
    expect(screen.queryByRole("listbox")).toBeNull();
    transition.capture();
    fireEvent.click(trigger);
    await transition.finish();
    expect(screen.getByRole("listbox")).toBeTruthy();
    expect(select).toHaveBeenCalledOnce();
  });
});
