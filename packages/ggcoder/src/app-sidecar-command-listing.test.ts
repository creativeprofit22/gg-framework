import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useFakeHome } from "./test-support/fake-home.js";
import { appSidecarCodeCommandsResponse } from "./app-sidecar-command-listing.js";
import { PROMPT_COMMANDS } from "./core/prompt-commands.js";
import { buildProgrammaticProfileProposal, persistProgrammaticProfile } from "./core/programmatic/profile.js";

let root: string;
let cwd: string;
let restoreHome: () => void;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "command-discovery-"));
  cwd = path.join(root, "project");
  await fs.mkdir(path.join(cwd, ".gg", "commands"), { recursive: true });
  restoreHome = useFakeHome(path.join(root, "home"));
});
afterEach(async () => {
  restoreHome();
  await fs.rm(root, { recursive: true, force: true });
});

async function command(name: string) {
  await fs.writeFile(path.join(cwd, ".gg", "commands", `${name}.md`),
    `---\nname: ${name}\ndescription: Fixture command\n---\nFixture body`);
}

describe("setup-first desktop discovery", () => {
  it("withholds legacy setup until separately approved upgrade, preserving saved report bytes", async () => {
    const proposal = await buildProgrammaticProfileProposal(cwd);
    expect((await persistProgrammaticProfile(cwd, proposal.configurationFingerprint, proposal.profile)).ok).toBe(true);
    const profilePath = path.join(cwd, ".gg/programmatic/profile.json");
    const saved = JSON.parse(await fs.readFile(profilePath, "utf8"));
    const legacy = JSON.stringify({ version: 1, profile: saved.profile, configurationFingerprint: saved.configurationFingerprint });
    await fs.writeFile(profilePath, legacy);
    const statePath = path.join(cwd, ".gg/programmatic/state.json");
    await fs.writeFile(statePath, "independent saved report bytes");
    expect((await appSidecarCodeCommandsResponse(cwd)).commands.some((item) => item.name === "programmatic")).toBe(false);
    expect(await fs.readFile(profilePath, "utf8")).toBe(legacy);
    expect(await fs.readFile(statePath, "utf8")).toBe("independent saved report bytes");
    const upgrade = await buildProgrammaticProfileProposal(cwd);
    expect((await persistProgrammaticProfile(cwd, upgrade.configurationFingerprint, upgrade.profile, { expectedPriorProfileDigest: upgrade.expectedPriorProfileDigest })).ok).toBe(true);
    expect((await appSidecarCodeCommandsResponse(cwd)).commands.some((item) => item.name === "programmatic")).toBe(true);
    expect(await fs.readFile(statePath, "utf8")).toBe("independent saved report bytes");
  });
  it("unlocks only after saving approved settings and detects later configuration drift", async () => {
    await fs.writeFile(path.join(cwd, "package.json"), '{"name":"fixture"}');
    const proposal = await buildProgrammaticProfileProposal(cwd);
    expect((await appSidecarCodeCommandsResponse(cwd)).commands.some((item) => item.name === "programmatic")).toBe(false);
    const saved = await persistProgrammaticProfile(cwd, proposal.configurationFingerprint, proposal.profile);
    expect(saved.ok).toBe(true);
    const profilePath = path.join(cwd, ".gg/programmatic/profile.json");
    const bytes = await fs.readFile(profilePath);
    expect((await appSidecarCodeCommandsResponse(cwd)).commands.some((item) => item.name === "programmatic")).toBe(true);
    expect(await fs.readFile(profilePath)).toEqual(bytes);
    await fs.writeFile(path.join(cwd, "package.json"), '{"name":"changed"}');
    expect((await appSidecarCodeCommandsResponse(cwd)).commands.some((item) => item.name === "programmatic")).toBe(false);
    expect(await fs.readFile(profilePath)).toEqual(bytes);
  });

  it("preserves malformed setup while withholding assessment", async () => {
    await fs.mkdir(path.join(cwd, ".gg/programmatic"));
    const profilePath = path.join(cwd, ".gg/programmatic/profile.json");
    await fs.writeFile(profilePath, "malformed fixture");
    expect((await appSidecarCodeCommandsResponse(cwd)).commands.some((item) => item.name === "programmatic")).toBe(false);
    expect(await fs.readFile(profilePath, "utf8")).toBe("malformed fixture");
  });
  it("advertises setup but not assessment or its internal run helper in a fresh project", async () => {
    const names = (await appSidecarCodeCommandsResponse(cwd)).commands.map((item) => item.name);
    expect(names).toContain("setup-programmatic");
    expect(names).not.toContain("programmatic");
    expect(names).not.toContain("programmatic-run");
  });

  it("reserves hidden feature identities and built-in and workspace aliases", async () => {
    // Current definitions have no aliases; exercise the supported alias contract explicitly.
    const builtin = PROMPT_COMMANDS[0]!;
    const alias = "fixture-builtin-alias";
    builtin.aliases.push(alias);
    try {
      for (const name of ["programmatic", "programmatic-run", alias, "adddir"]) await command(name);
      const rows = (await appSidecarCodeCommandsResponse(cwd)).commands;
      expect(rows.filter((item) => item.source === "custom")).toEqual([]);
    } finally {
      builtin.aliases.pop();
    }
  });

  it("re-reads command creation and removal without restarting discovery", async () => {
    expect((await appSidecarCodeCommandsResponse(cwd)).commands.some((item) => item.name === "fresh")).toBe(false);
    await command("fresh");
    expect((await appSidecarCodeCommandsResponse(cwd)).commands.find((item) => item.name === "fresh"))
      .toMatchObject({ origin: "project-custom", invocationKind: "prompt" });
    await fs.unlink(path.join(cwd, ".gg", "commands", "fresh.md"));
    expect((await appSidecarCodeCommandsResponse(cwd)).commands.some((item) => item.name === "fresh")).toBe(false);
  });
});
