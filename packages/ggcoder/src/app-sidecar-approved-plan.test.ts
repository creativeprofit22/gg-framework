import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { persistApprovedPlanSnapshot } from "./app-sidecar-approved-plan.js";
import {
  hashPlanContent,
  isApprovedPlanArtifact,
  type PersistedPlanReviewCheckpoint,
} from "./app-sidecar-plan-gate.js";

const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gg-approved-plan-"));
  roots.push(root);
  return root;
}

function approvedCheckpoint(content: string): PersistedPlanReviewCheckpoint {
  return {
    version: 1,
    checkpointId: "e750ee71-b874-4a7f-998c-9ff0a9a141c0",
    generation: 1,
    planPath: "/project/.gg/plans/sitebench.md",
    content,
    contentHash: hashPlanContent(content),
    state: "human-approved",
    reviewStatus: "ready",
    actor: "user",
    timestamp: "2026-08-13T12:00:00.000Z",
    feedback: null,
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("persistApprovedPlanSnapshot", () => {
  it("writes an unambiguously approved artifact instead of copying Draft status", async () => {
    const root = await temporaryRoot();
    const plan = approvedCheckpoint(
      "# Site Bench plan\n\n**Status:** Draft\n\n## Steps\n\n1. Implement.\n",
    );

    const approvedPath = await persistApprovedPlanSnapshot(root, plan);
    const artifact = await fs.readFile(approvedPath, "utf8");

    expect(isApprovedPlanArtifact(artifact)).toBe(true);
    expect(artifact).toContain("**Status:** Approved");
  });

  it("repairs an exact legacy approved copy that still says Draft", async () => {
    const root = await temporaryRoot();
    const plan = approvedCheckpoint("# Site Bench plan\n\n**Status:** Draft\n");
    const approvedDirectory = path.join(root, ".gg", "plans", "approved");
    const approvedPath = path.join(approvedDirectory, `${plan.checkpointId}.md`);
    await fs.mkdir(approvedDirectory, { recursive: true });
    await fs.writeFile(approvedPath, plan.content, "utf8");

    await expect(persistApprovedPlanSnapshot(root, plan)).resolves.toBe(approvedPath);
    expect(isApprovedPlanArtifact(await fs.readFile(approvedPath, "utf8"))).toBe(true);
  });

  it("refuses to overwrite an unproven collision", async () => {
    const root = await temporaryRoot();
    const plan = approvedCheckpoint("# Reviewed plan\n");
    const approvedDirectory = path.join(root, ".gg", "plans", "approved");
    const approvedPath = path.join(approvedDirectory, `${plan.checkpointId}.md`);
    await fs.mkdir(approvedDirectory, { recursive: true });
    await fs.writeFile(approvedPath, "# Different plan\n", "utf8");

    await expect(persistApprovedPlanSnapshot(root, plan)).rejects.toThrow(
      "Approved plan snapshot path contains different content",
    );
  });
});
