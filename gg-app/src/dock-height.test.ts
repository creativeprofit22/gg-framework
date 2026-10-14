import { describe, expect, it } from "vitest";
import { nextDockHeight } from "./dock-height";

describe("nextDockHeight", () => {
  it("writes a new height, rounded", () => {
    expect(nextDockHeight(171.6, "160px")).toBe("172px");
  });

  it("leaves an unchanged height alone", () => {
    expect(nextDockHeight(160, "160px")).toBeNull();
  });

  it("keeps the last height while the dock is hidden (measures 0)", () => {
    expect(nextDockHeight(0, "160px")).toBeNull();
  });
});
