import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  isRoadmapInspectionOutcome,
  isRoadmapPhaseCreateDraft,
  type RoadmapPhaseNotEditableReason,
} from "@kenkaiiii/gg-core/roadmap-workflow";
import { ProjectNotesRepository } from "./project-notes-repository.js";
import type {
  NotesDocumentV3,
  NotesPhase,
  ProjectNotesLoadOutcome,
  RoadmapPhaseDraftRequest,
  RoadmapPhaseEditRequest,
  RoadmapPhaseMoveRequest,
} from "@kenkaiiii/gg-core";
import {
  APP_SIDECAR_ROADMAP_DRAFT_SYSTEM_PROMPT,
  APP_SIDECAR_ROADMAP_PHASE_SYSTEM_PROMPT,
  AppSidecarRoadmapDraftToolHost,
  projectRoadmapInspection,
} from "./app-sidecar-roadmap-draft-tool-host.js";
import { AppSidecarRoadmapDraftCoordinator } from "./app-sidecar-roadmap-drafts.js";
import { ResearchSourceLedger } from "./core/research-sources.js";

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
  getActivePhaseId?: () => string | undefined,
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
      ...(getActivePhaseId ? { getActivePhaseId } : {}),
    }),
  };
}

describe("bound-phase inspection scope", () => {
  const twoPhases = (): ProjectNotesLoadOutcome =>
    loaded(4, [
      phase({ id: "phase-1", order: 1 }),
      phase({ id: "phase-2", order: 2, title: "Second phase" }),
    ]);

  it("returns only the active phase plus the current revision by default", async () => {
    const { value } = host(
      async () => twoPhases(),
      undefined,
      () => "phase-2",
    );
    const result = await value.inspect();
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.inspection.revision).toBe(4);
    expect(result.inspection.phases.map((candidate) => candidate.id)).toEqual(["phase-2"]);
  });

  it("returns every phase when the roadmap scope is requested or no phase is bound", async () => {
    const bound = host(
      async () => twoPhases(),
      undefined,
      () => "phase-2",
    ).value;
    const full = await bound.inspect({ scope: "roadmap" });
    const unbound = await host(
      async () => twoPhases(),
      undefined,
      () => undefined,
    ).value.inspect({
      scope: "active-phase",
    });
    for (const result of [full, unbound]) {
      expect(result.status).toBe("ok");
      if (result.status !== "ok") continue;
      expect(result.inspection.phases.map((candidate) => candidate.id)).toEqual([
        "phase-1",
        "phase-2",
      ]);
    }
  });

  it("refuses to draft from an active-phase slice and accepts after a full inspection", async () => {
    const { value } = host(
      async () => twoPhases(),
      undefined,
      () => "phase-2",
    );
    await value.inspect();
    expect(await value.draft(request)).toEqual({
      status: "inspection-required",
      message:
        'Drafting needs every current phase. Call roadmap_inspect with scope "roadmap", then retry with its revision.',
    });

    await value.inspect({ scope: "roadmap" });
    expect((await value.draft(request)).status).toBe("drafted");
  });
});

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

    await expect(value.draft(request)).resolves.toEqual({
      status: "inspection-required",
      message: 'Call roadmap_inspect with scope "roadmap" first, then retry with its revision.',
    });
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
      "roadmap_phase_edit",
      "roadmap_phase_move",
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
    await expect(value.draft(request)).resolves.toEqual({
      status: "inspection-required",
      message: 'Call roadmap_inspect with scope "roadmap" first, then retry with its revision.',
    });
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
    await expect(value.draft(request)).resolves.toEqual({
      status: "inspection-required",
      message: 'Call roadmap_inspect with scope "roadmap" first, then retry with its revision.',
    });
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
    await expect(value.draft(request)).resolves.toEqual({
      status: "inspection-required",
      message: 'Call roadmap_inspect with scope "roadmap" first, then retry with its revision.',
    });
  });

  it("returns drafts that omit corpus code retrieved by the owning session", async () => {
    const ledger = new ResearchSourceLedger();
    ledger.recordCorpusResult(
      { action: "search" },
      JSON.stringify({
        matches: [
          {
            repo: "vercel/turborepo",
            url: "https://github.com/vercel/turborepo/blob/c42dc5320e1e62342d6cde0a05b8f027627f1412/a.ts#L8",
          },
        ],
      }),
    );
    let sequence = 0;
    const drafts = new AppSidecarRoadmapDraftCoordinator({
      createId: () => `generated-${++sequence}`,
      now: () => timestamp,
    });
    const value = new AppSidecarRoadmapDraftToolHost({
      cwd: "/work/app",
      repository: { load: async () => loaded(4) },
      drafts,
      getOwningSession: () => ({
        getState: () => ({ sessionId: "session-1" }),
        researchSources: ledger,
      }),
    });
    await value.inspect();

    const rejected = await value.draft(request);
    expect(rejected).toMatchObject({ status: "citations-required" });
    expect(JSON.stringify(rejected)).toContain("vercel/turborepo");
    expect(drafts.pending("/work/app")).toBeNull();

    await expect(
      value.draft({
        ...request,
        sourcesNotCited: "Corpus results only confirmed the local design.",
      }),
    ).resolves.toMatchObject({ status: "drafted" });
    expect(drafts.pending("/work/app")).toMatchObject({
      sourcesNotCited: "Corpus results only confirmed the local design.",
    });
    expect(ledger.isEmpty()).toBe(true);
  });

  it("states every app-only workflow boundary without keyword interception", () => {
    expect(APP_SIDECAR_ROADMAP_DRAFT_SYSTEM_PROMPT).toContain("roadmap_inspect");
    expect(APP_SIDECAR_ROADMAP_DRAFT_SYSTEM_PROMPT).toContain("explicit user approval");
    expect(APP_SIDECAR_ROADMAP_DRAFT_SYSTEM_PROMPT).toContain("flat peer phases");
    expect(APP_SIDECAR_ROADMAP_DRAFT_SYSTEM_PROMPT).toContain("roadmap_status");
    expect(APP_SIDECAR_ROADMAP_DRAFT_SYSTEM_PROMPT).toContain("ordinary coding requests");
    expect(APP_SIDECAR_ROADMAP_DRAFT_SYSTEM_PROMPT).toContain("proposed_references");
  });
});

