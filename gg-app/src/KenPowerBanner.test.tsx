// @vitest-environment jsdom
import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { KenFace } from "./KenFace";
import { KenPowerBanner } from "./KenPowerBanner";

const layers = (container: HTMLElement): string[] =>
  [...container.querySelectorAll<HTMLImageElement>(".ken-face-layer")].map((img) =>
    [...img.classList].filter((c) => c !== "ken-face-layer").join(" "),
  );

describe("KenFace", () => {
  it("idles in chat with a blink, and adds a talking mouth while streaming", () => {
    const idle = render(<KenFace mood="chat" />);
    expect(layers(idle.container)).toEqual(["ken-face-base", "ken-face-blink"]);

    const talking = render(<KenFace mood="chat" talking />);
    expect(layers(talking.container)).toEqual(["ken-face-base", "ken-face-talk", "ken-face-blink"]);
    expect(talking.container.querySelector(".ken-face-talking")).not.toBeNull();
  });

  it("wakes up for on and nods off, with a z, for off", () => {
    const on = render(<KenFace mood="on" />);
    expect(layers(on.container)).toEqual(["ken-face-sleepy", "ken-face-happy"]);
    expect(on.container.querySelector(".ken-face-z")).toBeNull();

    const off = render(<KenFace mood="off" />);
    expect(layers(off.container)).toEqual(["ken-face-base", "ken-face-sleepy"]);
    expect(off.container.querySelector(".ken-face-z")).not.toBeNull();
  });
});

describe("KenPowerBanner", () => {
  // Local Fork: the banner keeps its KEN ON / KEN OFF block-font art rather
  // than upstream's plain "Ken is on." line.
  it.each(["on", "off"] as const)("shows Ken's %s face beside the block-font words", (mode) => {
    const { container } = render(<KenPowerBanner mode={mode} onDone={() => undefined} />);
    expect(container.querySelector(`.ken-power-banner-${mode} .ken-face-${mode}`)).not.toBeNull();
    expect(
      container.querySelectorAll(".ken-power-banner-text .ken-power-banner-line"),
    ).toHaveLength(6);
  });

  // jsdom has no AnimationEvent, so React listens for the prefixed name there.
  const animationEnd = (el: Element): boolean =>
    fireEvent(el, new Event("webkitAnimationEnd", { bubbles: true }));

  it("ends on the banner's own animation, not the face's", () => {
    const onDone = vi.fn();
    const { container } = render(<KenPowerBanner mode="off" onDone={onDone} />);
    const face = container.querySelector(".ken-face");
    const banner = container.querySelector(".ken-power-banner");
    if (!face || !banner) throw new Error("banner not rendered");

    animationEnd(face);
    expect(onDone).not.toHaveBeenCalled();

    animationEnd(banner);
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});
