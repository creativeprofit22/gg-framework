import os from "node:os";
import fs from "node:fs";
import path from "node:path";

// Machine profile and concurrency defaults (docs/harness-checks.md#machine-profile-defaults).

export interface MachineProbe {
  availableParallelism: () => number;
  cpus: () => readonly unknown[];
  totalmem: () => number;
  freemem: () => number;
  platform: () => NodeJS.Platform;
  arch: () => string;
  /** `/proc/cpuinfo` text on Linux; null when unavailable. */
  readCpuInfo?: () => string | null;
}

export interface MachineFacts {
  logicalCores: number;
  physicalCores: number;
  physicalSource: "reported" | "estimated";
  totalMemBytes: number;
  freeMemBytes: number;
  platform: NodeJS.Platform;
  arch: string;
}

export interface ConcurrencySettings {
  /** Settings `concurrencyBudget`; 0 = derive from the machine. */
  budget: number;
  /** Settings `concurrencyDefaults`; false = set no env defaults. */
  defaults: boolean;
  /** Settings `heavyCheckLimit`; 0 = no limit. */
  heavyCheckLimit: number;
}

export const DEFAULT_CONCURRENCY_SETTINGS: ConcurrencySettings = Object.freeze({
  budget: 0,
  defaults: true,
  heavyCheckLimit: 1,
});

export interface ConcurrencyProfile {
  budget: number;
  workspaceConcurrency: number;
  cpuBudget: number;
  memBudget: number;
  /** True when the `concurrencyBudget` setting chose the budget. */
  overridden: boolean;
  facts: MachineFacts;
}

const GIB = 1024 ** 3;
/** LibreChat-style memory cap: one heavy worker per 2 GiB of total memory. */
const MEM_PER_WORKER_BYTES = 2 * GIB;
/** pnpm's own default ceiling (min(4, cores)); Tianshu uses the same. */
const MAX_WORKSPACE_CONCURRENCY = 4;
/** Each package's test runner fans out again, so assume two busy workers per package. */
const WORKERS_PER_PACKAGE = 2;

export const localMachineProbe: MachineProbe = {
  availableParallelism: () =>
    typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length,
  cpus: () => os.cpus(),
  totalmem: () => os.totalmem(),
  freemem: () => os.freemem(),
  platform: () => process.platform,
  arch: () => process.arch,
  readCpuInfo: () => {
    if (process.platform !== "linux") return null;
    try {
      return fs.readFileSync("/proc/cpuinfo", "utf-8");
    } catch {
      return null;
    }
  },
};

/** Unique (physical id, core id) pairs; null when the text has none. */
function countCpuInfoCores(text: string): number | null {
  const pairs = new Set<string>();
  for (const block of text.split(/\n\s*\n/)) {
    const physical = /^physical id\s*:\s*(\d+)/m.exec(block)?.[1];
    const core = /^core id\s*:\s*(\d+)/m.exec(block)?.[1];
    if (physical !== undefined && core !== undefined) pairs.add(`${physical}:${core}`);
  }
  return pairs.size > 0 ? pairs.size : null;
}

export function readMachineFacts(probe: MachineProbe = localMachineProbe): MachineFacts {
  const logicalCores = Math.max(1, probe.availableParallelism() || probe.cpus().length || 1);
  const platform = probe.platform();
  const arch = probe.arch();
  const cpuInfo = platform === "linux" ? (probe.readCpuInfo?.() ?? null) : null;
  const reported = cpuInfo ? countCpuInfoCores(cpuInfo) : null;
  let physicalCores: number;
  if (reported !== null) {
    physicalCores = Math.min(reported, logicalCores);
  } else if ((arch === "x64" || arch === "ia32") && logicalCores >= 4 && logicalCores % 2 === 0) {
    // Assumes hyper-threading; wrong on non-SMT and hybrid parts, hence "estimated".
    physicalCores = logicalCores / 2;
  } else {
    physicalCores = logicalCores;
  }
  return {
    logicalCores,
    physicalCores,
    physicalSource: reported !== null ? "reported" : "estimated",
    totalMemBytes: probe.totalmem(),
    freeMemBytes: probe.freemem(),
    platform,
    arch,
  };
}

