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

  it("has one bounded fingerprint/refresh policy and no watcher, polling or alternate writer", async () => {
    const inventory = await fs.readFile(path.join(programmaticDirectory, "inventory.ts"), "utf8");
    const profile = await fs.readFile(profilePath, "utf8");
    const lifecycle = await fs.readFile(path.join(programmaticDirectory, "lifecycle.ts"), "utf8");
    expect(inventory.match(/function fingerprintConfigurationSnapshot\(/g)).toHaveLength(1);
    expect(inventory.match(/function compareConfigurationSnapshots\(/g)).toHaveLength(1);
    expect(profile.match(/function assessProgrammaticSetup\(/g)).toHaveLength(1);
    expect(profile.match(/function persistProgrammaticProfile\(/g)).toHaveLength(1);
    expect(profile.match(/operations\.rename\(/g)).toHaveLength(1);
    expect(profile).toContain("compareConfigurationSnapshots(");
    expect(lifecycle).toContain("assessProgrammaticSetup(");
    expect(profile).not.toContain("CONFIG_FILE_NAMES");
    expect(lifecycle).not.toContain("CONFIG_FILE_NAMES");
    expect(`${inventory}\n${profile}\n${lifecycle}`).not.toMatch(/\b(?:setInterval|setTimeout|watch|watchFile)\s*\(/);
    expect(inventory).toContain("PROGRAMMATIC_CONFIGURATION_INPUT_LIMIT * 2");
    expect(Buffer.byteLength(profile)).toBeLessThan(24_000);
    expect(Buffer.byteLength(inventory)).toBeLessThan(18_000);
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
    const setupCommands = PROMPT_COMMANDS.filter(
      (command) => command.name.startsWith("setup-") && command.name.includes("programmatic"),
    );
    expect(setupCommands.map((command) => command.name)).toEqual(["setup-programmatic"]);
    expect(getPromptCommand("generate-programmatic-profile")).toBeUndefined();
    expect(setupCommands[0]?.prompt).not.toContain('action: "generate"');
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
          specifier === "@kenkaiiii/gg-agent" ||
          specifier === "@kenkaiiii/gg-core" ||
          specifier === "@kenkaiiii/gg-core/programmatic-chat-contract",
      ),
    ).toBe(true);
  });
});
