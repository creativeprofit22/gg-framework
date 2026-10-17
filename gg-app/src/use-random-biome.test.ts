// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { BIOMES } from "./critter-terrain";
import { useRandomBiome } from "./use-random-biome";

beforeEach(() => {
  localStorage.clear();
});

describe("useRandomBiome", () => {
  it("picks a terrain, and a different one on the next visit", () => {
    const first = renderHook(() => useRandomBiome(() => 0));
    const firstId = first.result.current[0].id;
    expect(BIOMES.map((b) => b.id)).toContain(firstId);
    first.unmount();

    // Same roll again: still a different terrain, because the last one is excluded.
    const second = renderHook(() => useRandomBiome(() => 0));
    expect(second.result.current[0].id).not.toBe(firstId);
    second.unmount();
  });
});
