import { describe, expect, it, vi } from "vitest";
import type { NotesPhase } from "@kenkaiiii/gg-core/project-notes";
import type { RoadmapPhaseDraftApprovalResult } from "@kenkaiiii/gg-core/roadmap-workflow";
import { AppSidecarRoadmapDraftCoordinator } from "./app-sidecar-roadmap-drafts.js";

function phase(id: string, order: number, overrides: Partial<NotesPhase> = {}): NotesPhase {
  return {
    id,
    title: `Phase ${id}`,
    goal: `Goal ${id}`,
    doneWhen: [`${id} tests pass`],
    order,
    status: "not-started",
    sourcePrompt: `Implement ${id} only.`,
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
    ...overrides,
  };
}

const roadmap = (overrides: Record<string, Partial<NotesPhase>> = {}): NotesPhase[] =>
  ["a", "b", "c", "d"].map((id, order) => phase(id, order, overrides[id]));

function coordinator(onChange = vi.fn()) {
  let sequence = 0;
  return {
    onChange,
    value: new AppSidecarRoadmapDraftCoordinator({
      createId: () => `id-${++sequence}`,
      now: () => "2026-08-05T12:00:00.000Z",
      onChange,
    }),
  };
}

const cwd = "/work/app";
const editBatch = {
  expectedRevision: 3,
  summary: "Tighten two phases",
  edits: [
    { phaseId: "a", title: "Phase A" },
    { phaseId: "c", goal: "Goal C", doneWhen: ["c tests pass", "c docs"] },
  ],
};
const moveBatch = {
  expectedRevision: 3,
  summary: "Do d and c first",
  moves: [
    { phaseId: "d", beforePhaseId: "a" },
    { phaseId: "c", afterPhaseId: "d" },
  ],
};

describe("AppSidecarRoadmapDraftCoordinator batch edits", () => {
  it("creates one edit-batch draft with only changed fields and emits copies", () => {
    const { value, onChange } = coordinator();
    const created = value.createEditBatch({
      cwd,
      sessionId: "s1",
      request: editBatch,
      currentPhases: roadmap(),
    });
    expect(created).toEqual({
      status: "drafted",
      draft: {
        kind: "edit-batch",
        id: "id-1",
        projectKey: expect.any(String),
        basedOnRevision: 3,
        createdAt: "2026-08-05T12:00:00.000Z",
        createdBySessionId: "s1",
        summary: "Tighten two phases",
        edits: [
          {
            phaseId: "a",
            phaseTitle: "Phase a",
            basedOnUpdatedAt: "2026-08-02T12:00:00.000Z",
            changes: [{ field: "title", before: "Phase a", after: "Phase A" }],
          },
          {
            phaseId: "c",
            phaseTitle: "Phase c",
            basedOnUpdatedAt: "2026-08-02T12:00:00.000Z",
            changes: [
              { field: "goal", before: "Goal c", after: "Goal C" },
              { field: "doneWhen", before: ["c tests pass"], after: ["c tests pass", "c docs"] },
            ],
          },
        ],
        status: "pending",
      },
    });
    expect(onChange).toHaveBeenCalledOnce();
    if (created.status !== "drafted") throw new Error("expected a draft");
    created.draft.edits[0]!.changes.length = 0;
    expect(value.pending(cwd)).toMatchObject({ edits: [{ changes: [{ field: "title" }] }, {}] });
  });

  it("refuses the whole batch for a locked phase or an item that changes nothing", () => {
    const { value, onChange } = coordinator();
    expect(
      value.createEditBatch({
        cwd,
        sessionId: "s1",
        request: editBatch,
        currentPhases: roadmap({ c: { status: "done" } }),
      }),
    ).toEqual({ status: "phase-not-editable", phaseId: "c", reason: "done" });
    expect(
      value.createEditBatch({
        cwd,
        sessionId: "s1",
        request: { ...editBatch, edits: [editBatch.edits[0]!, { phaseId: "b", title: "Phase b" }] },
        currentPhases: roadmap(),
      }),
    ).toEqual({ status: "no-changes", phaseId: "b" });
    expect(
      value.createEditBatch({
        cwd,
        sessionId: "s1",
        request: { ...editBatch, edits: [editBatch.edits[0]!, { phaseId: "zz", title: "X" }] },
        currentPhases: roadmap(),
      }),
    ).toEqual({ status: "phase-not-editable", phaseId: "zz", reason: "missing" });
    expect(onChange).not.toHaveBeenCalled();
    expect(value.pending(cwd)).toBeNull();
  });

  it("validates the combined dependency graph and lists linked phases", () => {
    const { value } = coordinator();
    const cycle = value.createEditBatch({
      cwd,
      sessionId: "s1",
      request: {
        ...editBatch,
        edits: [
          { phaseId: "a", dependsOn: ["c"] },
          { phaseId: "c", dependsOn: ["a"] },
        ],
      },
      currentPhases: roadmap(),
    });
    expect(cycle).toMatchObject({ status: "invalid-proposal", message: /circular/ });
    expect(value.pending(cwd)).toBeNull();

    const linked = value.createEditBatch({
      cwd,
      sessionId: "s1",
      request: {
        ...editBatch,
        edits: [
          { phaseId: "b", dependsOn: ["a"] },
          { phaseId: "c", dependsOn: [] },
        ],
      },
      currentPhases: roadmap({ c: { dependsOn: ["d"] } }),
    });
    expect(linked).toMatchObject({
      status: "drafted",
      draft: {
        dependencyPhases: [
          { phaseId: "a", title: "Phase a", archived: false },
          { phaseId: "d", title: "Phase d", archived: false },
        ],
      },
    });
  });

  it("shares the one-pending slot and lets the creator revise in place", () => {
    const { value } = coordinator();
    const first = value.createMoveBatch({
      cwd,
      sessionId: "s1",
      request: moveBatch,
      currentPhases: roadmap(),
    });
    expect(first.status).toBe("drafted");
    expect(
      value.createEditBatch({ cwd, sessionId: "s2", request: editBatch, currentPhases: roadmap() }),
    ).toMatchObject({ status: "proposal-pending", draft: { kind: "move-batch" } });
    const revised = value.createEditBatch({
      cwd,
      sessionId: "s1",
      request: editBatch,
      currentPhases: roadmap(),
    });
    expect(revised).toMatchObject({ status: "drafted", draft: { kind: "edit-batch" } });
    expect(value.pending(cwd)).toMatchObject({ kind: "edit-batch" });
  });

  it("records a batch approval tombstone with every phase ID", async () => {
    const { value } = coordinator();
    const created = value.createEditBatch({
      cwd,
      sessionId: "s1",
      request: editBatch,
      currentPhases: roadmap(),
    });
    if (created.status !== "drafted") throw new Error("expected a draft");
    const result: RoadmapPhaseDraftApprovalResult = {
      status: "edited",
      revision: 4,
      phaseId: "a",
      phaseIds: ["a", "c"],
    };
    await expect(value.approve(cwd, created.draft.id, async () => result)).resolves.toEqual(result);
    expect(value.pending(cwd)).toBeNull();
    const replay = await value.approve(cwd, created.draft.id, async () => {
      throw new Error("must not commit twice");
    });
    expect(replay).toEqual(result);
  });

  it("marks the whole batch stale when any phase changed", async () => {
    const { value } = coordinator();
    const created = value.createEditBatch({
      cwd,
      sessionId: "s1",
      request: editBatch,
      currentPhases: roadmap(),
    });
    if (created.status !== "drafted") throw new Error("expected a draft");
    await value.approve(cwd, created.draft.id, async () => ({
      status: "phase-changed",
      phaseId: "c",
    }));
    expect(value.pending(cwd)).toMatchObject({ kind: "edit-batch", status: "stale" });
  });
});

