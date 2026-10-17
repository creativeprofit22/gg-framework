import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Read straight from disk: inside Vitest, Vite stubs stylesheets out, so the
// app's own tests can't see a CSS rule.
const css = readFileSync(new URL("../src/App.css", import.meta.url), "utf8");

describe("streaming word spans", () => {
  it("are plain inline text, so lines break the same with or without them", () => {
    // Each streamed word fades in through a `.md-word` span, and the spans
    // come off when a block finishes. As inline-blocks they moved line breaks
    // (none inside "newest-first", one allowed before ";"), so every paragraph
    // re-wrapped the instant it finished: the flicker at the end of each one.
    const rule = css.match(/\.markdown \.md-word \{([^}]*)\}/)?.[1];
    expect(rule).toBeDefined();
    expect(rule).toContain("animation: md-word-fade var(--dur-row) var(--ease-out)");
    const frames = css.match(/@keyframes md-word-fade \{([\s\S]*?)\n\}/)?.[1];
    expect(frames).toContain("opacity: 0");
    expect(frames).not.toMatch(/filter|transform|translate/);
    expect(rule).not.toMatch(/display\s*:/);
    expect(rule).not.toMatch(/white-space\s*:/);
  });
});
