import { spawn } from "node:child_process";
import { z } from "zod";
import { getSafeToolEnv } from "../../tools/safe-env.js";
import { isGitRepo, runBackgroundGit } from "../../utils/git.js";
import { killProcessTree } from "../../utils/process.js";
import {
  commitGeneratedSet,
  generatedRecordPath,
  GeneratedSetCommitError,
  previewGeneratedSet,
  type GeneratedFile,
  type GeneratedFilePreviewAction,
  type GeneratedSetSpec,
} from "../generated-files/owner.js";
import { generatedFile, renderPlaceholders } from "../generated-files/render.js";
import { detectLanguages } from "../language-detector.js";
import { resolveShell } from "../shell.js";
import { compareText, containedPath, sha256, stableJson } from "../tauri-package/paths.js";
import { detectVerifyCommands } from "../verify-commands.js";
import type { GeneratorForApply } from "./command-verification.js";
import {
  FAMILY_GENERATOR_HELPERS,
  isSafeRepositoryPath,
  renderMemberInFixture,
} from "./family-generator.js";

/**
 * Apply a verified family generator to the other members. `planFamily` is the
 * no-write preview (render in a fixture, classify every file through the shared
 * owner, git gate); `applyFamily` commits one member at a time through
 * `commitGeneratedSet`, so each member has its own snapshot and rollback.
 * Neither function asks for approval: the tool owns the question card.
 */
export const FAMILY_APPLY_LIMITS = Object.freeze({
  previewChars: 64_000,
  projectCheckTimeoutMs: 5 * 60_000,
  checkOutputChars: 4_000,
  gitTimeoutMs: 30_000,
});
export const FAMILY_LOCK_NAME = "gg-family-generator";

export type ReadyGenerator = Extract<GeneratorForApply, { status: "ready" }>;

const templateSchema = z.object({
  version: z.literal(1),
  kind: z.enum(["directory", "file"]),
  files: z.array(z.object({ path: z.string(), content: z.string() })).min(1),
});
const inputsSchema = z.object({
  version: z.literal(1),
  members: z.array(z.object({ path: z.string(), values: z.record(z.string(), z.string()) })),
});

export type GitGate = { repository: false } | { repository: true; dirty: string[] };

export interface ProjectCheckRun {
  exitCode: number | null;
  timedOut: boolean;
  outputTail: string;
}

export interface FamilyApplyDeps {
  render?: typeof renderMemberInFixture;
  git?: (
    root: string,
    pathspecs: readonly string[],
    affected: ReadonlySet<string>,
    signal: AbortSignal,
  ) => Promise<GitGate>;
  detectChecks?: (root: string) => string[];
  runCheck?: (
    command: string,
    root: string,
    signal: AbortSignal,
    timeoutMs: number,
  ) => Promise<ProjectCheckRun>;
  /** Fault boundary for host tests only. */
  afterWrite?: (member: string, repositoryPath: string, index: number) => Promise<void> | void;
}

export interface PlannedFile {
  path: string;
  action: GeneratedFilePreviewAction;
  reason?: string;
  priorSha256?: string;
  renderedSha256: string;
}

export interface PlannedMember {
  path: string;
  ownerId: string;
  /** `ready`: has files to create or change. `unchanged`: nothing to write. */
  status: "ready" | "unchanged" | "conflict" | "failed";
  reason?: string;
  files: PlannedFile[];
  /** Files the owner may write for this member (rendered minus `skip`). */
  writable: GeneratedFile[];
}

export interface FamilyPlan {
  members: PlannedMember[];
  git: GitGate;
  projectCheck: string | null;
  previewSha256: string;
  text: string;
}

export type FamilyPlanResult =
  { status: "planned"; plan: FamilyPlan } | { status: "unavailable"; reason: string };

export function familyOwnerId(familyId: string, member: string): string {
  return `family-${familyId}-${sha256(member).slice(0, 16)}`;
}

function memberSpec(ownerId: string, member: string, paths: readonly string[]): GeneratedSetSpec {
  return {
    ownerId,
    paths: [...paths],
    completeSet: false,
    byteCompareExempt: [],
    lockName: FAMILY_LOCK_NAME,
    tempPrefix: ".gg-family-",
    label: `family member ${member}`,
    ownership: { kind: "side-record" },
  };
}

