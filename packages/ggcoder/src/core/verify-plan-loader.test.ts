import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  VERIFY_PLAN_DESCRIPTOR_PATH,
  VERIFY_PLAN_HEURISTICS_REASONS,
} from "@kenkaiiii/gg-core/verify-plan";
import { SettingsManager } from "./settings-manager.js";
import { verifyPlanDescriptorSha256 } from "./verify-plan-approval.js";
import {
  VerifyPlanLoader,
  resolveWindowsProgram,
  type VerifyPlanCommandLimits,
} from "./verify-plan-loader.js";

const PLAN_SCRIPT = `
import fs from "node:fs";
const [mode] = process.argv.slice(2);
fs.appendFileSync("runs.txt", mode + "\\n");
const gate = { id: "rust", argv: ["cargo", "test"], covers: ["crates/**"], quietBudgetSeconds: 900 };
if (mode === "gg") process.stdout.write(JSON.stringify({ version: 1, mode: "changed", gates: [gate] }));
if (mode === "gg2") process.stdout.write(JSON.stringify({ version: 1, mode: "full", gates: [] }));
if (mode === "supa")
  process.stdout.write(JSON.stringify({
    version: 1,
    mode: "changed",
    run: [{ gate: "ts", argv: ["pnpm", "check"], files: ["src/**"] }],
    skip: [{ gate: "rust", reason: "unchanged", lastRun: "2026-10-30" }],
  }));
if (mode === "big") process.stdout.write("x".repeat(5000));
if (mode === "fail") process.exit(3);
if (mode === "slow") setTimeout(() => {}, 20000);
`;

let root: string;
let cwd: string;

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gg-verify-plan-loader-")));
  execFileSync("git", ["init", "-q"], { cwd: root });
  cwd = path.join(root, "packages", "app");
  await fs.mkdir(cwd, { recursive: true });
  await fs.mkdir(path.join(root, ".gg"), { recursive: true });
  await fs.writeFile(path.join(root, "plan.mjs"), PLAN_SCRIPT, "utf-8");
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

async function writeDescriptor(mode: string, format = "gg-verify-plan-v1"): Promise<void> {
  await writeDescriptorText(
    JSON.stringify({
      version: 1,
      command: { argv: [process.execPath, "plan.mjs", mode], cwd: "." },
      format,
    }),
  );
}

async function writeDescriptorText(text: string): Promise<void> {
  await fs.writeFile(path.join(root, VERIFY_PLAN_DESCRIPTOR_PATH), text, "utf-8");
}

async function runs(): Promise<string[]> {
  const text = await fs.readFile(path.join(root, "runs.txt"), "utf-8").catch(() => "");
  return text.split(/\r?\n/).filter(Boolean);
}

function loader(approved = true, limits?: VerifyPlanCommandLimits): VerifyPlanLoader {
  return new VerifyPlanLoader({ cwd, isApproved: () => approved, limits });
}

async function descriptorText(): Promise<string> {
  return fs.readFile(path.join(root, VERIFY_PLAN_DESCRIPTOR_PATH), "utf-8");
}

