import { describe, expect, it } from "vitest";
import {
  COMPACT_IDLE_PLACEHOLDER,
  COMPACT_RUNNING_PLACEHOLDER,
  fitPlaceholder,
} from "./composer-placeholder";

const FULL = "Type a message, / commands, @ files, @Ken for help";
const perChar =
  (px: number) =>
  (text: string): number =>
    text.length * px;

describe("fitPlaceholder", () => {
  it.each([
    ["fits with room to spare", 600, FULL],
    ["fits exactly", FULL.length * 7, FULL],
    ["one pixel short", FULL.length * 7 - 1, COMPACT_IDLE_PLACEHOLDER],
    ["much too narrow", 120, COMPACT_IDLE_PLACEHOLDER],
  ])("%s", (_label, available, expected) => {
    expect(fitPlaceholder(FULL, COMPACT_IDLE_PLACEHOLDER, available, perChar(7))).toBe(expected);
  });

  it("keeps the full hint when the field width is unknown", () => {
    expect(fitPlaceholder(FULL, COMPACT_IDLE_PLACEHOLDER, null, perChar(7))).toBe(FULL);
  });

  it("keeps the full hint when text cannot be measured", () => {
    expect(fitPlaceholder(FULL, COMPACT_IDLE_PLACEHOLDER, 50, () => null)).toBe(FULL);
  });

  it("offers short hints for idle and running states", () => {
    expect(COMPACT_IDLE_PLACEHOLDER).toBe("Type a message…");
    expect(COMPACT_RUNNING_PLACEHOLDER).toBe("Add a follow-up…");
  });
});
