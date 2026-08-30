import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getPromptCommand, PROMPT_COMMANDS } from "../prompt-commands.js";
import { ProgrammaticProfileParams } from "../../tools/programmatic-profile.js";

const programmaticDirectory = import.meta.dirname;
const toolPath = path.join(programmaticDirectory, "../../tools/programmatic-profile.ts");
const profilePath = path.join(programmaticDirectory, "profile.ts");

async function setupSources(): Promise<string> {
  return [await fs.readFile(profilePath, "utf8"), await fs.readFile(toolPath, "utf8")].join("\n");
}

describe("A touched-files-only bloat audit confirms no executable scanner, shell template, parallel command variant, dependency, or unrelated prompt refactor was added", () => {
  it("adds declarative JSON persistence without executable generation or orchestration", async () => {
    const source = await setupSources();

    expect(source).not.toMatch(/node:child_process|\b(?:exec|execFile|spawn|fork)\s*\(/);
    expect(source).not.toMatch(/\b(?:eval|Function)\s*\(/);
    expect(source).not.toMatch(/\.gg\/.*\.(?:js|mjs|cjs|sh|ps1|md)["'`]/);
    expect(source).not.toMatch(/from ["'].*(?:lifecycle|roadmap|subagent|process-manager)/);
    expect(source).not.toMatch(/(?:run|execute)(?:Scanner|Specialist|Command)/);
  });

  it("accepts no arbitrary destination or executable command field", () => {
    expect(
      ProgrammaticProfileParams.safeParse({ action: "inspect", path: "elsewhere.json" }).success,
    ).toBe(false);
    expect(
      ProgrammaticProfileParams.safeParse({ action: "inspect", command: "do something" }).success,
    ).toBe(false);
  });

  it("registers one setup command and no parallel generation command", () => {
    const commands = PROMPT_COMMANDS.filter((command) => command.name.includes("programmatic"));
    expect(commands.map((command) => command.name)).toEqual(["setup-programmatic"]);
    expect(getPromptCommand("generate-programmatic-profile")).toBeUndefined();
    expect(commands[0]?.prompt).not.toContain('action: "generate"');
  });

  it("uses only standard, installed, or repository-local imports", async () => {
    const source = await setupSources();
    const imports = [...source.matchAll(/from\s+["']([^"']+)["']/g)].map((match) => match[1]);
    expect(
      imports.every(
        (specifier) =>
          specifier?.startsWith(".") ||
          specifier?.startsWith("node:") ||
          specifier === "zod" ||
          specifier === "@kenkaiiii/gg-agent",
      ),
    ).toBe(true);
  });
});