describe("VerifyPlanLoader", () => {
  it("loads a gg plan from the git root's descriptor and caches it", async () => {
    await writeDescriptor("gg");
    const plans = loader();
    expect(plans.get()).toBeNull();
    const result = await plans.refresh();
    expect(result.reason).toBeNull();
    expect(result.plan?.gates).toMatchObject([
      { id: "rust", argv: ["cargo", "test"], covers: ["crates/**"], quietBudgetSeconds: 900 },
    ]);
    expect(plans.get()).toBe(result.plan);
    await plans.refresh();
    expect(await runs()).toEqual(["gg"]);
    plans.dispose();
    expect(plans.get()).toBeNull();
  });

  it("never runs an unapproved descriptor and reports it as needing approval", async () => {
    await writeDescriptor("gg");
    const plans = loader(false);
    expect(await plans.refresh()).toEqual({
      plan: null,
      reason: VERIFY_PLAN_HEURISTICS_REASONS.notApproved,
    });
    expect(plans.get()).toBeNull();
    expect(plans.status()).toEqual({
      state: "needs-approval",
      reason: VERIFY_PLAN_HEURISTICS_REASONS.notApproved,
      argv: [process.execPath, "plan.mjs", "gg"],
      cwd: root,
      descriptorSha256: verifyPlanDescriptorSha256(await descriptorText()),
    });
    expect(await runs()).toEqual([]);
  });

  it("does not treat MCP trust as approval to run the plan", async () => {
    await writeDescriptor("gg");
    const settingsFile = path.join(root, "settings.json");
    await fs.writeFile(
      settingsFile,
      JSON.stringify({ trustProjectMcpServers: true, trustedProjects: [cwd] }),
      "utf-8",
    );
    const settings = new SettingsManager(settingsFile);
    await settings.load();
    expect(settings.isProjectTrusted(cwd)).toBe(true);
    const plans = new VerifyPlanLoader({
      cwd,
      isApproved: (text) => settings.isVerifyPlanApproved(cwd, text),
    });
    expect((await plans.refresh()).reason).toBe(VERIFY_PLAN_HEURISTICS_REASONS.notApproved);
    expect(plans.status()?.state).toBe("needs-approval");
    expect(await runs()).toEqual([]);
  });

  it("runs an approved hash and asks again once the descriptor changes", async () => {
    await writeDescriptor("gg");
    const settings = new SettingsManager(path.join(root, "settings.json"));
    await settings.load();
    const plans = new VerifyPlanLoader({
      cwd,
      isApproved: (text) => settings.isVerifyPlanApproved(cwd, text),
    });
    await plans.refresh();
    const shown = await plans.readCurrentDescriptor();
    const pending = plans.status();
    expect(shown?.sha256).toBe(
      pending?.state === "needs-approval" ? pending.descriptorSha256 : undefined,
    );
    await settings.approveVerifyPlan(cwd, shown?.text ?? "");
    expect(plans.get()).toBeNull();
    expect((await plans.refresh()).plan?.mode).toBe("changed");
    expect(plans.status()).toEqual({ state: "plan", reason: null });
    expect(await runs()).toEqual(["gg"]);

    await writeDescriptor("gg2");
    plans.noteFileMutated(path.join(root, VERIFY_PLAN_DESCRIPTOR_PATH));
    expect((await plans.refresh()).reason).toBe(VERIFY_PLAN_HEURISTICS_REASONS.notApproved);
    expect(plans.status()?.state).toBe("needs-approval");
    expect(await runs()).toEqual(["gg"]);
  });

  it("shows why an approved plan fell back", async () => {
    await writeDescriptor("fail");
    const plans = loader();
    await plans.refresh();
    expect(plans.status()).toEqual({
      state: "heuristics",
      reason: `${VERIFY_PLAN_HEURISTICS_REASONS.nonZeroExit} (exit 3)`,
      descriptorPresent: true,
    });
  });

  it("falls back without a descriptor", async () => {
    expect(await loader().refresh()).toEqual({
      plan: null,
      reason: VERIFY_PLAN_HEURISTICS_REASONS.noDescriptor,
    });
  });

  it("falls back on a bad or oversized descriptor", async () => {
    await writeDescriptorText(
      JSON.stringify({
        version: 1,
        command: { argv: "node plan.mjs gg" },
        format: "gg-verify-plan-v1",
      }),
    );
    const bad = await loader().refresh();
    expect(bad.plan).toBeNull();
    expect(bad.reason).toMatch(/^bad verify-plan descriptor: command\.argv: argv must be an array/);
    await writeDescriptorText(`{"version":1,"pad":"${"x".repeat(9000)}"}`);
    expect((await loader().refresh()).reason).toBe(
      `${VERIFY_PLAN_HEURISTICS_REASONS.badDescriptor}: descriptor is larger than 8192 bytes`,
    );
    expect(await runs()).toEqual([]);
  });

  it("falls back when the command fails, times out or prints too much", async () => {
    await writeDescriptor("fail");
    expect((await loader().refresh()).reason).toBe(
      `${VERIFY_PLAN_HEURISTICS_REASONS.nonZeroExit} (exit 3)`,
    );
    await writeDescriptor("slow");
    const started = Date.now();
    expect(await loader(true, { timeoutMs: 500, maxOutputBytes: 1000 }).refresh()).toEqual({
      plan: null,
      reason: VERIFY_PLAN_HEURISTICS_REASONS.timedOut,
    });
    expect(Date.now() - started).toBeLessThan(10_000);
    await writeDescriptor("big");
    expect((await loader(true, { timeoutMs: 10_000, maxOutputBytes: 1000 }).refresh()).reason).toBe(
      VERIFY_PLAN_HEURISTICS_REASONS.oversize,
    );
  }, 30_000);

  it("never holds a turn longer than the wait budget for a slow plan command", async () => {
    await writeDescriptor("slow");
    const plans = loader(true, { timeoutMs: 3_000, maxOutputBytes: 1000 });
    const started = Date.now();
    await plans.settle(200);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(plans.get()).toBeNull();
    expect((await plans.refresh()).reason).toBe(VERIFY_PLAN_HEURISTICS_REASONS.timedOut);
  }, 30_000);

  it("adapts supa plan v1 output", async () => {
    await writeDescriptor("supa", "supa-plan-v1");
    const { plan } = await loader().refresh();
    expect(plan?.gates).toMatchObject([{ id: "ts", argv: ["pnpm", "check"], covers: ["src/**"] }]);
    expect(plan?.advice).toEqual([
      { gateId: "rust", kind: "reused-pass", reason: "unchanged", lastRun: "2026-10-30" },
    ]);
  });

  it("reloads after an edit to the descriptor", async () => {
    await writeDescriptor("gg");
    const plans = loader();
    await plans.refresh();
    expect(plans.get()?.mode).toBe("changed");
    await writeDescriptor("gg2");
    plans.noteFileMutated(path.join(root, VERIFY_PLAN_DESCRIPTOR_PATH));
    expect(plans.get()).toBeNull();
    await plans.refresh();
    expect(plans.get()?.mode).toBe("full");
    plans.noteFileMutated(path.join(root, "src", "a.ts"));
    expect(plans.get()?.mode).toBe("full");
    expect(await runs()).toEqual(["gg", "gg2"]);
  });

  it("stops using a cached plan once approval is withdrawn", async () => {
    await writeDescriptor("gg");
    let approved = true;
    const plans = new VerifyPlanLoader({ cwd, isApproved: () => approved });
    await plans.refresh();
    expect(plans.get()).not.toBeNull();
    approved = false;
    expect(plans.get()).toBeNull();
    expect((await plans.refresh()).reason).toBe(VERIFY_PLAN_HEURISTICS_REASONS.notApproved);
  });
});