/** budget = min(physical cores, total GiB / 2), or the setting when above 0. */
export function deriveConcurrencyBudget(facts: MachineFacts, override = 0): ConcurrencyProfile {
  const cpuBudget = Math.max(1, facts.physicalCores);
  const memBudget = Math.max(1, Math.floor(facts.totalMemBytes / MEM_PER_WORKER_BYTES));
  const overridden = Number.isInteger(override) && override > 0;
  const budget = overridden ? override : Math.min(cpuBudget, memBudget);
  const workspaceConcurrency = Math.min(
    MAX_WORKSPACE_CONCURRENCY,
    Math.max(1, Math.floor(budget / WORKERS_PER_PACKAGE)),
  );
  return { budget, workspaceConcurrency, cpuBudget, memBudget, overridden, facts };
}

/** e.g. `budget 6 (12 threads, ~6 cores est., 24 GiB)`. */
export function formatBudgetSummary(profile: ConcurrencyProfile): string {
  const { facts } = profile;
  const cores =
    facts.physicalSource === "reported"
      ? `${facts.physicalCores} cores`
      : `~${facts.physicalCores} cores est.`;
  const memGiB = Math.round(facts.totalMemBytes / GIB);
  const source = profile.overridden ? "setting; " : "";
  return `budget ${profile.budget} (${source}${facts.logicalCores} threads, ${cores}, ${memGiB} GiB)`;
}

/** Budget summary for this machine, as the bash tool would apply it. */
export function describeLocalBudget(override = 0, probe: MachineProbe = localMachineProbe): string {
  return formatBudgetSummary(deriveConcurrencyBudget(readMachineFacts(probe), override));
}

// ── Environment defaults ───────────────────────────────────

type ManagedKey = "cargoJobs" | "rustTestThreads" | "workspaceConcurrency";

interface ManagedSetting {
  key: ManagedKey;
  label: string;
  /** Env names written when applying the default. */
  names: readonly string[];
  /** Matches any env name that sets this logical value. */
  matches: (name: string, platform: NodeJS.Platform) => boolean;
  /** A command flag or inline assignment that sets it for this command. */
  commandSets: RegExp;
  value: (profile: ConcurrencyProfile) => number;
}

const exactName =
  (target: string) =>
  (name: string, platform: NodeJS.Platform): boolean =>
    platform === "win32" ? name.toUpperCase() === target : name === target;

