import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { loadSavedSettings, seedDefaultAgents, SHADOWING_SEEDED_AGENT_HASHES } from "./config.js";
import { BUNDLED_AGENTS } from "./core/agents.js";

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "__fixtures__");

const tempDirs: string[] = [];

function tempSettingsPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ggcoder-config-"));
  tempDirs.push(dir);
  return path.join(dir, "settings.json");
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("loadSavedSettings", () => {
  it("defaults ideal review and shared compaction policy", () => {
    const settings = loadSavedSettings(tempSettingsPath());

    expect(settings.idealReviewEnabled).toBe(true);
    expect(settings.autoCompact).toBe(true);
    expect(settings.compactThreshold).toBe(0.85);
  });

  it("honors an explicit ideal review disable", () => {
    const settingsPath = tempSettingsPath();
    fs.writeFileSync(settingsPath, JSON.stringify({ idealReviewEnabled: false }), "utf-8");

    const settings = loadSavedSettings(settingsPath);

    expect(settings.idealReviewEnabled).toBe(false);
  });

  it("loads the configured compaction policy used by CLI resume", () => {
    const settingsPath = tempSettingsPath();
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({ autoCompact: false, compactThreshold: 0.72 }),
      "utf-8",
    );

    const settings = loadSavedSettings(settingsPath);
    expect(settings.autoCompact).toBe(false);
    expect(settings.compactThreshold).toBe(0.72);
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

// v5.22.6 seeded auditor.md / skeptic.md into the user agents dir, silently
// shadowing the richer BUNDLED_AGENTS of the same name. seedDefaultAgents now
// cleans them up on next launch — but only when the file is untouched.
//
// These call seedDefaultAgents(dir) directly: getAppPaths() resolves
// os.homedir() inside gg-core's prebuilt dist, which vitest does not transform,
// so going via ensureAppDirs would ignore a homedir spy and mutate the real
// ~/.gg.
describe("seedDefaultAgents shadowing-agent cleanup", () => {
  // Byte-exact copies of what v5.22.6 wrote, so the deletion path is tested
  // against the real thing rather than a paraphrase.
  const SEEDED_AUDITOR = fs.readFileSync(
    path.join(fixturesDir, "seeded-auditor-v5.22.6.md"),
    "utf-8",
  );

  it("the recorded hashes match the real v5.22.6 seed files", () => {
    for (const [name, fixture] of [
      ["auditor.md", "seeded-auditor-v5.22.6.md"],
      ["skeptic.md", "seeded-skeptic-v5.22.6.md"],
    ]) {
      const content = fs.readFileSync(path.join(fixturesDir, fixture), "utf-8");
      const hash = createHash("sha256").update(content, "utf-8").digest("hex");
      expect(hash, name).toBe(SHADOWING_SEEDED_AGENT_HASHES[name]);
    }
  });

  function tempAgentsDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ggcoder-agents-"));
    tempDirs.push(dir);
    return dir;
  }

  it("deletes an untouched seeded auditor.md so the bundled agent wins again", async () => {
    const dir = tempAgentsDir();
    fs.writeFileSync(path.join(dir, "auditor.md"), SEEDED_AUDITOR, "utf-8");

    await seedDefaultAgents(dir);

    expect(fs.existsSync(path.join(dir, "auditor.md"))).toBe(false);
    expect(BUNDLED_AGENTS.some((a) => a.name === "auditor")).toBe(true);
  });

  it("keeps a user-modified auditor.md", async () => {
    const dir = tempAgentsDir();
    const mine = SEEDED_AUDITOR + "\nMy own extra rule.\n";
    fs.writeFileSync(path.join(dir, "auditor.md"), mine, "utf-8");

    await seedDefaultAgents(dir);

    expect(fs.readFileSync(path.join(dir, "auditor.md"), "utf-8")).toBe(mine);
  });

  it("seeds owl and bee but never auditor or skeptic", async () => {
    const dir = tempAgentsDir();

    await seedDefaultAgents(dir);

    expect(fs.existsSync(path.join(dir, "owl.md"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "bee.md"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "auditor.md"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "skeptic.md"))).toBe(false);
  });

  it("does not overwrite a user's edited owl.md", async () => {
    const dir = tempAgentsDir();
    fs.writeFileSync(path.join(dir, "owl.md"), "mine", "utf-8");

    await seedDefaultAgents(dir);

    expect(fs.readFileSync(path.join(dir, "owl.md"), "utf-8")).toBe("mine");
  });
});
