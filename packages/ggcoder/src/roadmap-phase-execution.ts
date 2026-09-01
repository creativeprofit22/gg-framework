import { createHash, timingSafeEqual } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  NotesApprovedPlanV1,
  NotesPlanStepV1,
  NotesRepositoryIdentityV1,
  NotesVerificationEvidenceV1,
  NotesWorkspaceSnapshotV1,
} from "@kenkaiiii/gg-core";
import { approvedPlanArtifactContent } from "./app-sidecar-plan-gate.js";
import { extractPlanSteps } from "./utils/plan-steps.js";

const GIT_TIMEOUT_MS = 10_000;
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

export class RepositoryUnverifiableError extends Error {
  readonly code = "repository-unverifiable";

  constructor(message = "The Git repository could not be verified.") {
    super(message);
    this.name = "RepositoryUnverifiableError";
  }
}

export interface ApprovedPlanInput {
  planId: string;
  content: string;
  snapshotPath: string;
  approvedAt: string;
  approvedRevision: number;
  baseCommit: string | null;
}

export interface LegacyPlanImportIdentity {
  projectKey: string;
  phaseId: string;
  phaseSessionPath: string | null;
  currentSessionPath: string | null;
  planId: string;
  planState: "approval-committed" | "implementation-prompt-started" | "completed";
  planProjectKey: string | null;
  planPhaseId: string | null;
  planSessionPath: string | null;
}

export interface PlanReconciliationResult {
  steps: NotesPlanStepV1[];
  changed: boolean;
  needsRevalidation: string[];
}

export type PlanSnapshotResumeCode = "plan-snapshot-missing" | "reconciliation-required";

export class PlanSnapshotResumeError extends Error {
  constructor(
    readonly code: PlanSnapshotResumeCode,
    readonly snapshotPath: string,
  ) {
    super(
      code === "plan-snapshot-missing"
        ? "The approved plan snapshot is missing."
        : "The approved plan snapshot requires reconciliation.",
    );
    this.name = "PlanSnapshotResumeError";
  }
}

export interface LegacyPlanSnapshotRecovery extends LegacyPlanImportIdentity {
  checkpointId: string;
  content: string;
  contentHash: string;
}

export type PlanSnapshotResumeResult =
  | { status: "ready"; path: string; content: string; recovered: boolean }
  | { status: PlanSnapshotResumeCode; path: string };

export function isLegacyPlanImportEligible(input: LegacyPlanImportIdentity): boolean {
  return (
    input.planState !== "completed" &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(input.planId) &&
    input.planProjectKey === input.projectKey &&
    input.planPhaseId === input.phaseId &&
    input.planSessionPath === input.phaseSessionPath &&
    input.currentSessionPath === input.phaseSessionPath
  );
}

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export async function resolveExecutionPlanSnapshot(input: {
  cwd: string;
  plan: NotesApprovedPlanV1;
  recovery?: LegacyPlanSnapshotRecovery;
}): Promise<PlanSnapshotResumeResult> {
  let root: string;
  try {
    root = await fs.realpath(input.cwd);
  } catch {
    return { status: "reconciliation-required", path: input.plan.snapshotPath };
  }
  const snapshotPath = containedSnapshotPath(root, input.plan.snapshotPath);
  if (!snapshotPath) return { status: "reconciliation-required", path: input.plan.snapshotPath };

  try {
    const realSnapshotPath = await fs.realpath(snapshotPath);
    if (!isPathContained(root, realSnapshotPath)) {
      return { status: "reconciliation-required", path: snapshotPath };
    }
    const stat = await fs.stat(realSnapshotPath);
    if (!stat.isFile()) return { status: "reconciliation-required", path: snapshotPath };
    const content = await fs.readFile(realSnapshotPath);
    if (!constantTimeHexEqual(sha256(content), input.plan.contentHash)) {
      return { status: "reconciliation-required", path: snapshotPath };
    }
    return {
      status: "ready",
      path: realSnapshotPath,
      content: content.toString("utf8"),
      recovered: false,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      return { status: "reconciliation-required", path: snapshotPath };
    }
  }

  const recovery = input.recovery;
  if (!recovery) return { status: "plan-snapshot-missing", path: snapshotPath };
  const artifact = approvedPlanArtifactContent(recovery.content);
  if (
    recovery.checkpointId !== input.plan.planId ||
    recovery.planId !== input.plan.planId ||
    !constantTimeHexEqual(sha256(recovery.content), recovery.contentHash) ||
    !constantTimeHexEqual(sha256(artifact), input.plan.contentHash) ||
    !isLegacyPlanImportEligible(recovery)
  ) {
    return { status: "plan-snapshot-missing", path: snapshotPath };
  }

  try {
    const parent = await fs.realpath(path.dirname(snapshotPath));
    if (!isPathContained(root, parent)) {
      return { status: "reconciliation-required", path: snapshotPath };
    }
    await fs.writeFile(snapshotPath, artifact, { encoding: "utf8", flag: "wx" });
    return { status: "ready", path: snapshotPath, content: artifact, recovered: true };
  } catch {
    return { status: "reconciliation-required", path: snapshotPath };
  }
}

