import { describe, expect, it } from "vitest";
import * as icons from "./phosphor-icons";

// Guard: Phosphor icons come through ./phosphor-icons, which reaches each one
// by its own path. The package's main entry loads every icon (~3,000 files)
// and costs seconds per test file, so no other file may import it.

const PACKAGE = "@phosphor-icons/react";

const APP_SOURCES = import.meta.glob<string>("./**/*.{ts,tsx}", {
  query: "?raw",
  import: "default",
  eager: true,
});
const FIXTURE_SOURCES = import.meta.glob<string>("../scripts/fixtures/**/*.{ts,tsx}", {
  query: "?raw",
  import: "default",
  eager: true,
});
const SELF = new Set(["./phosphor-icons.ts", "./phosphor-icons.test.ts"]);

const QUOTES = ['"', "'", "`"];

// Any quoted mention counts: static import, `export … from`, `import()` and `vi.mock`.
function usesBareEntry(source: string): boolean {
  return QUOTES.some((quote) => source.includes(`${quote}${PACKAGE}${quote}`));
}

function usesPerIconPath(source: string): boolean {
  return QUOTES.some((quote) => source.includes(`${quote}${PACKAGE}/`));
}

/** Runtime names imported from a relative `phosphor-icons` module; `type` names and aliases are dropped. */
function importedIconNames(source: string): string[] {
  const names: string[] = [];
  const pattern = /import\s+(type\s+)?\{([^}]*)\}\s*from\s*["'](?:\.{1,2}\/)+phosphor-icons["']/g;
  for (const match of source.matchAll(pattern)) {
    if (match[1] !== undefined) continue;
    for (const raw of (match[2] ?? "").split(",")) {
      const item = raw.trim();
      if (item === "" || item.startsWith("type ")) continue;
      const name = item.split(/\s+as\s+/)[0];
      if (name !== undefined) names.push(name);
    }
  }
  return names;
}

const RUNTIME_EXPORTS = new Set(Object.keys(icons));

function unknownIcons(sources: Record<string, string>): string[] {
  const problems: string[] = [];
  for (const [file, source] of Object.entries(sources).sort(([a], [b]) => a.localeCompare(b))) {
    for (const name of importedIconNames(source)) {
      if (!RUNTIME_EXPORTS.has(name)) problems.push(`${file}: ${name}`);
    }
  }
  return problems;
}

describe("Phosphor icon imports", () => {
  it("finds the sources it guards", () => {
    expect(Object.keys(APP_SOURCES)).toContain("./phosphor-icons.ts");
    expect(Object.keys(APP_SOURCES).length).toBeGreaterThan(40);
    expect(Object.keys(FIXTURE_SOURCES).length).toBeGreaterThan(0);
  });

  it("never imports the all-icons entry", () => {
    const offenders = Object.entries({ ...APP_SOURCES, ...FIXTURE_SOURCES })
      .filter(([file, source]) => !SELF.has(file) && usesBareEntry(source))
      .map(([file]) => file)
      .sort();
    expect(offenders).toEqual([]);
  });

  it("reaches per-icon paths only through ./phosphor-icons (fixtures excepted)", () => {
    const offenders = Object.entries(APP_SOURCES)
      .filter(([file, source]) => !SELF.has(file) && usesPerIconPath(source))
      .map(([file]) => file)
      .sort();
    expect(offenders).toEqual([]);
  });

  it("only uses icons that ./phosphor-icons exports", () => {
    expect(unknownIcons(APP_SOURCES)).toEqual([]);
  });

  it("maps every export to the icon of the same name", () => {
    const mismatched = [...RUNTIME_EXPORTS]
      .sort()
      .filter(
        (name) => (icons as Record<string, { displayName?: string }>)[name]?.displayName !== name,
      );
    expect(mismatched).toEqual([]);
  });

  it("catches a bare entry and an unexported icon in synthetic source", () => {
    expect(usesBareEntry(`import { XIcon } from "${PACKAGE}";`)).toBe(true);
    expect(usesBareEntry(`vi.mock("${PACKAGE}", () => ({}));`)).toBe(true);
    expect(usesBareEntry(`const m = await import('${PACKAGE}');`)).toBe(true);
    expect(usesBareEntry(`export { XIcon } from "${PACKAGE}";`)).toBe(true);
    expect(usesBareEntry(`import { XIcon } from "${PACKAGE}/X";`)).toBe(false);
    expect(usesPerIconPath(`import { XIcon } from "${PACKAGE}/X";`)).toBe(true);
    expect(
      importedIconNames(
        [
          'import {\n  XIcon,\n  type Icon as PhosphorIcon,\n  CheckIcon as Tick,\n} from "./phosphor-icons";',
          'import type { Icon } from "../phosphor-icons";',
          'import { Icon } from "./icons";',
        ].join("\n"),
      ),
    ).toEqual(["XIcon", "CheckIcon"]);
    expect(
      unknownIcons({ "./Fake.tsx": `import { XIcon, NotARealIcon } from "./phosphor-icons";` }),
    ).toEqual(["./Fake.tsx: NotARealIcon"]);
  });
});
