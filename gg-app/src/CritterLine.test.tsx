// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CritterLine, CRITTER_TONE_COLOR, type CritterTone } from "./CritterLine";
import { CRITTERS } from "./critter-sprites";
import { theme } from "./theme";

const critter = CRITTERS[0];
if (!critter) throw new Error("critter roster is empty");

describe("CritterLine", () => {
  it.each([
    ["working", theme.critter, true],
    ["done", theme.success, false],
    ["failed", theme.error, false],
    ["stopped", theme.warning, false],
  ] as const)("%s: colours the text and shimmers only while working", (tone, color, shimmers) => {
    const { container } = render(<CritterLine critter={critter} tone={tone} text="A critter" />);
    const text = container.querySelector<HTMLElement>(".subagents-compact-text");
    const img = container.querySelector(".subagents-critter-img");
    expect(CRITTER_TONE_COLOR[tone satisfies CritterTone]).toBe(color);
    expect(text?.style.color).toBe(color);
    expect(container.querySelector(".shimmer-text") !== null).toBe(shimmers);
    expect(img?.classList.contains(`subagents-critter-${tone}`)).toBe(true);
    expect(text?.textContent).toBe("A critter");
  });

  it("a colour override replaces the tone colour, keeping the tone's pose and shimmer", () => {
    const { container } = render(
      <CritterLine critter={critter} tone="working" color={theme.warning} text="Plan accepted" />,
    );
    const text = container.querySelector<HTMLElement>(".subagents-compact-text");
    const shimmer = container.querySelector<HTMLElement>(".shimmer-text");
    expect(text?.style.color).toBe(theme.warning);
    expect(shimmer?.style.getPropertyValue("--shimmer-base")).toBe(theme.warning);
    expect(container.querySelector(".subagents-critter-working")).not.toBeNull();
  });

  it("dissolves to new wording when the status changes, but not on first show", () => {
    const { container, rerender } = render(
      <CritterLine critter={critter} tone="working" text="Sent a critter off to help…" />,
    );
    const text = (): Element | null => container.querySelector(".subagents-compact-text");
    // The row itself already dissolves in; restored history must not animate.
    expect(text()?.classList.contains("dissolve-swap")).toBe(false);

    rerender(<CritterLine critter={critter} tone="done" text="The critter is back" />);
    expect(text()?.classList.contains("dissolve-swap")).toBe(true);
    expect(text()?.textContent).toBe("The critter is back");
  });
});
