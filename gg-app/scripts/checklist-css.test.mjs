import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Match the other CSS tests: Vite stubs stylesheets in browser-environment tests.
const checklistStyles = readFileSync(
  new URL("../src/ChecklistScreen.css", import.meta.url),
  "utf8",
);
const appStyles = readFileSync(new URL("../src/App.css", import.meta.url), "utf8");

describe("checklist keyboard focus", () => {
  it("uses a defined theme colour for both focus outlines", () => {
    const focusRules = [
      ...checklistStyles.matchAll(/\.checklist-(?:entry-info|scroll):focus-visible\s*\{([^}]+)\}/g),
    ];
    expect(focusRules).toHaveLength(2);
    for (const rule of focusRules) {
      const token = rule[1]?.match(/outline:\s*2px solid var\((--[\w-]+)\)/)?.[1];
      expect(token).toBeDefined();
      expect(appStyles).toContain(`${token}:`);
    }
  });
});
