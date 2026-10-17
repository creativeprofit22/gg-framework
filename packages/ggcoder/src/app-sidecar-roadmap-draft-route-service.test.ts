import { describe, expect, it, vi } from "vitest";
import type { ProjectNotesSnapshot } from "@kenkaiiii/gg-core/project-notes";
import type { RoadmapPhaseDraftApprovalResult } from "@kenkaiiii/gg-core/roadmap-workflow";
import { AppSidecarRoadmapDraftDecisionService } from "./app-sidecar-roadmap-draft-route.js";
import { AppSidecarRoadmapDraftCoordinator } from "./app-sidecar-roadmap-drafts.js";
import { AppSidecarRoadmapReconciliationCoordinator } from "./app-sidecar-roadmap-reconciliation.js";

const request = {
  expectedRevision: 3,
  summary: "Create a reviewable phase",
  proposedReferences: [
    {
      referenceKey: "source",
      provider: "github",
      tool: null,
      canonicalUrl: "https://github.com/KenKaiiii/gg-framework",
      owner: "KenKaiiii",
      repo: "gg-framework",
      revision: null,
      path: null,
      range: null,
      issue: null,
      pullRequest: null,
      query: null,
      anchor: null,
      relevance: "Approval contract",
    },
  ],
  phases: [
    {
      title: "Approval UI",
      goal: "Require an explicit decision.",
      doneWhen: ["Create is explicit", "Reject does not write Notes"],
      sourcePrompt: "Implement the approval UI only.",
      referenceKeys: ["source"],
    },
  ],
};

function setup() {
  let sequence = 0;
  let revision = 3;
  const snapshots = vi.fn<(snapshot: ProjectNotesSnapshot) => void>();
  const createApprovedPhases = vi.fn(
    async (
      _cwd: string,
      draft: { phases: { phaseId: string }[] },
    ): Promise<RoadmapPhaseDraftApprovalResult> => {
      revision += 1;
      return {
        status: "created",
        revision,
        phaseIds: draft.phases.map((phase) => phase.phaseId),
      };
    },
  );
  const applyApprovedPhaseEdit = vi.fn(
    async (_cwd: string, draft: { phaseId: string }): Promise<RoadmapPhaseDraftApprovalResult> => {
      revision += 1;
      return { status: "edited", revision, phaseId: draft.phaseId };
    },
  );
  const load = vi.fn(async (cwd: string) => ({
    status: "ok" as const,
    recoveredFromBackup: false,
    snapshot: {
      projectKey: cwd,
      revision,
      document: {} as ProjectNotesSnapshot["document"],
    },
  }));
  const drafts = new AppSidecarRoadmapDraftCoordinator({
    createId: () => `id-${++sequence}`,
    now: () => "2026-08-05T12:00:00.000Z",
  });
  const reconciliations = new AppSidecarRoadmapReconciliationCoordinator(() => `lease-${sequence}`);
  const service = new AppSidecarRoadmapDraftDecisionService({
    drafts,
    repository: { applyApprovedPhaseEdit, createApprovedPhases, load } as never,
    reconciliations,
    onCommittedSnapshot: snapshots,
  });
  return {
    drafts,
    service,
    applyApprovedPhaseEdit,
    createApprovedPhases,
    load,
    reconciliations,
    snapshots,
  };
}

function publishEdit(drafts: AppSidecarRoadmapDraftCoordinator, cwd = "/work/app") {
  const result = drafts.createEdit({
    cwd,
    sessionId: "session-1",
    request: {
      expectedRevision: 3,
      summary: "Clarify the approval goal",
      phaseId: "phase-1",
      goal: "Require an explicit, recorded decision.",
    },
    phase: {
      id: "phase-1",
      title: "Approval UI",
      goal: "Require an explicit decision.",
      doneWhen: ["Create is explicit"],
      order: 0,
      status: "not-started",
      sourcePrompt: "Implement the approval UI only.",
      referenceIds: [],
      session: null,
      reminder: null,
      attentionReason: null,
      createdAt: "2026-08-01T12:00:00.000Z",
      updatedAt: "2026-08-02T12:00:00.000Z",
      completedAt: null,
      archivedAt: null,
      overrides: { status: null, referenceIds: null },
      pendingAutomaticLifecycleTransition: null,
      lifecycleEvents: [],
      roadmapEvents: [],
    },
  });
  if (result.status !== "drafted") throw new Error("expected edit draft");
  return result.draft;
}

function publish(drafts: AppSidecarRoadmapDraftCoordinator, cwd = "/work/app") {
  const result = drafts.create({ cwd, sessionId: "session-1", request });
  if (result.status !== "drafted") throw new Error("expected draft");
  return result.draft;
}

