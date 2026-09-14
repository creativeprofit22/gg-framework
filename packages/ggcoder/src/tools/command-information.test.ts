import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAppPaths } from "../config.js";
import { useFakeHome } from "../test-support/fake-home.js";
import { createCommandInformationTool } from "./command-information.js";
let root: string;
let cwd: string;
let restore: () => void;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "command-information-"));
  cwd = path.join(root, "project");
  await fs.mkdir(path.join(cwd, ".gg/commands"), { recursive: true });
  restore = useFakeHome(path.join(root, "home"));
});
afterEach(async () => { restore(); await fs.rm(root, { recursive: true, force: true }); });
const context = { signal: new AbortController().signal, toolCallId: "fixture" };
const reference = { version: 1 as const, name: "fixture", source: "project-custom" as const, invocationKind: "prompt" as const };
async function command(body: string) {
  await fs.writeFile(path.join(cwd, ".gg/commands/fixture.md"), `---\nname: fixture\ndescription: Fixture\n---\n${body}`);
}

describe("read-only command information", () => {
  it("honors active-global, fallback-global and project ownership without exposing paths", async () => {
    const active = path.join(getAppPaths().agentDir, "commands");
    const fallback = path.join(root, "fallback/.gg/commands");
    process.env[process.platform === "win32" ? "HOME" : "USERPROFILE"] = path.join(root, "fallback");
    for (const [dir, body] of [[active, "ACTIVE"], [fallback, "FALLBACK"]]) {
      await fs.mkdir(dir!, { recursive: true });
      await fs.writeFile(path.join(dir!, "fixture.md"), `---\nname: fixture\n---\n${body}`);
    }
    const tool = createCommandInformationTool(cwd);
    const globalRequest = { action: "resolve" as const, command: { ...reference, source: "global-custom" as const } };
    expect(JSON.parse(String(await tool.execute(globalRequest, context)))).toMatchObject({ body: "ACTIVE" });
    await command("PROJECT");
    expect(JSON.parse(String(await tool.execute(globalRequest, context)))).toMatchObject({ status: "unavailable" });
    expect(JSON.parse(String(await tool.execute({ action: "resolve", command: reference }, context)))).toMatchObject({ body: "PROJECT" });
    await fs.unlink(path.join(cwd, ".gg/commands/fixture.md"));
    await fs.unlink(path.join(active, "fixture.md"));
    expect(JSON.parse(String(await tool.execute(globalRequest, context)))).toMatchObject({ body: "FALLBACK" });
    expect(String(await tool.execute({ action: "list" }, context))).not.toContain(root);
  });

  it("cancels before discovery and after an in-flight readiness check", async () => {
    const controller = new AbortController();
    const readiness = vi.fn(async () => { controller.abort(); return "missing" as const; });
    const tool = createCommandInformationTool(cwd, { readReadiness: readiness });
    expect(JSON.parse(String(await tool.execute({ action: "list" }, { ...context, signal: controller.signal })))).toMatchObject({ reason: "cancelled" });
    expect(readiness).toHaveBeenCalledOnce();
    expect(JSON.parse(String(await tool.execute({ action: "list" }, { ...context, signal: controller.signal })))).toMatchObject({ reason: "cancelled" });
    expect(readiness).toHaveBeenCalledOnce();
  });

  it("keeps unsupported names visible as metadata but refuses body lookup and remote filesystems", async () => {
    await fs.writeFile(path.join(cwd, ".gg/commands/odd.md"), "---\nname: odd:name\n---\nPRIVATE");
    const tool = createCommandInformationTool(cwd);
    const page = JSON.parse(String(await tool.execute({ action: "list" }, context)));
    expect(page.entries.find((entry: { name: string }) => entry.name === "odd:name")).toMatchObject({ bodyUnavailableReason: expect.any(String) });
    expect(JSON.parse(String(await tool.execute({ action: "resolve", command: { ...reference, name: "odd:name" } }, context)))).toMatchObject({ reason: "invalid-request" });
    expect(JSON.parse(String(await createCommandInformationTool(cwd, { localFilesystem: false }).execute({ action: "list" }, context)))).toMatchObject({ reason: "local-filesystem-required" });
  });
  it("re-resolves edits, removals and source claims while keeping bodies out of list pages", async () => {
    await command("PRIVATE BODY");
    const tool = createCommandInformationTool(cwd);
    expect(String(await tool.execute({ action: "list" }, context))).not.toContain("PRIVATE BODY");
    const resolve = () => tool.execute({ action: "resolve", command: reference }, context);
    expect(JSON.parse(String(await resolve()))).toMatchObject({ status: "prompt", body: "PRIVATE BODY", untrusted: true });
    await command("UPDATED BODY");
    expect(JSON.parse(String(await resolve()))).toMatchObject({ body: "UPDATED BODY" });
    expect(JSON.parse(String(await tool.execute({ action: "resolve", command: { ...reference, source: "global-custom" } }, context)))).toMatchObject({ status: "unavailable" });
    await fs.unlink(path.join(cwd, ".gg/commands/fixture.md"));
    expect(JSON.parse(String(await resolve()))).toMatchObject({ status: "unavailable" });
  });
  it("refuses oversized bodies and never synthesizes workspace prompts", async () => {
    await command("x".repeat(32_001));
    const tool = createCommandInformationTool(cwd, { workspaceActions: [{
      name: "folder", aliases: [], description: "Folder action", source: "built-in",
      input: { text: "optional", references: "none", attachments: "none" },
    }] });
    expect(JSON.parse(String(await tool.execute({ action: "resolve", command: reference }, context)))).toMatchObject({ reason: "body-exceeds-limit" });
    expect(JSON.parse(String(await tool.execute({ action: "resolve", command: { version: 1, name: "folder", source: "built-in", invocationKind: "workspace-action" } }, context)))).toMatchObject({ status: "non-prompt" });
  });
  it("refuses linked owner directories without disclosing their paths or bodies", async () => {
    const external = path.join(root, "external");
    await fs.mkdir(external);
    await fs.writeFile(path.join(external, "fixture.md"), "---\nname: fixture\n---\nDO NOT EXPOSE");
    await fs.rmdir(path.join(cwd, ".gg/commands"));
    await fs.symlink(external, path.join(cwd, ".gg/commands"), process.platform === "win32" ? "junction" : "dir");
    const result = String(await createCommandInformationTool(cwd).execute({ action: "resolve", command: reference }, context));
    expect(JSON.parse(result)).toMatchObject({ status: "unavailable" });
    expect(result).not.toContain(external);
    expect(result).not.toContain("DO NOT EXPOSE");
  });
});
