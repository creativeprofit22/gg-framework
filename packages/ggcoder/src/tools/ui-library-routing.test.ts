import { describe, expect, it } from "vitest";
import { BUILTIN_TOOL_NAMES, TOOL_PROMPT_HINTS } from "./prompt-hints.js";
import { DEFERRED_TOOL_NAMES } from "./tool-tiers.js";

describe("normal UI library routing", () => {
  for (const name of ["ui_registry", "ui_adopt"]) {
    it(`advertises ${name} without an always-loaded schema`, () => {
      expect(BUILTIN_TOOL_NAMES).toContain(name);
      expect(DEFERRED_TOOL_NAMES).toContain(name);
      expect(TOOL_PROMPT_HINTS[name]).toMatch(/Bklit|Kokonut/);
    });
  }
});
