import { createHash, timingSafeEqual } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  NotesApprovedPlanV1,
  NotesPlanStepV1,
  NotesRepositoryIdentityV1,
  NotesWorkspaceSnapshotV1,
} from "@kenkaiiii/gg-core";
import { approvedPlanArtifactContent } from "./app-sidecar-plan-gate.js";
import { isDeepStrictEqual } from "node:util";
import { extractPlanSteps } from "./utils/plan-steps.js";

import {
  createRoadmapGit,
  ROADMAP_SNAPSHOT_BUDGET_MS,
  RoadmapGitError,
  type RoadmapGit,
} from "./roadmap-git.js";
import {
  classifyRoadmapGitFailure,
  RepositoryUnverifiableError,
} from "./roadmap-repository-errors.js";

export { RepositoryUnverifiableError };

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
  return isDeepStrictEqual(left, right);
}

export async function captureGitWorkspaceSnapshot(
  cwd: string,
  projectKey: string,
): Promise<NotesWorkspaceSnapshotV1> {
  const deadlineMs = Date.now() + ROADMAP_SNAPSHOT_BUDGET_MS;
  const root = await gitText(
    createRoadmapGit(cwd, { deadlineMs }),
    ["rev-parse", "--show-toplevel"],
    "find the repository root",
  );
  if (!root) throw new RepositoryUnverifiableError("not-a-repository");
  const git = createRoadmapGit(root, { deadlineMs });
  const repository = await captureRepositoryIdentity(root, projectKey, git);
  const headCommit = await gitText(git, ["rev-parse", "HEAD"], "read HEAD");
  if (!/^[a-f0-9]{40}$/.test(headCommit)) throw new RepositoryUnverifiableError("no-commits");

  let prior = await captureWorktree(git, root);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const next = await captureWorktree(git, root);
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
  throw new RepositoryUnverifiableError("workspace-changing");
}

export async function captureRepositoryIdentity(
  cwd: string,
  projectKey: string,
  git: RoadmapGit = createRoadmapGit(cwd),
): Promise<NotesRepositoryIdentityV1> {
  const roots = (
    await gitText(git, ["rev-list", "--max-parents=0", "HEAD"], "read the commit history")
  )
    .split(/\r?\n/)
    .filter((value) => /^[a-f0-9]{40}$/.test(value))
    .sort();
  if (roots.length === 0) throw new RepositoryUnverifiableError("no-commits");
  const remote = await tryGitText(git, ["remote", "get-url", "origin"], "read the origin remote");
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
    await createRoadmapGit(cwd)(["merge-base", "--is-ancestor", ancestor, descendant]);
    return true;
  } catch {
    return false;
  }
}

interface WorktreeCapture {
  digest: string;
  clean: boolean;
}

async function captureWorktree(git: RoadmapGit, root: string): Promise<WorktreeCapture> {
  let status: Buffer;
  let index: Buffer;
  let trackedChanges: Buffer;
  let untracked: Buffer;
  try {
    [status, index, trackedChanges, untracked] = await Promise.all([
      git(["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
      git(["ls-files", "--stage", "-z"]),
      git(["diff", "--name-only", "-z", "--diff-filter=ACDMRTUXB"]),
      git(["ls-files", "--others", "--exclude-standard", "-z"]),
    ]);
  } catch (error) {
    throw classifyRoadmapGitFailure(error, "read the worktree");
  }
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
    throw new RepositoryUnverifiableError("unsafe-workspace", {
      message: "Git returned an unsafe workspace path.",
    });
  }
  const absolute = path.resolve(root, relative);
  const contained = path.relative(root, absolute);
  if (contained.startsWith("..") || path.isAbsolute(contained)) {
    throw new RepositoryUnverifiableError("unsafe-workspace", {
      message: "Git returned a path outside the repository.",
    });
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
  if (!stat.isFile()) {
    throw new RepositoryUnverifiableError("unsafe-workspace", {
      message: "Workspace entry is not a file.",
    });
  }
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

async function gitText(git: RoadmapGit, args: string[], step: string): Promise<string> {
  try {
    return (await git(args)).toString("utf8").trim();
  } catch (error) {
    throw classifyRoadmapGitFailure(error, step);
  }
}

// A missing remote is a real answer; a timeout must not silently change the repository identity.
async function tryGitText(git: RoadmapGit, args: string[], step: string): Promise<string | null> {
  try {
    return (await git(args)).toString("utf8").trim() || null;
  } catch (error) {
    if (error instanceof RoadmapGitError && error.kind === "exit") return null;
    throw classifyRoadmapGitFailure(error, step);
  }
}
