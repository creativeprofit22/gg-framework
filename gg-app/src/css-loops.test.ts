import { describe, expect, it } from "vitest";

// Guard: every looping CSS animation must follow the window's motion level.
// A loop that ignores `--loop-play-state` keeps repainting in background
// windows (see `:root[data-motion]` in App.css): that is how the plan-mode
// shimmer, the signal arcs and the scorecard's rank shimmer were missed by
// the old hand-kept pause list.

/** Every stylesheet next to this test, as text, keyed by "./Name.css". */
const SHEETS = import.meta.glob<string>("./*.css", {
  query: "?raw",
  import: "default",
  eager: true,
});
const LOOP_STATE = "var(--loop-play-state, running)";

function lastIndex(list: readonly string[], test: (item: string) => boolean): number {
  for (let i = list.length - 1; i >= 0; i--) {
    const item = list[i];
    if (item !== undefined && test(item)) return i;
  }
  return -1;
}

/** Split a comma list at the top level (commas inside `()` don't count). */
function splitTop(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of value) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  parts.push(current.trim());
  return parts;
}

interface Problem {
  readonly at: string;
  readonly reason: string;
}

/** Problems in one stylesheet's looping animations. */
function loopProblems(file: string, css: string): Problem[] {
  const problems: Problem[] = [];
  for (const block of css.matchAll(/\{([^{}]*)\}/g)) {
    const body = (block[1] ?? "").replace(/\/\*[\s\S]*?\*\//g, "");
    const decls = body
      .split(";")
      .map((d) => d.trim().replace(/\s+/g, " "))
      .filter((d) => d.startsWith("animation"));
    if (!decls.some((d) => /\binfinite\b/.test(d))) continue;
    const line = css.slice(0, block.index).split("\n").length;
    const at = `${file}:${line}`;
    const stateIndex = lastIndex(decls, (d) => d.startsWith("animation-play-state:"));
    const shorthandIndex = lastIndex(decls, (d) => /^animation ?:/.test(d));
    if (stateIndex === -1) {
      problems.push({ at, reason: `loops without animation-play-state: ${LOOP_STATE}` });
      continue;
    }
    if (stateIndex < shorthandIndex) {
      problems.push({ at, reason: "animation shorthand after play-state resets it to running" });
      continue;
    }
    const states = splitTop(decls[stateIndex]?.split(":").slice(1).join(":") ?? "");
    const shorthand = decls[shorthandIndex];
    const entries = shorthand ? splitTop(shorthand.split(":").slice(1).join(":")) : [];
    if (entries.length === 0) {
      // Longhands only (iteration-count set here, name elsewhere).
      if (!states.every((s) => s === LOOP_STATE)) {
        problems.push({ at, reason: `play-state must be ${LOOP_STATE}` });
      }
      continue;
    }
    entries.forEach((entry, i) => {
      const state = states[i % states.length];
      const loops = /\binfinite\b/.test(entry);
      if (loops && state !== LOOP_STATE) {
        problems.push({ at, reason: `"${entry}" loops but its play-state is ${state}` });
      }
      if (!loops && state === LOOP_STATE) {
        problems.push({ at, reason: `one-shot "${entry}" would freeze half-played when paused` });
      }
    });
  }
  return problems;
}

describe("looping CSS animations", () => {
  const sheets = Object.keys(SHEETS).sort();

  it("finds the app stylesheets", () => {
    expect(sheets).toContain("./App.css");
  });

  it("all pause with the window's motion level", () => {
    const problems = sheets.flatMap((name) => loopProblems(name, SHEETS[name] ?? ""));
    expect(problems).toEqual([]);
  });

  it("catches a loop that ignores the motion level", () => {
    const css = ".spin {\n  animation: spin 1s linear infinite;\n}\n";
    expect(loopProblems("x.css", css)).toEqual([
      { at: "x.css:1", reason: `loops without animation-play-state: ${LOOP_STATE}` },
    ]);
  });

  it("only pauses the looping entries of a mixed list", () => {
    const good = `.a {\n  animation: pop 1s both, glow 2s infinite;\n  animation-play-state: running, ${LOOP_STATE};\n}`;
    const bad = `.a {\n  animation: pop 1s both, glow 2s infinite;\n  animation-play-state: ${LOOP_STATE};\n}`;
    expect(loopProblems("x.css", good)).toEqual([]);
    expect(loopProblems("x.css", bad).map((p) => p.reason)).toEqual([
      'one-shot "pop 1s both" would freeze half-played when paused',
    ]);
  });
});
