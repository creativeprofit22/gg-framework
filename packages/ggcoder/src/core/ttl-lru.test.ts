import { describe, expect, it } from "vitest";
import { TtlLru } from "./ttl-lru.js";

describe("TtlLru", () => {
  it("drops the oldest-used entry at the cap; a get refreshes recency", () => {
    const cache = new TtlLru<number>(2, 1_000);
    cache.set("a", 1, 0);
    cache.set("b", 2, 0);
    expect(cache.get("a", 0)).toBe(1);
    cache.set("c", 3, 0);
    expect(cache.size).toBe(2);
    expect(cache.get("b", 0)).toBeUndefined();
    expect(cache.entries()).toEqual([
      ["a", 1],
      ["c", 3],
    ]);
  });

  it("an entry expires after ttlMs and is deleted when read", () => {
    const cache = new TtlLru<string>(5, 1_000);
    cache.set("k", "v", 100);
    expect(cache.get("k", 1_099)).toBe("v");
    expect(cache.get("k", 1_100)).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it("deleteIf removes only the value it was given", () => {
    const cache = new TtlLru<object>(5, 1_000);
    const old = {};
    const fresh = {};
    cache.set("k", old, 0);
    cache.set("k", fresh, 0);
    cache.deleteIf("k", old);
    expect(cache.get("k", 0)).toBe(fresh);
    cache.deleteIf("k", fresh);
    expect(cache.size).toBe(0);
  });

  it("rejects a bad size or expiry", () => {
    expect(() => new TtlLru(0, 1_000)).toThrow(RangeError);
    expect(() => new TtlLru(1.5, 1_000)).toThrow(RangeError);
    expect(() => new TtlLru(1, 0)).toThrow(RangeError);
    expect(() => new TtlLru(1, Number.POSITIVE_INFINITY).size).not.toThrow();
  });
});