describe("AppSidecarRoadmapDraftCoordinator batch moves", () => {
  it("creates a move-batch draft whose preview replays every step", () => {
    const { value } = coordinator();
    const created = value.createMoveBatch({
      cwd,
      sessionId: "s1",
      request: moveBatch,
      currentPhases: roadmap(),
    });
    expect(created).toMatchObject({
      status: "drafted",
      draft: {
        kind: "move-batch",
        moves: [
          {
            phaseId: "d",
            phaseTitle: "Phase d",
            position: "before",
            targetPhaseId: "a",
            targetPhaseTitle: "Phase a",
          },
          {
            phaseId: "c",
            phaseTitle: "Phase c",
            position: "after",
            targetPhaseId: "d",
            targetPhaseTitle: "Phase d",
          },
        ],
      },
    });
    if (created.status !== "drafted") throw new Error("expected a draft");
    expect(created.draft.orderPreview.before.map((entry) => entry.phaseId)).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
    expect(created.draft.orderPreview.after.map((entry) => entry.phaseId)).toEqual([
      "d",
      "c",
      "a",
      "b",
    ]);
    expect(created).not.toHaveProperty("dependencyWarnings");
  });

  it("refuses a step with its index and publishes nothing", () => {
    const { value, onChange } = coordinator();
    expect(
      value.createMoveBatch({
        cwd,
        sessionId: "s1",
        request: moveBatch,
        currentPhases: roadmap({ b: { status: "done", completedAt: "2026-08-02T12:00:00.000Z" } }),
      }),
    ).toEqual({
      status: "order-refused",
      refusal: { reason: "ahead-of-done", phaseId: "d", donePhaseId: "b" },
      moveIndex: 0,
    });
    expect(
      value.createMoveBatch({
        cwd,
        sessionId: "s1",
        request: {
          ...moveBatch,
          moves: [
            { phaseId: "d", beforePhaseId: "a" },
            { phaseId: "a", afterPhaseId: "d" },
          ],
        },
        currentPhases: roadmap(),
      }),
    ).toEqual({
      status: "order-refused",
      refusal: { reason: "no-change", phaseId: "a" },
      moveIndex: 1,
    });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("merges dependency warnings for every moved phase against the final order", () => {
    const { value } = coordinator();
    const created = value.createMoveBatch({
      cwd,
      sessionId: "s1",
      request: moveBatch,
      currentPhases: roadmap({ d: { dependsOn: ["a"] }, c: { dependsOn: ["b"] } }),
    });
    expect(created).toMatchObject({
      status: "drafted",
      dependencyWarnings: [
        `"Phase d" (d) would sit above its prerequisite "Phase a" (a).`,
        `"Phase c" (c) would sit above its prerequisite "Phase b" (b).`,
      ],
    });
  });
});
