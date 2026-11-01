import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SettingsManager } from "./settings-manager.js";
import { verifyPlanDescriptorSha256 } from "./verify-plan-approval.js";

const DESCRIPTOR =
  '{"version":1,"command":{"argv":["node","plan.mjs"]},"format":"gg-verify-plan-v1"}';

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "gg-settings-manager-"));
  file = path.join(dir, "settings.json");
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

async function load(): Promise<SettingsManager> {
  const settings = new SettingsManager(file);
  await settings.load();
  return settings;
}

describe("SettingsManager verify-plan approvals", () => {
  it("approves one descriptor text for one resolved project, separately from MCP trust", async () => {
    await fs.writeFile(file, JSON.stringify({ trustProjectMcpServers: true }), "utf-8");
    const settings = await load();
    const project = path.join(dir, "repo");
    expect(settings.isProjectTrusted(project)).toBe(true);
    expect(settings.isVerifyPlanApproved(project, DESCRIPTOR)).toBe(false);

    await settings.approveVerifyPlan(path.join(project, "sub", ".."), DESCRIPTOR);
    expect(settings.isVerifyPlanApproved(project, DESCRIPTOR)).toBe(true);
    expect(settings.isVerifyPlanApproved(project, `${DESCRIPTOR} `)).toBe(false);
    expect(settings.isVerifyPlanApproved(path.join(dir, "other"), DESCRIPTOR)).toBe(false);
    expect((await load()).isVerifyPlanApproved(project, DESCRIPTOR)).toBe(true);
  });

  it("dedupes approvals and keeps settings another process wrote meanwhile", async () => {
    const settings = await load();
    const project = path.join(dir, "repo");
    await fs.writeFile(file, JSON.stringify({ theme: "dark", customKey: 7 }), "utf-8");
    await settings.approveVerifyPlan(project, DESCRIPTOR);
    await settings.approveVerifyPlan(project, DESCRIPTOR);
    const raw = JSON.parse(await fs.readFile(file, "utf-8")) as Record<string, unknown>;
    expect(raw).toEqual({
      theme: "dark",
      customKey: 7,
      verifyPlanApprovals: [
        {
          project: path.resolve(project),
          descriptorSha256: verifyPlanDescriptorSha256(DESCRIPTOR),
        },
      ],
    });
    expect((await fs.readdir(dir)).sort()).toEqual(["settings.json"]);
  });

  it("refuses to overwrite a settings file it cannot parse", async () => {
    const settings = await load();
    await fs.writeFile(file, "{ not json", "utf-8");
    await expect(settings.approveVerifyPlan(dir, DESCRIPTOR)).rejects.toThrow();
    expect(await fs.readFile(file, "utf-8")).toBe("{ not json");
    expect(settings.isVerifyPlanApproved(dir, DESCRIPTOR)).toBe(false);
  });

  it("picks up approvals saved by another manager on reload", async () => {
    const first = await load();
    const second = await load();
    await first.approveVerifyPlan(dir, DESCRIPTOR);
    expect(second.isVerifyPlanApproved(dir, DESCRIPTOR)).toBe(false);
    await second.reloadVerifyPlanApprovals();
    expect(second.isVerifyPlanApproved(dir, DESCRIPTOR)).toBe(true);
  });
});

describe("SettingsManager concurrency settings", () => {
  it("defaults to an auto budget, env defaults on and one heavy check at a time", async () => {
    const settings = await load();
    expect(settings.get("concurrencyBudget")).toBe(0);
    expect(settings.get("concurrencyDefaults")).toBe(true);
    expect(settings.get("heavyCheckLimit")).toBe(1);
  });

  it("reads saved values and falls back to defaults for invalid ones", async () => {
    await fs.writeFile(
      file,
      JSON.stringify({ concurrencyBudget: 4, concurrencyDefaults: false, heavyCheckLimit: 0 }),
      "utf-8",
    );
    const saved = await load();
    expect(saved.get("concurrencyBudget")).toBe(4);
    expect(saved.get("concurrencyDefaults")).toBe(false);
    expect(saved.get("heavyCheckLimit")).toBe(0);

    await fs.writeFile(
      file,
      JSON.stringify({ concurrencyBudget: 2.5, heavyCheckLimit: 99 }),
      "utf-8",
    );
    const invalid = await load();
    expect(invalid.get("concurrencyBudget")).toBe(0);
    expect(invalid.get("heavyCheckLimit")).toBe(1);
  });
});
