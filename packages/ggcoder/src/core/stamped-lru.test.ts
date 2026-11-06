import { describe, expect, it } from "vitest";
import { StampedLru } from "./stamped-lru.js";

const stamp = (path: string, size = 10, mtime = 1_000) => ({ path, size, mtime });

describe("StampedLru", () => {
  it("returns a value only for the exact file version it was read from", () => {
    const lru = new StampedLru<string>(4);
    lru.remember(stamp("/a"), "first read");

    expect(lru.lookup(stamp("/a"))).toEqual({ value: "first read" });
    // Appending changes the size; rewriting in place changes the mtime.
    expect(lru.lookup(stamp("/a", 11))).toBeUndefined();
    expect(lru.lookup(stamp("/a", 10, 2_000))).toBeUndefined();
    expect(lru.lookup(stamp("/b"))).toBeUndefined();
  });

  it("drops an entry once its file changed, so the stale value cannot return", () => {
    const lru = new StampedLru<string>(4);
    lru.remember(stamp("/a"), "old");
    expect(lru.lookup(stamp("/a", 20))).toBeUndefined();
    expect(lru.lookup(stamp("/a"))).toBeUndefined();
    expect(lru.size).toBe(0);
  });

  it("remembers null as a real answer", () => {
    const lru = new StampedLru<string | null>(4);
    lru.remember(stamp("/not-a-session"), null);
    expect(lru.lookup(stamp("/not-a-session"))).toEqual({ value: null });
  });

  it("evicts the least recently used entry beyond its cap", () => {
    const lru = new StampedLru<number>(2);
    lru.remember(stamp("/a"), 1);
    lru.remember(stamp("/b"), 2);
    // Using /a makes /b the oldest.
    expect(lru.lookup(stamp("/a"))).toEqual({ value: 1 });
    lru.remember(stamp("/c"), 3);

    expect(lru.size).toBe(2);
    expect(lru.lookup(stamp("/b"))).toBeUndefined();
    expect(lru.lookup(stamp("/a"))).toEqual({ value: 1 });
    expect(lru.lookup(stamp("/c"))).toEqual({ value: 3 });
  });

  it("replaces a re-read file's entry instead of growing", () => {
    const lru = new StampedLru<string>(2);
    lru.remember(stamp("/a"), "v1");
    lru.remember(stamp("/a", 11), "v2");
    expect(lru.size).toBe(1);
    expect(lru.lookup(stamp("/a", 11))).toEqual({ value: "v2" });
  });

  it("rejects a cap that could not hold anything", () => {
    expect(() => new StampedLru(0)).toThrow(RangeError);
    expect(() => new StampedLru(1.5)).toThrow(RangeError);
  });
});
