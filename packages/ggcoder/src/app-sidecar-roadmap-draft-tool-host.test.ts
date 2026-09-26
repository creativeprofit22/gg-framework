import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { isRoadmapInspectionOutcome } from "@kenkaiiii/gg-core/roadmap-workflow";
import { ProjectNotesRepository } from "./project-notes-repository.js";
import type {
  NotesDocumentV3,
  NotesPhase,
  ProjectNotesLoadOutcome,
  RoadmapPhaseDraftRequest,
} from "@kenkaiiii/gg-core";
import {
  APP_SIDECAR_ROADMAP_DRAFT_SYSTEM_PROMPT,
  AppSidecarRoadmapDraftToolHost,
  projectRoadmapInspection,
} from "./app-sidecar-roadmap-draft-tool-host.js";
import { AppSidecarRoadmapDraftCoordinator } from "./app-sidecar-roadmap-drafts.js";

const timestamp = "2026-08-05T12:00:00.000Z";

function phase(overrides: Partial<NotesPhase> = {}): NotesPhase {
  return {
    id: "phase-1",
    title: "First phase",
    goal: "Ship bounded behavior",
    doneWhen: ["Focused tests pass"],
    order: 1,
    status: "review",
    sourcePrompt: "Implement the first phase.",
    referenceIds: [],
    session: { sessionId: "bound-session", sessionPath: null },
    reminder: null,
    attentionReason: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    completedAt: null,
    archivedAt: null,
    overrides: {
      status: { value: "review", source: "user", updatedAt: timestamp },
      referenceIds: null,
    },
    pendingAutomaticLifecycleTransition: null,
    lifecycleEvents: [],
    roadmapEvents: [
      {
        type: "status-update",
        id: "update-1",
        actor: "gg-coder",
        transition: "in-progress",
        progress: "Implementation complete",
        blocker: null,
        requiredExternalAction: null,
        evidence: ["pnpm test passed"],
        verification: "passed",
        verificationReason: null,
        verificationSession: { sessionId: "bound-session", sessionPath: null },
        statusOutcome: "applied",
        proposedReferences: [],
        timestamp,
      },
      {
        type: "completion-review",
        id: "review-1",
        reviewer: "ken",
        decision: "accepted",
        evidence: ["Reviewed tests"],
        reason: null,
        implementationCheckpointId: "checkpoint-1",
        verificationStatusUpdateId: "update-1",
        acceptsVerificationException: false,
        gateOutcome: "review",
        unmetGateCodes: ["missing-implementation"],
        timestamp,
      },
    ],
    ...overrides,
  };
}

function loaded(revision: number, phases = [phase()]): ProjectNotesLoadOutcome {
  const document: NotesDocumentV3 = {
    version: 3,
    reference: "",
    currentFocus: "",
    tasks: [],
    handoff: { text: "", updatedAt: null, readAt: null },
    updatedAt: timestamp,
    legacyImportedAt: null,
    phases,
    references: [],
  };
  return {
    status: "ok",
    snapshot: { projectKey: "/work/app", revision, document },
    recoveredFromBackup: false,
  };
}

const request: RoadmapPhaseDraftRequest = {
  expectedRevision: 4,
  summary: "Create the next peer phase",
  phases: [
    {
      title: "Next phase",
      goal: "Ship the next bounded behavior",
      doneWhen: ["Focused tests pass"],
      sourcePrompt: "Implement only the next phase.",
    },
  ],
};

function host(
  load: (cwd: string) => Promise<ProjectNotesLoadOutcome>,
  getSessionId: () => string = () => "session-1",
) {
  let sequence = 0;
  const drafts = new AppSidecarRoadmapDraftCoordinator({
    createId: () => `generated-${++sequence}`,
    now: () => timestamp,
  });
  return {
    drafts,
    value: new AppSidecarRoadmapDraftToolHost({
      cwd: "/work/app",
      repository: { load },
      drafts,
      getOwningSession: () => ({ getState: () => ({ sessionId: getSessionId() }) }),
    }),
  };
}

