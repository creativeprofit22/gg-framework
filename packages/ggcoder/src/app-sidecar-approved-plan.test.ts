import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import type { NotesDocumentV3 } from "@kenkaiiii/gg-core/project-notes";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectNotesRepository } from "./project-notes-repository.js";
import { createApprovedPlan } from "./roadmap-phase-execution.js";
import { AppSidecarPlanHandoff, type ApprovedPlanConsumptionIdentity } from "./app-sidecar-plan-handoff.js";
import { persistApprovedPlanSnapshot } from "./app-sidecar-approved-plan.js";
import {
  AppSidecarPlanGate,
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

// Execute the actual sidecar launch callback and its prompt declarations, without
// starting the HTTP server or a provider. Do not duplicate the generated message.
async function sidecarImplementationLaunch(bindings: Record<string, unknown>) {
  const source = await fs.readFile(new URL("./app-sidecar.ts", import.meta.url), "utf8");
  const file = ts.createSourceFile("app-sidecar.ts", source, ts.ScriptTarget.Latest, true);
  const declarations: string[] = [];
  let launch: string | undefined;
  function visit(node: ts.Node): void {
    if (ts.isVariableStatement(node) && node.declarationList.declarations.some(
      (declaration) => declaration.name.getText(file) === "IMPLEMENT_PLAN_PROMPT",
    )) declarations.push(node.getText(file));
    if (ts.isFunctionDeclaration(node) && node.name?.text === "currentImplementationPlanPrompt") {
      declarations.push(node.getText(file));
    }
    if (ts.isPropertyAssignment(node) && node.name.getText(file) === "launchImplementation") {
      expect(launch).toBeUndefined();
      launch = node.initializer.getText(file);
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  expect(launch).toBeDefined();
  expect(declarations.length).toBeGreaterThan(0);
  const compiled = ts.transpileModule(
    `(() => { ${declarations.join("\n")} return (${launch}); })()`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } },
  );
  return vm.runInNewContext(compiled.outputText, bindings) as
    (consumption: ApprovedPlanConsumptionIdentity) => Promise<void>;
}

describe("approved phase implementation message", () => {
  it.each([false, true])("requires user approval and avoids checkpoint ceremony (autopilot ready: %s)", async (autopilotReady) => {
    const cwd = await temporaryRoot();
    const repository = new ProjectNotesRepository(await temporaryRoot());
    const document = JSON.parse(await fs.readFile(
      new URL("../../../fixtures/project-notes-v3.json", import.meta.url), "utf8",
    )) as NotesDocumentV3;
    const phase = document.phases[0]!;
    await repository.migrate(cwd, document);
    const gate = new AppSidecarPlanGate([], async () => {});
    const checkpoint = await gate.submit("/plan.md", "# Plan\n\n## Steps\n\n1. Preserve requirement text\n2. Verify truthfully\n");
    if (autopilotReady) await gate.markReady(checkpoint.checkpointId, checkpoint.generation, "Ready for user review");
    let consumption: ApprovedPlanConsumptionIdentity | null = null;
    const runApprovedPlanImplementation = vi.fn(async (_prompt: string, _generation: number) => {});
    const launchImplementation = await sidecarImplementationLaunch({
      cwd,
      durableRoadmapExecution: true,
      notesRepository: repository,
      session: {
        getActivePhaseContext: () => ({ phase }),
        getApprovedPlanConsumption: () => consumption,
        runApprovedPlanImplementation,
      },
      planGate: gate,
      runClaim: { claim: () => true, release: () => {} },
      runLifecycle: { generation: 7 },
      commitActivePhaseImplementationStart: async () => {},
      runAgent: async (_prompt: string, run: () => Promise<void>) => run(),
    });
    const scheduled: Array<() => void> = [];
    const onLaunchFailure = vi.fn();
    const handoff = new AppSidecarPlanHandoff({
      approve: (id, generation) => gate.approve(id, generation),
      currentConsumption: () => consumption,
      commitApproval: async (approved) => {
        expect(approved).toMatchObject({ state: "human-approved", actor: "user", content: checkpoint.content });
        const approvedPath = await persistApprovedPlanSnapshot(cwd, approved);
        const plan = createApprovedPlan({
          planId: approved.checkpointId,
          content: await fs.readFile(approvedPath, "utf8"),
          snapshotPath: path.relative(cwd, approvedPath).split(path.sep).join("/"),
          approvedAt: approved.timestamp,
          approvedRevision: 2,
          baseCommit: "2".repeat(40),
        });
        await repository.approvePhaseExecutionPlan(cwd, {
          operationId: approved.checkpointId,
          phaseId: phase.id,
          expectedRevision: 1,
          repository: { projectKey: "project-key", identityHash: "1".repeat(64), rootCommit: "2".repeat(40) },
          plan,
          lastSession: phase.session,
        });
        const stored = await repository.load(cwd);
        expect(stored.status).toBe("ok");
        if (stored.status !== "ok") throw new Error("Stored phase plan unavailable");
        expect(stored.snapshot.document.phases[0]?.execution?.plan).toEqual(plan);
        consumption = { checkpointId: approved.checkpointId, generation: approved.generation, state: "approval-committed" };
        return consumption;
      },
      launchImplementation,
      schedule: (callback) => scheduled.push(callback),
      onLaunchFailure,
    });
    expect(gate.current()?.state).toBe("pending-review");
    expect(handoff.resumePending()).toBe(false);
    expect(await handoff.recoverApproved(gate.current())).toBe(false);
    expect(scheduled).toHaveLength(0);
    expect(runApprovedPlanImplementation).not.toHaveBeenCalled();

    // Both manual review and autopilot-ready review still require this user action.
    expect(await handoff.accept(checkpoint.checkpointId, checkpoint.generation)).toMatchObject({ status: "committed" });
    expect(scheduled).toHaveLength(1);
    scheduled[0]!();
    await vi.waitFor(() => expect(runApprovedPlanImplementation).toHaveBeenCalledOnce());
    expect(onLaunchFailure).not.toHaveBeenCalled();
    const [message, generation] = runApprovedPlanImplementation.mock.calls[0]!;
    expect(generation).toBe(7);
    expect(message).toContain("The plan has been approved. Implement it now");
    expect(message).not.toMatch(/before continuing|roadmap_checkpoint|expected_revision|stale-revision|retry|step_id=|plan_hash=/i);
  });
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
