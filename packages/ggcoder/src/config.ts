import path from "node:path";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import { createHash } from "node:crypto";
import type { Provider, ThinkingLevel } from "@kenkaiiii/gg-ai";
import { getAppPaths, withoutPaidTier, type AppPaths } from "@kenkaiiii/gg-core";
import type { ThemeName } from "./ui/theme/theme.js";
import { parseVerifyPlanApprovals, type VerifyPlanApproval } from "./core/verify-plan-approval.js";
import {
  DEFAULT_FOREGROUND_LIMIT_SETTINGS,
  type ForegroundLimitSettings,
} from "./tools/foreground-limits.js";
import { DEFAULT_CONCURRENCY_SETTINGS, type ConcurrencySettings } from "./core/machine-profile.js";

export const APP_NAME = "ggcoder";
export const VERSION = "0.0.1";

// getAppPaths + AppPaths now live in @kenkaiiii/gg-core. Re-exported here so the
// many `./config.js` importers keep resolving them unchanged.
export { getAppPaths };
export type { AppPaths };

export async function ensureAppDirs(): Promise<AppPaths> {
  const paths = getAppPaths();
  await fs.mkdir(paths.agentDir, { recursive: true, mode: 0o700 });
  await fs.mkdir(path.join(paths.agentDir, "commands"), { recursive: true, mode: 0o700 });
  await fs.mkdir(paths.sessionsDir, { recursive: true, mode: 0o700 });
  await fs.mkdir(paths.skillsDir, { recursive: true, mode: 0o700 });
  await fs.mkdir(paths.extensionsDir, { recursive: true, mode: 0o700 });
  await fs.mkdir(paths.agentsDir, { recursive: true, mode: 0o700 });
  await seedDefaultAgents(paths.agentsDir);
  await removeRetiredSeededSkills(paths.skillsDir);
  return paths;
}

export interface SavedSettings {
  provider?: Provider;
  model?: string;
  autoCompact: boolean;
  compactThreshold: number;
  /** Absolute auto-compaction trigger (settings `compactAtTokens`). */
  compactAtTokens?: number;
  thinkingEnabled: boolean;
  thinkingLevel?: ThinkingLevel;
  theme: "auto" | ThemeName;
  idealReviewEnabled: boolean;
  /** Append LSP diagnostics to edit/write tool results. */
  lspDiagnostics: boolean;
  /** Allow write/edit outside the workspace (cwd, tmpdir, ~/.gg). */
  allowOutsideWorkspaceWrites: boolean;
  /** Connect MCP servers declared in the opened repo's .gg/mcp.json. That file
   *  is repo-controlled, so a malicious repo could run a command the moment
   *  the project opens. Default false — enable only for repos you trust.
   *  MCP only: it does not approve the repo's .gg/verify-plan.json command. */
  trustProjectMcpServers: boolean;
  /** Repo paths individually trusted for project-scope MCP (the per-repo
   *  complement to the global `trustProjectMcpServers`). MCP only. */
  trustedProjects: string[];
  /** Per-descriptor approvals to run a repo's .gg/verify-plan.json command,
   *  bound to the descriptor's sha256 (see core/verify-plan-approval.ts). */
  verifyPlanApprovals: VerifyPlanApproval[];
  /** Max concurrent subagents per resolved child model (1–4). Unset = global limit only. */
  subagentMaxPerModel?: number;
  /** Days to keep session transcripts before startup pruning. 0 disables. */
  sessionRetentionDays: number;
  /** Seconds before a foreground bash command moves to the background; 0 disables. */
  bashYieldSeconds?: number;
  /** Seconds without output before a bash command is stopped; 0 disables. */
  bashInactivitySeconds?: number;
  /** Minutes before a bash command is stopped regardless of output; 0 disables. */
  bashHardLimitMinutes?: number;
  /** Concurrency budget for build/test tools (0–256); 0 = derive from this machine. */
  concurrencyBudget?: number;
  /** Set CARGO_BUILD_JOBS, RUST_TEST_THREADS and pnpm workspace concurrency where unset. */
  concurrencyDefaults?: boolean;
  /** Full test/build runs allowed at once (0–8); 0 = no limit. */
  heavyCheckLimit?: number;
  /** Speed optimization profile.
   *  - "baseline": current defaults (5-min cache TTL, no pre-warm)
   *  - "optimized": 1-h cache TTL, cache pre-warming on first prompt
   *  Default: "baseline" so existing behavior is unchanged until benchmarked/merged. */
  speedProfile?: "baseline" | "optimized";
}