function inside(kind: "directory" | "file", member: string, file: string): boolean {
  return kind === "file" ? file === member : file.startsWith(`${member}/`);
}

/** Git status for the affected paths only; non-git projects are reported, not refused. */
export async function familyGitGate(
  root: string,
  pathspecs: readonly string[],
  affected: ReadonlySet<string>,
  signal: AbortSignal,
): Promise<GitGate> {
  const timeoutMs = FAMILY_APPLY_LIMITS.gitTimeoutMs;
  if (!(await isGitRepo(root, { timeoutMs }))) return { repository: false };
  const prefix = (
    await runBackgroundGit(["rev-parse", "--show-prefix"], { cwd: root, timeoutMs, signal })
  ).stdout.trim();
  const { stdout } = await runBackgroundGit(
    [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--",
      ...pathspecs.map((item) => `:(literal)${item}`),
    ],
    { cwd: root, timeoutMs, signal, maxBuffer: 4 * 1024 * 1024 },
  );
  const dirty = new Set<string>();
  const entries = stdout.split("\0");
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    if (!entry || entry.length < 4) continue;
    const paths = [entry.slice(3)];
    // Renames and copies carry the original path as the next entry.
    if (entry[0] === "R" || entry[0] === "C") paths.push(entries[++index] ?? "");
    for (const item of paths) {
      // Porcelain paths are relative to the repository top level.
      const relative = item.startsWith(prefix) ? item.slice(prefix.length) : null;
      if (relative !== null && affected.has(relative)) dirty.add(relative);
    }
  }
  return { repository: true, dirty: [...dirty].sort(compareText) };
}

function detectProjectChecks(root: string): string[] {
  return detectVerifyCommands(root, detectLanguages(root)).map((item) => item.command);
}

/**
 * The verified project check when still detected, else the first detected one,
 * else none. Only an exact detected command is ever offered.
 */
function chooseProjectCheck(generator: ReadyGenerator, detected: readonly string[]): string | null {
  const verified = generator.verification.projectCheck;
  if (verified.status === "passed" && verified.command && detected.includes(verified.command))
    return verified.command;
  return detected[0] ?? null;
}

const ACTION_LABEL: Record<GeneratedFilePreviewAction, string> = {
  create: "create",
  change: "change",
  unchanged: "unchanged",
  skip: "skip",
  conflict: "CONFLICT",
};

function previewText(
  generator: ReadyGenerator,
  members: readonly PlannedMember[],
  git: GitGate,
  projectCheck: string | null,
): string {
  const lines = [
    `Apply the verified generator for ${generator.metadata.reference} to ${members.length} other family member(s). Nothing has been written.`,
    !git.repository
      ? "Not a git repository: there is no git undo for these writes."
      : git.dirty.length
        ? `Uncommitted changes to affected paths (applying needs an explicit override):\n${git.dirty.map((item) => `  ${item}`).join("\n")}`
        : "Git: affected paths have no uncommitted changes.",
    projectCheck
      ? `Project check offered: \`${projectCheck}\`. If chosen it runs once before any write, then after each member; a failing run rolls that member back. It runs repository code and is not a sandbox.`
      : "No project check was found: only exact rendering will be checked.",
    "A member with any conflict is skipped whole. Unowned files are never overwritten.",
  ];
  for (const member of members) {
    const status =
      member.status === "conflict"
        ? "conflict, will be skipped"
        : member.status === "failed"
          ? `cannot render (${member.reason ?? "failed"})`
          : member.status === "unchanged"
            ? "already up to date"
            : "ready";
    lines.push("", `${member.path}: ${status}`);
    for (const file of member.files)
      lines.push(
        `  ${ACTION_LABEL[file.action]} ${file.path}${file.reason ? ` (${file.reason})` : ""}`,
      );
  }
  return lines.join("\n");
}

