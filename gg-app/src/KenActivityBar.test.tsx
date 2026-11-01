// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MENTOR_DISPLAY_NAME } from "./brand";
import { KenActivityBar } from "./KenActivityBar";
import { theme } from "./theme";

const baseProps = {
  runStartTs: null,
  tokens: 1234,
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
  it("uses the listening orb and shimmer with Ken's existing color", async () => {
    const { container } = render(<KenActivityBar {...baseProps} />);
    await waitFor(() => expect(container.querySelector("canvas")).toBeTruthy());
    const orb = container.querySelector("canvas");
    expect(orb?.getAttribute("aria-label")).toBe("Listening…");
    expect(orb?.getAttribute("aria-hidden")).toBe("true");
    expect(orb?.style.width).toBe("20px");
    const filter = container.querySelector("filter");
    expect(orb?.style.filter).toBe(`url("#${filter?.id}")`);
    const flood = container.querySelector<SVGElement>("feFlood");
    expect(flood?.style.getPropertyValue("flood-color")).toBe(theme.ken);
    const label = screen.getByText(`${MENTOR_DISPLAY_NAME} is thinking…`);
    expect(label.classList.contains("shimmer-text")).toBe(true);
    expect(label.style.getPropertyValue("--shimmer-base")).toBe(theme.ken);
  });

  it("matches the main bar's running row: its meta and a Stop key in the error colour", () => {
    const onCancel = vi.fn();
    const { container } = render(<KenActivityBar {...baseProps} onCancel={onCancel} />);
    expect(container.querySelector(".task-activity > .statusrow.running")).toBeTruthy();
    expect(screen.getByTitle("Output tokens").textContent).toBe(" · 1.2k tok");
    const stop = screen.getByRole("button", { name: "Cancel Ken's reply" });
    expect(stop.textContent).toBe("Stop");
    expect(stop.style.color).toBe(theme.error);
    expect(stop.closest(".statusrow-right")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /tool panel/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Cancel Ken's reply" }));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("shows the tool panel chevron beside Stop, like the main bar", () => {
    const onToggleTools = vi.fn();
    render(<KenActivityBar {...baseProps} toolsHidden onToggleTools={onToggleTools} />);
    const chevron = screen.getByRole("button", { name: "Show tool panel" });
    expect(chevron.nextElementSibling?.textContent).toBe("Stop");
    fireEvent.click(chevron);
    expect(onToggleTools).toHaveBeenCalledOnce();
  });
});
