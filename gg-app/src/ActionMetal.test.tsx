// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ActionMetal } from "./ActionMetal";

let staticAppearance: boolean;
let mediaEvents: EventTarget;

beforeEach(() => {
  staticAppearance = false;
  mediaEvents = new EventTarget();
  vi.stubGlobal("matchMedia", (media: string) => ({
    get matches() {
      return staticAppearance;
    },
    media,
    addEventListener: mediaEvents.addEventListener.bind(mediaEvents),
    removeEventListener: mediaEvents.removeEventListener.bind(mediaEvents),
  }));
  // Exercise the package's real fallback for devices without WebGL2.
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("ActionMetal", () => {
  it("does not mount the effect for an inactive Send button", () => {
    const { container } = render(<ActionMetal active={false} windowFocused />);
    expect(container.firstChild).toBeNull();
  });

  it.each(["circle", "button"] as const)(
    "preserves the no-WebGL fallback for %s actions",
    async (variant) => {
      const { container, rerender } = render(
        <ActionMetal active windowFocused variant={variant} />,
      );
      await waitFor(() => {
        expect(container.querySelector("[data-metal-fx-unsupported]")).not.toBeNull();
      });
      expect(container.querySelector(".action-metal")?.getAttribute("aria-hidden")).toBe("true");
      expect(container.querySelector("canvas")).toBeNull();
      rerender(<ActionMetal active={false} windowFocused />);
      expect(container.firstChild).toBeNull();
    },
  );

  it("responds immediately when reduced motion or forced colors are requested", async () => {
    const { container } = render(<ActionMetal active windowFocused />);
    await waitFor(() => expect(container.querySelector(".action-metal")).not.toBeNull());
    act(() => {
      staticAppearance = true;
      mediaEvents.dispatchEvent(new Event("change"));
    });
    expect(container.firstChild).toBeNull();
    act(() => {
      staticAppearance = false;
      mediaEvents.dispatchEvent(new Event("change"));
    });
    await waitFor(() => expect(container.querySelector(".action-metal")).not.toBeNull());
  });
});
