import { describe, expect, it, vi } from "vitest";
import { ANNOUNCED_UPDATE_KEY, announceUpdate } from "./update-announce";

function memoryStorage(): Pick<Storage, "getItem" | "setItem"> {
  const data = new Map<string, string>();
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
  };
}

describe("announceUpdate", () => {
  it("plays once per version, however many hooks and windows see it", () => {
    const storage = memoryStorage();
    const play = vi.fn();
    expect(announceUpdate("1.2.0", storage, play)).toBe(true);
    // The hourly re-check, the home screen's hook, and another window.
    expect(announceUpdate("1.2.0", storage, play)).toBe(false);
    expect(announceUpdate("1.2.0", storage, play)).toBe(false);
    expect(play).toHaveBeenCalledTimes(1);
    expect(storage.getItem(ANNOUNCED_UPDATE_KEY)).toBe("1.2.0");
  });

  it("plays again for a newer version", () => {
    const storage = memoryStorage();
    const play = vi.fn();
    announceUpdate("1.2.0", storage, play);
    announceUpdate("1.3.0", storage, play);
    expect(play).toHaveBeenCalledTimes(2);
  });

  it("still plays when storage is unavailable or throws", () => {
    const play = vi.fn();
    expect(announceUpdate("1.2.0", null, play)).toBe(true);
    const broken = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {},
    };
    expect(announceUpdate("1.2.0", broken, play)).toBe(true);
    expect(play).toHaveBeenCalledTimes(2);
  });
});
