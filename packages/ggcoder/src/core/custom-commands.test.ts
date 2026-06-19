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
