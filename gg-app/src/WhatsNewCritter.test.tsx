// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CRITTERS } from "./critter-sprites";
import { randomCritter, WhatsNewCritter } from "./WhatsNewCritter";

const fixed = (value: number) => (): number => value;

describe("randomCritter", () => {
  it("can land on every critter in the roster", () => {
    const seen = new Set(
      CRITTERS.map((_, i) => randomCritter(fixed((i + 0.5) / CRITTERS.length)).id),
    );
    expect(seen.size).toBe(CRITTERS.length);
  });

  it("stays in range at the top end", () => {
    expect(CRITTERS).toContain(randomCritter(fixed(0.999999)));
  });
});

describe("WhatsNewCritter", () => {
  it("shows the picked critter with both walk frames, hidden from screen readers", () => {
    const pick = CRITTERS[2];
    if (!pick) throw new Error("roster too small");
    const { container } = render(<WhatsNewCritter random={fixed(2.5 / CRITTERS.length)} />);
    expect(container.querySelector(".whatsnew-critter")?.getAttribute("data-critter")).toBe(
      pick.id,
    );
    expect(container.querySelectorAll(".whatsnew-critter-body img")).toHaveLength(2);
    expect(container.querySelector(".whatsnew-critter-lane")?.getAttribute("aria-hidden")).toBe(
      "true",
    );
  });

  it("keeps the same critter across re-renders", () => {
    let calls = 0;
    const counting = (): number => {
      calls++;
      return 0.4;
    };
    const { rerender } = render(<WhatsNewCritter random={counting} />);
    rerender(<WhatsNewCritter random={counting} />);
    expect(calls).toBe(1);
  });
});
