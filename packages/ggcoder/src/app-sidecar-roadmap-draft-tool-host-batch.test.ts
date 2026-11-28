import { describe, expect, it } from "vitest";
import type { NotesDocumentV3, NotesPhase, ProjectNotesLoadOutcome } from "@kenkaiiii/gg-core";
import {
  APP_SIDECAR_ROADMAP_DRAFT_SYSTEM_PROMPT,
  APP_SIDECAR_ROADMAP_PHASE_SYSTEM_PROMPT,
  AppSidecarRoadmapDraftToolHost,
} from "./app-sidecar-roadmap-draft-tool-host.js";
import { AppSidecarRoadmapDraftCoordinator } from "./app-sidecar-roadmap-drafts.js";

const timestamp = "2026-08-05T12:00:00.000Z";

function phase(id: string, order: number, overrides: Partial<NotesPhase> = {}): NotesPhase {
  return {
    id,
    title: `Phase ${id}`,
    goal: `Goal ${id}`,
    doneWhen: [`${id} passes`],
    order,
    status: "not-started",
    sourcePrompt: `Implement ${id}.`,
    referenceIds: [],
    session: null,
    reminder: null,
    attentionReason: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    completedAt: null,
    archivedAt: null,
    overrides: { status: null, referenceIds: null },
    pendingAutomaticLifecycleTransition: null,
    lifecycleEvents: [],
    roadmapEvents: [],
    ...overrides,
  };
}

function loaded(
  revision: number,
  phases = ["a", "b", "c", "d"].map((id, order) => phase(id, order)),
): ProjectNotesLoadOutcome {
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

function host(load: () => Promise<ProjectNotesLoadOutcome>, activePhaseId?: string) {
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
      getOwningSession: () => ({ getState: () => ({ sessionId: "session-1" }) }),
      ...(activePhaseId ? { getActivePhaseId: () => activePhaseId } : {}),
    }),
  };
}

const editBatch = {
  expectedRevision: 4,
  summary: "Tighten two phases",
  edits: [
    { phaseId: "a", title: "Phase A" },
    { phaseId: "c", goal: "Goal C" },
  ],
};
const moveBatch = {
  expectedRevision: 4,
  summary: "Do d and c first",
  moves: [
    { phaseId: "d", beforePhaseId: "a" },
    { phaseId: "c", afterPhaseId: "d" },
  ],
};

describe("roadmap batch proposals in the tool host", () => {
  it("drafts an edit batch only after a full-Roadmap inspection", async () => {
    const { value } = host(async () => loaded(4), "a");
    expect(await value.proposeEdit(editBatch)).toMatchObject({ status: "inspection-required" });
    await value.inspect();
    expect(await value.proposeEdit(editBatch)).toMatchObject({
      status: "inspection-required",
      message: expect.stringContaining('scope "roadmap"'),
    });
    await value.inspect({ scope: "roadmap" });
    expect(await value.proposeEdit(editBatch)).toMatchObject({
      status: "drafted",
      draft: { kind: "edit-batch", edits: [{ phaseId: "a" }, { phaseId: "c" }] },
    });
  });

  it("refuses a phase_id inspection for a batch even when it names one of the phases", async () => {
    const { value } = host(async () => loaded(4));
    await value.inspect({ phase_id: "a" });
    expect(await value.proposeEdit(editBatch)).toMatchObject({ status: "inspection-required" });
  });

  it("treats a one-entry batch as an ordinary single edit or move", async () => {
    const { value } = host(async () => loaded(4));
    await value.inspect({ phase_id: "a" });
    expect(
      await value.proposeEdit({ ...editBatch, edits: [{ phaseId: "a", title: "Phase A" }] }),
    ).toMatchObject({ status: "drafted", draft: { kind: "edit", phaseId: "a" } });
    await value.inspect({ scope: "roadmap" });
    expect(
      await value.proposeMove({ ...moveBatch, moves: [{ phaseId: "d", beforePhaseId: "a" }] }),
    ).toMatchObject({ status: "drafted", draft: { kind: "move", phaseId: "d" } });
  });

  it("checks the revision and stale Notes before drafting a batch", async () => {
    let revision = 4;
    const { value, drafts } = host(async () => loaded(revision));
    await value.inspect({ scope: "roadmap" });
    expect(await value.proposeEdit({ ...editBatch, expectedRevision: 3 })).toEqual({
      status: "inspection-revision-mismatch",
      inspectedRevision: 4,
      requestedRevision: 3,
    });
    revision = 5;
    expect(await value.proposeMove(moveBatch)).toEqual({
      status: "stale-revision",
      expectedRevision: 4,
      currentRevision: 5,
    });
    expect(drafts.pending("/work/app")).toBeNull();
  });

  it("drafts a move batch and reports a refused step with its index", async () => {
    const { value } = host(async () =>
      loaded(4, [
        phase("a", 0),
        phase("b", 1, { status: "done", completedAt: timestamp }),
        phase("c", 2),
        phase("d", 3),
      ]),
    );
    await value.inspect({ scope: "roadmap" });
    expect(
      await value.proposeMove({
        ...moveBatch,
        moves: [
          { phaseId: "d", afterPhaseId: "b" },
          { phaseId: "c", beforePhaseId: "a" },
        ],
      }),
    ).toEqual({ status: "ahead-of-done-phase", phaseId: "c", donePhaseId: "b", moveIndex: 1 });
    const drafted = await value.proposeMove({
      ...moveBatch,
      moves: [
        { phaseId: "d", afterPhaseId: "b" },
        { phaseId: "a", afterPhaseId: "c" },
      ],
    });
    expect(drafted).toMatchObject({ status: "drafted", draft: { kind: "move-batch" } });
    if (drafted.status !== "drafted") throw new Error("expected a draft");
    expect(drafted.draft.orderPreview.after.map((entry) => entry.phaseId)).toEqual([
      "b",
      "d",
      "c",
      "a",
    ]);
  });

  it("tells both Roadmap prompts about the batch forms", () => {
    expect(APP_SIDECAR_ROADMAP_DRAFT_SYSTEM_PROMPT).toContain("roadmap_phase_edit with edits");
    expect(APP_SIDECAR_ROADMAP_DRAFT_SYSTEM_PROMPT).toContain("roadmap_phase_move with moves");
    expect(APP_SIDECAR_ROADMAP_PHASE_SYSTEM_PROMPT).toContain("roadmap_phase_edit with edits");
    expect(APP_SIDECAR_ROADMAP_PHASE_SYSTEM_PROMPT).toContain("use moves for several phases");
  });
});
