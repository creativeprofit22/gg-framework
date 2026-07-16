import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureAppDirs, loadSavedSettings } from "./config.js";

const tempDirs: string[] = [];

function tempSettingsPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ggcoder-config-"));
  tempDirs.push(dir);
  return path.join(dir, "settings.json");
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("ensureAppDirs", () => {
  it("creates the global custom-command directory with owner-only POSIX permissions", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ggcoder-home-"));
    tempDirs.push(home);
    vi.spyOn(os, "homedir").mockReturnValue(home);

    const paths = await ensureAppDirs();
    const commandsDir = path.join(paths.agentDir, "commands");
    const stat = fs.statSync(commandsDir);

    expect(stat.isDirectory()).toBe(true);
    if (process.platform !== "win32") expect(stat.mode & 0o777).toBe(0o700);
  });
});

describe("loadSavedSettings", () => {
  it("defaults ideal review to enabled", () => {
    const settings = loadSavedSettings(tempSettingsPath());

    expect(settings.idealReviewEnabled).toBe(true);
  });

  it("honors an explicit ideal review disable", () => {
    const settingsPath = tempSettingsPath();
    fs.writeFileSync(settingsPath, JSON.stringify({ idealReviewEnabled: false }), "utf-8");

    const settings = loadSavedSettings(settingsPath);

    expect(settings.idealReviewEnabled).toBe(false);
  });

  it("accepts xai as a saved provider", () => {
    const settingsPath = tempSettingsPath();
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({ defaultProvider: "xai", defaultModel: "grok-4.5" }),
      "utf-8",
    );

    const settings = loadSavedSettings(settingsPath);

    expect(settings.provider).toBe("xai");
    expect(settings.model).toBe("grok-4.5");
  });
});