describe("resolveWindowsProgram", () => {
  const files = (...paths: string[]) => {
    const known = new Set(paths.map((file) => path.win32.resolve(file).toLowerCase()));
    return (file: string) => known.has(file.toLowerCase());
  };
  const env = { Path: "C:/tools;C:/npm", PATHEXT: ".COM;.EXE;.BAT;.CMD" };

  it("walks PATH x PATHEXT and reports npm shims as batch", () => {
    expect(resolveWindowsProgram("pnpm", env, "C:/repo", files("C:/npm/pnpm.cmd"))).toEqual({
      file: path.win32.resolve("C:/npm/pnpm.cmd"),
      kind: "batch",
    });
  });

  it("takes the first PATH dir and PATHEXT order, with the default PATHEXT", () => {
    const isFile = files("C:/tools/supa.cmd", "C:/tools/supa.exe", "C:/npm/supa.exe");
    expect(resolveWindowsProgram("supa", { PATH: "C:/tools;C:/npm" }, "C:/repo", isFile)).toEqual({
      file: path.win32.resolve("C:/tools/supa.exe"),
      kind: "exe",
    });
  });

  it("resolves a path against the cwd without searching PATH", () => {
    const isFile = files("C:/repo/scripts/plan.cmd", "C:/npm/plan.cmd");
    expect(resolveWindowsProgram("scripts/plan.cmd", env, "C:/repo", isFile)).toEqual({
      file: path.win32.resolve("C:/repo/scripts/plan.cmd"),
      kind: "batch",
    });
    expect(resolveWindowsProgram("./plan", env, "C:/repo", isFile)).toBeNull();
  });

  it("ignores extensions it can't launch and missing programs", () => {
    const isFile = files("C:/tools/plan.js", "C:/tools/plan.vbs");
    const withJs = { ...env, PATHEXT: ".JS;.VBS;.EXE" };
    expect(resolveWindowsProgram("plan", withJs, "C:/repo", isFile)).toBeNull();
    expect(resolveWindowsProgram("missing", env, "C:/repo", isFile)).toBeNull();
  });
});

describe.runIf(process.platform === "win32")("VerifyPlanLoader on Windows", () => {
  async function withShimOnPath(run: () => Promise<void>): Promise<void> {
    // A space in the dir exercises quoting the resolved path for cmd.exe.
    const bin = path.join(root, "bin dir");
    await fs.mkdir(bin, { recursive: true });
    const lines = ["@echo off", `"${process.execPath}" plan.mjs %*`, ""];
    await fs.writeFile(path.join(bin, "plan.cmd"), lines.join(os.EOL), "utf-8");
    vi.stubEnv("PATH", [bin, process.env.PATH ?? ""].join(path.delimiter));
    try {
      await run();
    } finally {
      vi.unstubAllEnvs();
    }
  }

  async function writeArgv(argv: string[]): Promise<void> {
    await writeDescriptorText(
      JSON.stringify({ version: 1, command: { argv, cwd: "." }, format: "gg-verify-plan-v1" }),
    );
  }

  it("runs a .cmd program found on PATH", async () => {
    await withShimOnPath(async () => {
      await writeArgv(["plan", "gg"]);
      const result = await loader().refresh();
      expect(result.reason).toBeNull();
      expect(result.plan?.mode).toBe("changed");
      expect(await runs()).toEqual(["gg"]);
    });
  });

  it("refuses a .cmd program whose arguments could inject cmd syntax", async () => {
    await withShimOnPath(async () => {
      await writeArgv(["plan", "gg&echo", "x"]);
      expect((await loader().refresh()).reason).toBe(
        `${VERIFY_PLAN_HEURISTICS_REASONS.nonZeroExit} (.cmd/.bat programs only take plain arguments)`,
      );
      expect(await runs()).toEqual([]);
    });
  });

  it("names a program it can't find", async () => {
    await writeArgv(["gg-definitely-missing-program", "gg"]);
    expect((await loader().refresh()).reason).toBe(
      `${VERIFY_PLAN_HEURISTICS_REASONS.nonZeroExit} (program "gg-definitely-missing-program" not found)`,
    );
  });
});
