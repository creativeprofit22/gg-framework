// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AppErrorBoundary } from "./AppErrorBoundary";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function Boom(): never {
  throw new Error("render exploded");
}

describe("AppErrorBoundary", () => {
  it("shows a reload panel instead of a blank window when a child throws", () => {
    // React logs caught render errors to console.error; keep the output clean.
    vi.spyOn(console, "error").mockImplementation(() => {});
    const reload = vi.fn();
    vi.stubGlobal("location", { ...window.location, reload });

    render(
      <AppErrorBoundary>
        <Boom />
      </AppErrorBoundary>,
    );

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("This window hit a problem");
    expect(alert.textContent).toContain("render exploded");
    fireEvent.click(screen.getByRole("button", { name: "Reload window" }));
    expect(reload).toHaveBeenCalledOnce();
  });

  it("renders children untouched when nothing throws", () => {
    render(
      <AppErrorBoundary>
        <p>fine</p>
      </AppErrorBoundary>,
    );
    expect(screen.getByText("fine")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
