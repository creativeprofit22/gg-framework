// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ExportChatButton } from "./ExportChatButton";

describe("ExportChatButton", () => {
  it("stays mounted while hidden so the exit animation can play", () => {
    render(<ExportChatButton visible={false} busy={false} onExport={vi.fn()} />);
    const button = screen.getByRole("button", { hidden: true });
    expect(button.className).not.toContain("visible");
    // Hidden from the a11y tree and the tab order, matching pointer-events: none.
    expect(button.getAttribute("aria-hidden")).toBe("true");
    expect(button.tabIndex).toBe(-1);
  });

  it("becomes reachable when visible", () => {
    render(<ExportChatButton visible busy={false} onExport={vi.fn()} />);
    const button = screen.getByRole("button");
    expect(button.className).toContain("visible");
    expect(button.getAttribute("aria-hidden")).toBe("false");
    expect(button.tabIndex).toBe(0);
    expect(screen.getByText("Export chat")).toBeTruthy();
  });

  it("fires the handler on click", () => {
    const onExport = vi.fn();
    render(<ExportChatButton visible busy={false} onExport={onExport} />);
    screen.getByRole("button").click();
    expect(onExport).toHaveBeenCalledTimes(1);
  });

  it("shows progress and refuses clicks while busy", () => {
    const onExport = vi.fn();
    render(<ExportChatButton visible busy onExport={onExport} />);
    const button = screen.getByRole("button") as HTMLButtonElement;
    expect(screen.getByText("Exporting…")).toBeTruthy();
    expect(button.disabled).toBe(true);
    button.click();
    expect(onExport).not.toHaveBeenCalled();
  });
});
