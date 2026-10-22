import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadTrophies, updateTrophies } from "./store.js";

let dir: string;
let filePath: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "gg-trophies-"));
  filePath = path.join(dir, "trophies.json");
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("trophies store", () => {
  it("starts fresh without a file, and never writes on load", async () => {
    const loaded = await loadTrophies(filePath);
    expect(loaded.fresh).toBe(true);
    await expect(fs.stat(filePath)).rejects.toThrow();
  });

  it("round-trips an update", async () => {
    await updateTrophies((f) => {
      f.counters.steers = 2;
      f.unlocked.steer = "2026-10-21T00:00:00.000Z";
    }, filePath);
    const loaded = await loadTrophies(filePath);
    expect(loaded.fresh).toBe(false);
    expect(loaded.file.counters.steers).toBe(2);
    expect(loaded.file.unlocked.steer).toBe("2026-10-21T00:00:00.000Z");
  });

  it("discards a pre-release v1 file, so everyone starts from zero", async () => {
    await fs.writeFile(
      filePath,
      JSON.stringify({
        v: 1,
        createdAt: "2026-10-21T00:00:00.000Z",
        counters: { steers: 3 },
        sets: {},
        unlocked: { "first-run": "2026-10-21T00:00:00.000Z" },
        lastEvent: null,
      }),
    );
    expect((await loadTrophies(filePath)).fresh).toBe(true);
    const { file } = await updateTrophies(() => {}, filePath);
    expect(file.unlocked).toEqual({});
    expect(file.counters).toEqual({});
    await expect(fs.stat(`${filePath}.bad`)).rejects.toThrow();
  });

  it("drops counters it doesn't know", async () => {
    await fs.writeFile(
      filePath,
      JSON.stringify({
        v: 2,
        createdAt: "2026-10-21T00:00:00.000Z",
        baseline: null,
        streak: { last: null, current: 0, best: 0 },
        counters: { steers: 1, fromTheFuture: 9 },
        sets: { toolsUsed: ["read", "read"], alien: ["x"] },
        unlocked: {},
        lastEvent: null,
      }),
    );
    const { file } = await loadTrophies(filePath);
    expect(file.counters).toEqual({ steers: 1 });
    expect(file.sets).toEqual({ toolsUsed: ["read"] });
  });

  it("sets a damaged file aside instead of overwriting it silently", async () => {
    await fs.writeFile(filePath, "{not json");
    await updateTrophies((f) => {
      f.counters.exports = 1;
    }, filePath);
    expect(await fs.readFile(`${filePath}.bad`, "utf-8")).toBe("{not json");
    expect((await loadTrophies(filePath)).file.counters.exports).toBe(1);
  });

  it("keeps every update when many land at once", async () => {
    await Promise.all(
      Array.from({ length: 12 }, () =>
        updateTrophies((f) => {
          f.counters.steers = (f.counters.steers ?? 0) + 1;
        }, filePath),
      ),
    );
    expect((await loadTrophies(filePath)).file.counters.steers).toBe(12);
  });
});