const VALID_PROVIDERS = new Set<Provider>([
  "anthropic",
  "xiaomi",
  "openai",
  "azure",
  "qwen-cloud",
  "gemini",
  "glm",
  "moonshot",
  "minimax",
  "deepseek",
  "openrouter",
  "huggingface",
  "sakana",
  "xai",
]);

function isValidProvider(value: unknown): value is Provider {
  return typeof value === "string" && VALID_PROVIDERS.has(value as Provider);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/** Bash foreground limits from saved settings, falling back per field to the tool defaults. */
export function foregroundLimitSettingsFrom(
  saved: Pick<SavedSettings, "bashYieldSeconds" | "bashInactivitySeconds" | "bashHardLimitMinutes">,
): ForegroundLimitSettings {
  return {
    yieldSeconds: saved.bashYieldSeconds ?? DEFAULT_FOREGROUND_LIMIT_SETTINGS.yieldSeconds,
    inactivitySeconds:
      saved.bashInactivitySeconds ?? DEFAULT_FOREGROUND_LIMIT_SETTINGS.inactivitySeconds,
    hardLimitMinutes:
      saved.bashHardLimitMinutes ?? DEFAULT_FOREGROUND_LIMIT_SETTINGS.hardLimitMinutes,
  };
}

function isIntegerInRange(value: unknown, max: number): value is number {
  return isNonNegativeInteger(value) && value <= max;
}

/** Concurrency settings from saved settings, falling back per field to the machine-profile defaults. */
export function concurrencySettingsFrom(
  saved: Pick<SavedSettings, "concurrencyBudget" | "concurrencyDefaults" | "heavyCheckLimit">,
): ConcurrencySettings {
  return {
    budget: saved.concurrencyBudget ?? DEFAULT_CONCURRENCY_SETTINGS.budget,
    defaults: saved.concurrencyDefaults ?? DEFAULT_CONCURRENCY_SETTINGS.defaults,
    heavyCheckLimit: saved.heavyCheckLimit ?? DEFAULT_CONCURRENCY_SETTINGS.heavyCheckLimit,
  };
}

/**
 * Load saved settings from the settings file. Returns defaults on missing/invalid file.
 * `localModels`: accept a saved local model. Only the desktop app discovers
 * local endpoints; the CLI would boot on a model it can't find.
 */
export function loadSavedSettings(
  settingsFilePath?: string,
  { localModels = false }: { localModels?: boolean } = {},
): SavedSettings {
  const filePath = settingsFilePath ?? getAppPaths().settingsFile;
  const result: SavedSettings = {
    autoCompact: true,
    compactThreshold: 0.85,
    thinkingEnabled: false,
    theme: "auto",
    idealReviewEnabled: true,
    lspDiagnostics: true,
    allowOutsideWorkspaceWrites: false,
    sessionRetentionDays: 30,
    trustProjectMcpServers: false,
    trustedProjects: [],
    verifyPlanApprovals: [],
  };
  try {
    const raw = JSON.parse(fsSync.readFileSync(filePath, "utf-8"));
    // Only accept providers the current build actually supports. A stale
    // provider name (e.g. a previously-supported provider that's since been
    // removed) would otherwise poison startup with "Not logged in" errors.
    if (isValidProvider(raw.defaultProvider) || (localModels && raw.defaultProvider === "local")) {
      result.provider = raw.defaultProvider as Provider;
      // Only honor the saved model when the provider was also accepted —
      // otherwise a model from the removed provider would leak through.
      // A saved paid tier (Claude fast mode bills usage credits) never boots a
      // session by itself; it starts on the standard model instead.
      if (typeof raw.defaultModel === "string") result.model = withoutPaidTier(raw.defaultModel);
    }
    if (raw.autoCompact === false) result.autoCompact = false;
    if (
      typeof raw.compactThreshold === "number" &&
      Number.isFinite(raw.compactThreshold) &&
      raw.compactThreshold >= 0.1 &&
      raw.compactThreshold <= 1
    ) {
      result.compactThreshold = raw.compactThreshold;
    }
    if (
      typeof raw.compactAtTokens === "number" &&
      Number.isInteger(raw.compactAtTokens) &&
      raw.compactAtTokens >= 20_000
    ) {
      result.compactAtTokens = raw.compactAtTokens;
    }
    if (raw.thinkingEnabled === true) result.thinkingEnabled = true;
    if (isValidThinkingLevel(raw.thinkingLevel)) result.thinkingLevel = raw.thinkingLevel;
    if (typeof raw.theme === "string" && isValidThemeSetting(raw.theme)) result.theme = raw.theme;
    if (raw.idealReviewEnabled === false) result.idealReviewEnabled = false;
    if (raw.lspDiagnostics === false) result.lspDiagnostics = false;
    if (raw.allowOutsideWorkspaceWrites === true) result.allowOutsideWorkspaceWrites = true;
    if (
      typeof raw.subagentMaxPerModel === "number" &&
      Number.isInteger(raw.subagentMaxPerModel) &&
      raw.subagentMaxPerModel >= 1 &&
      raw.subagentMaxPerModel <= 4
    ) {
      result.subagentMaxPerModel = raw.subagentMaxPerModel;
    }
    if (
      typeof raw.sessionRetentionDays === "number" &&
      Number.isInteger(raw.sessionRetentionDays) &&
      raw.sessionRetentionDays >= 0
    ) {
      result.sessionRetentionDays = raw.sessionRetentionDays;
    }
    if (isNonNegativeInteger(raw.bashYieldSeconds)) result.bashYieldSeconds = raw.bashYieldSeconds;
    if (isNonNegativeInteger(raw.bashInactivitySeconds))
      result.bashInactivitySeconds = raw.bashInactivitySeconds;
    if (isNonNegativeInteger(raw.bashHardLimitMinutes))
      result.bashHardLimitMinutes = raw.bashHardLimitMinutes;
    // Same bounds as SettingsSchema in core/settings-manager.ts.
    if (isIntegerInRange(raw.concurrencyBudget, 256))
      result.concurrencyBudget = raw.concurrencyBudget;
    if (typeof raw.concurrencyDefaults === "boolean")
      result.concurrencyDefaults = raw.concurrencyDefaults;
    if (isIntegerInRange(raw.heavyCheckLimit, 8)) result.heavyCheckLimit = raw.heavyCheckLimit;
    if (raw.speedProfile === "optimized" || raw.speedProfile === "baseline") {
      result.speedProfile = raw.speedProfile;
    }
    if (raw.trustProjectMcpServers === true) result.trustProjectMcpServers = true;
    if (Array.isArray(raw.trustedProjects))
      result.trustedProjects = raw.trustedProjects.filter(
        (x: unknown): x is string => typeof x === "string",
      );
    result.verifyPlanApprovals = parseVerifyPlanApprovals(raw.verifyPlanApprovals);
  } catch {
    // No settings file or invalid JSON — use defaults
  }
  return result;
}

/** Whether project-scope MCP is allowed for the given cwd. True when EITHER the
 *  global `trustProjectMcpServers` toggle is on OR the resolved cwd is in the
 *  per-repo `trustedProjects` list. Shared so the CLI, sidecar, and dashboard
 *  all agree on the same decision. */
export function projectScopeAllowed(
  globalTrust: boolean,
  trustedProjects: string[],
  cwd: string,
): boolean {
  if (globalTrust) return true;
  return trustedProjects.includes(path.resolve(cwd));
}

const VALID_THINKING_LEVELS = new Set<ThinkingLevel>([
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
]);

function isValidThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === "string" && VALID_THINKING_LEVELS.has(value as ThinkingLevel);
}

