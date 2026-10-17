// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {} from "vitest/jsdom";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type * as Sounds from "./sounds";

const playSound = vi.hoisted(() => vi.fn());
vi.mock("./sounds", async (importOriginal) => ({
  ...(await importOriginal<typeof Sounds>()),
  playSound,
}));

import { SoundButton } from "./SoundButton";
import { isSoundEnabled, setSoundEnabled } from "./sounds";

beforeEach(() => {
  // Node 25's global storage can shadow jsdom's browser implementation.
  vi.stubGlobal("localStorage", jsdom.window.localStorage);
  localStorage.clear();
  setSoundEnabled(true);
  playSound.mockClear();
});

afterEach(() => {
  cleanup();
  setSoundEnabled(true);
  vi.unstubAllGlobals();
});

describe("SoundButton", () => {
  it("keeps the name Sound effects and exposes on/off as pressed", () => {
    render(<SoundButton />);
    const button = screen.getByRole("button", { name: "Sound effects" });
    expect(button.getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(button);

    expect(isSoundEnabled()).toBe(false);
    expect(screen.getByRole("button", { name: "Sound effects" })).toBe(button);
    expect(button.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(button);

    expect(isSoundEnabled()).toBe(true);
    expect(button.getAttribute("aria-pressed")).toBe("true");
  });

  it("uses the shared toggle styling in Settings", () => {
    render(<SoundButton />);

    expect(screen.getByRole("button", { name: "Sound effects" }).classList).toContain("toggle-btn");
  });

  it("plays a confirmation click only when turning sound back on", () => {
    render(<SoundButton />);
    const button = screen.getByRole("button", { name: "Sound effects" });

    fireEvent.click(button);
    expect(playSound).not.toHaveBeenCalled();

    fireEvent.click(button);
    expect(playSound).toHaveBeenCalledWith("click");
  });

  it("remembers the choice on this machine", () => {
    render(<SoundButton />);

    fireEvent.click(screen.getByRole("button", { name: "Sound effects" }));

    expect(localStorage.getItem("gg-sound-enabled")).toBe("0");
  });
});
