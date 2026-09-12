// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Dropdown } from "./Dropdown";

// jsdom implements no layout, so it ships no `scrollIntoView`. Stub it here
// rather than guarding the call site — the component should keep calling the
// real DOM API in the browser.
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(cleanup);

const OPTIONS = [
  { value: "lofi", label: "Lo-fi", description: "Beats" },
  { value: "jazz", label: "Jazz", disabled: true },
  { value: "synth", label: "Synthwave" },
];

function open(): HTMLElement {
  fireEvent.click(screen.getByRole("button", { name: "Station" }));
  return screen.getByRole("listbox", { name: "Station" });
}

describe("Dropdown", () => {
  it("opens, moves with arrows past disabled options, and commits on Enter", () => {
    const onChange = vi.fn();
    render(<Dropdown label="Station" options={OPTIONS} value="lofi" onChange={onChange} />);

    const list = open();
    fireEvent.keyDown(list, { key: "ArrowDown" });
    expect(list.getAttribute("aria-activedescendant")).toBe(
      screen.getByRole("option", { name: "Synthwave" }).id,
    );

    fireEvent.keyDown(list, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("synth");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("opens on the current value, then jumps with Home/End", () => {
    // Deliberately a value that is NOT the first option: opening at index 0
    // would be indistinguishable from opening at the selection otherwise.
    render(<Dropdown label="Station" options={OPTIONS} value="synth" onChange={vi.fn()} />);
    const list = open();

    const synthwave = screen.getByRole("option", { name: "Synthwave" });
    expect(synthwave.getAttribute("aria-selected")).toBe("true");
    expect(list.getAttribute("aria-activedescendant")).toBe(synthwave.id);
    fireEvent.keyDown(list, { key: "Home" });
    expect(list.getAttribute("aria-activedescendant")).toBe(
      screen.getByRole("option", { name: /Lo-fi/ }).id,
    );
    fireEvent.keyDown(list, { key: "End" });
    expect(list.getAttribute("aria-activedescendant")).toBe(
      screen.getByRole("option", { name: "Synthwave" }).id,
    );
  });

  it("cancels on Escape without letting a host modal see the key", () => {
    const onChange = vi.fn();
    const hostEscape = vi.fn();
    document.addEventListener("keydown", hostEscape);
    render(<Dropdown label="Station" options={OPTIONS} value="lofi" onChange={onChange} />);

    fireEvent.keyDown(open(), { key: "Escape" });

    expect(screen.queryByRole("listbox")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
    expect(hostEscape).not.toHaveBeenCalled();
    document.removeEventListener("keydown", hostEscape);
  });

  it("closes on an outside press and ignores a disabled option's click", async () => {
    const onChange = vi.fn();
    render(<Dropdown label="Station" options={OPTIONS} value="lofi" onChange={onChange} />);

    open();
    fireEvent.click(screen.getByRole("option", { name: "Jazz" }));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByRole("listbox")).not.toBeNull();

    // The outside-press listener is armed on the next tick, so the click that
    // opened the list can't immediately close it again.
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("disables the trigger when there are no options", () => {
    render(
      <Dropdown
        label="Station"
        options={[]}
        value=""
        onChange={vi.fn()}
        placeholder="Loading stations…"
      />,
    );
    const trigger = screen.getByRole("button", { name: "Station" });
    expect(trigger).toHaveProperty("disabled", true);
    expect(trigger.textContent).toContain("Loading stations…");
  });
});
