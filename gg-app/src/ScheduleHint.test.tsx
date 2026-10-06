// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ScheduleHint } from "./ScheduleHint";

/** The slot rendered as active, read from the data attributes. */
function activeSlot(): string | null {
  const el = document.querySelector('.schedule-slot[data-active="true"]');
  return el?.getAttribute("data-slot") ?? null;
}

afterEach(cleanup);

describe("ScheduleHint", () => {
  it("renders the full signature", () => {
    render(<ScheduleHint input="/schedule " caret={10} onPickInterval={vi.fn()} />);
    expect(screen.getByText("<prompt>")).toBeTruthy();
    expect(screen.getByText("<every>")).toBeTruthy();
    expect(screen.getByText("[times]")).toBeTruthy();
  });

  describe("active slot tracking", () => {
    it("highlights the prompt while the caret is before any pipe", () => {
      const input = "/schedule check the railway logs";
      render(<ScheduleHint input={input} caret={input.length} onPickInterval={vi.fn()} />);
      expect(activeSlot()).toBe("prompt");
    });

    it("highlights the interval once the caret moves past the first pipe", () => {
      const input = "/schedule check logs | 15m";
      render(<ScheduleHint input={input} caret={input.length} onPickInterval={vi.fn()} />);
      expect(activeSlot()).toBe("every");
    });

    it("highlights the count once the caret moves past the second pipe", () => {
      const input = "/schedule check logs | 15m | 10";
      render(<ScheduleHint input={input} caret={input.length} onPickInterval={vi.fn()} />);
      expect(activeSlot()).toBe("times");
    });

    it("returns to the prompt when the caret moves back into it", () => {
      const input = "/schedule check logs | 15m | 10";
      render(<ScheduleHint input={input} caret={15} onPickInterval={vi.fn()} />);
      expect(activeSlot()).toBe("prompt");
    });

    it("treats a shell pipe in the prompt as prompt, not interval", () => {
      // Caret sits just after "grep node", which is still the prompt because the
      // interval is claimed from the END of the input.
      const input = "/schedule ps aux | grep node | 15m";
      render(<ScheduleHint input={input} caret={28} onPickInterval={vi.fn()} />);
      expect(activeSlot()).toBe("prompt");
    });
  });

  describe("valid input", () => {
    it("summarises the resolved schedule", () => {
      render(
        <ScheduleHint input="/schedule check logs | 15m" caret={25} onPickInterval={vi.fn()} />,
      );
      expect(screen.getByText("Every 15 min · until stopped")).toBeTruthy();
    });

    it("spells out a combined interval so a mistype is visible", () => {
      render(
        <ScheduleHint input="/schedule check logs | 1h30m" caret={28} onPickInterval={vi.fn()} />,
      );
      expect(screen.getByText("Every 1 hr 30 min · until stopped")).toBeTruthy();
    });

    it("reports a bounded run count", () => {
      render(
        <ScheduleHint input="/schedule check logs | 1h | 10" caret={29} onPickInterval={vi.fn()} />,
      );
      expect(screen.getByText("Every 1 hr · 10 runs")).toBeTruthy();
    });

    it("shows no error underline while valid", () => {
      render(
        <ScheduleHint input="/schedule check logs | 15m" caret={25} onPickInterval={vi.fn()} />,
      );
      expect(document.querySelector(".schedule-echo-bad")).toBeNull();
    });
  });

  describe("invalid input", () => {
    it("shows the parser message for a bad unit", () => {
      render(
        <ScheduleHint input="/schedule check logs | 15s" caret={26} onPickInterval={vi.fn()} />,
      );
      const message = document.querySelector(".schedule-msg");
      expect(message?.textContent).toContain("Use minutes or hours");
      // The rejected text is quoted back in the message, not just underlined.
      expect(message?.textContent).toContain('"15s"');
    });

    it("underlines exactly the rejected range", () => {
      render(
        <ScheduleHint input="/schedule check logs | 15s" caret={26} onPickInterval={vi.fn()} />,
      );
      const bad = document.querySelector(".schedule-echo-bad");
      expect(bad?.textContent).toBe("15s");
    });

    it("underlines only the count when the count is the problem", () => {
      render(
        <ScheduleHint input="/schedule check logs | 15m | 0" caret={29} onPickInterval={vi.fn()} />,
      );
      expect(document.querySelector(".schedule-echo-bad")?.textContent).toBe("0");
      expect(screen.getByText(/at least 1/)).toBeTruthy();
    });

    it("reconstructs the original text around the underline", () => {
      const input = "/schedule check logs | 15s";
      render(<ScheduleHint input={input} caret={26} onPickInterval={vi.fn()} />);
      expect(document.querySelector(".schedule-echo")?.textContent).toBe(input);
    });

    it("asks for an interval when none was given", () => {
      render(<ScheduleHint input="/schedule check logs" caret={20} onPickInterval={vi.fn()} />);
      expect(screen.getByText(/Add an interval/)).toBeTruthy();
    });

    it("asks for a prompt when only an interval was given", () => {
      render(<ScheduleHint input="/schedule | 15m" caret={15} onPickInterval={vi.fn()} />);
      expect(screen.getByText(/Add a prompt/)).toBeTruthy();
    });
  });

  describe("interval presets", () => {
    it("offers the presets", () => {
      render(<ScheduleHint input="/schedule " caret={10} onPickInterval={vi.fn()} />);
      for (const preset of ["15m", "1h", "6h", "24h"]) {
        expect(screen.getByRole("button", { name: preset })).toBeTruthy();
      }
    });

    it("reports the chosen preset", () => {
      const onPickInterval = vi.fn();
      render(
        <ScheduleHint input="/schedule check logs" caret={20} onPickInterval={onPickInterval} />,
      );
      fireEvent.click(screen.getByRole("button", { name: "1h" }));
      expect(onPickInterval).toHaveBeenCalledWith("1h");
    });
  });
});
