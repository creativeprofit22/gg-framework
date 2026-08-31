import { createHash, timingSafeEqual } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { NotesApprovedPlanV1 } from "@kenkaiiii/gg-core";
import { approvedPlanArtifactContent } from "./app-sidecar-plan-gate.js";
import { extractPlanSteps } from "./utils/plan-steps.js";

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

function constantTimeHexEqual(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(left) || !/^[a-f0-9]{64}$/.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}