describe("roadmap_phase_edit proposals", () => {
  const editRequest: RoadmapPhaseEditRequest = {
    expectedRevision: 4,
    summary: "Narrow the first phase",
    phaseId: "phase-1",
    goal: "Ship narrower behavior",
  };
  const twoPhases = (revision = 4, first: Partial<NotesPhase> = {}): ProjectNotesLoadOutcome =>
    loaded(revision, [
      phase({ id: "phase-1", order: 1, ...first }),
      phase({ id: "phase-2", order: 2, title: "Second phase" }),
    ]);

  it("requires a prior inspection and creates an edit draft with only changed fields", async () => {
    const { value, drafts } = host(async () => twoPhases());

    await expect(value.proposeEdit(editRequest)).resolves.toMatchObject({
      status: "inspection-required",
    });
    expect(drafts.pending("/work/app")).toBeNull();

    await value.inspect();
    await expect(
      value.proposeEdit({ ...editRequest, title: "First phase" }),
    ).resolves.toMatchObject({
      status: "drafted",
      draft: {
        kind: "edit",
        phaseId: "phase-1",
        phaseTitle: "First phase",
        basedOnRevision: 4,
        basedOnUpdatedAt: timestamp,
        createdBySessionId: "session-1",
        changes: [
          { field: "goal", before: "Ship bounded behavior", after: "Ship narrower behavior" },
        ],
      },
    });
    expect(drafts.pending("/work/app")).toMatchObject({ kind: "edit", status: "pending" });
  });

  it("rejects revision mismatches and stale Notes without drafting", async () => {
    let revision = 4;
    const { value, drafts } = host(async () => twoPhases(revision));
    await value.inspect();

    await expect(value.proposeEdit({ ...editRequest, expectedRevision: 3 })).resolves.toEqual({
      status: "inspection-revision-mismatch",
      inspectedRevision: 4,
      requestedRevision: 3,
    });

    revision = 5;
    await expect(value.proposeEdit(editRequest)).resolves.toEqual({
      status: "stale-revision",
      expectedRevision: 4,
      currentRevision: 5,
    });
    // A stale revision clears the inspection, so the next attempt must re-inspect.
    await expect(value.proposeEdit(editRequest)).resolves.toMatchObject({
      status: "inspection-required",
    });
    expect(drafts.pending("/work/app")).toBeNull();
  });

  it.each<[RoadmapPhaseNotEditableReason, Partial<NotesPhase>]>([
    ["done", { status: "done", completedAt: timestamp }],
    ["archived", { archivedAt: timestamp }],
    ["deleted", { deletion: { version: 1, currentDeletionId: "deletion-1", events: [] } }],
  ])("rejects %s phases", async (reason, overrides) => {
    const { value, drafts } = host(async () => twoPhases(4, overrides));
    await value.inspect();
    await expect(value.proposeEdit(editRequest)).resolves.toEqual({
      status: "phase-not-editable",
      phaseId: "phase-1",
      reason,
    });
    expect(drafts.pending("/work/app")).toBeNull();
  });

  it("rejects missing phases and reports unchanged edits", async () => {
    const { value, drafts } = host(async () => twoPhases());
    await value.inspect();
    await expect(value.proposeEdit({ ...editRequest, phaseId: "phase-404" })).resolves.toEqual({
      status: "phase-not-editable",
      phaseId: "phase-404",
      reason: "missing",
    });
    await expect(
      value.proposeEdit({ ...editRequest, goal: "Ship bounded behavior" }),
    ).resolves.toEqual({ status: "no-changes", phaseId: "phase-1" });
    expect(drafts.pending("/work/app")).toBeNull();
  });

  it("limits an active-phase inspection to edits of the active phase", async () => {
    const { value, drafts } = host(
      async () => twoPhases(),
      () => "session-1",
      () => "phase-1",
    );
    await value.inspect();
    await expect(
      value.proposeEdit({ ...editRequest, phaseId: "phase-2", goal: "Other goal" }),
    ).resolves.toMatchObject({
      status: "inspection-required",
      message: expect.stringContaining('scope "roadmap"'),
    });
    expect(drafts.pending("/work/app")).toBeNull();

    await value.inspect();
    await expect(value.proposeEdit(editRequest)).resolves.toMatchObject({ status: "drafted" });
  });

  it("returns exactly one phase with its full sourcePrompt for a phase_id inspection", async () => {
    const { value } = host(async () => twoPhases(4, { sourcePrompt: "Full saved prompt." }));
    const result = await value.inspect({ phase_id: "phase-1" });
    expect(isRoadmapInspectionOutcome(result)).toBe(true);
    if (result.status !== "ok") throw new Error("Expected inspection");
    expect(result.inspection.revision).toBe(4);
    expect(result.inspection.phases).toHaveLength(1);
    expect(result.inspection.phases[0]).toMatchObject({
      id: "phase-1",
      sourcePrompt: "Full saved prompt.",
    });

    // Default inspections stay lean.
    expect(JSON.stringify(await value.inspect())).not.toContain("sourcePrompt");
  });

  it.each<[string, Partial<NotesPhase>]>([
    ["phase-404", {}],
    ["phase-1", { deletion: { version: 1, currentDeletionId: "deletion-1", events: [] } }],
  ])("returns no phases for an unknown or deleted phase_id %s", async (phaseId, first) => {
    const { value } = host(async () => twoPhases(4, first));
    await expect(value.inspect({ phase_id: phaseId })).resolves.toMatchObject({
      status: "ok",
      inspection: { revision: 4, phases: [] },
    });
  });

  it("accepts an edit only for the phase a phase_id inspection covered", async () => {
    const { value, drafts } = host(async () => twoPhases());
    await value.inspect({ phase_id: "phase-1" });
    await expect(
      value.proposeEdit({ ...editRequest, phaseId: "phase-2", goal: "Other goal" }),
    ).resolves.toEqual({
      status: "inspection-required",
      message:
        "The last inspection covered a different phase. Call roadmap_inspect with this phase_id, then retry with its revision.",
    });
    expect(drafts.pending("/work/app")).toBeNull();

    await value.inspect({ phase_id: "phase-1" });
    await expect(
      value.proposeEdit({ ...editRequest, sourcePrompt: "Rewritten prompt." }),
    ).resolves.toMatchObject({
      status: "drafted",
      draft: {
        phaseId: "phase-1",
        changes: expect.arrayContaining([
          {
            field: "sourcePrompt",
            before: "Implement the first phase.",
            after: "Rewritten prompt.",
          },
        ]),
      },
    });
  });

  it("refuses to draft new phases after a phase_id inspection", async () => {
    const { value, drafts } = host(async () => loaded(4));
    await value.inspect({ phase_id: "phase-1" });
    await expect(value.draft(request)).resolves.toEqual({
      status: "inspection-required",
      message:
        'Drafting needs every current phase. Call roadmap_inspect with scope "roadmap", then retry with its revision.',
    });
    expect(drafts.pending("/work/app")).toBeNull();
  });

  it("still needs a full inspection to edit a non-active phase in a bound session", async () => {
    const { value, drafts } = host(
      async () => twoPhases(),
      () => "session-1",
      () => "phase-1",
    );
    const inspected = await value.inspect({ phase_id: "phase-2" });
    if (inspected.status !== "ok") throw new Error("Expected inspection");
    expect(inspected.inspection.phases.map((candidate) => candidate.id)).toEqual(["phase-2"]);
    await expect(
      value.proposeEdit({ ...editRequest, phaseId: "phase-2", goal: "Other goal" }),
    ).resolves.toMatchObject({
      status: "inspection-required",
      message: expect.stringContaining('scope "roadmap"'),
    });
    expect(drafts.pending("/work/app")).toBeNull();

    await value.inspect({ phase_id: "phase-1" });
    await expect(value.proposeEdit(editRequest)).resolves.toMatchObject({ status: "drafted" });
  });

  it("tells both edit surfaces to inspect by phase_id before changing sourcePrompt", () => {
    expect(APP_SIDECAR_ROADMAP_DRAFT_SYSTEM_PROMPT).toContain(
      "To change sourcePrompt, first call roadmap_inspect with that phase_id",
    );
    const edit = host(async () => twoPhases())
      .value.createSessionTools()
      .find((tool) => tool.name === "roadmap_phase_edit");
    expect(edit?.description).toContain(
      "To change sourcePrompt, first call roadmap_inspect with that phase_id",
    );
  });

  it("revises this session's own pending proposal in place instead of reporting it pending", async () => {
    const { value } = host(async () => twoPhases());
    await value.inspect();
    const first = await value.proposeEdit(editRequest);
    if (first.status !== "drafted") throw new Error("expected a drafted edit");
    const revised = await value.proposeEdit({ ...editRequest, title: "Renamed phase" });
    if (revised.status !== "drafted") throw new Error("expected a revised edit");
    expect(revised.draft.id).not.toBe(first.draft.id);
    expect(revised.draft.changes).toContainEqual(
      expect.objectContaining({ field: "title", after: "Renamed phase" }),
    );
    expect(APP_SIDECAR_ROADMAP_DRAFT_SYSTEM_PROMPT).toContain("never ask the user to reject it");
    expect(APP_SIDECAR_ROADMAP_PHASE_SYSTEM_PROMPT).toContain("never ask the user to reject it");
  });

  it("names the edit tool and its boundaries in both system prompts", () => {
    for (const prompt of [
      APP_SIDECAR_ROADMAP_DRAFT_SYSTEM_PROMPT,
      APP_SIDECAR_ROADMAP_PHASE_SYSTEM_PROMPT,
    ]) {
      expect(prompt).toContain("roadmap_phase_edit");
      expect(prompt).toContain("only the changed fields");
      expect(prompt).toContain("Never loosen completion criteria");
      expect(prompt).toContain("approval is pending");
    }
    expect(APP_SIDECAR_ROADMAP_DRAFT_SYSTEM_PROMPT).toContain(
      "Never delete and redraft, or add a duplicate phase",
    );
    expect(APP_SIDECAR_ROADMAP_DRAFT_SYSTEM_PROMPT).toContain(
      "Done, archived, and deleted phases cannot be edited",
    );
  });
});

