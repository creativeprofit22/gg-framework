import fs from "node:fs/promises";
import { z } from "zod";
import { getAppPaths } from "../config.js";

// ── Settings Schema ────────────────────────────────────────

const SettingsSchema = z.object({
  autoCompact: z.boolean().default(true),
  compactThreshold: z.number().min(0.1).max(1.0).default(0.85),
  defaultProvider: z
    .enum([
      "anthropic",
      "openai",
      "azure",
      "gemini",
      "glm",
      "moonshot",
      "minimax",
      "xiaomi",
      "deepseek",
      "openrouter",
      "sakana",
      "xai",
    ])
    .default("anthropic"),
  defaultModel: z.string().optional(),
  maxTokens: z.number().int().min(256).default(16384),
  thinkingEnabled: z.boolean().default(false),
  thinkingLevel: z.enum(["low", "medium", "high", "xhigh", "max", "ultra"]).optional(),
  theme: z
    .enum([
      "auto",
      "dark",
      "light",
      "dark-ansi",
      "light-ansi",
      "dark-daltonized",
      "light-daltonized",
    ])
    .default("auto"),
  showTokenUsage: z.boolean().default(true),
  idealReviewEnabled: z.boolean().default(true),
  /** Append LSP diagnostics to edit/write tool results. */
  lspDiagnostics: z.boolean().default(true),
  /** Allow write/edit outside the workspace (cwd, tmpdir, ~/.gg). Off by
   *  default — outside writes return a guard error asking for user approval. */
  allowOutsideWorkspaceWrites: z.boolean().default(false),
  /** Network egress policy. "allowlist" enforces `networkAllow` on the agent's
   *  own web-fetch/web-search calls and blocks recognised network commands in
   *  bash. NOT an OS sandbox — a determined process can still reach the network
   *  (see core/network-guard.ts). Default "off" changes nothing. */
  networkMode: z.enum(["off", "allowlist"]).default("off"),
  /** Hosts allowed when networkMode is "allowlist". A leading `*.` wildcard
   *  matches subdomains (`*.github.com`). */
  networkAllow: z.array(z.string()).default([]),
  /**
   * OS-enforced command isolation for bash (filesystem + network), via
   * sandbox-runtime. `auto` isolates wherever the platform supports it and
   * degrades with a warning where it does not; `workspace` additionally fails
   * closed on hosts that cannot isolate.
   *
   * Opt-in, and deliberately so. Verified day-one breakage in the upstream
   * sandbox that we cannot fix from here:
   *   • Linux: pipes and redirections fail under seccomp — `echo hi | grep hi`
   *     returns "Permission denied" on /proc/self/fd/3 (upstream #261).
   *   • macOS: git over SSH fails the SOCKS handshake, because the ProxyCommand
   *     uses `nc`, which cannot do SOCKS5 auth (upstream sandbox-utils.ts).
   *   • `git config --global` is refused: ~/.gitconfig is a mandatory upstream
   *     write protection with no opt-out.
   *   • Corporate TLS interception and private registries need extra config.
   * Enabling it by default would break `git push` and piped commands for a
   * large share of users immediately after an update, with no obvious cause.
   */
  sandboxMode: z.enum(["auto", "workspace", "off"]).default("off"),
  /** Defer MCP tool schemas out of the prompt until discovered via tool_search.
   *  Cuts ~8k tokens/cache-miss turn with two MCP servers connected. */
  deferredMcpTools: z.boolean().default(true),
  /** Defer rarely reached BUILT-IN tool schemas the same way, leaving a one-line
   *  capability hint in the prompt that `tool_search` expands on demand. Trades
   *  per-request tokens against how reliably the model still finds the tool. */
  deferredBuiltinTools: z.boolean().default(true),
  /** Use the `rg` binary for `grep` content search when it is on PATH, falling
   *  back to the in-process scanner otherwise. */
  grepUseRipgrep: z.boolean().default(true),
  /** Opt into the 2026-07-28 MCP protocol revision. When on, a connect probes
   *  with `server/discover` and falls back to the 2025 `initialize` handshake,
   *  so a legacy server still connects. Off by default: the probe costs a round
   *  trip, and a legacy stdio server that ignores it pays the probe timeout. */
  mcpModernProtocol: z.boolean().default(false),
  /** Max concurrent subagents per resolved child model. Unset = only the
   *  global limit applies. Can only REDUCE concurrency, never raise it. */
  subagentMaxPerModel: z.number().int().min(1).max(4).optional(),
  enabledTools: z.array(z.string()).optional(),
  /** Delete session transcripts older than this many days at startup. 0 disables pruning. */
  sessionRetentionDays: z.number().int().min(0).default(30),
  /** Speed optimization profile.
   *  - "baseline": 5-min cache TTL, no pre-warm
   *  - "optimized": 1-h cache TTL, cache pre-warming on first prompt (default) */
  speedProfile: z.enum(["baseline", "optimized"]).default("optimized"),
});

export type Settings = z.infer<typeof SettingsSchema>;

export const DEFAULT_SETTINGS: Settings = {
  autoCompact: true,
  compactThreshold: 0.85,
  defaultProvider: "anthropic",
  maxTokens: 16384,
  thinkingEnabled: false,
  theme: "auto",
  showTokenUsage: true,
  idealReviewEnabled: true,
  lspDiagnostics: true,
  allowOutsideWorkspaceWrites: false,
  networkMode: "off",
  networkAllow: [],
  sandboxMode: "off",
  deferredMcpTools: true,
  deferredBuiltinTools: true,
  grepUseRipgrep: true,
  mcpModernProtocol: false,
  sessionRetentionDays: 30,
  speedProfile: "optimized",
};

// ── Settings Manager ───────────────────────────────────────

export class SettingsManager {
  private settings: Settings = { ...DEFAULT_SETTINGS };
  private filePath: string;
  private loaded = false;

  constructor(filePath?: string) {
    this.filePath = filePath ?? getAppPaths().settingsFile;
  }

  async load(): Promise<Settings> {
    try {
      const content = await fs.readFile(this.filePath, "utf-8");
      const raw = JSON.parse(content);
      // Merge with defaults so new fields get default values
      this.settings = SettingsSchema.parse({ ...DEFAULT_SETTINGS, ...raw });
    } catch {
      this.settings = { ...DEFAULT_SETTINGS };
    }
    this.loaded = true;
    return this.settings;
  }

  async save(): Promise<void> {
    const content = JSON.stringify(this.settings, null, 2);
    await fs.writeFile(this.filePath, content, "utf-8");
  }

  get<K extends keyof Settings>(key: K): Settings[K] {
    return this.settings[key];
  }

  async set<K extends keyof Settings>(key: K, value: Settings[K]): Promise<void> {
    this.settings[key] = value;
    await this.save();
  }

  getAll(): Settings {
    return { ...this.settings };
  }
}
