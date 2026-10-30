// Project verify-plan contract: how a project tells the harness its checks.
// Pure validators only (no I/O, no Node imports); see docs/harness-checks.md.

export const VERIFY_PLAN_VERSION = 1;
export const VERIFY_PLAN_MAX_BYTES = 256 * 1024;
export const VERIFY_PLAN_DESCRIPTOR_MAX_BYTES = 8 * 1024;
export const VERIFY_PLAN_DESCRIPTOR_PATH = ".gg/verify-plan.json";
export const VERIFY_PLAN_LIMITS = {
  gates: 64,
  advice: 64,
  argv: 64,
  argLength: 1024,
  pathLength: 512,
  covers: 2000,
  protectedPaths: 200,
  reasonLength: 1024,
  lastRunLength: 128,
  quietBudgetSeconds: 3600,
} as const;
export const VERIFY_PLAN_COMMAND_LIMITS = {
  timeoutMs: 30_000,
  maxOutputBytes: VERIFY_PLAN_MAX_BYTES,
} as const;

export type VerifyPlanMode = "changed" | "full";
export type VerifyPlanFormat = "gg-verify-plan-v1" | "supa-plan-v1";

export interface VerifyGate {
  id: string;
  argv: string[];
  /** Repo-relative working directory; "." is the repository root. */
  cwd: string;
  /** Repo-relative paths or globs whose content this gate checks. */
  covers: string[];
  /** sha256 hex reported by the project, or null. */
  fingerprint: string | null;
  quietBudgetSeconds: number | null;
  protectedPaths: string[];
}

/** A pass the project says it reused. Advice only: never verification evidence. */
export interface VerifyPlanAdvice {
  gateId: string;
  kind: "reused-pass";
  reason: string;
  lastRun: string | null;
}

export interface VerifyPlan {
  version: typeof VERIFY_PLAN_VERSION;
  mode: VerifyPlanMode;
  gates: VerifyGate[];
  advice: VerifyPlanAdvice[];
}

export interface VerifyPlanDescriptor {
  version: typeof VERIFY_PLAN_VERSION;
  command: { argv: string[]; cwd: string };
  format: VerifyPlanFormat;
}

export type VerifyPlanParseResult = { ok: true; plan: VerifyPlan } | { ok: false; reason: string };
export type VerifyPlanDescriptorParseResult =
  { ok: true; descriptor: VerifyPlanDescriptor } | { ok: false; reason: string };

export type VerifyPlanSourceDecision =
  { kind: "run"; descriptor: VerifyPlanDescriptor } | { kind: "heuristics"; reason: string };

export type VerifyPlanOutcome =
  { kind: "plan"; plan: VerifyPlan } | { kind: "heuristics"; reason: string };

export const VERIFY_PLAN_HEURISTICS_REASONS = {
  untrusted: "project is not trusted, so its plan command is not run",
  noDescriptor: `no ${VERIFY_PLAN_DESCRIPTOR_PATH} descriptor`,
  badDescriptor: "bad verify-plan descriptor",
  timedOut: "plan command timed out",
  nonZeroExit: "plan command failed",
  oversize: `plan output is larger than ${VERIFY_PLAN_MAX_BYTES} bytes`,
  badPlan: "plan output is not a valid plan",
} as const;

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "cmd", "powershell", "pwsh"]);
const GATE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const FINGERPRINT = /^[a-f0-9]{64}$/;
const FORMATS: readonly VerifyPlanFormat[] = ["gg-verify-plan-v1", "supa-plan-v1"];

type Check<T> = { ok: true; value: T } | { ok: false; reason: string };
const fail = (reason: string): { ok: false; reason: string } => ({ ok: false, reason });
const ok = <T>(value: T): { ok: true; value: T } => ({ ok: true, value });

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function unknownKey(value: Record<string, unknown>, allowed: readonly string[]): string | null {
  return Object.keys(value).find((key) => !allowed.includes(key)) ?? null;
}

