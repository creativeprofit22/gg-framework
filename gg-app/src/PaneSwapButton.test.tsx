// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PaneSwapButton } from "./PaneSwapButton";
afterEach(cleanup);
it("describes unavailability, prevents native activation and restores availability", () => {
  const onSwap = vi.fn();
  const props = {
    paneId: "a",
    label: "Conversation A",
    helpId: "help",
    buttonRef: vi.fn(),
    onSwap,
  };
  const { rerender } = render(
    <PaneSwapButton {...props} unavailableReason="Swap unavailable while a pane is closing." />,
  );
  const button = screen.getByRole("button") as HTMLButtonElement;
  expect(button.disabled).toBe(true);
  const descriptionId = button.getAttribute("aria-describedby")!.split(" ")[1];
  expect(document.getElementById(descriptionId)?.textContent).toBe(button.title);
  fireEvent.click(button, { detail: 1 });
  fireEvent.keyDown(button, { key: "Enter" });
  fireEvent.click(button, { detail: 0 });
  expect(onSwap).not.toHaveBeenCalled();
  rerender(<PaneSwapButton {...props} />);
  expect(button.disabled).toBe(false);
  expect(button.getAttribute("aria-describedby")).toBe("help");
  expect(document.getElementById(descriptionId)).toBeNull();
  fireEvent.click(button, { detail: 0 });
  expect(onSwap).toHaveBeenCalledExactlyOnceWith("a", true, true);
});
it("uses native button activation, blocks repeated keydowns but leaves normal Space keyup intact", () => {
  const onSwap = vi.fn();
  const ref = vi.fn();
  render(
    <PaneSwapButton
      paneId="a"
      label="Conversation A"
      helpId="help"
      buttonRef={ref}
      onSwap={onSwap}
    />,
  );
  const button = screen.getByRole("button", { name: "Swap with middle: Conversation A" });
  expect(ref).toHaveBeenCalledWith(button);
  expect(fireEvent.keyDown(button, { key: "Enter", repeat: true })).toBe(false);
  expect(fireEvent.keyDown(button, { key: " ", repeat: true })).toBe(false);
  expect(fireEvent.keyDown(button, { key: " " })).toBe(true);
  expect(fireEvent.keyUp(button, { key: " " })).toBe(true);
  expect(onSwap).not.toHaveBeenCalled();
  fireEvent.click(button);
  expect(onSwap).toHaveBeenCalledExactlyOnceWith("a", true, true);
  fireEvent.click(button, { detail: 1 });
  expect(onSwap).toHaveBeenNthCalledWith(2, "a", true, false);
});