function containedSnapshotPath(root: string, relativePath: string): string | null {
  if (
    !relativePath ||
    path.isAbsolute(relativePath) ||
    relativePath.split(/[\\/]/).includes("..")
  ) {
    return null;
  }
  const resolved = path.resolve(root, relativePath);
  return isPathContained(root, resolved) ? resolved : null;
}

function isPathContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function normalizePlanStepText(text: string): string {
  return text.trim().replace(/\s+/g, " ").normalize("NFC");
}

export function planStepId(planId: string, index: number, text: string): string {
  return sha256(`${planId}\0${index}\0${normalizePlanStepText(text)}`);
}

export function createApprovedPlan(input: ApprovedPlanInput): NotesApprovedPlanV1 {
  const steps = extractPlanSteps(input.content).map(({ step, text }) => {
    const normalized = normalizePlanStepText(text);
    return {
      id: planStepId(input.planId, step, normalized),
      index: step,
      text: normalized,
      state: "pending" as const,
      completedAt: null,
      workspace: null,
    };
  });
  if (steps.length === 0) throw new Error("Approved plans require at least one canonical step.");
  return {
    planId: input.planId,
    contentHash: sha256(input.content),
    snapshotPath: input.snapshotPath,
    approvedAt: input.approvedAt,
    approvedRevision: input.approvedRevision,
    baseCommit: input.baseCommit,
    steps,
  };
}

export function workspaceSnapshotsEqual(
  left: NotesWorkspaceSnapshotV1,
  right: NotesWorkspaceSnapshotV1,
): boolean {
  return (
    left.version === right.version &&
    left.repository.projectKey === right.repository.projectKey &&
    constantTimeHexEqual(left.repository.identityHash, right.repository.identityHash) &&
    left.repository.rootCommit === right.repository.rootCommit &&
    left.headCommit === right.headCommit &&
    constantTimeHexEqual(left.worktreeDigest, right.worktreeDigest) &&
    left.clean === right.clean
  );
}

export function reconcilePlanSteps(
  steps: readonly NotesPlanStepV1[],
  current: NotesWorkspaceSnapshotV1,
  isAncestor: (commit: string, descendant: string) => boolean,
): PlanReconciliationResult {
  const needsRevalidation: string[] = [];
  let changed = false;
  const reconciled = steps.map((step) => {
    if (step.state === "pending" || step.workspace === null) return step;
    const valid = step.workspace.clean
      ? isAncestor(step.workspace.headCommit, current.headCommit)
      : workspaceSnapshotsEqual(step.workspace, current);
    if (valid) return step;
    needsRevalidation.push(step.id);
    if (step.state === "needs-revalidation") return step;
    changed = true;
    return { ...step, state: "needs-revalidation" as const };
  });
  return { steps: changed ? reconciled : [...steps], changed, needsRevalidation };
}

export function isEvidenceCurrent(
  evidence: NotesVerificationEvidenceV1,
  current: NotesWorkspaceSnapshotV1,
  classifierVersion: string,
): boolean {
  return (
    evidence.state !== "needs-revalidation" &&
    evidence.exitCode === 0 &&
    evidence.verdict === "approved" &&
    evidence.classifierVersion === classifierVersion &&
    workspaceSnapshotsEqual(evidence.workspace, current)
  );
}

export async function captureGitWorkspaceSnapshot(
  cwd: string,
  projectKey: string,
): Promise<NotesWorkspaceSnapshotV1> {
  const root = await gitText(cwd, ["rev-parse", "--show-toplevel"]);
  if (!root) throw new RepositoryUnverifiableError();
  const repository = await captureRepositoryIdentity(root, projectKey);
  const headCommit = await gitText(root, ["rev-parse", "HEAD"]);
  if (!/^[a-f0-9]{40}$/.test(headCommit)) throw new RepositoryUnverifiableError();

  let prior = await captureWorktree(root);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const next = await captureWorktree(root);
    if (prior.digest === next.digest && prior.clean === next.clean) {
      return {
        version: 1,
        repository,
        headCommit,
        worktreeDigest: next.digest,
        clean: next.clean,
      };
    }
    prior = next;
  }
  throw new RepositoryUnverifiableError("The workspace changed while it was being captured.");
}