function describe(value: unknown): string {
  if (value === undefined) return "missing";
  const text = typeof value === "string" ? JSON.stringify(value) : String(JSON.stringify(value));
  return text.length > 32 ? `${text.slice(0, 32)}…` : text;
}

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

function checkVersion(value: Record<string, unknown>, label: string): string | null {
  return value.version === VERIFY_PLAN_VERSION
    ? null
    : `unsupported ${label} version ${describe(value.version)}; expected ${VERIFY_PLAN_VERSION}`;
}

function checkArgv(value: unknown, at: string): Check<string[]> {
  if (typeof value === "string")
    return fail(`${at}: argv must be an array, shell strings are not accepted`);
  if (!Array.isArray(value) || value.length === 0)
    return fail(`${at}: argv must be a non-empty array`);
  if (value.length > VERIFY_PLAN_LIMITS.argv)
    return fail(`${at}: argv has more than ${VERIFY_PLAN_LIMITS.argv} entries`);
  for (const [index, arg] of value.entries()) {
    if (typeof arg !== "string" || arg.length === 0 || arg.length > VERIFY_PLAN_LIMITS.argLength)
      return fail(`${at}[${index}]: must be a string of 1-${VERIFY_PLAN_LIMITS.argLength} chars`);
    if (/[\0\r\n]/.test(arg)) return fail(`${at}[${index}]: contains NUL or a newline`);
  }
  const argv = value as string[];
  const program = (argv[0] ?? "")
    .split(/[/\\]/)
    .pop()
    ?.toLowerCase()
    .replace(/\.exe$/, "");
  if (program !== undefined && SHELLS.has(program))
    return fail(`${at}[0]: shells are not accepted as the program`);
  return ok([...argv]);
}

function checkGlobSegment(segment: string): boolean {
  if (segment === "**") return true;
  if (segment.includes("**")) return false;
  let depth = 0;
  for (const char of segment) {
    if (char === "[" || char === "]" || char === "!") return false;
    if (char === "{") {
      if (depth > 0) return false;
      depth = 1;
    } else if (char === "}") {
      if (depth === 0) return false;
      depth = 0;
    }
  }
  return depth === 0;
}

function checkPath(value: unknown, at: string, glob: boolean): Check<string> {
  if (typeof value !== "string" || value.length === 0)
    return fail(`${at}: must be a non-empty string`);
  if (value.length > VERIFY_PLAN_LIMITS.pathLength)
    return fail(`${at}: longer than ${VERIFY_PLAN_LIMITS.pathLength} chars`);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(value)) return fail(`${at}: contains control characters`);
  if (value.includes("\\")) return fail(`${at}: use "/" separators, not "\\"`);
  if (value.startsWith("/") || /^[A-Za-z]:/.test(value))
    return fail(`${at}: must be repo-relative, not absolute`);
  if (value === ".") return ok(value);
  const segments = value.split("/");
  if (segments.includes("..")) return fail(`${at}: ".." segments are not allowed`);
  if (segments.some((segment) => segment === "" || segment === "."))
    return fail(`${at}: empty or "." segments are not allowed`);
  if (!glob && /[*?{}[\]]/.test(value)) return fail(`${at}: globs are not allowed here`);
  if (glob && !segments.every(checkGlobSegment))
    return fail(`${at}: only **, *, ? and {a,b} globs are supported`);
  return ok(value);
}

function checkPathList(value: unknown, at: string, max: number): Check<string[]> {
  if (value === undefined) return ok([]);
  if (!Array.isArray(value)) return fail(`${at}: must be an array`);
  if (value.length > max) return fail(`${at}: more than ${max} entries`);
  const paths: string[] = [];
  for (const [index, entry] of value.entries()) {
    const path = checkPath(entry, `${at}[${index}]`, true);
    if (!path.ok) return path;
    paths.push(path.value);
  }
  return ok(paths);
}

