import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  validateNotesDocumentV3,
  type ProjectNotesSnapshot,
} from "@kenkaiiii/gg-core/project-notes";
import {
  createManualCompletionApprovalService,
  type ManualCompletionApprovalSession,
} from "./app-sidecar-manual-completion-approval.js";
import { ProjectNotesRepository } from "./project-notes-repository.js";

const roots: string[] = [];
const sessionLink = { sessionId: "session-1", sessionPath: "/sessions/1.jsonl" };

async function setup(name: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `gg-manual-approval-${name}-`));
  roots.push(root);
  const cwd = path.join(root, "project");
  const repository = new ProjectNotesRepository(path.join(root, "agent"));
  const raw = JSON.parse(
    await fs.readFile(new URL("../../../fixtures/project-notes-v3.json", import.meta.url), "utf8"),
  ) as unknown;
  const validation = validateNotesDocumentV3(raw);
  if (!validation.ok) throw new Error(`Invalid fixture: ${validation.error.path}`);
  const document = structuredClone(validation.document);
  const phase = document.phases[0]!;
  phase.id = "phase-1";
  phase.status = "in-progress";
  phase.doneWhen = ["Focused tests pass"];
  phase.session = sessionLink;
  phase.reminder = null;
  phase.attentionReason = null;
  phase.completedAt = null;
  phase.archivedAt = null;
  phase.overrides.status = null;
  phase.pendingAutomaticLifecycleTransition = null;
  phase.lifecycleEvents = [];
  phase.roadmapEvents = [];
  document.phases = [phase];
  await repository.migrate(cwd, document);
  await repository.recordImplementationCheckpoint(cwd, {
    checkpointId: "implementation-1",
    phaseId: "phase-1",
    expectedSession: sessionLink,
    planStepTotal: 1,
    completedPlanSteps: [1],
    runOutcome: "succeeded",
    timestamp: "2026-08-27T20:00:00.000Z",
  });
  await repository.recordRoadmapStatusUpdate(cwd, {
    updateId: "verification-1",
    phaseId: "phase-1",
    actor: "gg-coder",
    transition: "review",
    progress: "Focused verification passed",
    blocker: null,
    requiredExternalAction: null,
    evidence: ["pnpm test"],
    verification: "passed",
    verificationReason: null,
    proposedReferences: [],
    timestamp: "2026-08-27T20:01:00.000Z",
    expectedSession: sessionLink,
    requireBoundPhase: true,
    autopilotEnabled: false,
  });
  const session: ManualCompletionApprovalSession = {
    getState: () => ({ cwd, ...sessionLink }),
  };
  return { cwd, repository, session };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("manual completion approval service", () => {
  it("previews current evidence, commits once, and publishes the authoritative snapshot", async () => {
    const { cwd, repository, session } = await setup("commit");
    const committedSnapshots: ProjectNotesSnapshot[] = [];
    const service = createManualCompletionApprovalService({
      repository,
      now: () => Date.parse("2026-08-27T20:02:00.000Z"),
      idFactory: () => "nonce-1",
      onCommittedSnapshot: (snapshot) => committedSnapshots.push(snapshot),
    });

    const preview = await service.preview(
      { version: 1, phaseId: "phase-1", expectedRevision: 3 },
      session,
    );
    expect(preview).toMatchObject({
      status: "ready",
      checkpoint: {
        nonce: "nonce-1",
        revision: 3,
        session: sessionLink,
        implementationCheckpointId: "implementation-1",
        verificationStatusUpdateId: "verification-1",
      },
    });
    await expect(
      service.commit({ version: 1, nonce: "nonce-1", confirmed: true }),
    ).resolves.toEqual({
      status: "committed",
      revision: 4,
      phaseId: "phase-1",
      approvalId: "manual-approval-nonce-1",
    });
    expect(committedSnapshots).toHaveLength(1);
    expect(committedSnapshots[0]).toMatchObject({
      revision: 4,
      document: { phases: [{ status: "done" }] },
    });
    const loaded = await repository.load(cwd);
    expect(loaded).toMatchObject({
      status: "ok",
      snapshot: { revision: 4, document: { phases: [{ status: "done" }] } },
    });
    if (loaded.status !== "ok") throw new Error("Expected completed fixture");
    expect(
      loaded.snapshot.document.phases[0]!.roadmapEvents.filter(
        (event) => event.type === "manual-completion-approval",
      ),
    ).toEqual([
      expect.objectContaining({
        type: "manual-completion-approval",
        authority: "native-user",
      }),
    ]);
    await expect(
      service.commit({ version: 1, nonce: "nonce-1", confirmed: true }),
    ).resolves.toEqual({ status: "nonce-not-found" });
    expect(committedSnapshots).toHaveLength(1);
  });

  it("rejects preview when current evidence belongs to an in-progress phase", async () => {
    const { cwd, repository, session } = await setup("in-progress");
    await expect(
      repository.recordPhaseLifecycleTransition(cwd, "phase-1", {
        status: "in-progress",
        source: "agent",
        reason: "Implementation resumed",
        timestamp: "2026-08-27T20:02:00.000Z",
        kind: "other",
        expectedSession: sessionLink,
      }),
    ).resolves.toMatchObject({ status: "ok", snapshot: { revision: 4 } });
    const service = createManualCompletionApprovalService({ repository });

    await expect(
      service.preview({ version: 1, phaseId: "phase-1", expectedRevision: 4 }, session),
    ).resolves.toEqual({ status: "unmet-gate", revision: 4, code: "inactive-phase" });
  });

  it("rejects every revision race without publishing and requires a fresh preview", async () => {
    const { cwd, repository, session } = await setup("stale");
    const onCommittedSnapshot = vi.fn();
    const service = createManualCompletionApprovalService({
      repository,
      now: () => Date.parse("2026-08-27T20:02:00.000Z"),
      idFactory: () => "nonce-stale",
      onCommittedSnapshot,
    });
    await service.preview({ version: 1, phaseId: "phase-1", expectedRevision: 3 }, session);
    const loaded = await repository.load(cwd);
    if (loaded.status !== "ok") throw new Error("Expected approval fixture");
    await repository.save(cwd, 3, loaded.snapshot.document);

    await expect(
      service.commit({ version: 1, nonce: "nonce-stale", confirmed: true }),
    ).resolves.toEqual({ status: "stale-revision", revision: 4 });
    await expect(repository.load(cwd)).resolves.toMatchObject({
      status: "ok",
      snapshot: { revision: 4, document: { phases: [{ status: "review" }] } },
    });
    expect(onCommittedSnapshot).not.toHaveBeenCalled();
  });

  it("serializes duplicate concurrent commits into one approval event and broadcast", async () => {
    const { cwd, repository, session } = await setup("duplicate");
    const onCommittedSnapshot = vi.fn();
    const service = createManualCompletionApprovalService({
      repository,
      now: () => Date.parse("2026-08-27T20:02:00.000Z"),
      idFactory: () => "nonce-race",
      onCommittedSnapshot,
    });
    await service.preview({ version: 1, phaseId: "phase-1", expectedRevision: 3 }, session);

    const outcomes = await Promise.all([
      service.commit({ version: 1, nonce: "nonce-race", confirmed: true }),
      service.commit({ version: 1, nonce: "nonce-race", confirmed: true }),
    ]);
    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(["committed", "duplicate"]);
    expect(onCommittedSnapshot).toHaveBeenCalledOnce();
    const loaded = await repository.load(cwd);
    if (loaded.status !== "ok") throw new Error("Expected completed fixture");
    expect(
      loaded.snapshot.document.phases[0]!.roadmapEvents.filter(
        (event) => event.type === "manual-completion-approval",
      ),
    ).toHaveLength(1);
  });

  it("expires previews and loses them on service restart", async () => {
    let now = Date.parse("2026-08-27T20:02:00.000Z");
    const { repository, session } = await setup("expiry");
    const service = createManualCompletionApprovalService({
      repository,
      now: () => now,
      ttlMs: 10,
      idFactory: () => "nonce-expiring",
    });
    await service.preview({ version: 1, phaseId: "phase-1", expectedRevision: 3 }, session);
    now += 11;
    await expect(
      service.commit({ version: 1, nonce: "nonce-expiring", confirmed: true }),
    ).resolves.toEqual({ status: "nonce-expired" });
    const restarted = createManualCompletionApprovalService({ repository });
    await expect(
      restarted.commit({ version: 1, nonce: "nonce-expiring", confirmed: true }),
    ).resolves.toEqual({ status: "nonce-not-found" });
  });
});
