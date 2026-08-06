import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockedPaths = vi.hoisted(() => ({ agentDir: "" }));

vi.mock("../config.js", () => ({
  getAppPaths: () => ({ agentDir: mockedPaths.agentDir }),
}));

import { loadCustomCommands } from "./custom-commands.js";

const temporaryDirs: string[] = [];

async function temporaryDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirs.push(dir);
  return dir;
}

async function writeCommand(filePath: string, description: string, prompt: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const name = path.basename(filePath, ".md");
  await fs.writeFile(
    filePath,
    `---\nname: ${name}\ndescription: ${description}\n---\n${prompt}`,
    "utf-8",
  );
}

beforeEach(async () => {
  mockedPaths.agentDir = await temporaryDir("gg-command-app-");
  vi.stubEnv("HOME", "");
  vi.stubEnv("USERPROFILE", "");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(temporaryDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true })));
});

describe("loadCustomCommands", () => {
  it("loads a global-only command from the app commands directory", async () => {
    const cwd = await temporaryDir("gg-command-project-");
    await writeCommand(
      path.join(mockedPaths.agentDir, "commands", "release.md"),
      "Release globally",
      "Run the release.",
    );

    await expect(loadCustomCommands(cwd)).resolves.toEqual([
      expect.objectContaining({
        name: "release",
        description: "Release globally",
        prompt: "Run the release.",
        scope: "global",
      }),
    ]);
  });

  it("lets a project command override a global command with the same name", async () => {
    const cwd = await temporaryDir("gg-command-project-");
    await writeCommand(
      path.join(mockedPaths.agentDir, "commands", "shared.md"),
      "Global command",
      "Global body.",
    );
    await writeCommand(
      path.join(cwd, ".gg", "commands", "shared.md"),
      "Project command",
      "Project body.",
    );

    const commands = await loadCustomCommands(cwd);

    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      name: "shared",
      description: "Project command",
      prompt: "Project body.",
      scope: "project",
    });
  });

  it("checks distinct HOME and USERPROFILE command directories", async () => {
    const cwd = await temporaryDir("gg-command-project-");
    const home = await temporaryDir("gg-command-home-");
    const userProfile = await temporaryDir("gg-command-profile-");
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", userProfile);
    await writeCommand(path.join(home, ".gg", "commands", "home.md"), "Home", "Home body.");
    await writeCommand(
      path.join(userProfile, ".gg", "commands", "profile.md"),
      "Profile",
      "Profile body.",
    );

    const commands = await loadCustomCommands(cwd);

    expect(commands.map((command) => command.name)).toEqual(["home", "profile"]);
    expect(commands.every((command) => command.scope === "global")).toBe(true);
  });

  it("returns no commands when global and project directories are missing", async () => {
    const missingRoot = path.join(await temporaryDir("gg-command-missing-"), "not-created");
    mockedPaths.agentDir = path.join(missingRoot, "app");
    vi.stubEnv("HOME", path.join(missingRoot, "home"));
    vi.stubEnv("USERPROFILE", path.join(missingRoot, "profile"));

    await expect(loadCustomCommands(path.join(missingRoot, "project"))).resolves.toEqual([]);
  });
});
