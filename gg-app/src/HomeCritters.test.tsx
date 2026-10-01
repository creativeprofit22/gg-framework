// @vitest-environment jsdom
import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { HomeCritters } from "./HomeCritters";
import { homeRoster } from "./home-roster";
import { CRITTERS, renderCritterFrame } from "./critter-sprites";
import { BIOMES } from "./critter-terrain";

// jsdom has no Web Animations API; the floor only needs the calls to exist.
beforeAll(() => {
  const fakeAnimation = (): Animation =>
    ({
      finished: Promise.resolve(),
      cancel: () => undefined,
      onfinish: null,
    }) as unknown as Animation;
  Element.prototype.animate = vi.fn(fakeAnimation) as unknown as Element["animate"];
  Element.prototype.getAnimations = vi.fn(() => []) as unknown as Element["getAnimations"];
});

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
});
afterEach(() => {
  vi.useRealTimers();
});

const terrainOf = (container: HTMLElement): string | null =>
  container.querySelector<HTMLElement>(".home-critters")?.dataset.terrain ?? null;

const sprites = (container: HTMLElement): string[] =>
  [...container.querySelectorAll<HTMLImageElement>(".critter .critter-f0")]
    .map((img) => img.getAttribute("src"))
    .filter((src): src is string => src !== null);

describe("homeRoster", () => {
  it("lists every critter once, pinned and named, as a busy pretend agent", () => {
    const roster = homeRoster();
    expect(roster.map((agent) => agent.critterId)).toEqual(CRITTERS.map((c) => c.id));
    expect(roster.map((agent) => agent.label)).toEqual(CRITTERS.map((c) => c.name));
    expect(roster.every((agent) => agent.status === "running")).toBe(true);
  });
});

describe("HomeCritters", () => {
  it("lays down a terrain, and a different one on the next visit", () => {
    const first = render(<HomeCritters random={() => 0} />);
    const firstId = terrainOf(first.container);
    expect(BIOMES.map((b) => b.id)).toContain(firstId);
    // Inside the critter lane (so it rises with it), ground and props both drawn.
    const terrain = first.container.querySelector<HTMLElement>(".critter-lane > .critter-terrain");
    const ground = terrain?.querySelector<HTMLElement>(".terrain-land > .terrain-ground");
    expect(ground?.style.backgroundImage).toContain("data:image/svg+xml");
    const props = terrain?.querySelectorAll<HTMLElement>(".terrain-prop") ?? [];
    expect(props.length).toBeGreaterThan(0);
    for (const prop of props) {
      expect(prop.style.getPropertyValue("--img")).toContain("data:image/svg+xml");
    }
    first.unmount();

    // Same roll again: still a different terrain, because the last one is excluded.
    const second = render(<HomeCritters random={() => 0} />);
    expect(terrainOf(second.container)).not.toBe(firstId);
    second.unmount();
  });

  it("brings out the whole roster, one of each critter", async () => {
    const { container } = render(<HomeCritters />);
    expect(sprites(container)).toHaveLength(0);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });

    const shown = sprites(container);
    expect(shown).toHaveLength(CRITTERS.length);
    expect(new Set(shown)).toEqual(new Set(CRITTERS.map((c) => renderCritterFrame(c, 0))));
  });

  it("keeps everyone out playing without thinking pauses, and cleans up on unmount", async () => {
    const { container, unmount } = render(<HomeCritters />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(40000);
    });
    expect(sprites(container)).toHaveLength(CRITTERS.length);
    expect(container.querySelector(".critter-thought")).toBeNull();
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("shows just the critter's name on hover", async () => {
    const { container } = render(<HomeCritters />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });
    const critter = container.querySelector<HTMLElement>(".critter");
    if (!critter) throw new Error("no critter");
    fireEvent.mouseEnter(critter);

    const tooltip = container.querySelector<HTMLElement>(".critter-tooltip");
    expect(tooltip?.hidden).toBe(false);
    const names = CRITTERS.map((c) => c.name);
    expect(names).toContain(tooltip?.textContent);
  });
});
