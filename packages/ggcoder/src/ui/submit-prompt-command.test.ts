import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useFakeHome } from "../test-support/fake-home.js";
import { buildProgrammaticProfileProposal, persistProgrammaticProfile } from "../core/programmatic/profile.js";
import { submitPromptCommand } from "./submit-prompt-command.js";
import * as customCommandLoader from "../core/custom-commands.js";
import * as discoveryModule from "../core/command-discovery.js";
import { handleUiSlashCommand, UI_SLASH_COMMANDS } from "./submit-slash-commands.js";
import { PROMPT_COMMANDS } from "../core/prompt-commands.js";
import { expandPromptCommand } from "../core/prompt-command-expansion.js";
import { getAppPaths } from "../config.js";

let cwd: string;
let restore: () => void;
beforeEach(async () => {
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), "terminal-programmatic-"));
  restore = useFakeHome(path.join(cwd, "home"));
});
afterEach(async () => { vi.restoreAllMocks(); restore(); await fs.rm(cwd, { recursive: true, force: true }); });
function options(trimmed: string): Parameters<typeof submitPromptCommand>[0] {
  return {
    cwd, trimmed, inputImages: [], currentModel: "gpt-4o", isBusy: () => false,
    setLastUserMessage: vi.fn(), setDoneStatus: vi.fn(), finalizeSubmittedUserItem: vi.fn(),
    runAgent: vi.fn(async () => {}), setLiveItems: vi.fn(), getId: () => "fixture", reloadCustomCommands: vi.fn(),
  };
}
async function writeCommand(directory: string, name: string, body: string) {
  await fs.mkdir(directory, { recursive: true });
  const file = path.join(directory, `${name}.md`);
  await fs.writeFile(file, body);
  return file;
}

async function listedCustomCommands() {
  const discovery = await discoveryModule.discoverCommands(cwd, {
    workspaceActions: UI_SLASH_COMMANDS, readReadiness: async () => "missing",
  });
  return discovery.entries.flatMap((entry) => entry.custom ? [entry.custom] : []);
}

describe("terminal live custom command resolution", () => {
  it("intercepts bare model but executes the current custom model with focus", async () => {
    await writeCommand(path.join(cwd, ".gg/commands"), "model", "Current model template");
    const customCommands = await listedCustomCommands();
    expect(customCommands).toEqual([]);
    const actions = {
      openModelSelector: vi.fn(), compactConversation: vi.fn(async () => {}), quit: vi.fn(),
      clearSession: vi.fn(), openThemeSelector: vi.fn(), toggleMarkdown: vi.fn(), clearApprovedPlan: vi.fn(),
    };
    for (const input of ["/model", "/m", "/models", "/model focus"]) {
      const opts = { ...options(input), customCommands };
      if (!(await handleUiSlashCommand(input, actions))) await submitPromptCommand(opts);
      if (input === "/model focus") expect(opts.runAgent).toHaveBeenCalledWith(expandPromptCommand("Current model template", "focus"));
      else expect(opts.runAgent).not.toHaveBeenCalled();
    }
    expect(actions.openModelSelector).toHaveBeenCalledTimes(3);
  });

  it.each(["creation", "edit", "deletion", "project shadow", "project removal"])("resolves %s after listing without waiting for menu refresh", async (change) => {
    const project = path.join(cwd, ".gg/commands");
    const global = path.join(getAppPaths().agentDir, "commands");
    if (change === "project shadow" || change === "project removal") await writeCommand(global, "live", "Global body");
    if (change === "edit" || change === "deletion" || change === "project removal") await writeCommand(project, "live", "Stale body");
    const customCommands = await listedCustomCommands();
    if (change === "deletion" || change === "project removal") await fs.unlink(path.join(project, "live.md"));
    else await writeCommand(project, "live", "Current body");
    const opts = { ...options("/live focus"), customCommands };
    expect(await submitPromptCommand(opts)).toBe(change !== "deletion");
    if (change === "deletion") expect(opts.runAgent).not.toHaveBeenCalled();
    else expect(opts.runAgent).toHaveBeenCalledWith(expandPromptCommand(change === "project removal" ? "Global body" : "Current body", "focus"));
    expect(JSON.stringify(vi.mocked(opts.runAgent).mock.calls)).not.toContain("Stale body");
  });

  it("does no inventory work for ordinary input or built-in prompts", async () => {
    const load = vi.spyOn(customCommandLoader, "loadCustomCommands");
    const discover = vi.spyOn(discoveryModule, "discoverCommands");
    const readiness = vi.spyOn(discoveryModule, "createProgrammaticReadinessReader");
    const ordinary = options("ordinary input");
    expect(await submitPromptCommand(ordinary)).toBe(false);
    expect(ordinary.runAgent).not.toHaveBeenCalled();
    const builtin = PROMPT_COMMANDS.find((command) => command.name === "setup-programmatic")!;
    await writeCommand(path.join(cwd, ".gg/commands"), builtin.name, "Shadow body");
    const opts = options(`/${builtin.name}`);
    expect(await submitPromptCommand(opts)).toBe(true);
    expect(opts.runAgent).toHaveBeenCalledWith(builtin.prompt, { programmaticAssessment: { cwd, mode: "setup", focus: undefined } });
    expect(load).not.toHaveBeenCalled();
    expect(discover).not.toHaveBeenCalled();
    expect(readiness).not.toHaveBeenCalled();
  });
});

