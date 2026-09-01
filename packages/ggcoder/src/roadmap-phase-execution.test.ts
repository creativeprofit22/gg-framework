import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { approvedPlanArtifactContent } from "./app-sidecar-plan-gate.js";
import {
  captureGitWorkspaceSnapshot,
  createApprovedPlan,
  reconcilePlanSteps,
  resolveExecutionPlanSnapshot,
  sha256,
} from "./roadmap-phase-execution.js";

let repository: string;

beforeEach(async () => {
  repository = await fs.mkdtemp(path.join(os.tmpdir(), "gg-roadmap-execution-"));
});

afterEach(async () => {
  await fs.rm(repository, { recursive: true, force: true });
});

describe("durable roadmap plan reconciliation", () => {
  it("preserves clean ancestor and exact dirty steps, invalidating uncertain work", async () => {
    const git = (...args: string[]): string =>
      execFileSync("git", args, { cwd: repository, encoding: "utf8" }).trim();
    git("init", "--quiet");
    git("config", "user.name", "Roadmap Test");
    git("config", "user.email", "roadmap@example.invalid");
    await fs.writeFile(path.join(repository, "tracked.txt"), "initial\n");
    git("add", "tracked.txt");
    git("commit", "--quiet", "-m", "initial");

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