function checkText(value: unknown, at: string, max: number): Check<string> {
  if (typeof value !== "string" || value.length === 0 || value.length > max)
    return fail(`${at}: must be a string of 1-${max} chars`);
  if (value.includes("\0")) return fail(`${at}: contains NUL`);
  return ok(value);
}

const GATE_KEYS = [
  "id",
  "argv",
  "cwd",
  "covers",
  "fingerprint",
  "quietBudgetSeconds",
  "protectedPaths",
] as const;

function checkGate(value: unknown, at: string): Check<VerifyGate> {
  if (!isRecord(value)) return fail(`${at}: must be an object`);
  const extra = unknownKey(value, GATE_KEYS);
  if (extra !== null) return fail(`${at}: unknown key "${extra}"`);
  if (typeof value.id !== "string" || !GATE_ID.test(value.id))
    return fail(`${at}.id: must match ${GATE_ID.source}`);
  const argv = checkArgv(value.argv, `${at}.argv`);
  if (!argv.ok) return argv;
  const cwd = value.cwd === undefined ? ok(".") : checkPath(value.cwd, `${at}.cwd`, false);
  if (!cwd.ok) return cwd;
  const covers = checkPathList(value.covers, `${at}.covers`, VERIFY_PLAN_LIMITS.covers);
  if (!covers.ok) return covers;
  const protectedPaths = checkPathList(
    value.protectedPaths,
    `${at}.protectedPaths`,
    VERIFY_PLAN_LIMITS.protectedPaths,
  );
  if (!protectedPaths.ok) return protectedPaths;
  const fingerprint = value.fingerprint ?? null;
  if (fingerprint !== null && (typeof fingerprint !== "string" || !FINGERPRINT.test(fingerprint)))
    return fail(`${at}.fingerprint: must be 64 lowercase hex chars or null`);
  const quiet = value.quietBudgetSeconds ?? null;
  if (
    quiet !== null &&
    (typeof quiet !== "number" ||
      !Number.isInteger(quiet) ||
      quiet < 1 ||
      quiet > VERIFY_PLAN_LIMITS.quietBudgetSeconds)
  )
    return fail(
      `${at}.quietBudgetSeconds: must be an integer 1-${VERIFY_PLAN_LIMITS.quietBudgetSeconds} or null`,
    );
  return ok({
    id: value.id,
    argv: argv.value,
    cwd: cwd.value,
    covers: covers.value,
    fingerprint,
    quietBudgetSeconds: quiet,
    protectedPaths: protectedPaths.value,
  });
}

function checkAdvice(value: unknown, at: string): Check<VerifyPlanAdvice> {
  if (!isRecord(value)) return fail(`${at}: must be an object`);
  const extra = unknownKey(value, ["gateId", "kind", "reason", "lastRun"]);
  if (extra !== null) return fail(`${at}: unknown key "${extra}"`);
  if (typeof value.gateId !== "string" || !GATE_ID.test(value.gateId))
    return fail(`${at}.gateId: must match ${GATE_ID.source}`);
  if (value.kind !== "reused-pass") return fail(`${at}.kind: must be "reused-pass"`);
  const reason = checkText(value.reason, `${at}.reason`, VERIFY_PLAN_LIMITS.reasonLength);
  if (!reason.ok) return reason;
  const lastRunValue = value.lastRun ?? null;
  const lastRun =
    lastRunValue === null
      ? ok(null)
      : checkText(lastRunValue, `${at}.lastRun`, VERIFY_PLAN_LIMITS.lastRunLength);
  if (!lastRun.ok) return lastRun;
  return ok({
    gateId: value.gateId,
    kind: "reused-pass",
    reason: reason.value,
    lastRun: lastRun.value,
  });
}

function checkList<T>(
  value: unknown,
  at: string,
  max: number,
  item: (entry: unknown, at: string) => Check<T>,
): Check<T[]> {
  if (!Array.isArray(value)) return fail(`${at}: must be an array`);
  if (value.length > max) return fail(`${at}: more than ${max} entries`);
  const items: T[] = [];
  for (const [index, entry] of value.entries()) {
    const checked = item(entry, `${at}[${index}]`);
    if (!checked.ok) return checked;
    items.push(checked.value);
  }
  return ok(items);
}

