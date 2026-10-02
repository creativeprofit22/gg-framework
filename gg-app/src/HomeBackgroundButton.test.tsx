// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {} from "vitest/jsdom";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { HomeBackgroundButton } from "./HomeBackgroundButton";
import { isHomeBackgroundEnabled, setHomeBackgroundEnabled } from "./home-background";

beforeEach(() => {
  // Node 25's global storage can shadow jsdom's browser implementation.
  vi.stubGlobal("localStorage", jsdom.window.localStorage);
  localStorage.clear();
  setHomeBackgroundEnabled(true);
});

afterEach(() => {
  cleanup();
  setHomeBackgroundEnabled(true);
  vi.unstubAllGlobals();
});

describe("HomeBackgroundButton", () => {
  it("is on by default and turns the home background off and on", () => {
    render(<HomeBackgroundButton />);
    const button = screen.getByRole("button", { name: /Background on/ });
    expect(button.getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(button);

    expect(isHomeBackgroundEnabled()).toBe(false);
    expect(screen.getByRole("button", { name: /Background off/ })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Background off/ }));

    expect(isHomeBackgroundEnabled()).toBe(true);
  });

  it("remembers the choice on this machine", () => {
    render(<HomeBackgroundButton />);

    fireEvent.click(screen.getByRole("button", { name: /Background on/ }));

    expect(localStorage.getItem("gg-home-background")).toBe("0");
  });
});