describe("projectRoadmapInspection", () => {
  it.each(["passed", "failed", "exception-requested"] as const)(
    "retains persisted %s evidence and provenance across a later progress-only update",
    async (verification) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "roadmap-inspection-"));
      try {
        const repository = new ProjectNotesRepository(root);
        const initial = loaded(1, [phase({ order: 0, roadmapEvents: [] })]);
        if (initial.status !== "ok") throw new Error("Expected fixture snapshot");
        const migrated = await repository.migrate("/work/app", initial.snapshot.document);
        expect(migrated.status, JSON.stringify(migrated)).toBe("ok");
        const report = {
          updateId: "verified-update",
          phaseId: "phase-1",
          actor: "gg-coder" as const,
          transition: "in-progress" as const,
          progress: "Focused verification report",
          blocker: null,
          requiredExternalAction: null,
          evidence: ["reports/focused-checks.md: bounded criteria results"],
          verification,
          verificationReason: verification === "passed" ? null : "Check unavailable or failed",
          proposedReferences: [],
          timestamp,
          expectedSession: { sessionId: "bound-session", sessionPath: null },
          requireBoundPhase: true,
          autopilotEnabled: false,
        };
        expect((await repository.recordRoadmapStatusUpdate("/work/app", report)).status).toBe(
          "committed",
        );
        expect(
          (
            await repository.recordRoadmapStatusUpdate("/work/app", {
              ...report,
              updateId: "later-progress",
              progress: "Later unrelated progress",
              evidence: ["Not verification evidence"],
              verification: null,
              verificationReason: null,
              timestamp: "2026-08-05T13:00:00.000Z",
            })
          ).status,
        ).toBe("committed");

        // A fresh repository and tool host must use persisted evidence, not session memory.
        const beforeInspection = await repository.load("/work/app");
        const fresh = host((cwd) => new ProjectNotesRepository(root).load(cwd)).value;
        const tool = fresh
          .createSessionTools()
          .find((candidate) => candidate.name === "roadmap_inspect")!;
        const outcome = JSON.parse((await tool.execute({}, {} as never)) as string);
        expect(isRoadmapInspectionOutcome(outcome)).toBe(true);
        expect(outcome.inspection.revision).toBe(3);
        expect(outcome.inspection.phases[0]).toMatchObject({
          status: "review",
          hasUserStatusOverride: true,
          latestProgress: "Later unrelated progress",
          latestVerification: {
            status: verification,
            reason: report.verificationReason,
            evidence: report.evidence,
            updateId: report.updateId,
            timestamp,
            progress: report.progress,
          },
        });
        const serialized = JSON.stringify(outcome);
        for (const hidden of [
          "sessionPath",
          "roadmapEvents",
          "sourcePrompt",
          "verificationSession",
          "currentFocus",
        ]) {
          expect(serialized).not.toContain(hidden);
        }
        expect(await repository.load("/work/app")).toEqual(beforeInspection);
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );

  it("returns no verification when there are no verification reports", () => {
    const outcome = projectRoadmapInspection(
      "/work/app",
      loaded(1, [phase({ roadmapEvents: [] })]),
    );
    expect(outcome).toMatchObject({
      status: "ok",
      inspection: { phases: [{ latestVerification: null }] },
    });
  });
  it("preserves maximum bounded evidence without aliasing stored events", () => {
    const source = phase();
    const report = source.roadmapEvents[0]!;
    if (report.type !== "status-update") throw new Error("Expected status fixture");
    report.evidence = Array.from({ length: 20 }, () => "x".repeat(4_096));
    report.progress = "p".repeat(4_096);
    const outcome = projectRoadmapInspection("/work/app", loaded(4, [source]));
    expect(isRoadmapInspectionOutcome(outcome)).toBe(true);
    if (outcome.status !== "ok") throw new Error("Expected inspection");
    expect(outcome.inspection.phases[0]!.latestVerification).toEqual({
      status: "passed",
      reason: null,
      evidence: report.evidence,
      updateId: report.id,
      timestamp,
      progress: report.progress,
    });
    expect(outcome.inspection.phases[0]!.latestVerification!.evidence).not.toBe(report.evidence);
  });

  it("returns a sorted bounded projection with latest summaries", () => {
    const outcome = projectRoadmapInspection(
      "/work/app",
      loaded(4, [phase({ id: "later", order: 2 }), phase({ id: "earlier", order: 1 })]),
    );

    expect(outcome).toMatchObject({
      status: "ok",
      inspection: {
        projectKey: "/work/app",
        revision: 4,
        phases: [
          {
            id: "earlier",
            hasBoundSession: true,
            latestProgress: "Implementation complete",
            latestVerification: {
              status: "passed",
              reason: null,
              evidence: ["pnpm test passed"],
              updateId: "update-1",
              timestamp,
              progress: "Implementation complete",
            },
            latestReview: { reviewer: "ken", decision: "accepted", reason: null },
            hasUserStatusOverride: true,
          },
          { id: "later" },
        ],
      },
    });
    expect(JSON.stringify(outcome)).not.toContain("sessionPath");
    expect(JSON.stringify(outcome)).not.toContain("roadmapEvents");
    expect(JSON.stringify(outcome)).not.toContain("sourcePrompt");
  });

  it("returns typed missing and corrupt outcomes", () => {
    expect(projectRoadmapInspection("/work/app", { status: "missing" })).toEqual({
      status: "missing",
      projectKey: "/work/app",
    });
    expect(
      projectRoadmapInspection("/work/app", {
        status: "corrupt",
        primary: "invalid-envelope",
        backup: "malformed-json",
      }),
    ).toEqual({
      status: "corrupt",
      projectKey: "/work/app",
      primary: "invalid-envelope",
      backup: "malformed-json",
    });
  });
});

