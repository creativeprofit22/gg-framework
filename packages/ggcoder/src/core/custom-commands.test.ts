import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadCustomCommands } from "./custom-commands.js";

const temporaryDirs: string[] = [];

async function temporaryDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirs.push(dir);
  return dir;
}

async function writeCommand(filePath: string, body: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, body, "utf-8");
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(temporaryDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true })));
});

describe("loadCustomCommands", () => {
  it("refreshes global and project commands from disk with project precedence", async () => {
    const home = await temporaryDir("gg-command-home-");
    const cwd = await temporaryDir("gg-command-project-");
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);

    const globalPath = path.join(home, ".gg", "commands", "shared.md");
    const projectPath = path.join(cwd, ".gg", "commands", "project.md");
    await writeCommand(globalPath, "---\nname: shared\ndescription: Global\n---\nGlobal body.");
    await writeCommand(projectPath, "---\nname: project\ndescription: Project\n---\nProject body.");

    expect((await loadCustomCommands(cwd)).map((command) => command.name)).toEqual([
      "shared",
      "project",
    ]);

    await fs.rm(globalPath);
    await writeCommand(
      path.join(cwd, ".gg", "commands", "shared.md"),
      "---\nname: shared\ndescription: Local\n---\nLocal body.",
    );

    const refreshed = await loadCustomCommands(cwd);
    expect(refreshed.find((command) => command.name === "shared")).toMatchObject({
      description: "Local",
      prompt: "Local body.",
      scope: "project",
    });
    expect(refreshed).toHaveLength(2);
  });

  it("checks USERPROFILE when it differs from HOME and keeps the app directory authoritative", async () => {
    const home = await temporaryDir("gg-command-home-");
    const userProfile = await temporaryDir("gg-command-profile-");
    const cwd = await temporaryDir("gg-command-project-");
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", userProfile);

    await writeCommand(
      path.join(home, ".gg", "commands", "shared.md"),
      "---\nname: shared\ndescription: Home\n---\nHome body.",
    );
    await writeCommand(
      path.join(userProfile, ".gg", "commands", "shared.md"),
      "---\nname: shared\ndescription: Profile\n---\nProfile body.",
    );
    await writeCommand(
      path.join(userProfile, ".gg", "commands", "profile.md"),
      "---\nname: profile\ndescription: Profile only\n---\nProfile-only body.",
    );

    const commands = await loadCustomCommands(cwd);
    expect(commands.find((command) => command.name === "shared")?.description).toBe(
      process.platform === "win32" ? "Profile" : "Home",
    );
    expect(commands.find((command) => command.name === "profile")?.scope).toBe("global");
  });
});
