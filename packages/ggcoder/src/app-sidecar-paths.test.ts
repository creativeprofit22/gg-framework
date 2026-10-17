import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appSettingsFile } from "./app-sidecar-paths.js";

const originalAgentDir = process.env.GG_AGENT_DIR;

afterEach(() => {
  if (originalAgentDir === undefined) {
    delete process.env.GG_AGENT_DIR;
  } else {
    process.env.GG_AGENT_DIR = originalAgentDir;
  }
});

describe("appSettingsFile", () => {
  it("stores app settings beneath the injected agent directory", () => {
    const identityRoot = path.join(os.tmpdir(), "identities", "com.ggcoder.local-fork");
    process.env.GG_AGENT_DIR = identityRoot;

    expect(appSettingsFile()).toBe(path.join(identityRoot, "gg-app.json"));
  });

  it("preserves the legacy app settings location without an override", () => {
    delete process.env.GG_AGENT_DIR;

    expect(appSettingsFile()).toBe(path.join(os.homedir(), ".gg", "gg-app.json"));
  });
});
