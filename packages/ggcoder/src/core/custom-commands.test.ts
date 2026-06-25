import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadCustomCommands } from "./custom-commands.js";

async function writeCommand(filePath: string, body: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, body, "utf-8");
}

function stubHome(home: string): void {
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
}

function stubHomes(home: string, userProfile: string): void {
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", userProfile);
}

describe("loadCustomCommands", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("loads global and project commands", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "gg-home-"));
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gg-project-"));
    stubHome(home);

    await writeCommand(
      path.join(home, ".gg", "commands", "global.md"),
      "---\nname: global\ndescription: Global command\n---\nRun globally.",
    );
    await writeCommand(
      path.join(cwd, ".gg", "commands", "project.md"),
      "---\nname: project\ndescription: Project command\n---\nRun locally.",
    );

    const commands = await loadCustomCommands(cwd);

    expect(commands.map((command) => command.name)).toEqual(["global", "project"]);
    expect(commands.find((command) => command.name === "global")?.scope).toBe("global");
    expect(commands.find((command) => command.name === "project")?.scope).toBe("project");
  });

  it("also loads global commands from USERPROFILE when it differs from HOME", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "gg-home-"));
    const userProfile = await fs.mkdtemp(path.join(os.tmpdir(), "gg-userprofile-"));
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gg-project-"));
    stubHomes(home, userProfile);

    await writeCommand(
      path.join(home, ".gg", "commands", "home.md"),
      "---\nname: home\ndescription: Home command\n---\nRun from HOME.",
    );
    await writeCommand(
      path.join(userProfile, ".gg", "commands", "profile.md"),
      "---\nname: profile\ndescription: Profile command\n---\nRun from USERPROFILE.",
    );
    await writeCommand(
      path.join(userProfile, ".gg", "commands", "home.md"),
      "---\nname: home\ndescription: Profile duplicate\n---\nDo not override HOME.",
    );

    const commands = await loadCustomCommands(cwd);

    expect(commands.map((command) => command.name)).toEqual(
      expect.arrayContaining(["home", "profile"]),
    );
    expect(commands.find((command) => command.name === "home")).toMatchObject({
      description: "Home command",
      scope: "global",
    });
    expect(commands.find((command) => command.name === "profile")?.scope).toBe("global");
  });

  it("lets project commands override global commands with the same name", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "gg-home-"));
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gg-project-"));
    stubHome(home);

    await writeCommand(
      path.join(home, ".gg", "commands", "shared.md"),
      "---\nname: shared\ndescription: Global shared\n---\nRun globally.",
    );
    await writeCommand(
      path.join(cwd, ".gg", "commands", "shared.md"),
      "---\nname: shared\ndescription: Project shared\n---\nRun locally.",
    );

    const commands = await loadCustomCommands(cwd);

    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      name: "shared",
      description: "Project shared",
      prompt: "Run locally.",
      scope: "project",
    });
  });
});
