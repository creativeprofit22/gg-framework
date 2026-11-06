import { describe, expect, it } from "vitest";
import { LIGHTS, REACTIONS, type Reaction, type ThingKind } from "./goal-farm-interact";
import {
  createFarmSounds,
  hasFarmSound,
  soundKey,
  USE_SOUND_GAP_MS,
  inUseSoundDue,
} from "./goal-farm-sounds";
import { STATION_USES } from "./goal-farm-use";

const reaction = (over: Partial<Reaction> = {}): Reaction => ({
  target: "t",
  kind: "bench",
  action: "hammer",
  start: 0,
  until: 1300,
  x: 0,
  y: 0,
  from: null,
  seed: 1,
  ...over,
});

describe("goal farm sounds", () => {
  it("has a sound for every reaction a poke can start", () => {
    const missing: string[] = [];
    for (const kind of Object.keys(REACTIONS) as ThingKind[]) {
      if (kind === "ground") continue;
      const actions = LIGHTS.has(kind) ? ["on", "off"] : REACTIONS[kind];
      for (const action of actions) {
        const key = soundKey({ kind, action, from: null });
        if (!hasFarmSound(key)) missing.push(key);
      }
    }
    for (const ground of ["snow", "puddle", "grass", "dirt"]) {
      if (!hasFarmSound(`ground:${ground}`)) missing.push(`ground:${ground}`);
    }
    expect(missing).toEqual([]);
  });

  it("has a sound for everything a thing in use plays", () => {
    for (const { kind, actions } of Object.values(STATION_USES)) {
      for (const action of actions) expect(hasFarmSound(`${kind}:${action}`)).toBe(true);
    }
  });

  it("plays the pebble arcing in first when the pond is clicked on its stones", () => {
    expect(soundKey({ kind: "pond", action: "splash", from: null })).toBe("pond:splash");
    const flicked = soundKey({ kind: "pond", action: "splash", from: { x: 1, y: 2 } });
    expect(flicked).toBe("pond:splash~flick");
    expect(hasFarmSound(flicked)).toBe(true);
  });

  it("sounds a thing in use only now and then, and never Ken's idle tea", () => {
    expect(inUseSoundDue("bench", undefined, 0)).toBe(true);
    expect(inUseSoundDue("bench", 0, USE_SOUND_GAP_MS - 1)).toBe(false);
    expect(inUseSoundDue("bench", 0, USE_SOUND_GAP_MS)).toBe(true);
    expect(inUseSoundDue("teabench", undefined, 0)).toBe(false);
  });

  it("stays silent, without throwing, where there's no Web Audio", () => {
    const sounds = createFarmSounds();
    expect(() => sounds.play(reaction())).not.toThrow();
    expect(() => sounds.play(reaction({ use: true }))).not.toThrow();
    sounds.dispose();
    expect(() => sounds.play(reaction())).not.toThrow();
  });
});
