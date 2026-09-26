import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useFakeHome } from "../../test-support/fake-home.js";
import { getGlobalCommandDirs } from "../custom-commands.js";
import { resolveDirectCommand } from "./routes.js";
import type { DirectCommandSelection, DirectExecutionPolicy } from "./contracts.js";

let root: string;
let restore: (() => void) | undefined;
const selection: DirectCommandSelection = {
  version: 1, command: { version: 1, name: "direct-fixture", source: "project-custom", invocationKind: "prompt" },
  arguments: "exact arguments", outcome: "Check fixture", successCondition: "Report fixture",
  helpers: [], prerequisites: [], requiredTools: ["read"], mode: "read-only", containment: "agent-session",
};
const policy: DirectExecutionPolicy = {
  version: 1, revision: 1, mode: "read-only", tools: ["read"], actionApprovalTools: [],
  containment: "agent-session", disclosure: "Not OS confined", maxTurns: 30, deadlineMs: 600000,
  provider: "fixture", model: "fixture", runtimeSha256: "a".repeat(64),
};
async function fixture() {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "gg-direct-route-"));
  restore = useFakeHome(path.join(root, "home"));
  await fs.mkdir(path.join(root, ".gg/commands"), { recursive: true });
  await fs.writeFile(path.join(root, ".gg/commands/direct-fixture.md"), "---\nname: direct-fixture\ndescription: Fixture\n---\nRead fixture.\n");
}
const resolve = (input = selection, effective = policy) => resolveDirectCommand(root, input, effective, new AbortController().signal, { readReadiness: async () => "missing" });
afterEach(async () => { restore?.(); if (root) await fs.rm(root, { recursive: true, force: true }); });

describe("direct command resolution", () => {
  it("loads project and global commands using actual precedence and rejects a changed winner", async () => {
    await fixture();
    const global = getGlobalCommandDirs()[0]!;
    await fs.mkdir(global, { recursive: true });
    await fs.writeFile(path.join(global, "direct-fixture.md"), "Global prompt");
    expect((await resolve()).command.prompt).toBe("Read fixture.");
    await expect(resolve({ ...selection, command: { ...selection.command, source: "global-custom" } })).rejects.toThrow("owner");
    await fs.unlink(path.join(root, ".gg/commands/direct-fixture.md"));
    expect((await resolve({ ...selection, command: { ...selection.command, source: "global-custom" } })).command.prompt).toBe("Global prompt");
    await expect(resolve()).rejects.toThrow("owner");
  });
  it("binds raw frontmatter, prompt, helpers, prerequisites, arguments and policy", async () => {
    await fixture();
    await fs.writeFile(path.join(root, "helper.mjs"), "console.log('fixture');");
    await fs.writeFile(path.join(root, "package.json"), "{}");
    const input = { ...selection, helpers: ["helper.mjs"], prerequisites: ["package.json"] };
    const before = await resolve(input);
    expect((await resolve(input)).sha256).toBe(before.sha256);
    for (const file of [".gg/commands/direct-fixture.md", "helper.mjs", "package.json"]) {
      const absolute = path.join(root, file);
      const original = await fs.readFile(absolute, "utf8");
      await fs.writeFile(absolute, original + "\n");
      expect((await resolve(input)).sha256).not.toBe(before.sha256);
      await fs.writeFile(absolute, original);
      expect((await resolve(input)).sha256).not.toBe(before.sha256);
    }
    const fresh = await resolve(input);
    expect((await resolve({ ...input, arguments: "changed" })).sha256).not.toBe(fresh.sha256);
    expect((await resolve(input, { ...policy, revision: 2 })).sha256).not.toBe(fresh.sha256);
    expect(fresh.snapshot.command.helpers[0]!.path).toBe("helper.mjs");
    expect(fresh.preview).toContain("console.log");
  });
  it("rejects same-owner canonical and filename collisions before loader deduplication", async () => {
    await fixture();
    await fs.writeFile(path.join(root, ".gg/commands/other.md"), "---\nname: direct-fixture\n---\nOther prompt");
    await expect(resolve()).rejects.toThrow("Ambiguous");
  });
  it("rejects unavailable tools, workspace actions, requested OS confinement and oversized previews", async () => {
    await fixture();
    await expect(resolve({ ...selection, requiredTools: ["bash"] })).rejects.toThrow();
    await expect(resolve({ ...selection, containment: "os-confined" })).rejects.toThrow("confinement");
    await expect(resolve({ ...selection, command: { ...selection.command, source: "built-in", invocationKind: "workspace-action" } })).rejects.toThrow("Workspace");
    await fs.writeFile(path.join(root, "large.txt"), "a".repeat(64000));
    await expect(resolve({ ...selection, prerequisites: ["large.txt"] })).rejects.toThrow("64 KB");
  });
  it("rejects linked declared files and cancellation", async () => {
    await fixture();
    await fs.mkdir(path.join(root, "actual"));
    await fs.writeFile(path.join(root, "actual/helper.txt"), "fixture");
    await fs.symlink(path.join(root, "actual"), path.join(root, "linked"), "junction");
    await expect(resolve({ ...selection, helpers: ["linked/helper.txt"] })).rejects.toThrow();
    await expect(resolveDirectCommand(root, selection, policy, AbortSignal.abort())).rejects.toThrow();
  });
});
