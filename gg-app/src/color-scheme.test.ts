import { describe, expect, it } from "vitest";
import { readColorSchemePref, resolveColorScheme } from "./color-scheme";

const store = (value: string | null): Pick<Storage, "getItem"> => ({ getItem: () => value });

describe("color scheme", () => {
  it("defaults to dark, the only look before the setting existed", () => {
    expect(readColorSchemePref(store(null))).toBe("dark");
  });

  it("ignores an unknown stored value", () => {
    expect(readColorSchemePref(store("sepia"))).toBe("dark");
  });

  it("keeps a stored choice", () => {
    expect(readColorSchemePref(store("light"))).toBe("light");
    expect(readColorSchemePref(store("auto"))).toBe("auto");
  });

  it("follows the system only on auto", () => {
    expect(resolveColorScheme("auto", false)).toBe("light");
    expect(resolveColorScheme("auto", true)).toBe("dark");
    expect(resolveColorScheme("light", true)).toBe("light");
    expect(resolveColorScheme("dark", false)).toBe("dark");
  });
});