describe("AppSidecarRoadmapDraftToolHost", () => {
  it("requires same-session inspection, rechecks revision, and publishes one draft", async () => {
    const load = vi.fn(async () => loaded(4));
    const { value, drafts } = host(load);

    await expect(value.draft(request)).resolves.toEqual({ status: "inspection-required" });
    await expect(value.inspect()).resolves.toMatchObject({
      status: "ok",
      inspection: { revision: 4 },
    });
    await expect(value.draft(request)).resolves.toMatchObject({
      status: "drafted",
      draft: { basedOnRevision: 4, createdBySessionId: "session-1" },
    });
    expect(load).toHaveBeenCalledTimes(2);
    expect(drafts.pending("/work/app")).toMatchObject({ basedOnRevision: 4 });
    expect(value.createSessionTools().map((tool) => tool.name)).toEqual([
      "roadmap_inspect",
      "roadmap_phase_draft",
    ]);
  });

  it("invalidates inspection when the logical session changes", async () => {
    const load = vi.fn(async () => loaded(4));
    let sessionId = "session-1";
    const { value, drafts } = host(load, () => sessionId);

    await expect(value.inspect()).resolves.toMatchObject({
      status: "ok",
      inspection: { revision: 4 },
    });
    sessionId = "session-2";
    await expect(value.draft(request)).resolves.toEqual({ status: "inspection-required" });
    expect(drafts.pending("/work/app")).toBeNull();

    await value.inspect();
    await expect(value.draft(request)).resolves.toMatchObject({
      status: "drafted",
      draft: { createdBySessionId: "session-2" },
    });
  });

  it("rejects caller and repository revision drift without publishing", async () => {
    const load = vi.fn().mockResolvedValueOnce(loaded(4)).mockResolvedValueOnce(loaded(5));
    const { value, drafts } = host(load);
    await value.inspect();

    await expect(value.draft({ ...request, expectedRevision: 3 })).resolves.toEqual({
      status: "inspection-revision-mismatch",
      inspectedRevision: 4,
      requestedRevision: 3,
    });
    await expect(value.draft(request)).resolves.toEqual({
      status: "stale-revision",
      expectedRevision: 4,
      currentRevision: 5,
    });
    expect(drafts.pending("/work/app")).toBeNull();
    await expect(value.draft(request)).resolves.toEqual({ status: "inspection-required" });
  });

  it("clears inspection on missing or corrupt rechecks", async () => {
    const load = vi.fn().mockResolvedValueOnce(loaded(4)).mockResolvedValueOnce({
      status: "corrupt",
      primary: "invalid-envelope",
      backup: "malformed-json",
    });
    const { value } = host(load);
    await value.inspect();
    await expect(value.draft(request)).resolves.toEqual({
      status: "notes-corrupt",
      primary: "invalid-envelope",
      backup: "malformed-json",
    });
    await expect(value.draft(request)).resolves.toEqual({ status: "inspection-required" });
  });

  it("states every app-only workflow boundary without keyword interception", () => {
    expect(APP_SIDECAR_ROADMAP_DRAFT_SYSTEM_PROMPT).toContain("roadmap_inspect");
    expect(APP_SIDECAR_ROADMAP_DRAFT_SYSTEM_PROMPT).toContain("explicit user approval");
    expect(APP_SIDECAR_ROADMAP_DRAFT_SYSTEM_PROMPT).toContain("flat peer phases");
    expect(APP_SIDECAR_ROADMAP_DRAFT_SYSTEM_PROMPT).toContain("roadmap_status");
    expect(APP_SIDECAR_ROADMAP_DRAFT_SYSTEM_PROMPT).toContain("ordinary coding requests");
  });
});
