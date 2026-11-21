import { describe, expect, it } from "vitest";
import { initialEntryView } from "./app-entry-view";

describe("App initial entry view", () => {
  it("opens both primary and secondary windows on Home", () => {
    expect(initialEntryView(false)).toBe("home");
    expect(initialEntryView(true)).toBe("home");
  });
});