export async function captureRepositoryIdentity(
  cwd: string,
  projectKey: string,
): Promise<NotesRepositoryIdentityV1> {
  const roots = (await gitText(cwd, ["rev-list", "--max-parents=0", "HEAD"]))
    .split(/\r?\n/)
    .filter((value) => /^[a-f0-9]{40}$/.test(value))
    .sort();
  if (roots.length === 0) throw new RepositoryUnverifiableError();
  const remote = await tryGitText(cwd, ["remote", "get-url", "origin"]);
  const identityHash = sha256(
    JSON.stringify({ roots, remote: remote ? normalizeRemoteIdentity(remote) : null }),
  );
  return { projectKey, identityHash, rootCommit: roots.length === 1 ? roots[0]! : null };
}

export async function isGitAncestor(
  cwd: string,
  ancestor: string,
  descendant: string,
): Promise<boolean> {
  try {
    await runGit(cwd, ["merge-base", "--is-ancestor", ancestor, descendant]);
    return true;
  } catch {
    return false;
  }
}

interface WorktreeCapture {
  digest: string;
  clean: boolean;
}

async function captureWorktree(root: string): Promise<WorktreeCapture> {
  const [status, index, trackedChanges, untracked] = await Promise.all([
    runGit(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
    runGit(root, ["ls-files", "--stage", "-z"]),
    runGit(root, ["diff", "--name-only", "-z", "--diff-filter=ACDMRTUXB"]),
    runGit(root, ["ls-files", "--others", "--exclude-standard", "-z"]),
  ]);
  const entries = [...new Set([...nulList(trackedChanges), ...nulList(untracked)])].sort();
  const hash = createHash("sha256");
  hash.update("index\0").update(index).update("\0status\0").update(status);
  for (const relative of entries) {
    hash.update("\0path\0").update(relative).update("\0content\0");
    await hashContainedPath(hash, root, relative);
  }
  return { digest: hash.digest("hex"), clean: status.length === 0 };
}

async function hashContainedPath(
  hash: ReturnType<typeof createHash>,
  root: string,
  relative: string,
) {
  if (!relative || path.isAbsolute(relative) || relative.split(/[\\/]/).includes("..")) {
    throw new RepositoryUnverifiableError("Git returned an unsafe workspace path.");
  }
  const absolute = path.resolve(root, relative);
  const contained = path.relative(root, absolute);
  if (contained.startsWith("..") || path.isAbsolute(contained)) {
    throw new RepositoryUnverifiableError("Git returned a path outside the repository.");
  }
  let stat;
  try {
    stat = await fs.lstat(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      hash.update("deleted");
      return;
    }
    throw error;
  }
  if (stat.isSymbolicLink()) {
    hash.update("symlink\0").update(await fs.readlink(absolute));
    return;
  }
  if (!stat.isFile()) throw new RepositoryUnverifiableError("Workspace entry is not a file.");
  hash.update(`file\0${stat.mode & 0o111 ? "executable" : "regular"}\0`);
  const handle = await fs.open(absolute, "r");
  try {
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
  } finally {
    await handle.close();
  }
}

function nulList(value: Buffer): string[] {
  return value
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map((entry) => entry.replace(/\\/g, "/"));
}

function normalizeRemoteIdentity(remote: string): string {
  const trimmed = remote.trim();
  try {
    const url = new URL(trimmed);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    url.protocol = url.protocol.toLowerCase();
    url.hostname = url.hostname.toLowerCase();
    url.pathname = url.pathname.replace(/\.git\/?$/i, "").replace(/\/$/, "");
    return url.toString();
  } catch {
    const scp = /^(?:[^@/:]+@)?([^:]+):(.+)$/.exec(trimmed);
    if (scp) return `${scp[1]!.toLowerCase()}:${scp[2]!.replace(/\.git\/?$/i, "")}`;
    return `local:${sha256(trimmed.replace(/\\/g, "/"))}`;
  }
}

function constantTimeHexEqual(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(left) || !/^[a-f0-9]{64}$/.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

async function gitText(cwd: string, args: string[]): Promise<string> {
  try {
    return (await runGit(cwd, args)).toString("utf8").trim();
  } catch {
    throw new RepositoryUnverifiableError();
  }
}

async function tryGitText(cwd: string, args: string[]): Promise<string | null> {
  try {
    return (await runGit(cwd, args)).toString("utf8").trim() || null;
  } catch {
    return null;
  }
}

function runGit(cwd: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      { cwd, encoding: "buffer", timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout));
      },
    );
  });
}
