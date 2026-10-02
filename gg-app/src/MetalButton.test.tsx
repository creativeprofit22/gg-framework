// @vitest-environment jsdom
import { createRef } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MetalButton } from "./MetalButton";

beforeEach(() => {
  vi.stubGlobal("matchMedia", (media: string) => ({
    matches: false,
    media,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("MetalButton", () => {
  it.each(["btn-primary", "btn-success", "btn-ghost"])(
    "keeps %s classes, labels, native refs, and actions intact",
    async (variant) => {
      const onClick = vi.fn();
      const ref = createRef<HTMLButtonElement>();
      const { container } = render(
        <MetalButton windowFocused className={`btn btn-sm ${variant}`} ref={ref} onClick={onClick}>
          + New
        </MetalButton>,
      );
      const button = screen.getByRole("button", { name: "+ New" });
      expect(button.classList.contains(variant)).toBe(true);
      expect(ref.current).toBe(button);
      await waitFor(() => expect(container.querySelector(".action-metal")).not.toBeNull());
      fireEvent.click(button);
      expect(onClick).toHaveBeenCalledOnce();
      expect(container.querySelector("button .action-metal")).toBeNull();
    },
  );

  it("preserves the button across disabled transitions, without leaving the effect active", () => {
    const onClick = vi.fn();
    const { container, rerender } = render(
      <MetalButton windowFocused disabled onClick={onClick}>
        /commit
      </MetalButton>,
    );
    const button = screen.getByRole("button", { name: "/commit" });
    expect(container.querySelector(".action-metal")).toBeNull();
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
    rerender(
      <MetalButton windowFocused onClick={onClick}>
        /commit
      </MetalButton>,
    );
    expect(screen.getByRole("button", { name: "/commit" })).toBe(button);
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("keeps unavailable Code/Chat actions explanatory without animating them", () => {
    const explainSetup = vi.fn();
    const { container } = render(
      <MetalButton windowFocused aria-disabled onClick={explainSetup}>
        Code
      </MetalButton>,
    );
    expect(container.querySelector(".action-metal")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Code" }));
    expect(explainSetup).toHaveBeenCalledOnce();
  });
});
