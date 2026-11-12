// @vitest-environment jsdom
import { useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ActionDial, type DialOption } from "./ActionDial";

type Id = "one" | "two" | "three";

function Harness({ runs, blocked }: { runs: Record<Id, () => void>; blocked?: Id }) {
  const [selected, setSelected] = useState<Id>("one");
  const options: DialOption<Id>[] = (["one", "two", "three"] as const).map((id) => ({
    id,
    label: `Action ${id}`,
    icon: <span>{id}</span>,
    hint: `Run ${id}`,
    blocked: id === blocked ? "Not now" : null,
    run: runs[id],
  }));
  return <ActionDial options={options} selected={selected} onSelect={setSelected} />;
}

function setup(blocked?: Id) {
  const runs = { one: vi.fn(), two: vi.fn(), three: vi.fn() };
  render(<Harness runs={runs} blocked={blocked} />);
  return runs;
}

const hub = () => document.querySelector<HTMLButtonElement>(".action-dial-hub");
const petal = (id: Id) => document.querySelector<HTMLButtonElement>(`[data-dial-option="${id}"]`);
const isOpen = () => document.querySelector(".action-dial")?.hasAttribute("data-open") ?? false;

/** jsdom has no layout: make every hit test land on `element`. */
function pointAt(element: Element | null): void {
  Object.defineProperty(document, "elementFromPoint", {
    configurable: true,
    value: () => element,
  });
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  Reflect.deleteProperty(document, "elementFromPoint");
});

describe("ActionDial", () => {
  it("runs the shown action on a click, and nothing when it is blocked", () => {
    const runs = setup();
    fireEvent.click(screen.getByRole("button", { name: "Action one" }));
    expect(runs.one).toHaveBeenCalledOnce();
    expect(runs.two).not.toHaveBeenCalled();
    cleanup();

    const blocked = setup("one");
    fireEvent.click(screen.getByRole("button", { name: "Action one" }));
    expect(blocked.one).not.toHaveBeenCalled();
  });

  it("opens on a long press and switches on release over a petal without running", () => {
    const runs = setup();
    const button = hub();
    if (!button) throw new Error("hub missing");
    fireEvent.pointerDown(button, { button: 0, pointerId: 1 });
    act(() => vi.advanceTimersByTime(319));
    expect(isOpen()).toBe(false);
    act(() => vi.advanceTimersByTime(1));
    expect(isOpen()).toBe(true);

    const target = petal("three");
    if (!target) throw new Error("petal missing");
    pointAt(target);
    fireEvent.pointerMove(button, { clientX: 5, clientY: 5 });
    // The hub previews the option under the pointer.
    expect(button.getAttribute("aria-label")).toBe("Action three");
    fireEvent.pointerUp(button, { clientX: 5, clientY: 5 });
    fireEvent.click(button);

    expect(isOpen()).toBe(false);
    expect(screen.getByRole("button", { name: "Action three" })).toBe(button);
    expect(runs.one).not.toHaveBeenCalled();
    expect(runs.three).not.toHaveBeenCalled();

    // The next ordinary click runs the newly shown action.
    fireEvent.pointerDown(button, { button: 0, pointerId: 1 });
    fireEvent.pointerUp(button);
    fireEvent.click(button);
    expect(runs.three).toHaveBeenCalledOnce();
  });

  it("stays open when the hold is released away from the petals, for a click", () => {
    const runs = setup();
    const button = hub();
    if (!button) throw new Error("hub missing");
    pointAt(null);
    fireEvent.pointerDown(button, { button: 0, pointerId: 1 });
    act(() => vi.advanceTimersByTime(320));
    fireEvent.pointerUp(button);
    fireEvent.click(button);
    expect(isOpen()).toBe(true);

    const two = petal("two");
    if (!two) throw new Error("petal missing");
    fireEvent.click(two);
    expect(isOpen()).toBe(false);
    expect(button.getAttribute("aria-label")).toBe("Action two");
    expect(runs.two).not.toHaveBeenCalled();
  });

  it("opens from the keyboard, moves with arrows and picks with Enter", () => {
    const runs = setup();
    const button = hub();
    if (!button) throw new Error("hub missing");
    fireEvent.keyDown(button, { key: "ArrowUp" });
    expect(isOpen()).toBe(true);
    fireEvent.keyDown(button, { key: "ArrowRight" });
    fireEvent.keyDown(button, { key: "ArrowRight" });
    expect(button.getAttribute("aria-label")).toBe("Action three");
    fireEvent.keyDown(button, { key: "ArrowRight" });
    expect(button.getAttribute("aria-label")).toBe("Action one");
    fireEvent.keyDown(button, { key: "ArrowLeft" });
    fireEvent.keyDown(button, { key: "Enter" });
    fireEvent.click(button);
    expect(isOpen()).toBe(false);
    expect(button.getAttribute("aria-label")).toBe("Action three");
    expect(runs.three).not.toHaveBeenCalled();
  });

  it("closes on Escape and on a press outside, keeping the shown action", () => {
    setup();
    const button = hub();
    if (!button) throw new Error("hub missing");
    fireEvent.contextMenu(button);
    expect(isOpen()).toBe(true);
    fireEvent.keyDown(button, { key: "ArrowRight" });
    fireEvent.keyDown(button, { key: "Escape" });
    expect(isOpen()).toBe(false);
    expect(button.getAttribute("aria-label")).toBe("Action one");

    fireEvent.keyDown(button, { key: "ArrowDown" });
    expect(isOpen()).toBe(true);
    fireEvent.pointerDown(document.body);
    expect(isOpen()).toBe(false);
  });

  it("cancels the hold when the press ends early", () => {
    const runs = setup();
    const button = hub();
    if (!button) throw new Error("hub missing");
    fireEvent.pointerDown(button, { button: 0, pointerId: 1 });
    act(() => vi.advanceTimersByTime(100));
    fireEvent.pointerUp(button);
    fireEvent.click(button);
    act(() => vi.advanceTimersByTime(1000));
    expect(isOpen()).toBe(false);
    expect(runs.one).toHaveBeenCalledOnce();
  });
});
