import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { approvedPlanArtifactContent } from "./app-sidecar-plan-gate.js";
import {
  captureGitWorkspaceSnapshot,
  captureRepositoryIdentity,
  createApprovedPlan,
  isEvidenceCurrent,
  isLegacyPlanImportEligible,
  planStepId,
  reconcilePlanSteps,
  resolveExecutionPlanSnapshot,
  sha256,
  workspaceSnapshotsEqual,
} from "./roadmap-phase-execution.js";

let repository: string;

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: repository, encoding: "utf8" }).trim();
}

beforeEach(async () => {
  repository = await fs.mkdtemp(path.join(os.tmpdir(), "gg-roadmap-execution-"));
  git("init", "--quiet");
  git("config", "user.name", "Roadmap Test");
  git("config", "user.email", "roadmap@example.invalid");
  await fs.writeFile(path.join(repository, "tracked.txt"), "initial\n");
  git("add", "tracked.txt");
  git("commit", "--quiet", "-m", "initial");
});

afterEach(async () => {
  await fs.rm(repository, { recursive: true, force: true });
});

describe("durable roadmap workspace snapshots", () => {
  it("captures deterministic clean, staged, unstaged, and untracked content", async () => {
    const clean = await captureGitWorkspaceSnapshot(repository, "project-key");
    expect(clean.clean).toBe(true);
    expect(clean.headCommit).toBe(git("rev-parse", "HEAD"));

    await fs.writeFile(path.join(repository, "untracked.txt"), "one\n");
    const untracked = await captureGitWorkspaceSnapshot(repository, "project-key");
    expect(untracked.clean).toBe(false);
    expect(untracked.worktreeDigest).not.toBe(clean.worktreeDigest);

    await fs.writeFile(path.join(repository, "untracked.txt"), "two\n");
    const changedUntracked = await captureGitWorkspaceSnapshot(repository, "project-key");
    expect(changedUntracked.worktreeDigest).not.toBe(untracked.worktreeDigest);

    await fs.writeFile(path.join(repository, "tracked.txt"), "unstaged\n");
    const unstaged = await captureGitWorkspaceSnapshot(repository, "project-key");
    git("add", "tracked.txt");
    const staged = await captureGitWorkspaceSnapshot(repository, "project-key");
    expect(staged.worktreeDigest).not.toBe(unstaged.worktreeDigest);
  });

  it("does not bind repository identity to rotating URL credentials", async () => {
    git("remote", "add", "origin", "https://first:secret@example.com/owner/repo.git");
    const first = await captureRepositoryIdentity(repository, "project-key");
    git("remote", "set-url", "origin", "https://second:changed@example.com/owner/repo.git");
    const second = await captureRepositoryIdentity(repository, "project-key");
    expect(second).toEqual(first);
    expect(JSON.stringify(first)).not.toContain("secret");
  });
});

describe("durable roadmap plan reconciliation", () => {
  it("creates stable plan and step identities", () => {
    const input = {
      planId: "plan-1",
      content:
        "# Plan\n\n## Steps\n\n1. Implement durable snapshots\n2. Verify exact reconciliation\n",
      snapshotPath: ".gg/plans/approved/plan-1.md",
      approvedAt: "2026-08-30T10:00:00.000Z",
      approvedRevision: 4,
      baseCommit: "a".repeat(40),
    };
    const first = createApprovedPlan(input);
    const second = createApprovedPlan(input);
    expect(second).toEqual(first);
    expect(first.steps.map((step) => step.id)).toEqual([
      planStepId("plan-1", 1, "Implement durable snapshots"),
      planStepId("plan-1", 2, "Verify exact reconciliation"),
    ]);
  });

  it("preserves clean ancestor and exact dirty steps, invalidating uncertain work", async () => {
    const clean = await captureGitWorkspaceSnapshot(repository, "project-key");
    const cleanStep = {
      id: "1".repeat(64),
      index: 1,
      text: "Clean step",
      state: "completed" as const,
      completedAt: "2026-08-30T10:00:00.000Z",
      workspace: clean,
    };
    await fs.writeFile(path.join(repository, "descendant.txt"), "descendant\n");
    git("add", "descendant.txt");
    git("commit", "--quiet", "-m", "descendant");
    const descendant = await captureGitWorkspaceSnapshot(repository, "project-key");
    const preserved = reconcilePlanSteps(
      [cleanStep],
      descendant,
      (ancestor, current) => ancestor === clean.headCommit && current === descendant.headCommit,
    );
    expect(preserved.needsRevalidation).toEqual([]);

    await fs.writeFile(path.join(repository, "dirty.txt"), "dirty\n");
    const dirty = await captureGitWorkspaceSnapshot(repository, "project-key");
    const dirtyStep = { ...cleanStep, workspace: dirty };
    expect(reconcilePlanSteps([dirtyStep], dirty, () => false).needsRevalidation).toEqual([]);

    await fs.writeFile(path.join(repository, "dirty.txt"), "changed\n");
    const changed = await captureGitWorkspaceSnapshot(repository, "project-key");
    const invalidated = reconcilePlanSteps([dirtyStep], changed, () => false);
    expect(invalidated.steps[0]!.state).toBe("needs-revalidation");
    expect(invalidated.needsRevalidation).toEqual([dirtyStep.id]);
  });

  it("requires final evidence on the exact classifier, workspace, and safe environment", async () => {
    const workspace = await captureGitWorkspaceSnapshot(repository, "project-key");
    const legacyEvidence = {
      commandHash: "1".repeat(64),
      commandDisplay: "pnpm test",
      exitCode: 0,
      classifierVersion: "roadmap-v1",
      verdict: "approved" as const,
      criterionId: "1".repeat(64),
      observedAt: "2026-08-30T10:00:00.000Z",
      workspace,
    };
    const evidence = {
      ...legacyEvidence,
      version: 2 as const,
      executionId: "execution-1",
      cwd: repository,
      safeToolEnvironmentDigest: "2".repeat(64),
    };
    expect(isEvidenceCurrent(evidence, workspace, "roadmap-v1", "2".repeat(64))).toBe(true);
    expect(isEvidenceCurrent(legacyEvidence, workspace, "roadmap-v1", "2".repeat(64))).toBe(false);
    expect(workspaceSnapshotsEqual(workspace, workspace)).toBe(true);
    expect(isEvidenceCurrent(evidence, workspace, "roadmap-v2", "2".repeat(64))).toBe(false);
    expect(isEvidenceCurrent(evidence, workspace, "roadmap-v1", "3".repeat(64))).toBe(false);
  });

  it("rejects the exact revision-105 phase-4 plan from phase 5", () => {
    const fixture = {
      roadmapRevision: 105,
      headCommit: "8129df7e152e89fce45aa7320cae60d2e7492dfb",
      projectKey: "c:/ggcoder-projects/gg-framework-fork",
      phaseId: "a639ff7d-64bf-4abe-a38e-cf6cae0acac2",
      phaseSessionPath: "C:/sessions/phase-5.jsonl",
      currentSessionPath: "C:/sessions/phase-5.jsonl",
      planId: "5ab5bc79-2d1b-4578-b6d3-7035a4723a91",
      planState: "implementation-prompt-started" as const,
      planProjectKey: "c:/ggcoder-projects/gg-framework-fork",
      planPhaseId: "phase-4",
      planSessionPath: "C:/sessions/phase-4.jsonl",
    };
    expect(fixture.roadmapRevision).toBe(105);
    expect(fixture.headCommit).toBe("8129df7e152e89fce45aa7320cae60d2e7492dfb");
    expect(isLegacyPlanImportEligible(fixture)).toBe(false);
    expect(
      isLegacyPlanImportEligible({
        ...fixture,
        planPhaseId: fixture.phaseId,
        planSessionPath: fixture.phaseSessionPath,
      }),
    ).toBe(true);
  });
});

