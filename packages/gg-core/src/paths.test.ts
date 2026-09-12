import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getAppPaths, resolveAgentDir } from "./paths.js";

const originalAgentDir = process.env.GG_AGENT_DIR;

afterEach(() => {
  if (originalAgentDir === undefined) {
    delete process.env.GG_AGENT_DIR;
  } else {
    process.env.GG_AGENT_DIR = originalAgentDir;
  }
});

describe("resolveAgentDir", () => {
  it("uses the legacy ~/.gg directory by default", () => {
    expect(resolveAgentDir(undefined, os.homedir())).toBe(path.join(os.homedir(), ".gg"));
  });

  it("accepts and normalizes an absolute override", () => {
    const override = `${path.join(os.tmpdir(), "gg-local-fork")}${path.sep}.`;

    expect(resolveAgentDir(override, os.homedir())).toBe(path.normalize(override));
  });

  it.each(["identities/local-fork", ".gg-local", "../other-user"])(
    "rejects the relative override %s",
    (override) => {
      const homeDir = path.join(os.tmpdir(), "gg-home");

      expect(resolveAgentDir(override, homeDir)).toBe(path.join(homeDir, ".gg"));
    },
  );
});

describe("getAppPaths", () => {
  it("derives every shared path from GG_AGENT_DIR", () => {
    const agentDir = path.join(os.tmpdir(), "gg-local-fork");
    process.env.GG_AGENT_DIR = agentDir;

    expect(getAppPaths()).toMatchObject({
      agentDir: path.normalize(agentDir),
      sessionsDir: path.join(agentDir, "sessions"),
      settingsFile: path.join(agentDir, "settings.json"),
      authFile: path.join(agentDir, "auth.json"),
      chatMemoryFile: path.join(agentDir, "chat-memories.json"),
      chatJiwaFile: path.join(agentDir, "chat-jiwa.json"),
      mcpFile: path.join(agentDir, "mcp.json"),
      mcpAuthFile: path.join(agentDir, "mcp-auth.json"),
      logFile: path.join(agentDir, "debug.log"),
      skillsDir: path.join(agentDir, "skills"),
      extensionsDir: path.join(agentDir, "extensions"),
      agentsDir: path.join(agentDir, "agents"),
    });
  });
});