describe("roadmap_phase_move proposals and insert_before_phase_id drafts", () => {
  const moveRequest: RoadmapPhaseMoveRequest = {
    expectedRevision: 4,
    summary: "Do the third phase first",
    phaseId: "c",
    beforePhaseId: "b",
  };
  const notStarted = (id: string, overrides: Partial<NotesPhase> = {}): NotesPhase =>
    phase({
      id,
      title: `Phase ${id}`,
      status: "not-started",
      session: null,
      overrides: { status: null, referenceIds: null },
      roadmapEvents: [],
      ...overrides,
    });
  const roadmap = (revision = 4, extra: Record<string, Partial<NotesPhase>> = {}) =>
    loaded(
      revision,
      ["a", "b", "c"].map((id, order) => notStarted(id, { order, ...extra[id] })),
    );

  it("requires a full-Roadmap inspection and drafts the order before and after", async () => {
    const { value, drafts } = host(async () => roadmap());
    await expect(value.proposeMove(moveRequest)).resolves.toMatchObject({
      status: "inspection-required",
    });
    await value.inspect();
    await expect(value.proposeMove(moveRequest)).resolves.toMatchObject({
      status: "drafted",
      draft: {
        kind: "move",
        phaseId: "c",
        phaseTitle: "Phase c",
        position: "before",
        targetPhaseId: "b",
        targetPhaseTitle: "Phase b",
        basedOnRevision: 4,
        orderPreview: {
          before: [
            { phaseId: "a", title: "Phase a" },
            { phaseId: "b", title: "Phase b" },
            { phaseId: "c", title: "Phase c" },
          ],
          after: [
            { phaseId: "a", title: "Phase a" },
            { phaseId: "c", title: "Phase c" },
            { phaseId: "b", title: "Phase b" },
          ],
        },
        status: "pending",
      },
    });
    expect(drafts.pending("/work/app")).toMatchObject({ kind: "move" });
  });

  it("refuses a bound session's active-phase slice", async () => {
    const { value, drafts } = host(
      async () => roadmap(),
      () => "session-1",
      () => "c",
    );
    await value.inspect();
    await expect(value.proposeMove(moveRequest)).resolves.toMatchObject({
      status: "inspection-required",
      message: expect.stringContaining('scope "roadmap"'),
    });
    expect(drafts.pending("/work/app")).toBeNull();
  });

  it("rejects stale expected revisions without drafting", async () => {
    let revision = 4;
    const { value, drafts } = host(async () => roadmap(revision));
    await value.inspect();
    await expect(value.proposeMove({ ...moveRequest, expectedRevision: 3 })).resolves.toEqual({
      status: "inspection-revision-mismatch",
      inspectedRevision: 4,
      requestedRevision: 3,
    });
    revision = 5;
    await expect(value.proposeMove(moveRequest)).resolves.toEqual({
      status: "stale-revision",
      expectedRevision: 4,
      currentRevision: 5,
    });
    expect(drafts.pending("/work/app")).toBeNull();
  });

  it.each<[RoadmapPhaseNotEditableReason, Partial<NotesPhase>]>([
    ["done", { status: "done", completedAt: timestamp }],
    ["archived", { archivedAt: timestamp }],
    ["deleted", { deletion: { version: 1, currentDeletionId: "deletion-1", events: [] } }],
  ])("refuses to move a %s phase", async (reason, overrides) => {
    const { value, drafts } = host(async () => roadmap(4, { c: overrides }));
    await value.inspect();
    await expect(value.proposeMove(moveRequest)).resolves.toEqual({
      status: "phase-not-movable",
      phaseId: "c",
      reason,
    });
    expect(drafts.pending("/work/app")).toBeNull();
  });

  it("refuses targets that are missing, deleted, or archived (not on this project's Roadmap)", async () => {
    const cases: [string, Record<string, Partial<NotesPhase>>][] = [
      ["phase-from-another-project", {}],
      ["b", { b: { deletion: { version: 1, currentDeletionId: "d", events: [] } } }],
      ["b", { b: { archivedAt: timestamp } }],
    ];
    for (const [target, extra] of cases) {
      const { value, drafts } = host(async () => roadmap(4, extra));
      await value.inspect();
      await expect(value.proposeMove({ ...moveRequest, beforePhaseId: target })).resolves.toEqual({
        status: "target-unavailable",
        phaseId: target,
      });
      expect(drafts.pending("/work/app")).toBeNull();
    }
  });

  it("refuses moving ahead of a Done phase, next to itself, and into its current position", async () => {
    const { value, drafts } = host(async () =>
      roadmap(4, { a: { status: "done", completedAt: timestamp } }),
    );
    await value.inspect();
    await expect(value.proposeMove({ ...moveRequest, beforePhaseId: "a" })).resolves.toEqual({
      status: "ahead-of-done-phase",
      phaseId: "c",
      donePhaseId: "a",
    });
    await expect(
      value.proposeMove({ ...moveRequest, beforePhaseId: undefined, afterPhaseId: "b" }),
    ).resolves.toEqual({ status: "no-changes", phaseId: "c" });
    await expect(value.proposeMove({ ...moveRequest, beforePhaseId: "c" })).resolves.toMatchObject({
      status: "invalid-proposal",
      message: "a phase cannot be moved next to itself",
    });
    expect(drafts.pending("/work/app")).toBeNull();
  });

  it("places an inserted draft phase and records the order preview", async () => {
    const { value } = host(async () => roadmap());
    await value.inspect();
    const insertRequest: RoadmapPhaseDraftRequest = {
      ...request,
      phases: [{ ...request.phases[0]!, insertBeforePhaseId: "b" }],
    };
    await expect(value.draft(insertRequest)).resolves.toMatchObject({
      status: "drafted",
      draft: {
        phases: [{ insertBeforePhaseId: "b" }],
        orderPreview: {
          after: [{ phaseId: "a" }, { title: "Next phase" }, { phaseId: "b" }, { phaseId: "c" }],
        },
      },
    });
  });

  it("drafts without insert_before_phase_id keep the legacy shape", async () => {
    const { value } = host(async () => roadmap());
    await value.inspect();
    const result = await value.draft(request);
    if (result.status !== "drafted" || !isRoadmapPhaseCreateDraft(result.draft)) {
      throw new Error("expected a create draft");
    }
    expect(result.draft).not.toHaveProperty("orderPreview");
    expect(result.draft.phases[0]).not.toHaveProperty("insertBeforePhaseId");
  });

  it("refuses inserting ahead of a Done phase or before an unknown phase", async () => {
    const cases: [string, Record<string, Partial<NotesPhase>>][] = [
      ["a", { b: { status: "done", completedAt: timestamp } }],
      ["phase-404", {}],
    ];
    for (const [target, extra] of cases) {
      const { value, drafts } = host(async () => roadmap(4, extra));
      await value.inspect();
      await expect(
        value.draft({
          ...request,
          phases: [{ ...request.phases[0]!, insertBeforePhaseId: target }],
        }),
      ).resolves.toMatchObject({
        status: "invalid-proposal",
        path: "phases[0].insertBeforePhaseId",
      });
      expect(drafts.pending("/work/app")).toBeNull();
    }
  });

  it("registers roadmap_phase_move and tells agents how to place and reorder phases", () => {
    const tools = host(async () => roadmap()).value.createSessionTools();
    const move = tools.find((tool) => tool.name === "roadmap_phase_move");
    expect(move?.description).toContain("exactly one of before_phase_id or after_phase_id");
    expect(move?.description).toContain("pending user approval");
    expect(tools.find((tool) => tool.name === "roadmap_phase_draft")?.description).toContain(
      "insert_before_phase_id",
    );
    expect(APP_SIDECAR_ROADMAP_DRAFT_SYSTEM_PROMPT).toContain("set its insert_before_phase_id");
    expect(APP_SIDECAR_ROADMAP_DRAFT_SYSTEM_PROMPT).toContain(
      "To change the order of existing phases",
    );
    expect(APP_SIDECAR_ROADMAP_DRAFT_SYSTEM_PROMPT).toContain(
      "Never delete and redraft a phase to reorder it",
    );
    expect(APP_SIDECAR_ROADMAP_DRAFT_SYSTEM_PROMPT).toContain(
      "After submitting a move, stop and say approval is pending",
    );
    expect(APP_SIDECAR_ROADMAP_PHASE_SYSTEM_PROMPT).toContain("roadmap_phase_move");
  });
});