describe("approved plan snapshot resume", () => {
  const rawPlan = "# Plan\n\n## Steps\n\n1. Resume only the approved artifact\n";
  const artifact = approvedPlanArtifactContent(rawPlan);
  const relativePath = ".gg/plans/approved/plan-resume.md";

  function plan() {
    return createApprovedPlan({
      planId: "plan-resume",
      content: artifact,
      snapshotPath: relativePath,
      approvedAt: "2026-08-31T10:00:00.000Z",
      approvedRevision: 5,
      baseCommit: "a".repeat(40),
    });
  }

  function recovery(planPhaseId = "phase-1") {
    return {
      projectKey: "project-key",
      phaseId: "phase-1",
      phaseSessionPath: "C:/sessions/phase-1.jsonl",
      currentSessionPath: "C:/sessions/phase-1.jsonl",
      planId: "plan-resume",
      checkpointId: "plan-resume",
      planState: "implementation-prompt-started" as const,
      planProjectKey: "project-key",
      planPhaseId,
      planSessionPath: "C:/sessions/phase-1.jsonl",
      content: rawPlan,
      contentHash: sha256(rawPlan),
    };
  }

  it("hydrates the exact canonical artifact", async () => {
    const snapshotPath = path.join(await fs.realpath(repository), relativePath);
    await fs.mkdir(path.dirname(snapshotPath), { recursive: true });
    await fs.writeFile(snapshotPath, artifact);

    await expect(resolveExecutionPlanSnapshot({ cwd: repository, plan: plan() })).resolves.toEqual({
      status: "ready",
      path: snapshotPath,
      content: artifact,
      recovered: false,
    });
  });

  it("requires reconciliation when canonical bytes are tampered", async () => {
    const snapshotPath = path.join(await fs.realpath(repository), relativePath);
    await fs.mkdir(path.dirname(snapshotPath), { recursive: true });
    await fs.writeFile(snapshotPath, `${artifact}\nTampered`);

    await expect(resolveExecutionPlanSnapshot({ cwd: repository, plan: plan() })).resolves.toEqual({
      status: "reconciliation-required",
      path: snapshotPath,
    });
  });

  it("recovers a missing artifact from matching active legacy consumption", async () => {
    const snapshotPath = path.join(await fs.realpath(repository), relativePath);
    await fs.mkdir(path.dirname(snapshotPath), { recursive: true });

    await expect(
      resolveExecutionPlanSnapshot({ cwd: repository, plan: plan(), recovery: recovery() }),
    ).resolves.toEqual({ status: "ready", path: snapshotPath, content: artifact, recovered: true });
    await expect(fs.readFile(snapshotPath, "utf8")).resolves.toBe(artifact);
  });

  it("denies recovery from another phase", async () => {
    const snapshotPath = path.join(await fs.realpath(repository), relativePath);
    await fs.mkdir(path.dirname(snapshotPath), { recursive: true });

    await expect(
      resolveExecutionPlanSnapshot({
        cwd: repository,
        plan: plan(),
        recovery: recovery("phase-2"),
      }),
    ).resolves.toEqual({ status: "plan-snapshot-missing", path: snapshotPath });
    await expect(fs.stat(snapshotPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects snapshot paths outside the project", async () => {
    const unsafePlan = { ...plan(), snapshotPath: "../outside.md" };
    await expect(
      resolveExecutionPlanSnapshot({ cwd: repository, plan: unsafePlan }),
    ).resolves.toEqual({ status: "reconciliation-required", path: "../outside.md" });
  });
});
