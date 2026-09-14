import { describe, expect, it, vi } from "vitest";
import { discoverCommands } from "./command-discovery.js";
import { AGENT_HOME_COMMANDS } from "../modes/agent-home-mode.js";
import { SERVE_COMMANDS } from "../modes/serve-mode.js";
import { UI_SLASH_COMMANDS } from "../ui/submit-slash-commands.js";

vi.mock("./custom-commands.js", () => ({ loadCustomCommands: async () => [
  "model", "m", "Help", "new", "n", "link", "start", "rewind", "ideal-on", "ordinary",
].map((name) => ({ name, description: "Custom", scope: "project", filePath: `/fixture/${name}.md`, prompt: "BODY" })) }));

describe("host-owned discovery contracts", () => {
  it.each([
    ["agent-home", AGENT_HOME_COMMANDS, true],
    ["serve", SERVE_COMMANDS, true],
    ["terminal", UI_SLASH_COMMANDS, false],
  ] as const)("reserves the actual %s action and alias identities", async (_name, workspaceActions, workspaceCaseInsensitive) => {
    const discovery = await discoverCommands("unused", { workspaceActions, workspaceCaseInsensitive, readReadiness: async () => "missing" });
    for (const action of workspaceActions) {
      expect(discovery.resolve(action.name)?.listing.invocationKind).toBe("workspace-action");
      for (const alias of action.aliases) expect(discovery.resolve(alias)?.listing.invocationKind).toBe("workspace-action");
    }
    expect(discovery.resolve("ordinary")?.listing.origin).toBe("project-custom");
    if (workspaceCaseInsensitive) expect(discovery.entries.some((entry) => entry.custom?.name === "Help")).toBe(false);
    expect(discovery.entries.some((entry) => entry.listing.name === "setup-programmatic")).toBe(true);
    expect(discovery.entries.some((entry) => entry.listing.name === "programmatic")).toBe(false);
  });
});