const VALID_THEME_SETTINGS = new Set<string>([
  "auto",
  "dark",
  "light",
  "dark-ansi",
  "light-ansi",
  "dark-daltonized",
  "light-daltonized",
]);

function isValidThemeSetting(value: string): value is "auto" | ThemeName {
  return VALID_THEME_SETTINGS.has(value);
}

/**
 * SHA-256 of every agent body ggcoder has ever seeded into `~/.gg/agents`.
 *
 * All of those names now ship as BUNDLED_AGENTS with richer prompts, and user-dir
 * agents take precedence — so a seeded copy silently shadows the bundled one
 * and freezes it at the version that happened to be written on first run.
 * Delete those copies, but ONLY when the file is byte-identical to something we
 * wrote, so a user who edited or authored their own agent of that name keeps
 * it. Hashes cover every historical variant (`git log -p -- src/config.ts`); a
 * variant we missed just means that user keeps an old shadowing copy.
 */
export const SHADOWING_SEEDED_AGENT_HASHES: Record<string, readonly string[]> = {
  "auditor.md": ["7c8c6c1ff892a7ebf45164b0367e340f099cf2cd611bfec23eb39ecc24592502"],
  "skeptic.md": ["7def72d81da78919efb4934f396d8da47912786a49176badf996eac4d57a285d"],
  "owl.md": [
    "aace1c0aa0f25971f8ea24058a2581baa790aea1d83972f3fd3498e56ff05f8a",
    "896a41bcd0c253c77619fb96903d8ab880005fa2f21fe2a22f89f9716156527d",
    "a1066c116dc8381937cf67ea567c3c449891a525a3fca874ec59a8d7040249e7",
    "705180ca682a29f40803b063e198526295c8d1d536b2eabe2462f9757ebf2a9c",
  ],
  "bee.md": [
    "f2f09824758ea6207d470a64249d3c0ebc9b2cb790d2517608959a77d40f6688",
    "3cd4a051e30c3eebed8b1f068f18a3f425b27eaeeb6eacc4d65916abf8f1b45a",
    "7ef25f058a58099358f19fb6ca874a21f7101f0e037bdffc7bb9de2713a8ee92",
  ],
};