function duplicate(ids: string[]): string | null {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) return id;
    seen.add(id);
  }
  return null;
}

function checkPlan(value: unknown): Check<VerifyPlan> {
  if (!isRecord(value)) return fail("plan must be a JSON object");
  const version = checkVersion(value, "verify-plan");
  if (version !== null) return fail(version);
  const extra = unknownKey(value, ["version", "mode", "gates", "advice"]);
  if (extra !== null) return fail(`unknown key "${extra}"`);
  if (value.mode !== "changed" && value.mode !== "full")
    return fail('mode: must be "changed" or "full"');
  const gates = checkList(value.gates, "gates", VERIFY_PLAN_LIMITS.gates, checkGate);
  if (!gates.ok) return gates;
  const duplicateGate = duplicate(gates.value.map((gate) => gate.id));
  if (duplicateGate !== null) return fail(`gates: duplicate id "${duplicateGate}"`);
  const advice =
    value.advice === undefined
      ? ok<VerifyPlanAdvice[]>([])
      : checkList(value.advice, "advice", VERIFY_PLAN_LIMITS.advice, checkAdvice);
  if (!advice.ok) return advice;
  const duplicateAdvice = duplicate(advice.value.map((entry) => entry.gateId));
  if (duplicateAdvice !== null) return fail(`advice: duplicate gateId "${duplicateAdvice}"`);
  return ok({
    version: VERIFY_PLAN_VERSION,
    mode: value.mode,
    gates: gates.value,
    advice: advice.value,
  });
}

function parseJsonText(text: string, max: number, label: string): Check<unknown> {
  // UTF-8 never has fewer bytes than UTF-16 code units, so length is a cheap first cut.
  if (text.length > max || utf8Bytes(text) > max)
    return fail(`${label} is larger than ${max} bytes`);
  try {
    return ok(JSON.parse(text) as unknown);
  } catch {
    return fail(`${label} is not valid JSON`);
  }
}

function toPlanResult(checked: Check<VerifyPlan>): VerifyPlanParseResult {
  return checked.ok ? { ok: true, plan: checked.value } : checked;
}

export function parseVerifyPlan(value: unknown): VerifyPlanParseResult {
  return toPlanResult(checkPlan(value));
}

export function parseVerifyPlanJson(text: string): VerifyPlanParseResult {
  const parsed = parseJsonText(text, VERIFY_PLAN_MAX_BYTES, "plan");
  return parsed.ok ? parseVerifyPlan(parsed.value) : parsed;
}

/** Map a supa `verify --json` plan (version 1) onto the harness shape. */
export function adaptSupaPlanV1(value: unknown): VerifyPlanParseResult {
  if (!isRecord(value)) return fail("supa plan must be a JSON object");
  const version = checkVersion(value, "supa plan");
  if (version !== null) return fail(version);
  if (!Array.isArray(value.run)) return fail("supa plan run: must be an array");
  if (value.skip !== undefined && !Array.isArray(value.skip))
    return fail("supa plan skip: must be an array");
  const gates: unknown[] = [];
  for (const [index, entry] of value.run.entries()) {
    if (!isRecord(entry)) return fail(`supa plan run[${index}]: must be an object`);
    gates.push({
      id: entry.gate,
      argv: entry.argv,
      cwd: entry.cwd,
      covers: entry.files,
      fingerprint: entry.fingerprint ?? null,
    });
  }
  const advice: unknown[] = [];
  for (const [index, entry] of (value.skip ?? []).entries()) {
    if (!isRecord(entry)) return fail(`supa plan skip[${index}]: must be an object`);
    // Only reused passes are worth surfacing; other skips carry no claim.
    if (entry.lastRun === undefined || entry.lastRun === null) continue;
    advice.push({
      gateId: entry.gate,
      kind: "reused-pass",
      reason: entry.reason,
      lastRun: entry.lastRun,
    });
  }
  return parseVerifyPlan({ version: VERIFY_PLAN_VERSION, mode: value.mode, gates, advice });
}