/** No-write preview. Every call re-renders, so a recomputed digest proves freshness. */
export async function planFamily(
  generator: ReadyGenerator,
  request: { members?: readonly string[] },
  signal: AbortSignal,
  deps: FamilyApplyDeps = {},
): Promise<FamilyPlanResult> {
  const unavailable = (reason: string) => ({ status: "unavailable", reason }) as const;
  const { metadata, root } = generator;
  const others = metadata.members.filter((member) => member !== metadata.reference);
  const requested = [...new Set(request.members ?? others)].sort(compareText);
  if (!requested.length) return unavailable("no-members-selected");
  if (requested.includes(metadata.reference)) return unavailable("reference-already-in-place");
  const unknown = requested.find((member) => !others.includes(member));
  if (unknown !== undefined) return unavailable(`unknown-member: ${unknown}`.slice(0, 500));
  const templateText = generator.helperTexts.get(FAMILY_GENERATOR_HELPERS.template);
  const inputsText = generator.helperTexts.get(FAMILY_GENERATOR_HELPERS.inputs);
  const scriptText = generator.helperTexts.get(FAMILY_GENERATOR_HELPERS.script);
  let template: z.infer<typeof templateSchema>;
  let inputs: z.infer<typeof inputsSchema>;
  try {
    if (templateText === undefined || inputsText === undefined || scriptText === undefined)
      throw new Error("missing");
    template = templateSchema.parse(JSON.parse(templateText));
    inputs = inputsSchema.parse(JSON.parse(inputsText));
  } catch {
    return unavailable("generator-files-invalid");
  }
  const render = deps.render ?? renderMemberInFixture;
  const members: PlannedMember[] = [];
  for (const member of requested) {
    signal.throwIfAborted();
    const ownerId = familyOwnerId(metadata.familyId, member);
    const failed = (reason: string): PlannedMember => ({
      path: member,
      ownerId,
      status: "failed",
      reason,
      files: [],
      writable: [],
    });
    const values = inputs.members.find((item) => item.path === member)?.values;
    if (!values) {
      members.push(failed("member-missing-from-inputs"));
      continue;
    }
    let expected: string[];
    try {
      expected = template.files
        .map((file) => renderPlaceholders(file.path, values))
        .sort(compareText);
    } catch {
      members.push(failed("member-values-invalid"));
      continue;
    }
    if (
      expected.some(
        (file) => !isSafeRepositoryPath(file) || !inside(template.kind, member, file),
      ) ||
      new Set(expected.map((file) => file.toLowerCase())).size !== expected.length
    ) {
      members.push(failed("rendered-path-outside-member-unsafe-or-duplicate"));
      continue;
    }
    const output = await render({
      runtimeExecutable: generator.runtimeExecutable,
      helperTexts: generator.helperTexts,
      member,
      signal,
    });
    signal.throwIfAborted();
    if (output.status !== "rendered") {
      members.push(failed(output.reason));
      continue;
    }
    const produced = [...output.files.keys()].sort(compareText);
    if (produced.join("\n") !== expected.join("\n")) {
      members.push(failed("generator-output-differs-from-template-paths"));
      continue;
    }
    const templateSha256 = sha256(
      stableJson({ script: sha256(scriptText), template: sha256(templateText), values }),
    );
    const rendered = expected.map((file) =>
      generatedFile(file, output.files.get(file) ?? Buffer.alloc(0), templateSha256),
    );
    let previews;
    try {
      previews = await previewGeneratedSet(root, memberSpec(ownerId, member, expected), rendered);
    } catch {
      signal.throwIfAborted();
      members.push(failed("member-unreadable"));
      continue;
    }
    const files = previews.map((item) => ({
      ...item,
      renderedSha256: rendered.find((file) => file.path === item.path)?.content_sha256 ?? "",
    }));
    const writable = rendered.filter(
      (file) => files.find((item) => item.path === file.path)?.action !== "skip",
    );
    const conflicts = files.filter((file) => file.action === "conflict");
    members.push({
      path: member,
      ownerId,
      status: conflicts.length
        ? "conflict"
        : files.some((file) => file.action === "create" || file.action === "change")
          ? "ready"
          : "unchanged",
      ...(conflicts.length
        ? {
            reason: conflicts
              .map((file) => `${file.path}: ${file.reason ?? "conflict"}`)
              .join("; "),
          }
        : {}),
      files,
      writable,
    });
  }
  const affected = new Set<string>();
  for (const member of members) {
    for (const file of member.files) affected.add(file.path);
    affected.add(generatedRecordPath(member.ownerId));
  }
  const pathspecs = [...requested, ...members.map((member) => generatedRecordPath(member.ownerId))];
  let git: GitGate;
  try {
    git = await (deps.git ?? familyGitGate)(root, pathspecs, affected, signal);
  } catch {
    signal.throwIfAborted();
    // Fail closed: an unanswered git status is neither clean nor "not a repository".
    return unavailable("git-status-failed");
  }
  signal.throwIfAborted();
  const projectCheck = chooseProjectCheck(
    generator,
    (deps.detectChecks ?? detectProjectChecks)(root),
  );
  const text = previewText(generator, members, git, projectCheck);
  if (text.length > FAMILY_APPLY_LIMITS.previewChars) return unavailable("preview-size-limit");
  const previewSha256 = sha256(
    stableJson({
      version: 1,
      binding: generator.binding,
      members: members.map((member) => ({
        path: member.path,
        ownerId: member.ownerId,
        status: member.status,
        reason: member.reason ?? null,
        files: member.files.map((file) => ({
          path: file.path,
          action: file.action,
          priorSha256: file.priorSha256 ?? null,
          renderedSha256: file.renderedSha256,
        })),
      })),
      git,
      projectCheck,
    }),
  );
  return { status: "planned", plan: { members, git, projectCheck, previewSha256, text } };
}

