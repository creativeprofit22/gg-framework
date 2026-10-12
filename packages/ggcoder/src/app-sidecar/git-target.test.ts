import { describe, expect, it } from "vitest";

import { resolveGitCwd } from "./git-target.js";

const repos = new Set(["/work/site", "/work/engine"]);
const isRepo = async (dir: string): Promise<boolean> => repos.has(dir);

describe("resolveGitCwd", () => {
  it("uses the window's cwd outside a goal", async () => {
    expect(await resolveGitCwd("/work/site", null, isRepo)).toBe("/work/site");
  });

  it("uses a goal's first attached folder that is a git repo", async () => {
    // Live bug: a goal window read git from ~/.gg/goals/<id>, which isn't a
    // repo, so the titlebar never showed the project's uncommitted files.
    const goal = {
      context: [
        { path: "/work/site/README.md", kind: "file" as const },
        { path: "/work/notes", kind: "folder" as const },
        { path: "/work/site", kind: "folder" as const },
        { path: "/work/engine", kind: "folder" as const },
      ],
    };
    expect(await resolveGitCwd("/home/.gg/goals/speed", goal, isRepo)).toBe("/work/site");
  });

  it("keeps the goal folder when no attached folder is a repo", async () => {
    const goal = { context: [{ path: "/work/notes", kind: "folder" as const }] };
    expect(await resolveGitCwd("/home/.gg/goals/speed", goal, isRepo)).toBe(
      "/home/.gg/goals/speed",
    );
  });

  it("skips a folder whose repo check fails", async () => {
    const goal = {
      context: [
        { path: "/gone", kind: "folder" as const },
        { path: "/work/engine", kind: "folder" as const },
      ],
    };
    const flaky = async (dir: string): Promise<boolean> => {
      if (dir === "/gone") throw new Error("ENOENT");
      return repos.has(dir);
    };
    expect(await resolveGitCwd("/home/.gg/goals/speed", goal, flaky)).toBe("/work/engine");
  });
});
