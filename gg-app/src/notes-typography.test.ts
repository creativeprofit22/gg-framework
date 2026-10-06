import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const appCss = readFileSync("src/App.css", "utf8");

const TYPE_TOKENS = [
  "--font-size-xs",
  "--font-size-sm",
  "--font-size-md",
  "--font-size-lg",
  "--font-size-xl",
  "--line-height-xs",
  "--line-height-sm",
  "--line-height-md",
  "--line-height-lg",
  "--line-height-xl",
  "--font-weight-regular",
  "--font-weight-strong",
] as const;

// The Notes/Roadmap block is the first adopter of the shared type scale.
function notesCss(): string {
  const start = appCss.indexOf("/* Reconstructed structured Project Notes and Roadmap UI. */");
  const end = appCss.indexOf(
    "/* End structured Project Notes and Roadmap UI typography scope. */",
    start,
  );
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return appCss.slice(start, end);
}

function notesInputRule(): string {
  const start = appCss.indexOf(".notes-input {");
  expect(start).toBeGreaterThan(-1);
  return appCss.slice(start, appCss.indexOf("}", start));
}

describe("Notes type scale", () => {
  it("defines each type token exactly once", () => {
    for (const token of TYPE_TOKENS) {
      const definitions = appCss.match(new RegExp(`${token}\\s*:`, "g")) ?? [];
      expect(definitions, token).toHaveLength(1);
    }
  });

  it("uses tokens instead of literal font sizes", () => {
    for (const css of [notesCss(), notesInputRule()]) {
      expect(css).not.toMatch(/font-size:\s*[\d.]+(px|em|rem)/);
      expect(css).not.toMatch(/font:\s*[\d.]+(px|em|rem)/);
    }
  });

  it("uses only the two weight tokens", () => {
    const weights = notesCss().match(/font-weight:[^;]+;/g) ?? [];
    expect(weights.length).toBeGreaterThan(0);
    for (const weight of weights) {
      expect(weight).toMatch(/^font-weight:\s*var\(--font-weight-(regular|strong)\)/);
    }
  });

  it("renders labels in sentence case", () => {
    expect(notesCss()).not.toMatch(/text-transform:\s*uppercase/);
  });
});
