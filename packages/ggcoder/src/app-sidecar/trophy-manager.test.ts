import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTrophyManager } from "./trophy-manager.js";
import { EMPTY_PROGRESS_FACTS } from "../core/trophies/engine.js";
import type { TrophyProgressFacts, TrophySnapshot } from "../core/trophies/types.js";

let dir: string;
let filePath: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "gg-trophy-manager-"));
  filePath = path.join(dir, "trophies.json");
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("trophy manager", () => {
  it("starts from zero, measuring XP from the moment trophies began", async () => {
    const frames: TrophySnapshot[] = [];
    let facts: TrophyProgressFacts = {
      prompts: 900,
      commits: 300,
      linesShipped: 50_000,
      level: 30,
    };
    const manager = await createTrophyManager(
      () => facts,
      (s) => frames.push(s),
      filePath,
    );
    expect(manager.snapshot().earned).toBe(0);
    expect(frames).toEqual([]);
    // One more run and one more commit after that: the first of each.
    facts = { ...facts, prompts: 901, commits: 301 };
    await manager.count("steers", "w");
    const earned = frames.at(-1)?.unlocked ?? [];
    expect(earned).toEqual(expect.arrayContaining(["first-run", "commit", "steer"]));
    expect(earned).not.toContain("shipper");
  });

  it("broadcasts a new unlock once, tagged with the window that earned it", async () => {
    const frames: Array<{ snap: TrophySnapshot; origin?: string }> = [];
    const manager = await createTrophyManager(
      () => EMPTY_PROGRESS_FACTS,
      (snap, origin) => frames.push({ snap, origin }),
      filePath,
    );
    await manager.count("steers", "window-a");
    await manager.count("steers", "window-a");
    expect(frames).toHaveLength(2);
    expect(frames[0]?.snap.unlocked).toEqual(["steer"]);
    expect(frames[0]?.origin).toBe("window-a");
    expect(frames[0]?.snap.eventNonce).toBeTruthy();
    // The second steer earns nothing new: a refresh frame, no celebration.
    expect(frames[1]?.snap.unlocked).toEqual([]);
    expect(frames[1]?.snap.eventNonce).toBeNull();
  });
});