describe("terminal setup-first submission", () => {
  it.each([false, true])("rejects busy workflows before dispatch with current setup=%s", async (approved) => {
    if (approved) {
      const proposal = await buildProgrammaticProfileProposal(cwd);
      await persistProgrammaticProfile(cwd, proposal.configurationFingerprint, proposal.profile);
    }
    const profile = path.join(cwd, ".gg/programmatic/profile.json");
    const before = await fs.readFile(profile).catch(() => null);
    for (const command of ["/setup-programmatic", "/programmatic", "/programmatic\tfocus", "/programmatic-run"]) {
      const opts = { ...options(command), isBusy: () => true };
      expect(await submitPromptCommand(opts)).toBe(true);
      expect(opts.runAgent).not.toHaveBeenCalled();
      expect(opts.finalizeSubmittedUserItem).not.toHaveBeenCalled();
      const update = vi.mocked(opts.setLiveItems).mock.calls[0]![0];
      expect(JSON.stringify(typeof update === "function" ? update([]) : update)).toContain("Wait for the current work to finish");
    }
    expect(await fs.readFile(profile).catch(() => null)).toEqual(before);
    await expect(fs.stat(path.join(cwd, ".gg/programmatic/state.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  describe.each([" ", "\t", "\n", "\r\n"])("command separator %j", (separator) => {
    it.each(["packaging", " \t\r\n ", "  café\n日本語\r\n\tpackaging  "])("gates and expands focus %j", async (focus) => {
      const input = `/programmatic${separator}${focus}`;
      const missing = options(input);
      expect(await submitPromptCommand(missing)).toBe(true);
      expect(missing.runAgent).not.toHaveBeenCalled();
      expect(missing.setLiveItems).toHaveBeenCalledOnce();

      const proposal = await buildProgrammaticProfileProposal(cwd);
      expect((await persistProgrammaticProfile(cwd, proposal.configurationFingerprint, proposal.profile)).ok).toBe(true);
      const approved = options(input);
      expect(await submitPromptCommand(approved)).toBe(true);
      expect(approved.runAgent).toHaveBeenCalledOnce();
      const content = String(vi.mocked(approved.runAgent).mock.calls[0]![0]);
      expect(vi.mocked(approved.runAgent).mock.calls[0]![1]).toEqual({ programmaticAssessment: { cwd, mode: "configured", focus: focus.trim() || undefined } });
      // Evidence/catalog preparation belongs under the run owner, tested through the real hook.
      expect(content).not.toContain("## Untrusted advisory context");
      if (focus.trim()) expect(content).toContain(`## User Instructions\n\n${focus.trim()}`);
      else expect(content).not.toContain("## User Instructions");
    });

    it.each(["x".repeat(4001), "bad\u0000focus", "focus\n\nReferenced files:\n- private.ts"])("consumes rejected input without provider fallback: %j", async (focus) => {
      for (const approved of [false, true]) {
        if (approved) {
          const proposal = await buildProgrammaticProfileProposal(cwd);
          expect((await persistProgrammaticProfile(cwd, proposal.configurationFingerprint, proposal.profile)).ok).toBe(true);
        }
        const opts = options(`/programmatic${separator}${focus}`);
        expect(await submitPromptCommand(opts)).toBe(true);
        expect(opts.runAgent).not.toHaveBeenCalled();
        expect(opts.setLiveItems).toHaveBeenCalledOnce();
      }
    });
  });
  it("blocks assessment and internal helper without running a model or writing setup", async () => {
    for (const command of ["/programmatic focus", "/programmatic-run"]) {
      const opts = options(command);
      expect(await submitPromptCommand(opts)).toBe(true);
      expect(opts.runAgent).not.toHaveBeenCalled();
      expect(opts.setLiveItems).toHaveBeenCalledOnce();
      expect(opts.reloadCustomCommands).toHaveBeenCalledOnce();
    }
    await expect(fs.stat(path.join(cwd, ".gg/programmatic/profile.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("sends validated host mode and focus after approved setup, and refreshes after failure", async () => {
    const proposal = await buildProgrammaticProfileProposal(cwd);
    expect((await persistProgrammaticProfile(cwd, proposal.configurationFingerprint, proposal.profile)).ok).toBe(true);
    const opts = options("/programmatic café\n日本語");
    vi.mocked(opts.runAgent).mockRejectedValue(new Error("fixture failure after write"));
    expect(await submitPromptCommand(opts)).toBe(true);
    const content = String(vi.mocked(opts.runAgent).mock.calls[0]![0]);
    expect(vi.mocked(opts.runAgent).mock.calls[0]![1]).toEqual({ programmaticAssessment: { cwd, mode: "configured", focus: "café\n日本語" } });
    expect(content).toContain("## User Instructions\n\ncafé\n日本語");
    expect(content).toContain("`programmatic_scan({})` exactly once; do not call it again");
    expect(opts.reloadCustomCommands).toHaveBeenCalledOnce();
  });
  it.each([`/programmatic ${"x".repeat(4001)}`, "/programmatic\n\nReferenced files:\n- private.ts"])("rejects invalid focus or references before running: %j", async (input) => {
    const opts = options(input);
    await submitPromptCommand(opts);
    expect(opts.runAgent).not.toHaveBeenCalled();
  });
});
