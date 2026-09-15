// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MENTOR_DISPLAY_NAME } from "./brand";
import { KenActivityBar } from "./KenActivityBar";
import { theme } from "./theme";

const baseProps = {
  runStartTs: null,
  tokens: 1234,
  isThinking: false,
  thinkingStartTs: null,
  thinkingAccumMs: 0,
  onCancel: vi.fn(),
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("KenActivityBar", () => {
  it("pauses elapsed updates while hidden and catches up when visible", () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    render(<KenActivityBar {...baseProps} runStartTs={9_000} />);
    expect(screen.getByText("1s")).toBeTruthy();
    hidden.mockReturnValue(true);
    fireEvent(document, new Event("visibilitychange"));
    act(() => vi.advanceTimersByTime(5_000));
    expect(screen.getByText("1s")).toBeTruthy();
    hidden.mockReturnValue(false);
    fireEvent(document, new Event("visibilitychange"));
    expect(screen.getByText("6s")).toBeTruthy();
  });
  it("uses the listening orb and shimmer with Ken's existing color", () => {
    const { container } = render(<KenActivityBar {...baseProps} />);
    const orb = container.querySelector("canvas");
    expect(orb?.getAttribute("aria-label")).toBe("Listening…");
    expect(orb?.getAttribute("aria-hidden")).toBe("true");
    expect(orb?.style.width).toBe("20px");
    const filter = container.querySelector("filter");
    expect(orb?.style.filter).toBe(`url("#${filter?.id}")`);
    expect(container.querySelector("feFlood")?.getAttribute("flood-color")).toBe(theme.ken);
    const label = screen.getByText(`${MENTOR_DISPLAY_NAME} is thinking…`);
    expect(label.classList.contains("shimmer-text")).toBe(true);
    expect(label.style.getPropertyValue("--shimmer-base")).toBe(theme.ken);
  });

  it("preserves token counts, thinking feedback, and cancellation", () => {
    const onCancel = vi.fn();
    render(<KenActivityBar {...baseProps} isThinking thinkingAccumMs={2000} onCancel={onCancel} />);
    expect(screen.getByText("↓ 1.2k tokens")).toBeTruthy();
    expect(screen.getByText("thinking for 2s")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "esc to cancel" }));
    expect(onCancel).toHaveBeenCalledOnce();
  });
});
