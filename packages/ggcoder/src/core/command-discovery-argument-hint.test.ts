import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isSlashCommandsResponse,
  SLASH_COMMAND_ARGUMENT_HINT_MAX_LENGTH,
} from "@kenkaiiii/gg-core";

const mockedPaths = vi.hoisted(() => ({ agentDir: "" }));

vi.mock("../config.js", () => ({
  getAppPaths: () => ({ agentDir: mockedPaths.agentDir }),
}));

import { discoverCommands, projectAdvisoryCommands } from "./command-discovery.js";

const BUNDLED_COMMANDS = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../assets/commands",
);
const temporaryDirs: string[] = [];

async function temporaryDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirs.push(dir);
  return dir;
}

async function writeProjectCommand(cwd: string, file: string, content: string): Promise<void> {
  const dir = path.join(cwd, ".gg", "commands");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, file), content, "utf-8");
}

const readReadiness = async () => "current" as const;

beforeEach(async () => {
  mockedPaths.agentDir = await temporaryDir("gg-hint-app-");
  vi.stubEnv("HOME", "");
  vi.stubEnv("USERPROFILE", "");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(temporaryDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true })));
});

describe("custom command argument-hint discovery", () => {
  it("carries a bundled command's argument-hint into the validated listing", async () => {
    const cwd = await temporaryDir("gg-hint-project-");
    const raw = await fs.readFile(path.join(BUNDLED_COMMANDS, "contract.md"), "utf-8");
    await writeProjectCommand(cwd, "contract.md", raw);

    const discovery = await discoverCommands(cwd, { readReadiness });
    const listing = discovery.resolve("contract")?.listing;

    expect(listing?.argumentHint).toBe(
      "[interface, module, natural-language scope, path, or recent — optional]",
    );
    expect(
      isSlashCommandsResponse({ commands: discovery.entries.map((entry) => entry.listing) }),
    ).toBe(true);
    const advisory = projectAdvisoryCommands(discovery).entries.find(
      (entry) => entry.name === "contract",
    );
    expect(advisory?.argumentHint).toBe(listing?.argumentHint);
  });

  it("omits absent, blank, and control-character hints and bounds long ones", async () => {
    const cwd = await temporaryDir("gg-hint-project-");
    await writeProjectCommand(cwd, "plain.md", "---\ndescription: Plain\n---\nBody");
    await writeProjectCommand(
      cwd,
      "blank.md",
      '---\ndescription: Blank\nargument-hint: "  "\n---\nBody',
    );
    await writeProjectCommand(
      cwd,
      "control.md",
      "---\ndescription: Control\nargument-hint: a\u0007b\n---\nBody",
    );
    await writeProjectCommand(
      cwd,
      "folded.md",
      "---\nargument-hint: >\n  <path>\n  [focus]\n---\nBody",
    );
    await writeProjectCommand(cwd, "long.md", `---\nargument-hint: ${"x".repeat(500)}\n---\nBody`);

    const discovery = await discoverCommands(cwd, { readReadiness });
    const hint = (name: string) => discovery.resolve(name)?.listing.argumentHint;

    expect(hint("plain")).toBeUndefined();
    expect(discovery.resolve("plain")?.listing).not.toHaveProperty("argumentHint");
    expect(hint("blank")).toBeUndefined();
    expect(hint("control")).toBeUndefined();
    expect(hint("folded")).toBe("<path> [focus]");
    expect(hint("long")?.length).toBe(SLASH_COMMAND_ARGUMENT_HINT_MAX_LENGTH);
    expect(
      isSlashCommandsResponse({ commands: discovery.entries.map((entry) => entry.listing) }),
    ).toBe(true);
  });
});