/**
 * Reclaim agent files ggcoder seeded into the user agents dir in past versions.
 *
 * Nothing is seeded anymore: bee/owl/researcher/worker/auditor/skeptic ship as
 * BUNDLED_AGENTS, which stay improvable across upgrades. A file written to
 * `~/.gg/agents` never would.
 *
 * Exported for tests: `getAppPaths()` resolves `os.homedir()` inside gg-core's
 * prebuilt dist, which vitest does not transform, so a homedir spy would not
 * apply and the test would operate on the developer's real `~/.gg`. Tests must
 * call this with an explicit temp directory instead of going via ensureAppDirs.
 */
export async function seedDefaultAgents(agentsDir: string): Promise<void> {
  await removeShadowingSeededAgents(agentsDir);
}

/**
 * Delete agent files that are byte-identical to one we seeded ourselves.
 *
 * Anything else — a user-authored agent of the same name, or a seeded file the
 * user has since edited — is left untouched. That precedence is the point:
 * user agents beat bundled ones.
 */
async function removeShadowingSeededAgents(agentsDir: string): Promise<void> {
  for (const [filename, seededHashes] of Object.entries(SHADOWING_SEEDED_AGENT_HASHES)) {
    const filePath = path.join(agentsDir, filename);
    try {
      const content = await fs.readFile(filePath, "utf-8");
      const hash = createHash("sha256").update(content, "utf-8").digest("hex");
      if (seededHashes.includes(hash)) await fs.rm(filePath, { force: true });
    } catch {
      // Missing or unreadable — nothing to clean up.
    }
  }
}

/**
 * find-skills was seeded into `~/.gg/skills` by earlier versions and is no
 * longer shipped (nor is the /setup-skills command that drove it). Delete a
 * copy only when it is byte-identical to one we wrote, so a user who edited
 * it keeps theirs. Hashes cover every variant in `git log -p -- src/config.ts`.
 */
export const RETIRED_SEEDED_SKILL_HASHES: Record<string, readonly string[]> = {
  "find-skills.md": [
    "352d5d6a76a2c8f3c35932ea368e221e7dd9760e25124eb4b38c59ddce8465de",
    "e098327dbd76b56d25a54974819d4be7a73ee86c9109c9dbe2c12f46c0f136b8",
  ],
};

/**
 * Exported for tests, which must pass a temp dir (see seedDefaultAgents for
 * why going through ensureAppDirs would touch the real `~/.gg`).
 */
export async function removeRetiredSeededSkills(skillsDir: string): Promise<void> {
  for (const [filename, seededHashes] of Object.entries(RETIRED_SEEDED_SKILL_HASHES)) {
    const filePath = path.join(skillsDir, filename);
    try {
      const content = await fs.readFile(filePath, "utf-8");
      const hash = createHash("sha256").update(content, "utf-8").digest("hex");
      if (seededHashes.includes(hash)) await fs.rm(filePath, { force: true });
    } catch {
      // Missing or unreadable — nothing to clean up.
    }
  }
}
