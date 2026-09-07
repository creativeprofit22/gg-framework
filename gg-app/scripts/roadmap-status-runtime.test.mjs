import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { AppSidecarRoadmapToolHost } from "../../packages/ggcoder/dist/app-sidecar-roadmap-tool-host.js";
import { AppSidecarRoadmapReconciliationCoordinator } from "../../packages/ggcoder/dist/app-sidecar-roadmap-reconciliation.js";
import { createAppSidecarPhaseBindingService } from "../../packages/ggcoder/dist/app-sidecar-phase-binding.js";
import { RoadmapPhaseLeaseRepository } from "../../packages/ggcoder/dist/roadmap-phase-lease-repository.js";
import { ProjectNotesRepository } from "../../packages/ggcoder/dist/project-notes-repository.js";
import { RoadmapStatusParams } from "../../packages/ggcoder/dist/tools/roadmap-status.js";

// Requires separately built artifacts. Never launches an app or touches live Notes.
test("runtime accepts explicit Done without an old session or execution bindings", async () => {
  const root = await mkdtemp(join(tmpdir(), "gg-roadmap-contract-runtime-"));
  try {
    const cwd = join(root, "project");
    const moduleUrl = new URL(
      "../../packages/ggcoder/dist/tools/roadmap-status.js",
      import.meta.url,
    );
    const moduleSource = await readFile(moduleUrl, "utf8");
    assert.match(moduleSource, /z\.preprocess/);
    console.log(
      JSON.stringify({
        runtimePid: process.pid,
        validator: fileURLToPath(moduleUrl),
        sha256: createHash("sha256").update(moduleSource).digest("hex"),
      }),
    );
    const repository = new ProjectNotesRepository(root);
    const historicalSession = {
      sessionId: randomUUID(),
      sessionPath: join(root, "historical.jsonl"),
    };
    const freshSession = { sessionId: randomUUID(), sessionPath: join(root, "fresh.jsonl") };
    const now = new Date().toISOString();
    const phase = {
      id: "isolated-contract-phase",
      title: "Isolated contract fixture",
      goal: "Inspect the fixture",
      doneWhen: ["One phase exists", "No tasks exist"],
      order: 0,
      status: "in-progress",
      sourcePrompt: "Synthetic test fixture only",
      referenceIds: [],
      session: historicalSession,
      reminder: null,
      attentionReason: null,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      archivedAt: null,
      overrides: { status: null, referenceIds: null },
      pendingAutomaticLifecycleTransition: null,
      lifecycleEvents: [],
      roadmapEvents: [],
    };
    assert.equal(
      (
        await repository.migrate(cwd, {
          version: 3,
          reference: "Isolated runtime fixture",
          currentFocus: "Inspect fixture",
          tasks: [],
          handoff: { text: "", updatedAt: null, readAt: null },
          updatedAt: now,
          legacyImportedAt: null,
          phases: [phase],
          references: [],
        })
      ).status,
      "ok",
    );
    const snapshot = await repository.load(cwd);
    assert.equal(snapshot.status, "ok");
    assert.equal(snapshot.snapshot.document.phases.length, 1);
    assert.equal(snapshot.snapshot.document.tasks.length, 0);
    const codingSession = {
      getActivePhaseContext: () => undefined,
      getMessages: () => [],
      getState: () => ({ ...freshSession, cwd }),
    };
    const binding = createAppSidecarPhaseBindingService({
      repository,
      leaseRepository: new RoadmapPhaseLeaseRepository(root),
      daemonInstanceId: randomUUID(),
      processId: process.pid,
      processStartToken: randomUUID(),
    });
    const host = new AppSidecarRoadmapToolHost({
      cwd,
      repository,
      durableExecution: true,
      reconciliations: new AppSidecarRoadmapReconciliationCoordinator(),
      projectAutopilot: { isEnabled: () => false },
      resolvePlanProgress: () => null,
      broadcastNotesSnapshot: () => {},
      mutateStatusWithLeaseFence: (phaseId, operation) =>
        binding.withStatusLease(codingSession, phaseId, operation),
    });
    const tool = host
      .createSessionTools("coding", () => codingSession)
      .find((item) => item.name === "roadmap_status");
    assert.ok(tool);
    const payload = RoadmapStatusParams.parse({
      update_id: randomUUID(),
      phase_id: phase.id,
      expected_revision: 1,
      progress: "Inspected the disposable fixture",
      evidence: ["Assertions confirmed one phase and no tasks"],
      proposed_references: null,
      transition: "done",
      blocker: null,
      required_external_action: null,
      verification: { result: "passed", reason: null },
      verification_bindings: null,
    });
    const context = { signal: new AbortController().signal, toolCallId: randomUUID() };
    const accepted = JSON.parse(String(await tool.execute(payload, context)));
    assert.equal(accepted.result, "committed");
    assert.equal(accepted.statusOutcome, "applied");
    const persisted = await repository.load(cwd);
    assert.equal(persisted.status, "ok");
    assert.equal(persisted.snapshot.document.phases[0].status, "done");
    assert.deepEqual(persisted.snapshot.document.phases[0].session, historicalSession);
    assert.equal(JSON.parse(String(await tool.execute(payload, context))).result, "duplicate");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