describe("AppSidecarRoadmapDraftDecisionService", () => {
  it("commits and refreshes Notes exactly once across concurrent and retried approval", async () => {
    const context = setup();
    const draft = publish(context.drafts);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const commit = context.createApprovedPhases.getMockImplementation();
    if (!commit) throw new Error("expected repository implementation");
    context.createApprovedPhases.mockImplementationOnce(async (cwd, proposal) => {
      await gate;
      return commit(cwd, proposal);
    });

    const first = context.service.approve("/work/app", draft.id);
    const concurrent = context.service.approve("/work/app", draft.id);
    release();
    await expect(first).resolves.toMatchObject({ status: "created", revision: 4 });
    await expect(concurrent).resolves.toMatchObject({ status: "created", revision: 4 });
    await expect(context.service.approve("/work/app", draft.id)).resolves.toMatchObject({
      status: "created",
      revision: 4,
    });
    expect(context.createApprovedPhases).toHaveBeenCalledOnce();
    expect(context.createApprovedPhases).toHaveBeenCalledWith(
      "/work/app",
      expect.objectContaining({
        references: [expect.objectContaining({ id: "id-2" })],
        phases: [expect.objectContaining({ phaseId: "id-3", referenceIds: ["id-2"] })],
      }),
    );
    expect(context.load).toHaveBeenCalledOnce();
    expect(context.snapshots).toHaveBeenCalledOnce();
    expect(context.snapshots).toHaveBeenCalledWith(expect.objectContaining({ revision: 4 }));
  });

  it("keeps a stale draft visible and does not emit a refresh", async () => {
    const context = setup();
    const draft = publish(context.drafts);
    context.createApprovedPhases.mockResolvedValueOnce({
      status: "stale-revision",
      expectedRevision: 3,
      currentRevision: 4,
    });

    await expect(context.service.approve("/work/app", draft.id)).resolves.toEqual({
      status: "stale-revision",
      expectedRevision: 3,
      currentRevision: 4,
    });
    expect(context.service.pending("/work/app")).toMatchObject({ id: draft.id, status: "stale" });
    expect(context.load).not.toHaveBeenCalled();
    expect(context.snapshots).not.toHaveBeenCalled();
  });

  it("rejects without reading or changing Project Notes", async () => {
    const context = setup();
    const draft = publish(context.drafts);

    await expect(context.service.reject("/work/app", draft.id, "Not this scope")).resolves.toEqual({
      status: "rejected",
    });
    expect(context.service.pending("/work/app")).toBeNull();
    expect(context.createApprovedPhases).not.toHaveBeenCalled();
    expect(context.load).not.toHaveBeenCalled();
    expect(context.snapshots).not.toHaveBeenCalled();
  });

  it("applies an approved edit draft through the edit path and broadcasts the snapshot", async () => {
    const context = setup();
    const draft = publishEdit(context.drafts);

    await expect(context.service.approve("/work/app", draft.id)).resolves.toEqual({
      status: "edited",
      revision: 4,
      phaseId: "phase-1",
    });
    await expect(context.service.approve("/work/app", draft.id)).resolves.toEqual({
      status: "edited",
      revision: 4,
      phaseId: "phase-1",
    });
    expect(context.applyApprovedPhaseEdit).toHaveBeenCalledExactlyOnceWith(
      "/work/app",
      expect.objectContaining({ kind: "edit", id: draft.id, phaseId: "phase-1" }),
    );
    expect(context.createApprovedPhases).not.toHaveBeenCalled();
    expect(context.service.pending("/work/app")).toBeNull();
    expect(context.snapshots).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ revision: 4 }),
    );
  });

  it("holds the phase-edit reconciliation lease while applying an edit", async () => {
    const context = setup();
    const draft = publishEdit(context.drafts);
    const commit = context.applyApprovedPhaseEdit.getMockImplementation();
    if (!commit) throw new Error("expected repository implementation");
    let observed: string | undefined;
    context.applyApprovedPhaseEdit.mockImplementationOnce(async (cwd, proposal) => {
      observed = context.reconciliations.owner(cwd)?.kind;
      return commit(cwd, proposal);
    });

    await expect(context.service.approve("/work/app", draft.id)).resolves.toMatchObject({
      status: "edited",
    });
    expect(observed).toBe("phase-edit");
    expect(context.reconciliations.owner("/work/app")).toBeUndefined();
  });

  it("keeps a conflicting edit draft visible as stale without a refresh", async () => {
    const context = setup();
    const draft = publishEdit(context.drafts);
    context.applyApprovedPhaseEdit.mockResolvedValueOnce({
      status: "phase-changed",
      phaseId: "phase-1",
    });

    await expect(context.service.approve("/work/app", draft.id)).resolves.toEqual({
      status: "phase-changed",
      phaseId: "phase-1",
    });
    expect(context.service.pending("/work/app")).toMatchObject({
      id: draft.id,
      kind: "edit",
      status: "stale",
    });
    expect(context.load).not.toHaveBeenCalled();
    expect(context.snapshots).not.toHaveBeenCalled();
  });

  it("rejects an edit draft with feedback without reading or changing Project Notes", async () => {
    const context = setup();
    const draft = publishEdit(context.drafts);

    await expect(
      context.service.reject("/work/app", draft.id, "Keep the original goal"),
    ).resolves.toEqual({ status: "rejected" });
    await expect(context.service.approve("/work/app", draft.id)).resolves.toEqual({
      status: "already-decided",
      decision: "rejected",
    });
    expect(context.service.pending("/work/app")).toBeNull();
    expect(context.applyApprovedPhaseEdit).not.toHaveBeenCalled();
    expect(context.createApprovedPhases).not.toHaveBeenCalled();
    expect(context.load).not.toHaveBeenCalled();
    expect(context.snapshots).not.toHaveBeenCalled();
  });

  it("isolates project decisions", async () => {
    const context = setup();
    const draft = publish(context.drafts, "/work/one");

    await expect(context.service.approve("/work/two", draft.id)).resolves.toEqual({
      status: "proposal-project-mismatch",
    });
    await expect(context.service.reject("/work/two", draft.id, null)).resolves.toEqual({
      status: "proposal-project-mismatch",
    });
    expect(context.createApprovedPhases).not.toHaveBeenCalled();
    expect(context.service.pending("/work/one")).toMatchObject({ id: draft.id });
  });
});
