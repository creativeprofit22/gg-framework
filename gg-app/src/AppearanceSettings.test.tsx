// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AppearanceSettings } from "./AppearanceSettings";
import { appearance, APPEARANCE_STORAGE_KEY, DEFAULT_APPEARANCE } from "./appearance";
import { Modal } from "./Modal";

let stop: () => void;
beforeEach(() => { localStorage.clear(); stop = appearance.start(); act(() => appearance.reset()); });
afterEach(() => { cleanup(); stop(); vi.restoreAllMocks(); });

describe("Appearance settings", () => {
  it("labels all seven independent controls and saves live", () => {
    render(<AppearanceSettings />);
    expect(screen.getAllByRole("combobox")).toHaveLength(7);
    const values = [
      ["Theme", "light", "theme"], ["Prose size", "16", "size"],
      ["Letter spacing", "normal", "tracking"], ["Paragraph spacing", "roomy", "paragraphs"],
      ["Wide-pane reading width", "on", "cap"], ["Identity markers", "on", "markers"],
      ["Streamed words", "crisp", "streaming"],
    ];
    for (const [label, value, field] of values) {
      const control = screen.getByRole("combobox", { name: label });
      expect(control.getAttribute("aria-describedby")).toBeTruthy();
      fireEvent.change(control, { target: { value } });
      expect(JSON.parse(localStorage.getItem(APPEARANCE_STORAGE_KEY)!)[field]).toBe(value);
    }
    expect(document.documentElement.dataset.appearanceTheme).toBe("light");
    fireEvent.change(screen.getByLabelText("Theme"), { target: { value: "dark" } });
    expect((screen.getByLabelText("Prose size") as HTMLSelectElement).value).toBe("16");
  });
  it("updates after a storage event and resets only appearance", () => {
    localStorage.setItem("unrelated", "keep");
    render(<AppearanceSettings />);
    act(() => window.dispatchEvent(new StorageEvent("storage", {
      key: APPEARANCE_STORAGE_KEY, newValue: JSON.stringify({ theme: "light", markers: "on" }), storageArea: localStorage,
    })));
    expect((screen.getByLabelText("Theme") as HTMLSelectElement).value).toBe("light");
    fireEvent.click(screen.getByRole("button", { name: "Reset appearance defaults" }));
    expect(appearance.getSnapshot().preferences).toEqual(DEFAULT_APPEARANCE);
    expect(localStorage.getItem("unrelated")).toBe("keep");
  });
  it("shows a nonblocking failed-save status while keeping the choice", () => {
    render(<AppearanceSettings />);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
    fireEvent.change(screen.getByLabelText("Theme"), { target: { value: "light" } });
    expect(screen.getByRole("status").textContent).toContain("could not be saved");
    expect((screen.getByLabelText("Theme") as HTMLSelectElement).value).toBe("light");
  });
  it("uses the existing modal focus trap, Escape, focus return and body portal", () => {
    const opener = document.createElement("button"); document.body.append(opener); opener.focus();
    const close = vi.fn();
    const view = render(<Modal title="Settings" onClose={close}><AppearanceSettings /></Modal>);
    const dialog = screen.getByRole("dialog", { name: "Settings" });
    expect(dialog.parentElement?.parentElement).toBe(document.body);
    const reset = screen.getByRole("button", { name: "Reset appearance defaults" });
    reset.focus(); fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close" }));
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(reset);
    fireEvent.keyDown(document, { key: "Escape" }); expect(close).toHaveBeenCalledOnce();
    view.unmount(); expect(document.activeElement).toBe(opener); opener.remove();
  });
});