const MANAGED: readonly ManagedSetting[] = [
  {
    key: "cargoJobs",
    label: "CARGO_BUILD_JOBS",
    names: ["CARGO_BUILD_JOBS"],
    matches: exactName("CARGO_BUILD_JOBS"),
    commandSets: /(?:^|[\s;&|(])CARGO_BUILD_JOBS=|\bcargo\b[^;&|\n]*\s(?:-j\s*\d|--jobs\b)/,
    value: (profile) => profile.budget,
  },
  {
    key: "rustTestThreads",
    label: "RUST_TEST_THREADS",
    names: ["RUST_TEST_THREADS"],
    matches: exactName("RUST_TEST_THREADS"),
    commandSets: /(?:^|[\s;&|(])RUST_TEST_THREADS=|--test-threads\b/,
    value: (profile) => profile.budget,
  },
  {
    key: "workspaceConcurrency",
    label: "pnpm workspace-concurrency",
    // pnpm 10 reads npm_config_*, pnpm 11 reads pnpm_config_* (both case-insensitive).
    names: ["npm_config_workspace_concurrency", "pnpm_config_workspace_concurrency"],
    matches: (name) => /^p?npm_config_workspace[-_]concurrency$/i.test(name),
    commandSets:
      /(?:^|[\s;&|(])p?npm_config_workspace[-_]concurrency=|--workspace-concurrency\b|--workspace-concurrency=/i,
    value: (profile) => profile.workspaceConcurrency,
  },
];

/** Test-runner worker variables passed through from the user, never set. */
const PASS_THROUGH_ONLY = [
  "VITEST_MAX_WORKERS",
  "VITEST_MIN_WORKERS",
  "JEST_WORKERS",
  "JEST_MAX_WORKERS",
];

export interface ProjectConcurrencyConfig {
  /** Managed setting → the file that sets it. */
  found: Partial<Record<ManagedKey, string>>;
}

export interface AppliedDefault {
  name: string;
  label: string;
  value: string;
}

export interface KeptValue {
  label: string;
  source: "user" | "project" | "command";
  /** User value or project file. */
  detail: string | null;
}

export interface ConcurrencyEnvResult {
  env: Record<string, string>;
  applied: AppliedDefault[];
  kept: KeptValue[];
  profile: ConcurrencyProfile;
  summary: string;
}

export interface ResolveConcurrencyEnvArgs {
  profile: ConcurrencyProfile;
  sourceEnv: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  projectConfig?: ProjectConcurrencyConfig;
  command?: string;
}

/**
 * Env for one command: user values pass through unchanged, project config and
 * command flags are left alone, everything else gets the profile default.
 */
export function resolveConcurrencyEnv({
  profile,
  sourceEnv,
  platform,
  projectConfig,
  command = "",
}: ResolveConcurrencyEnvArgs): ConcurrencyEnvResult {
  const env: Record<string, string> = {};
  const applied: AppliedDefault[] = [];
  const kept: KeptValue[] = [];
  const sourceNames = Object.keys(sourceEnv).sort();
  for (const setting of MANAGED) {
    const userNames = sourceNames.filter(
      (name) => setting.matches(name, platform) && sourceEnv[name] !== undefined,
    );
    if (userNames.length > 0) {
      for (const name of userNames) env[name] = String(sourceEnv[name]);
      kept.push({
        label: setting.label,
        source: "user",
        detail: String(sourceEnv[userNames[0]!]),
      });
      continue;
    }
    if (setting.commandSets.test(command)) {
      kept.push({ label: setting.label, source: "command", detail: null });
      continue;
    }
    const file = projectConfig?.found[setting.key];
    if (file) {
      kept.push({ label: setting.label, source: "project", detail: file });
      continue;
    }
    const value = String(setting.value(profile));
    for (const name of setting.names) env[name] = value;
    applied.push({ name: setting.names[0]!, label: setting.label, value });
  }
  for (const target of PASS_THROUGH_ONLY) {
    for (const name of sourceNames) {
      if (exactName(target)(name, platform) && sourceEnv[name] !== undefined) {
        env[name] = String(sourceEnv[name]);
      }
    }
  }
  return { env, applied, kept, profile, summary: formatBudgetSummary(profile) };
}

const INVOKES_BUILD_TOOL = /(?:^|[\s;&|(])(?:cargo|pnpm|npm|npx|yarn|bun|bunx|tauri)(?=\s|$)/;

/** One result line naming what was set and what was left alone; "" when irrelevant. */
export function formatConcurrencyLine(result: ConcurrencyEnvResult, command: string): string {
  if (!INVOKES_BUILD_TOOL.test(command)) return "";
  if (result.applied.length === 0 && result.kept.length === 0) return "";
  const applied =
    result.applied.length > 0
      ? result.applied.map((entry) => `${entry.label}=${entry.value}`).join(", ")
      : "none applied";
  const group = (source: KeptValue["source"], title: string): string => {
    const items = result.kept.filter((entry) => entry.source === source);
    if (items.length === 0) return "";
    const text = items
      .map((entry) =>
        source === "user"
          ? `${entry.label}=${entry.detail ?? ""}`
          : source === "project"
            ? `${entry.label} (${entry.detail ?? "config"})`
            : entry.label,
      )
      .join(", ");
    return `; ${title}: ${text}`;
  };
  return (
    `[Concurrency defaults (budget ${result.profile.budget}): ${applied}` +
    group("user", "kept yours") +
    group("project", "kept project config") +
    group("command", "set by the command") +
    ".]"
  );
}

const SCOPED_PROGRAM = /(^|[;&|(]\s*|\n\s*)(cargo|pnpm|npm|npx|yarn|bun|bunx|tauri)(?=\s|$)/g;

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Prefix build-tool invocations for a long-lived POSIX shell whose environment
 * was fixed at start. `${NAME:-value}` keeps anything the shell session exported.
 */
export function scopeConcurrency(command: string, result: ConcurrencyEnvResult | null): string {
  if (!result) return command;
  const entries = Object.entries(result.env).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return command;
  const workspaceNames = new Set(
    MANAGED.find((setting) => setting.key === "workspaceConcurrency")?.names,
  );
  const assignments = entries
    .filter(([name]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
    .map(([name, value]) => {
      const quoted = shellQuote(value);
      if (workspaceNames.has(name)) {
        // Either spelling exported in the shell wins for both pnpm generations.
        const other = [...workspaceNames].find((candidate) => candidate !== name) ?? name;
        return `${name}="\${${name}:-\${${other}:-${quoted}}}"`;
      }
      return `${name}="\${${name}:-${quoted}}"`;
    })
    .join(" ");
  if (!assignments) return command;
  return command.replace(
    SCOPED_PROGRAM,
    (_match, pre: string, prog: string) => `${pre}${assignments} ${prog}`,
  );
}

// ── Project config detection ───────────────────────────────

export type ReadTextFile = (filePath: string) => Promise<string | null>;

export const readTextFileOrNull: ReadTextFile = async (filePath) => {
  try {
    return await fs.promises.readFile(filePath, "utf-8");
  } catch {
    return null;
  }
};

/** Each directory and its ancestors, nearest first, without duplicates. */
function ancestorsOf(dirs: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const start of dirs) {
    let current = path.resolve(start);
    for (;;) {
      const key = process.platform === "win32" ? current.toLowerCase() : current;
      if (!seen.has(key)) {
        seen.add(key);
        out.push(current);
      }
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  return out;
}

/** The literal target of a leading `cd <path> &&`, resolved against `cwd`. */
export function leadingCdTarget(command: string, cwd: string): string | null {
  const match = /^\s*cd\s+(?:"([^"$`]+)"|'([^']+)'|([^\s;&|<>()$`'"]+))\s*&&/.exec(command);
  const target = match?.[1] ?? match?.[2] ?? match?.[3];
  if (!target || target.startsWith("~")) return null;
  return path.resolve(cwd, target);
}

export interface DetectProjectConfigArgs {
  dirs: readonly string[];
  homeDir: string;
  cargoHome?: string | undefined;
  readFile?: ReadTextFile;
}

/** Text scan of cargo, npm and pnpm config files that set a managed value. */
export async function detectProjectConcurrencyConfig({
  dirs,
  homeDir,
  cargoHome,
  readFile = readTextFileOrNull,
}: DetectProjectConfigArgs): Promise<ProjectConcurrencyConfig> {
  const ancestors = ancestorsOf(dirs);
  const cargoFiles = [
    ...ancestors.flatMap((dir) => [
      path.join(dir, ".cargo", "config.toml"),
      path.join(dir, ".cargo", "config"),
    ]),
    path.join(cargoHome ?? path.join(homeDir, ".cargo"), "config.toml"),
  ];
  const npmrcFiles = [
    ...ancestors.map((dir) => path.join(dir, ".npmrc")),
    path.join(homeDir, ".npmrc"),
  ];
  const workspaceFiles = ancestors.map((dir) => path.join(dir, "pnpm-workspace.yaml"));
  const unique = (files: string[]): string[] => [...new Set(files)];
  const read = async (files: string[]): Promise<Array<[string, string]>> => {
    const texts = await Promise.all(
      unique(files).map(async (file) => [file, await readFile(file)] as const),
    );
    return texts.filter((entry): entry is [string, string] => entry[1] !== null);
  };
  const [cargoTexts, npmrcTexts, workspaceTexts] = await Promise.all([
    read(cargoFiles),
    read(npmrcFiles),
    read(workspaceFiles),
  ]);
  const found: ProjectConcurrencyConfig["found"] = {};
  const first = (texts: Array<[string, string]>, pattern: RegExp): string | undefined =>
    texts.find(([, text]) => pattern.test(text))?.[0];
  const cargoJobs = first(cargoTexts, /^\s*jobs\s*=/m);
  if (cargoJobs) found.cargoJobs = cargoJobs;
  const testThreads = first(cargoTexts, /\bRUST_TEST_THREADS\b/);
  if (testThreads) found.rustTestThreads = testThreads;
  const workspace =
    first(npmrcTexts, /^\s*workspace-concurrency\s*=/m) ??
    first(workspaceTexts, /^\s*workspaceConcurrency\s*:/m);
  if (workspace) found.workspaceConcurrency = workspace;
  return { found };
}

// ── Heavy checks ───────────────────────────────────────────

/** Splits on shell separators; quoting is ignored (a miss only skips queueing). */
function segments(command: string): string[][] {
  return command
    .split(/&&|\|\||[;|\n]/)
    .map((segment) => segment.trim().split(/\s+/).filter(Boolean))
    .map((tokens) => {
      let index = 0;
      while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index]!)) index += 1;
      return tokens.slice(index);
    })
    .filter((tokens) => tokens.length > 0);
}

const PACKAGE_RUNNERS = new Set(["pnpm", "npm", "yarn", "bun"]);
const HEAVY_SCRIPTS = new Set(["test", "build"]);
const SCOPING_FLAGS = new Set(["--filter", "-F", "--dir", "-C", "--prefix", "--workspace", "-w"]);
const CARGO_VALUE_FLAGS = new Set([
  "--features",
  "-F",
  "--target",
  "-j",
  "--jobs",
  "--manifest-path",
  "--profile",
  "--test-threads",
  "--color",
  "--message-format",
  "--target-dir",
  "--config",
  "-Z",
]);
const CARGO_SCOPING_FLAGS = new Set([
  "-p",
  "--package",
  "--test",
  "--bin",
  "--example",
  "--bench",
  "--exclude",
]);

function isScoping(token: string): boolean {
  const name = token.split("=")[0]!;
  return SCOPING_FLAGS.has(name) || name.startsWith("--filter");
}

function packageRunnerHeavy(tokens: string[]): boolean {
  const recursive = tokens.some((token) => token === "-r" || token === "--recursive");
  if (tokens.slice(1).some(isScoping)) return false;
  let index = 1;
  while (index < tokens.length && tokens[index]!.startsWith("-")) index += 1;
  if (tokens[index] === "run") index += 1;
  else if (recursive && tokens[0] === "pnpm") {
    // `pnpm -r --if-present test`: the script is the first bare word.
    while (index < tokens.length && tokens[index]!.startsWith("-")) index += 1;
  }
  const script = tokens[index];
  if (!script || !HEAVY_SCRIPTS.has(script)) return false;
  // File or name arguments narrow the run; flags (and flags after `--`) do not.
  return tokens.slice(index + 1).every((token) => token.startsWith("-"));
}

function cargoHeavy(tokens: string[]): boolean {
  let index = 1;
  while (index < tokens.length && tokens[index]!.startsWith("+")) index += 1;
  const sub = tokens[index];
  if (sub === "nextest") {
    if (tokens[index + 1] !== "run") return false;
    index += 2;
  } else if (sub === "test" || sub === "build" || sub === "t" || sub === "b") {
    index += 1;
  } else {
    return false;
  }
  for (let at = index; at < tokens.length; at += 1) {
    const token = tokens[at]!;
    const name = token.split("=")[0]!;
    if (CARGO_SCOPING_FLAGS.has(name)) return false;
    if (token === "--") continue;
    if (CARGO_VALUE_FLAGS.has(token)) {
      at += 1;
      continue;
    }
    if (!token.startsWith("-")) return false; // a test-name filter
  }
  return true;
}

/** A whole-workspace test or build; conservative, since a miss only skips queueing. */
export function classifyHeavyCheck(command: string): { label: string } | null {
  for (const tokens of segments(command)) {
    const program = tokens[0]!.replace(/\.(?:cmd|exe)$/i, "");
    const label = tokens.join(" ");
    if (tokens.some((token, at) => token === "tauri" && tokens[at + 1] === "build")) {
      return { label };
    }
    if (PACKAGE_RUNNERS.has(program) && packageRunnerHeavy([program, ...tokens.slice(1)])) {
      return { label };
    }
    if (program === "cargo" && cargoHeavy(tokens)) return { label };
  }
  return null;
}

export interface HeavySlotLease {
  readonly label: string;
  /** Names the background task holding this slot, for refusal guidance. */
  attachTask(taskId: string): void;
  /** Idempotent. */
  release(): void;
}

export type HeavySlotResult =
  | { ok: true; lease: HeavySlotLease; waitedMs: number }
  | { ok: false; aborted: boolean; message: string };

export interface HeavySlotClock {
  now: () => number;
  setTimer: (callback: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
}

export interface AcquireHeavySlotArgs {
  label: string;
  owner: string;
  limit: number;
  signal?: AbortSignal;
  onWait?: (message: string) => void;
}

interface Holder {
  label: string;
  owner: string;
  startedAt: number;
  taskId: string | null;
}

interface Waiter {
  owner: string;
  label: string;
  limit: number;
  grant: () => void;
}

export const HEAVY_SLOT_WAIT_LIMIT_MS = 15 * 60_000;

const defaultClock: HeavySlotClock = {
  now: () => Date.now(),
  setTimer: (callback, ms) => {
    const timer = setTimeout(callback, ms);
    timer.unref?.();
    return timer;
  },
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

function formatAgo(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return seconds < 120 ? `${seconds}s` : `${Math.round(seconds / 60)}m`;
}

/**
 * Daemon-wide slots for whole-workspace tests and builds. Never kills: a busy
 * slot held by the same session refuses with guidance, one held elsewhere
 * queues first-in-first-out until it frees or the wait limit passes.
 */
export class HeavyCheckSlots {
  private readonly holders = new Set<Holder>();
  private readonly waiters: Waiter[] = [];
  private readonly clock: HeavySlotClock;
  private readonly waitLimitMs: number;

  constructor(options: { clock?: HeavySlotClock; waitLimitMs?: number } = {}) {
    this.clock = options.clock ?? defaultClock;
    this.waitLimitMs = options.waitLimitMs ?? HEAVY_SLOT_WAIT_LIMIT_MS;
  }

  /** Slots currently held (for tests and diagnostics). */
  get held(): number {
    return this.holders.size;
  }

  async acquire({
    label,
    owner,
    limit,
    signal,
    onWait,
  }: AcquireHeavySlotArgs): Promise<HeavySlotResult> {
    if (!(limit > 0)) {
      return { ok: true, waitedMs: 0, lease: { label, attachTask: () => {}, release: () => {} } };
    }
    if (signal?.aborted) return { ok: false, aborted: true, message: "cancelled" };
    if (this.holders.size < limit && this.waiters.length === 0) {
      return { ok: true, waitedMs: 0, lease: this.grant(label, owner) };
    }
    const own = [...this.holders].find((holder) => holder.owner === owner);
    if (own && this.holders.size >= limit) {
      const where = own.taskId
        ? `is already running as task ${own.taskId}; wait with task_output id="${own.taskId}" wait_ms, or stop it with task_stop`
        : "is already running in this session; let it finish first";
      return {
        ok: false,
        aborted: false,
        message: `\`${own.label}\` ${where}. Only ${limit} full test or build may run at once (setting heavyCheckLimit). Nothing was run.`,
      };
    }
    const blocker = [...this.holders][0];
    const startedAt = this.clock.now();
    onWait?.(
      blocker
        ? `Waiting for another window's \`${blocker.label}\` (started ${formatAgo(startedAt - blocker.startedAt)} ago) to finish…`
        : "Waiting for a queued full test or build in another window to finish…",
    );
    return await new Promise<HeavySlotResult>((resolve) => {
      let done = false;
      const finish = (result: HeavySlotResult): void => {
        if (done) return;
        done = true;
        this.clock.clearTimer(timer);
        signal?.removeEventListener("abort", onAbort);
        const at = this.waiters.indexOf(waiter);
        if (at >= 0) this.waiters.splice(at, 1);
        resolve(result);
        // A departing waiter may have been the head blocking the others.
        this.pump();
      };
      const waiter: Waiter = {
        owner,
        label,
        limit,
        grant: () =>
          finish({
            ok: true,
            waitedMs: this.clock.now() - startedAt,
            lease: this.grant(label, owner),
          }),
      };
      const onAbort = (): void => finish({ ok: false, aborted: true, message: "cancelled" });
      const timer = this.clock.setTimer(() => {
        const still = [...this.holders][0];
        finish({
          ok: false,
          aborted: false,
          message:
            `Waited ${formatAgo(this.waitLimitMs)} for another window's ` +
            `\`${still?.label ?? "full test or build"}\` to finish; it is still running. ` +
            "Nothing was run. Run a narrower check, or retry once it finishes.",
        });
      }, this.waitLimitMs);
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiters.push(waiter);
      this.pump();
    });
  }

  private grant(label: string, owner: string): HeavySlotLease {
    const holder: Holder = { label, owner, startedAt: this.clock.now(), taskId: null };
    this.holders.add(holder);
    let released = false;
    return {
      label,
      attachTask: (taskId) => {
        holder.taskId = taskId;
      },
      release: () => {
        if (released) return;
        released = true;
        this.holders.delete(holder);
        this.pump();
      },
    };
  }

  private pump(): void {
    const head = this.waiters[0];
    if (head && this.holders.size < head.limit) head.grant();
  }
}
