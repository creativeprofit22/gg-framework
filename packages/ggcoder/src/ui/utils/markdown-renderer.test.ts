import { describe, expect, it } from "vitest";
import stripAnsi from "strip-ansi";
import { STEROIDS_COLLAPSIBLE_TABLE_MARKER } from "@kenkaiiii/gg-core";
import { renderMarkdownToAnsiLines } from "./markdown-renderer.js";
import type { Theme } from "../theme/theme.js";
import darkTheme from "../theme/dark.json" with { type: "json" };

const theme = darkTheme as Theme;

const COMPLETE_TABLE =
  "Intro line.\n\n| Name | Status |\n|---|---|\n| alpha | ok |\n| beta | failed |";

function renderPlain(text: string, options?: { isPending?: boolean; height?: number }): string[] {
  return renderMarkdownToAnsiLines({
    text,
    theme,
    width: 80,
    isPending: options?.isPending ?? false,
    availableTerminalHeight: options?.height,
  }).map((line) => stripAnsi(line));
}

describe("renderMarkdownToAnsiLines tables", () => {
  it("renders a complete table as a box-drawing table", () => {
    const lines = renderPlain(COMPLETE_TABLE);
    expect(lines.some((line) => line.startsWith("┌"))).toBe(true);
    expect(lines.some((line) => line.includes("alpha"))).toBe(true);
    expect(lines.some((line) => line.includes("|"))).toBe(false);
  });

  it("drops the collapsible-table marker line but keeps the table", () => {
    const marked = `Intro line.\n\n${STEROIDS_COLLAPSIBLE_TABLE_MARKER}\n| Name | Status |\n|---|---|\n| alpha | ok |`;
    const lines = renderPlain(marked);
    expect(lines.some((line) => line.includes(STEROIDS_COLLAPSIBLE_TABLE_MARKER))).toBe(false);
    expect(lines.some((line) => line.startsWith("┌"))).toBe(true);
    expect(lines.some((line) => line.includes("alpha"))).toBe(true);
  });

  it("keeps other HTML comments and the marker inside code blocks visible", () => {
    const lines = renderPlain(
      `<!-- other note -->\n\n\`\`\`\n${STEROIDS_COLLAPSIBLE_TABLE_MARKER}\n\`\`\``,
    );
    expect(lines.some((line) => line.includes("<!-- other note -->"))).toBe(true);
    expect(lines.some((line) => line.includes(STEROIDS_COLLAPSIBLE_TABLE_MARKER))).toBe(true);
  });

  it("keeps a streaming table intact when the last row is partial", () => {
    const partial = COMPLETE_TABLE + "\n| gamma | in prog";
    const lines = renderPlain(partial, { isPending: true });
    // The completed rows still render as a table…
    expect(lines.some((line) => line.startsWith("┌"))).toBe(true);
    expect(lines.some((line) => line.includes("beta"))).toBe(true);
    // …and the half-streamed row is held back instead of dumped as raw pipes.
    expect(lines.some((line) => line.includes("| gamma"))).toBe(false);
  });

  it("holds back a streaming table header whose separator has not arrived", () => {
    const headerOnly = "Intro line.\n\n| Name | Status |";
    const lines = renderPlain(headerOnly, { isPending: true });
    expect(lines.some((line) => line.includes("| Name"))).toBe(false);
  });

  it("holds back a streaming header plus partial separator", () => {
    const partialSeparator = "Intro line.\n\n| Name | Status |\n|---|-";
    const lines = renderPlain(partialSeparator, { isPending: true });
    expect(lines.some((line) => line.includes("|"))).toBe(false);
  });

  it("still renders raw pipe lines verbatim when finalized (history parity)", () => {
    const headerOnly = "Intro line.\n\n| Name | Status |";
    const lines = renderPlain(headerOnly);
    expect(lines.some((line) => line.includes("| Name | Status |"))).toBe(true);
  });

  it("clamps a tall pending table to the available terminal height", () => {
    const manyRows = Array.from({ length: 30 }, (_, i) => `| row${i} | value${i} |`).join("\n");
    const tall = `| Name | Status |\n|---|---|\n${manyRows}`;
    const height = 10;
    const lines = renderPlain(tall, { isPending: true, height });
    expect(lines.length).toBeLessThanOrEqual(height);
    expect(lines.at(-1)).toContain("... generating more ...");
  });

  it("does not clamp tall tables when finalized", () => {
    const manyRows = Array.from({ length: 30 }, (_, i) => `| row${i} | value${i} |`).join("\n");
    const tall = `| Name | Status |\n|---|---|\n${manyRows}`;
    const lines = renderPlain(tall, { height: 10 });
    expect(lines.length).toBeGreaterThan(30);
    expect(lines.some((line) => line.includes("generating more"))).toBe(false);
  });
});
