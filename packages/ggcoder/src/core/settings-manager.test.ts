import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SettingsManager } from "./settings-manager.js";

const tempDirs: string[] = [];

function tempSettingsPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ggcoder-settings-manager-"));
  tempDirs.push(dir);
  return path.join(dir, "settings.json");
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("SettingsManager", () => {
  it("preserves Azure Sol and unrelated settings across model and thinking saves", async () => {
    const settingsPath = tempSettingsPath();
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        autoCompact: false,
        theme: "light",
        lspDiagnostics: false,
        sessionRetentionDays: 7,
      }),
      "utf-8",
    );

    const modelSettings = new SettingsManager(settingsPath);
    await modelSettings.load();
    await modelSettings.set("defaultProvider", "azure");
    await modelSettings.set("defaultModel", "azure:gpt-5.6-sol");

    const thinkingSettings = new SettingsManager(settingsPath);
    await thinkingSettings.load();
    await thinkingSettings.set("thinkingEnabled", true);
    await thinkingSettings.set("thinkingLevel", "ultra");

    const restored = await new SettingsManager(settingsPath).load();
    expect(restored).toMatchObject({
      defaultProvider: "azure",
      defaultModel: "azure:gpt-5.6-sol",
      thinkingEnabled: true,
      thinkingLevel: "ultra",
      autoCompact: false,
      theme: "light",
      lspDiagnostics: false,
      sessionRetentionDays: 7,
    });
  });
});
