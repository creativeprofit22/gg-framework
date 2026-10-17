import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isSlashCommandsResponse } from "@kenkaiiii/gg-core";

const mockedPaths = vi.hoisted(() => ({ agentDir: "" }));

vi.mock("../config.js", () => ({
  getAppPaths: () => ({ agentDir: mockedPaths.agentDir }),
}));

import { discoverCommands } from "./command-discovery.js";
import { boundCommandProblems, commandProblem } from "./custom-commands.js";
import { appSidecarCodeCommandsResponse } from "../app-sidecar-command-listing.js";

const temporaryDirs: string[] = [];

async function temporaryDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirs.push(dir);
  return dir;
}

async function writeCommand(dir: string, file: string, content: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, file), content, "utf-8");
}

const readReadiness = async () => "current" as const;

beforeEach(async () => {
  mockedPaths.agentDir = await temporaryDir("gg-palette-app-");
  vi.stubEnv("HOME", "");
  vi.stubEnv("USERPROFILE", "");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(temporaryDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true })));
});

describe("custom command palette metadata discovery", () => {
  it("carries normalized project and global group/effect into validated listings", async () => {
    const cwd = await temporaryDir("gg-palette-project-");
    const projectDir = path.join(cwd, ".gg", "commands");
    await writeCommand(
      projectDir,
      "alpha.md",
      "---\ndescription: Alpha\ncollection: demo\ngroup: everyday\neffect: reads\n---\nBody",
    );
    await writeCommand(
      projectDir,
      "beta.md",
      "---\ncollection: '  Demo '\ngroup: '  Setup '\neffect: EDITS\n---\nBody",
    );
    await writeCommand(
      path.join(mockedPaths.agentDir, "commands"),
      "gamma.md",
      "---\ncollection: demo\ngroup: specialist\neffect: plans\n---\nBody",
    );

    const discovery = await discoverCommands(cwd, { readReadiness });

    expect(discovery.resolve("alpha")?.listing).toMatchObject({
      collection: "demo",
      group: "everyday",
      effect: "reads",
      origin: "project-custom",
    });
    expect(discovery.resolve("beta")?.listing).toMatchObject({
      collection: "demo",
      group: "setup",
      effect: "edits",
    });
    expect(discovery.resolve("gamma")?.listing).toMatchObject({
      collection: "demo",
      group: "specialist",
      effect: "plans",
      origin: "global-custom",
    });
    expect(discovery.problems).toEqual([]);
    expect(
      isSlashCommandsResponse({ commands: discovery.entries.map((entry) => entry.listing) }),
    ).toBe(true);
  });

  it("keeps commands with absent, blank, unknown or invalid fields, just without that metadata", async () => {
    const cwd = await temporaryDir("gg-palette-project-");
    const dir = path.join(cwd, ".gg", "commands");
    await writeCommand(dir, "plain.md", "---\ndescription: Plain\n---\nBody");
    await writeCommand(
      dir,
      "blank.md",
      '---\ncollection: "  "\ngroup: "  "\neffect: ""\n---\nBody',
    );
    await writeCommand(
      dir,
      "unknown.md",
      "---\ncollection: my demo\ngroup: other\neffect: deletes\n---\nBody",
    );
    await writeCommand(
      dir,
      "control.md",
      "---\ncollection: de\u0007mo\ngroup: every\u0007day\n---\nBody",
    );
    await writeCommand(dir, "long.md", `---\ncollection: ${"x".repeat(41)}\n---\nBody`);

    const discovery = await discoverCommands(cwd, { readReadiness });

    for (const name of ["plain", "blank", "unknown", "control", "long"]) {
      const listing = discovery.resolve(name)?.listing;
      expect(listing, name).toBeDefined();
      expect(listing, name).not.toHaveProperty("group");
      expect(listing, name).not.toHaveProperty("effect");
      expect(listing, name).not.toHaveProperty("collection");
    }
    expect(
      isSlashCommandsResponse({ commands: discovery.entries.map((entry) => entry.listing) }),
    ).toBe(true);
  });

  it("keeps a collection marker without group or effect", async () => {
    const cwd = await temporaryDir("gg-palette-project-");
    const dir = path.join(cwd, ".gg", "commands");
    await writeCommand(dir, "member.md", "---\ncollection: demo\n---\nBody");

    const discovery = await discoverCommands(cwd, { readReadiness });

    const listing = discovery.resolve("member")?.listing;
    expect(listing?.collection).toBe("demo");
    expect(listing).not.toHaveProperty("group");
    expect(listing).not.toHaveProperty("effect");
  });

  it("never tags built-in commands", async () => {
    const cwd = await temporaryDir("gg-palette-project-");
    const discovery = await discoverCommands(cwd, { readReadiness });
    const builtIns = discovery.entries.filter((entry) => entry.listing.source === "built-in");
    expect(builtIns.length).toBeGreaterThan(0);
    for (const entry of builtIns) {
      expect(entry.listing).not.toHaveProperty("collection");
      expect(entry.listing).not.toHaveProperty("group");
      expect(entry.listing).not.toHaveProperty("effect");
    }
  });

  it("reports unreadable files and unclosed headers by file name, and still lists good commands", async () => {
    const cwd = await temporaryDir("gg-palette-project-");
    const dir = path.join(cwd, ".gg", "commands");
    await writeCommand(dir, "good.md", "---\ngroup: everyday\n---\nBody");
    // A directory named like a command file cannot be read as a file.
    await fs.mkdir(path.join(dir, "broken.md"), { recursive: true });
    await writeCommand(dir, "unclosed.md", "---\ndescription: Never closed\ngroup: everyday\nBody");
    await writeCommand(
      path.join(mockedPaths.agentDir, "commands"),
      "global-broken.md",
      "---\ngroup: setup\n",
    );
    await fs.mkdir(path.join(mockedPaths.agentDir, "commands", "gone.md"), { recursive: true });

    const discovery = await discoverCommands(cwd, { readReadiness });

    expect(discovery.resolve("good")?.listing.group).toBe("everyday");
    expect(discovery.resolve("broken")).toBeUndefined();
    // Unclosed headers still load, as before, but lose their metadata.
    expect(discovery.resolve("unclosed")?.listing).not.toHaveProperty("group");
    expect(discovery.problems).toEqual([
      { file: "broken.md", scope: "project", reason: "unreadable" },
      { file: "unclosed.md", scope: "project", reason: "malformed-frontmatter" },
      { file: "global-broken.md", scope: "global", reason: "malformed-frontmatter" },
      { file: "gone.md", scope: "global", reason: "unreadable" },
    ]);
    for (const problem of discovery.problems ?? []) {
      expect(problem.file).not.toContain(path.sep);
      expect(problem.file).not.toContain(cwd);
    }
  });

  it("reports names too long to list as invalid-name problems", async () => {
    const cwd = await temporaryDir("gg-palette-project-");
    const dir = path.join(cwd, ".gg", "commands");
    await writeCommand(dir, "long.md", `---\nname: ${"x".repeat(101)}\n---\nBody`);

    const discovery = await discoverCommands(cwd, { readReadiness });

    expect(discovery.entries.some((entry) => entry.listing.name.startsWith("xxx"))).toBe(false);
    expect(discovery.problems).toEqual([
      { file: "long.md", scope: "project", reason: "invalid-name" },
    ]);
  });

  it.skipIf(process.platform === "win32")(
    "drops invalid-name problems whose file name the listing contract cannot carry",
    async () => {
      const cwd = await temporaryDir("gg-palette-project-");
      const dir = path.join(cwd, ".gg", "commands");
      await writeCommand(dir, "bad\u0001.md", `---\nname: ${"x".repeat(101)}\n---\nBody`);
      await writeCommand(dir, "back\\slash.md", `---\nname: ${"y".repeat(101)}\n---\nBody`);

      const discovery = await discoverCommands(cwd, { readReadiness });

      expect(discovery.problems ?? []).toEqual([]);
      expect(
        isSlashCommandsResponse({
          commands: discovery.entries.map((entry) => entry.listing),
          problems: discovery.problems,
        }),
      ).toBe(true);
    },
  );

  it("builds problems only for file names the listing contract accepts", () => {
    expect(commandProblem(path.join("cmds", "bad\u0001.md"), "project", "invalid-name")).toBeNull();
    expect(commandProblem(path.join("cmds", "bad\u0085.md"), "global", "unreadable")).toBeNull();
    expect(commandProblem(`${"x".repeat(256)}.md`, "project", "invalid-name")).toBeNull();
    expect(commandProblem("", "project", "invalid-name")).toBeNull();
    expect(commandProblem(path.join("cmds", "ok.md"), "project", "invalid-name")).toEqual({
      file: "ok.md",
      scope: "project",
      reason: "invalid-name",
    });
    expect(
      boundCommandProblems([
        { file: "bad\u0001.md", scope: "project", reason: "invalid-name" },
        { file: "back\\slash.md", scope: "project", reason: "invalid-name" },
        { file: "", scope: "project", reason: "unreadable" },
        { file: "ok.md", scope: "global", reason: "unreadable" },
      ]),
    ).toEqual([{ file: "ok.md", scope: "global", reason: "unreadable" }]);
  });

  it("ships problems in the desktop /commands response only when there are some", async () => {
    const clean = await temporaryDir("gg-palette-project-");
    const cleanResponse = await appSidecarCodeCommandsResponse(clean);
    expect(cleanResponse).not.toHaveProperty("problems");
    expect(isSlashCommandsResponse(cleanResponse)).toBe(true);

    const cwd = await temporaryDir("gg-palette-project-");
    await fs.mkdir(path.join(cwd, ".gg", "commands", "broken.md"), { recursive: true });
    const response = await appSidecarCodeCommandsResponse(cwd);
    expect(response.problems).toEqual([
      { file: "broken.md", scope: "project", reason: "unreadable" },
    ]);
    expect(isSlashCommandsResponse(response)).toBe(true);
  });
});
