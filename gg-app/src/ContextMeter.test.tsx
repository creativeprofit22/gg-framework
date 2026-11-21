// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ContextMeter, getContextPercent } from "./ContextMeter";
import { theme } from "./theme";

function cssColor(color: string): string {
  const element = document.createElement("span");
  element.style.color = color;
  return element.style.color;
}

describe("ContextMeter", () => {
  it.each([
    { used: 0, window: 272_000, label: "0 / 272K · 0%" },
    { used: 136_000, window: 272_000, label: "136,000 / 272K · 50%" },
    { used: 300_000, window: 872_000, label: "300,000 / 872K · 34%" },
  ])("renders exact active context accounting: $label", ({ used, window, label }) => {
    render(<ContextMeter used={used} window={window} />);
    const meter = screen.getByRole("meter", { name: `Context used: ${label}` });
    expect(meter.textContent).toBe(label);
  });

  it("retains the over-window percentage while clamping the visual bar", () => {
    render(<ContextMeter used={300_000} window={272_000} />);
    const meter = screen.getByRole("meter", {
      name: "Context used: 300,000 / 272K · 110%",
    });
    expect(meter.textContent).toBe("300,000 / 272K · 110%");
    expect(meter.getAttribute("aria-valuenow")).toBe("100");
    expect((meter.querySelector(".ctx-meter-fill") as HTMLElement).style.width).toBe("100%");
    expect(meter.style.color).toBe(cssColor(theme.error));
    expect(getContextPercent(300_000, 272_000)).toBe(100);
  });
});