/** Run one detected project check with the reduced tool environment; tree-killed on timeout/abort. */
export function runProjectCheck(
  command: string,
  root: string,
  signal: AbortSignal,
  timeoutMs: number = FAMILY_APPLY_LIMITS.projectCheckTimeoutMs,
): Promise<ProjectCheckRun> {
  signal.throwIfAborted();
  const shell = resolveShell(command);
  return new Promise((resolve, reject) => {
    const child = spawn(shell.file, shell.args, {
      cwd: root,
      env: getSafeToolEnv(),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    let tail = "";
    let timedOut = false;
    const append = (chunk: Buffer) => {
      tail = (tail + chunk.toString("utf8")).slice(-FAMILY_APPLY_LIMITS.checkOutputChars);
    };
    const kill = () => {
      if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
        try {
          killProcessTree(child.pid);
        } catch {
          // Close still settles; the report records the run as failed.
        }
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    signal.addEventListener("abort", kill, { once: true });
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", kill);
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.once("error", (error) => {
      finish();
      if (signal.aborted) reject(signal.reason);
      else resolve({ exitCode: null, timedOut: false, outputTail: String(error.message) });
    });
    child.once("close", (code) => {
      finish();
      if (signal.aborted) reject(signal.reason);
      else resolve({ exitCode: code, timedOut, outputTail: tail });
    });
  });
}

const memberStatusSchema = z.enum([
  "created",
  "updated",
  "unchanged",
  "skipped",
  "failed",
  "not-attempted",
]);
export const familyApplyReportSchema = z.strictObject({
  version: z.literal(1),
  status: z.enum(["completed", "partial", "failed", "cancelled"]),
  stopped: z.enum(["cancelled", "deadline", "rollback-incomplete", "lock-busy"]).nullable(),
  members: z.array(
    z.strictObject({
      path: z.string(),
      status: memberStatusSchema,
      reason: z.string(),
      files: z.array(
        z.strictObject({
          path: z.string(),
          action: z.enum(["create", "change", "unchanged", "skip", "conflict"]),
        }),
      ),
      projectCheck: z.enum(["passed", "failed", "not-run"]).optional(),
    }),
  ),
  projectCheck: z.strictObject({
    command: z.string().nullable(),
    baseline: z.enum(["passed", "failed", "not-run"]),
    statement: z.string(),
  }),
  git: z.strictObject({
    repository: z.boolean(),
    dirtyOverride: z.boolean(),
    dirty: z.array(z.string()),
  }),
  limits: z.array(z.string()),
});
export type FamilyApplyReport = z.infer<typeof familyApplyReportSchema>;
type MemberReport = FamilyApplyReport["members"][number];
type StopReason = NonNullable<FamilyApplyReport["stopped"]>;

class ProjectCheckFailure extends Error {
  constructor(readonly run: ProjectCheckRun) {
    super(run.timedOut ? "project check timed out" : `project check exited ${run.exitCode}`);
  }
}

function isTimeout(reason: unknown): boolean {
  return reason instanceof Error && reason.name === "TimeoutError";
}

export interface FamilyApplyOptions {
  root: string;
  plan: FamilyPlan;
  /** The user chose to run the offered project check. */
  runProjectCheck: boolean;
  dirtyOverride: boolean;
  signal: AbortSignal;
  deadlineMs: number;
  checkTimeoutMs?: number;
  onPreMutation?: (absolutePath: string) => Promise<void> | void;
  onMutated?: (absolutePath: string) => Promise<void> | void;
  deps?: FamilyApplyDeps;
}

/**
 * Commit each member independently through the shared owner. Independent
 * failures continue; cancellation, the deadline, an incomplete rollback or a
 * busy lock stop the rest as `not-attempted`.
 */
export async function applyFamily(options: FamilyApplyOptions): Promise<FamilyApplyReport> {
  const { root, plan, deps = {} } = options;
  // The tool refuses first; this guards the domain contract against a caller bug.
  if (plan.git.repository && plan.git.dirty.length && !options.dirtyOverride)
    throw new Error("Dirty affected paths require an explicit override");
  const deadline = AbortSignal.timeout(options.deadlineMs);
  const signal = AbortSignal.any([options.signal, deadline]);
  const stopReason = (): StopReason | null =>
    options.signal.aborted
      ? isTimeout(options.signal.reason)
        ? "deadline"
        : "cancelled"
      : deadline.aborted
        ? "deadline"
        : null;
  const runCheck = deps.runCheck ?? runProjectCheck;
  const checkTimeout = options.checkTimeoutMs ?? FAMILY_APPLY_LIMITS.projectCheckTimeoutMs;
  const command = plan.projectCheck;
  let stopped: StopReason | null = null;
  let baseline: FamilyApplyReport["projectCheck"]["baseline"] = "not-run";
  let baselineExit: number | null = null;
  if (command && options.runProjectCheck) {
    try {
      const run = await runCheck(command, root, signal, checkTimeout);
      baseline = run.exitCode === 0 && !run.timedOut ? "passed" : "failed";
      baselineExit = run.exitCode;
    } catch {
      stopped = stopReason();
      if (!stopped) baseline = "failed";
    }
  }
  const perMember = baseline === "passed" && command !== null;
  const notify = async (callback: FamilyApplyOptions["onMutated"], repositoryPath: string) => {
    try {
      await callback?.(containedPath(root, repositoryPath));
    } catch {
      // Notifications never change what was written.
    }
  };
  const reports: MemberReport[] = [];
  for (const member of plan.members) {
    const files = member.files.map((file) => ({ path: file.path, action: file.action }));
    const report = (
      status: MemberReport["status"],
      reason: string,
      check?: MemberReport["projectCheck"],
    ) =>
      reports.push({
        path: member.path,
        status,
        reason,
        files,
        ...(check ? { projectCheck: check } : {}),
      });
    stopped ??= stopReason();
    if (stopped) {
      report("not-attempted", `stopped before this member: ${stopped}`);
      continue;
    }
    if (member.status === "failed") {
      report("failed", `could not render: ${member.reason ?? "failed"}; nothing written`);
      continue;
    }
    if (member.status === "conflict") {
      report("skipped", `conflicts, nothing written: ${member.reason ?? "conflict"}`);
      continue;
    }
    if (member.status === "unchanged") {
      report("unchanged", "already matches the generator; nothing written");
      continue;
    }
    const written: string[] = [];
    let check: "passed" | "failed" | "not-run" = "not-run";
    try {
      await commitGeneratedSet(
        root,
        memberSpec(
          member.ownerId,
          member.path,
          member.writable.map((file) => file.path),
        ),
        member.writable,
        {
          revalidate: async () => signal.throwIfAborted(),
          onPreMutation: async (repositoryPath) => {
            signal.throwIfAborted();
            await options.onPreMutation?.(containedPath(root, repositoryPath));
          },
          afterWrite: async (repositoryPath, index) => {
            written.push(repositoryPath);
            await deps.afterWrite?.(member.path, repositoryPath, index);
            signal.throwIfAborted();
          },
          ...(perMember
            ? {
                afterAllWrites: async () => {
                  const run = await runCheck(command, root, signal, checkTimeout);
                  check = run.exitCode === 0 && !run.timedOut ? "passed" : "failed";
                  if (check === "failed") throw new ProjectCheckFailure(run);
                },
              }
            : {}),
          onCommitted: (repositoryPath) => notify(options.onMutated, repositoryPath),
        },
      );
      const created = member.files.every((file) => file.action !== "change");
      report(
        created ? "created" : "updated",
        perMember
          ? `written; project check \`${command}\` passed`
          : "written; only exact rendering was checked",
        perMember ? "passed" : undefined,
      );
    } catch (error) {
      // Rolled-back paths changed on disk twice; refresh any watchers.
      for (const repositoryPath of written) await notify(options.onMutated, repositoryPath);
      const stop = stopReason();
      if (error instanceof GeneratedSetCommitError && error.rollbackIncomplete) {
        stopped = "rollback-incomplete";
        report(
          "failed",
          `rollback incomplete; inspect these files: ${error.message}`.slice(0, 4000),
        );
      } else if (error instanceof GeneratedSetCommitError && error.code === "busy") {
        stopped = "lock-busy";
        report("not-attempted", "another generated-file action holds the lock");
      } else if (stop) {
        stopped = stop;
        if (written.length) report("failed", `${stop} during this member; it was rolled back`);
        else report("not-attempted", `stopped before this member: ${stop}`);
      } else if (error instanceof GeneratedSetCommitError && error.code === "refused") {
        report(
          "skipped",
          `changed since the preview; nothing written: ${error.message}`.slice(0, 4000),
        );
      } else if (
        error instanceof GeneratedSetCommitError &&
        error.cause instanceof ProjectCheckFailure
      ) {
        const run = error.cause.run;
        const tail = run.outputTail.trim().slice(-1_000);
        report(
          "failed",
          `project check \`${command}\` ${run.timedOut ? "timed out" : `exited ${run.exitCode}`}; this member was rolled back${tail ? `\n${tail}` : ""}`,
          check,
        );
      } else {
        report(
          "failed",
          `write failed; this member was rolled back: ${error instanceof Error ? error.message : String(error)}`.slice(
            0,
            4000,
          ),
        );
      }
    }
  }
  const succeeded = reports.filter((item) =>
    ["created", "updated", "unchanged"].includes(item.status),
  ).length;
  const status: FamilyApplyReport["status"] =
    stopped === "cancelled"
      ? "cancelled"
      : succeeded === reports.length
        ? "completed"
        : succeeded === 0
          ? "failed"
          : "partial";
  const statement = !command
    ? "No project check was found; only exact rendering was checked."
    : !options.runProjectCheck
      ? `The project check \`${command}\` was not chosen; only exact rendering was checked.`
      : baseline === "failed"
        ? `The project check \`${command}\` already failed before any write (exit ${baselineExit ?? "none"}), so it could not judge members; only exact rendering was checked.`
        : baseline === "not-run"
          ? `The project check \`${command}\` did not run; only exact rendering was checked.`
          : `The project check \`${command}\` passed before any write and ran after each written member; a failing run rolled that member back.`;
  return familyApplyReportSchema.parse({
    version: 1,
    status,
    stopped,
    members: reports,
    projectCheck: { command, baseline, statement },
    git: {
      repository: plan.git.repository,
      dirtyOverride: options.dirtyOverride,
      dirty: plan.git.repository ? plan.git.dirty : [],
    },
    limits: [
      "A byte-exact render does not prove the member works in this project.",
      ...(command && options.runProjectCheck
        ? [
            "The project check runs repository code with a reduced environment; it is not a sandbox.",
          ]
        : []),
      ...(plan.git.repository
        ? []
        : ["Not a git repository: there is no git undo for these writes."]),
      "File actions are the previewed plan; only created and updated members were written. Ownership records live under .gg/programmatic/generated/.",
    ],
  });
}
