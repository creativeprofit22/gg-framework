// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GgUiButton } from "./GgUiButton";
import { ActionMetal } from "./ActionMetal";
import { MetalButton } from "./MetalButton";
import { setGgUiEnabled } from "./gg-ui";

let storage: Map<string, string>;
beforeEach(() => {
  storage = new Map();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  });
  setGgUiEnabled(true);
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
});
afterEach(() => {
  cleanup();
  setGgUiEnabled(true);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("toggles every shared button decoration without replacing native buttons or actions", async () => {
  const onClick = vi.fn();
  const { container } = render(
    <>
      <GgUiButton />
      <ActionMetal active windowFocused />
      <ActionMetal active windowFocused variant="button" />
      <MetalButton className="btn btn-primary" windowFocused onClick={onClick}>
        New
      </MetalButton>
      <MetalButton className="btn btn-success" windowFocused>
        Commit
      </MetalButton>
    </>,
  );
  const nativeNew = screen.getByRole("button", { name: "New" });
  await waitFor(() => expect(container.querySelectorAll(".action-metal")).toHaveLength(4));
  fireEvent.click(screen.getByRole("button", { name: "GG UI on" }));
  expect(screen.getByRole("button", { name: "GG UI off" }).getAttribute("aria-pressed")).toBe(
    "false",
  );
  expect(storage.get("gg-ui-enabled")).toBe("0");
  expect(container.querySelectorAll(".action-metal")).toHaveLength(0);
  expect(screen.getByRole("button", { name: "New" })).toBe(nativeNew);
  expect(nativeNew.classList.contains("btn-primary")).toBe(true);
  fireEvent.click(nativeNew);
  expect(onClick).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "GG UI off" }));
  expect(storage.get("gg-ui-enabled")).toBe("1");
  await waitFor(() => expect(container.querySelectorAll(".action-metal")).toHaveLength(4));
});

it("updates from another window and resets to on when saved preferences are cleared", () => {
  render(<GgUiButton />);
  act(() => {
    storage.set("gg-ui-enabled", "0");
    window.dispatchEvent(new StorageEvent("storage", { key: "gg-ui-enabled", newValue: "0" }));
  });
  expect(screen.getByRole("button", { name: "GG UI off" })).toBeTruthy();
  act(() => {
    storage.clear();
    window.dispatchEvent(new StorageEvent("storage", { key: null }));
  });
  expect(screen.getByRole("button", { name: "GG UI on" })).toBeTruthy();
});

it("keeps the toggle usable when persistence is unavailable", () => {
  render(<GgUiButton />);
  vi.spyOn(localStorage, "setItem").mockImplementation(() => {
    throw new Error("storage blocked");
  });
  fireEvent.click(screen.getByRole("button", { name: "GG UI on" }));
  expect(screen.getByRole("button", { name: "GG UI off" })).toBeTruthy();
});