export function parseVerifyPlanDescriptor(text: string): VerifyPlanDescriptorParseResult {
  const parsed = parseJsonText(text, VERIFY_PLAN_DESCRIPTOR_MAX_BYTES, "descriptor");
  if (!parsed.ok) return parsed;
  const value = parsed.value;
  if (!isRecord(value)) return fail("descriptor must be a JSON object");
  const version = checkVersion(value, "descriptor");
  if (version !== null) return fail(version);
  const extra = unknownKey(value, ["version", "command", "format"]);
  if (extra !== null) return fail(`unknown key "${extra}"`);
  if (!FORMATS.includes(value.format as VerifyPlanFormat))
    return fail(`format: must be one of ${FORMATS.join(", ")}`);
  if (!isRecord(value.command)) return fail("command: must be an object");
  const commandExtra = unknownKey(value.command, ["argv", "cwd"]);
  if (commandExtra !== null) return fail(`command: unknown key "${commandExtra}"`);
  const argv = checkArgv(value.command.argv, "command.argv");
  if (!argv.ok) return argv;
  const cwd =
    value.command.cwd === undefined ? ok(".") : checkPath(value.command.cwd, "command.cwd", false);
  if (!cwd.ok) return cwd;
  return {
    ok: true,
    descriptor: {
      version: VERIFY_PLAN_VERSION,
      command: { argv: argv.value, cwd: cwd.value },
      format: value.format as VerifyPlanFormat,
    },
  };
}

/** Decide whether to run the project's plan command. Untrusted projects never get parsed. */
export function decideVerifyPlanSource(input: {
  trusted: boolean;
  descriptor: string | null;
}): VerifyPlanSourceDecision {
  if (!input.trusted)
    return { kind: "heuristics", reason: VERIFY_PLAN_HEURISTICS_REASONS.untrusted };
  if (input.descriptor === null)
    return { kind: "heuristics", reason: VERIFY_PLAN_HEURISTICS_REASONS.noDescriptor };
  const descriptor = parseVerifyPlanDescriptor(input.descriptor);
  return descriptor.ok
    ? { kind: "run", descriptor: descriptor.descriptor }
    : {
        kind: "heuristics",
        reason: `${VERIFY_PLAN_HEURISTICS_REASONS.badDescriptor}: ${descriptor.reason}`,
      };
}

/** Turn the plan command's (untrusted) output into a plan, or a stated fallback. */
export function interpretVerifyPlanOutput(
  format: VerifyPlanFormat,
  stdout: string,
  exitCode: number | null,
  timedOut: boolean,
): VerifyPlanOutcome {
  if (timedOut) return { kind: "heuristics", reason: VERIFY_PLAN_HEURISTICS_REASONS.timedOut };
  if (exitCode !== 0)
    return {
      kind: "heuristics",
      reason: `${VERIFY_PLAN_HEURISTICS_REASONS.nonZeroExit} (exit ${exitCode ?? "unknown"})`,
    };
  if (stdout.length > VERIFY_PLAN_MAX_BYTES || utf8Bytes(stdout) > VERIFY_PLAN_MAX_BYTES)
    return { kind: "heuristics", reason: VERIFY_PLAN_HEURISTICS_REASONS.oversize };
  const parsed = parseJsonText(stdout, VERIFY_PLAN_MAX_BYTES, "plan");
  const plan = !parsed.ok
    ? parsed
    : format === "supa-plan-v1"
      ? adaptSupaPlanV1(parsed.value)
      : parseVerifyPlan(parsed.value);
  return plan.ok
    ? { kind: "plan", plan: plan.plan }
    : { kind: "heuristics", reason: `${VERIFY_PLAN_HEURISTICS_REASONS.badPlan}: ${plan.reason}` };
}
