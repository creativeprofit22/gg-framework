import { describe, expect, it, vi } from "vitest";
import type { NotesPhase } from "@kenkaiiii/gg-core/project-notes";
import {
  isRoadmapPhaseCreateDraft,
  type RoadmapPhaseCreateDraft,
} from "@kenkaiiii/gg-core/roadmap-workflow";
import { AppSidecarRoadmapDraftCoordinator } from "./app-sidecar-roadmap-drafts.js";

function pendingCreate(
  value: AppSidecarRoadmapDraftCoordinator,
  cwd: string,
): RoadmapPhaseCreateDraft | null {
  const draft = value.pending(cwd);
  if (draft && !isRoadmapPhaseCreateDraft(draft)) throw new Error("expected a create draft");
  return draft;
}

function phase(overrides: Partial<NotesPhase> = {}): NotesPhase {
  return {
    id: "phase-1",
    title: "Backend",
    goal: "Create bounded backend support.",
    doneWhen: ["Backend tests pass"],
    order: 0,
    status: "not-started",
    sourcePrompt: "Implement the backend phase only.",
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

const editRequest = {
  expectedRevision: 3,
  summary: "Clarify the backend phase",
  phaseId: "phase-1",
  title: "Backend",
  goal: "Create bounded, validated backend support.",
  doneWhen: ["Backend tests pass", "Malformed input is rejected"],
};

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

const request = {
  expectedRevision: 3,
  summary: "Create two peer phases",
  phases: [
    {
      title: "Backend",
      goal: "Create bounded backend support.",
      doneWhen: ["Backend tests pass"],
      sourcePrompt: "Implement the backend phase only.",
    },
    {
      title: "UI",
      goal: "Create explicit approval UI.",
      doneWhen: ["UI tests pass"],
      sourcePrompt: "Implement the UI phase only.",
    },
  ],
};

describe("AppSidecarRoadmapDraftCoordinator", () => {
  it("recovers a missed notification on retry without replacing the pending proposal", () => {
    const { value, onChange } = coordinator();
    const first = value.create({ cwd: "/work/app", sessionId: "s1", request });
    if (first.status !== "drafted") throw new Error("expected draft");
    onChange.mockClear();
    const retry = value.create({ cwd: "/work/app", sessionId: "s2", request });
    expect(retry).toEqual({ status: "proposal-pending", draft: first.draft });
    expect(onChange).toHaveBeenCalledExactlyOnceWith("/work/app", first.draft);
    expect(value.pending("/work/app")).toEqual(first.draft);
  });
  it("creates one normalized pending draft and emits defensive copies", () => {
    const { value, onChange } = coordinator();
    const created = value.create({ cwd: "C:\\Work\\App", sessionId: "session-1", request });

    expect(created).toMatchObject({
      status: "drafted",
      draft: {
        id: "id-1",
        projectKey: "c:/work/app",
        basedOnRevision: 3,
        createdBySessionId: "session-1",
        phases: [{ phaseId: "id-2" }, { phaseId: "id-3" }],
      },
    });
    expect(onChange).toHaveBeenCalledOnce();
    if (created.status !== "drafted") throw new Error("expected draft");
    expect(created.draft.references).toEqual([]);
    expect(created.draft.phases.map((phase) => phase.referenceIds)).toEqual([[], []]);
    created.draft.phases[0]!.doneWhen.push("mutated");
    expect(pendingCreate(value, "c:/work/app")?.phases[0]!.doneWhen).toEqual([
      "Backend tests pass",
    ]);
  });

  it("generates reference IDs before phase IDs and deep-clones multi-phase links", () => {
    const { value, onChange } = coordinator();
    const linkedRequest = {
      ...request,
      proposedReferences: [
        {
          referenceKey: "source",
          provider: "github",
          canonicalUrl: "https://github.com/KenKaiiii/gg-framework",
          owner: "KenKaiiii",
          repo: "gg-framework",
          tool: null,
          revision: "main",
          path: "packages/gg-core/src/roadmap-workflow.ts",
          range: { startLine: 1, endLine: 5 },
          issue: null,
          pullRequest: null,
          query: null,
          anchor: null,
          relevance: "shared contract",
        },
      ],
      phases: request.phases.map((phase) => ({ ...phase, referenceKeys: ["source"] })),
    };
    const created = value.create({ cwd: "/work/app", sessionId: "s1", request: linkedRequest });
    expect(created).toMatchObject({
      status: "drafted",
      draft: {
        id: "id-1",
        references: [{ id: "id-2" }],
        phases: [
          { phaseId: "id-3", referenceIds: ["id-2"] },
          { phaseId: "id-4", referenceIds: ["id-2"] },
        ],
      },
    });
    if (created.status !== "drafted") throw new Error("expected draft");
    created.draft.references[0]!.range!.startLine = 99;
    created.draft.phases[0]!.referenceIds.push("mutated");
    expect(pendingCreate(value, "/work/app")?.references[0]!.range!.startLine).toBe(1);
    expect(pendingCreate(value, "/work/app")?.phases[0]!.referenceIds).toEqual(["id-2"]);
    const emitted = onChange.mock.calls[0]![1]!;
    emitted.references[0].range.startLine = 88;
    expect(pendingCreate(value, "/work/app")?.references[0]!.range!.startLine).toBe(1);
  });

  it("does not replace an unseen same-project proposal", () => {
    const { value } = coordinator();
    const first = value.create({ cwd: "/work/app", sessionId: "session-1", request });
    const second = value.create({
      cwd: "/work/app",
      sessionId: "session-2",
      request: { ...request, expectedRevision: 4 },
    });
    expect(first.status).toBe("drafted");
    expect(second).toMatchObject({ status: "proposal-pending", draft: { basedOnRevision: 3 } });
  });

  it("lets the creating session revise its own pending proposal in place", async () => {
    const { value, onChange } = coordinator();
    const first = value.create({ cwd: "/work/app", sessionId: "s1", request });
    if (first.status !== "drafted") throw new Error("expected draft");
    onChange.mockClear();
    const revised = value.create({
      cwd: "/work/app",
      sessionId: "s1",
      request: { ...request, summary: "Create two corrected peer phases" },
    });
    if (revised.status !== "drafted") throw new Error("expected a revised draft");
    expect(revised.draft.id).not.toBe(first.draft.id);
    expect(revised.draft.summary).toBe("Create two corrected peer phases");
    expect(value.pending("/work/app")).toEqual(revised.draft);
    expect(onChange).toHaveBeenCalledExactlyOnceWith("/work/app", revised.draft);
    const commit = vi.fn();
    await expect(value.approve("/work/app", first.draft.id, commit)).resolves.toEqual({
      status: "proposal-not-found",
    });
    await expect(value.reject("/work/app", first.draft.id)).resolves.toEqual({
      status: "proposal-not-found",
    });
    expect(commit).not.toHaveBeenCalled();
    expect(value.pending("/work/app")).toEqual(revised.draft);

    const edited = value.createEdit({
      cwd: "/work/app",
      sessionId: "s1",
      request: editRequest,
      phase: phase(),
    });
    expect(edited.status).toBe("drafted");
    expect(value.create({ cwd: "/work/app", sessionId: "s2", request })).toMatchObject({
      status: "proposal-pending",
      draft: { kind: "edit" },
    });
  });

  it("keeps the pending proposal when a revision is invalid or an approval is in flight", async () => {
    const { value } = coordinator();
    const first = value.create({ cwd: "/work/app", sessionId: "s1", request });
    if (first.status !== "drafted") throw new Error("expected draft");
    expect(
      value.create({ cwd: "/work/app", sessionId: "s1", request: { ...request, phases: [] } }),
    ).toMatchObject({ status: "invalid-proposal" });
    expect(value.pending("/work/app")).toEqual(first.draft);

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const approval = value.approve("/work/app", first.draft.id, async () => {
      await gate;
      return { status: "created" as const, revision: 4, phaseIds: ["id-2", "id-3"] };
    });
    expect(value.create({ cwd: "/work/app", sessionId: "s1", request })).toEqual({
      status: "proposal-pending",
      draft: first.draft,
    });
    release();
    await expect(approval).resolves.toMatchObject({ status: "created" });
    expect(value.pending("/work/app")).toBeNull();
  });

  it("isolates different projects", () => {
    const { value } = coordinator();
    expect(value.create({ cwd: "/work/one", sessionId: "s1", request }).status).toBe("drafted");
    expect(value.create({ cwd: "/work/two", sessionId: "s2", request }).status).toBe("drafted");
    expect(value.pending("/work/one")?.projectKey).toBe("/work/one");
    expect(value.pending("/work/two")?.projectKey).toBe("/work/two");
  });

  it("deduplicates concurrent approval and stores a bounded idempotency tombstone", async () => {
    const { value, onChange } = coordinator();
    const created = value.create({ cwd: "/work/app", sessionId: "s1", request });
    if (created.status !== "drafted") throw new Error("expected draft");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const commit = vi.fn(async () => {
      await gate;
      return { status: "created" as const, revision: 4, phaseIds: ["id-2", "id-3"] };
    });

    const first = value.approve("/work/app", created.draft.id, commit);
    const duplicate = value.approve("/work/app", created.draft.id, commit);
    const rejection = value.reject("/work/app", created.draft.id);
    release();
    await expect(first).resolves.toMatchObject({ status: "created", revision: 4 });
    await expect(duplicate).resolves.toMatchObject({ status: "created", revision: 4 });
    await expect(rejection).resolves.toEqual({
      status: "already-decided",
      decision: "approved",
    });
    expect(commit).toHaveBeenCalledOnce();
    await expect(value.approve("/work/app", created.draft.id, commit)).resolves.toMatchObject({
      status: "created",
      revision: 4,
    });
    await expect(value.reject("/work/app", created.draft.id)).resolves.toEqual({
      status: "already-decided",
      decision: "approved",
    });
    expect(value.pending("/work/app")).toBeNull();
    expect(onChange).toHaveBeenLastCalledWith("/work/app", null);
  });

  it("lets an explicit rejection win when an in-flight approval fails", async () => {
    const { value } = coordinator();
    const created = value.create({ cwd: "/work/app", sessionId: "s1", request });
    if (created.status !== "drafted") throw new Error("expected draft");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const approval = value.approve("/work/app", created.draft.id, async () => {
      await gate;
      return { status: "storage-failed" as const, message: "disk unavailable" };
    });
    const rejection = value.reject("/work/app", created.draft.id);

    release();
    await expect(approval).resolves.toEqual({
      status: "storage-failed",
      message: "disk unavailable",
    });
    await expect(rejection).resolves.toEqual({ status: "rejected" });
    expect(value.pending("/work/app")).toBeNull();
  });

  it("marks stale proposals without deleting their visible content", async () => {
    const { value, onChange } = coordinator();
    const created = value.create({ cwd: "/work/app", sessionId: "s1", request });
    if (created.status !== "drafted") throw new Error("expected draft");

    await expect(
      value.approve("/work/app", created.draft.id, async () => ({
        status: "stale-revision",
        expectedRevision: 3,
        currentRevision: 4,
      })),
    ).resolves.toMatchObject({ status: "stale-revision" });
    expect(value.pending("/work/app")).toMatchObject({ id: created.draft.id, status: "stale" });
    expect(onChange).toHaveBeenLastCalledWith(
      "/work/app",
      expect.objectContaining({ status: "stale" }),
    );
    await expect(
      value.reject("/work/app", created.draft.id, "Make a fresh draft"),
    ).resolves.toEqual({ status: "rejected" });
  });

  it("makes rejection idempotent and rejects cross-project decisions", async () => {
    const { value } = coordinator();
    const created = value.create({ cwd: "/work/one", sessionId: "s1", request });
    if (created.status !== "drafted") throw new Error("expected draft");
    await expect(value.reject("/work/two", created.draft.id)).resolves.toEqual({
      status: "proposal-project-mismatch",
    });
    await expect(value.reject("/work/one", created.draft.id)).resolves.toEqual({
      status: "rejected",
    });
    await expect(value.reject("/work/one", created.draft.id)).resolves.toEqual({
      status: "rejected",
    });
    expect(value.pending("/work/one")).toBeNull();
  });

  it("creates an edit draft holding only the changed fields and emits defensive copies", () => {
    const { value, onChange } = coordinator();
    const created = value.createEdit({
      cwd: "C:\\Work\\App",
      sessionId: "session-1",
      request: editRequest,
      phase: phase(),
    });

    expect(created).toEqual({
      status: "drafted",
      draft: {
        kind: "edit",
        id: "id-1",
        projectKey: "c:/work/app",
        basedOnRevision: 3,
        createdAt: "2026-08-05T12:00:00.000Z",
        createdBySessionId: "session-1",
        summary: "Clarify the backend phase",
        phaseId: "phase-1",
        phaseTitle: "Backend",
        basedOnUpdatedAt: "2026-08-02T12:00:00.000Z",
        changes: [
          {
            field: "goal",
            before: "Create bounded backend support.",
            after: "Create bounded, validated backend support.",
          },
          {
            field: "doneWhen",
            before: ["Backend tests pass"],
            after: ["Backend tests pass", "Malformed input is rejected"],
          },
        ],
        status: "pending",
      },
    });
    expect(onChange).toHaveBeenCalledOnce();
    if (created.status !== "drafted") throw new Error("expected draft");
    const change = created.draft.changes[1]!;
    if (change.field !== "doneWhen") throw new Error("expected doneWhen change");
    change.after.push("mutated");
    expect(value.pending("c:/work/app")).toMatchObject({
      changes: [
        { field: "goal" },
        { after: ["Backend tests pass", "Malformed input is rejected"] },
      ],
    });
  });

  it("shares the one-pending slot between create and edit drafts", () => {
    const { value, onChange } = coordinator();
    const createdPhases = value.create({ cwd: "/work/app", sessionId: "s1", request });
    if (createdPhases.status !== "drafted") throw new Error("expected draft");
    onChange.mockClear();
    expect(
      value.createEdit({ cwd: "/work/app", sessionId: "s2", request: editRequest, phase: phase() }),
    ).toEqual({ status: "proposal-pending", draft: createdPhases.draft });
    expect(onChange).toHaveBeenCalledExactlyOnceWith("/work/app", createdPhases.draft);

    const other = coordinator();
    const edit = other.value.createEdit({
      cwd: "/work/app",
      sessionId: "s1",
      request: editRequest,
      phase: phase(),
    });
    if (edit.status !== "drafted") throw new Error("expected edit draft");
    expect(other.value.create({ cwd: "/work/app", sessionId: "s2", request })).toEqual({
      status: "proposal-pending",
      draft: edit.draft,
    });
  });

  it.each([
    ["done", { status: "done" as const, completedAt: "2026-08-03T12:00:00.000Z" }],
    ["archived", { archivedAt: "2026-08-03T12:00:00.000Z" }],
  ] as const)("refuses to draft an edit for a %s phase", (reason, overrides) => {
    const { value, onChange } = coordinator();
    expect(
      value.createEdit({
        cwd: "/work/app",
        sessionId: "s1",
        request: editRequest,
        phase: phase(overrides),
      }),
    ).toEqual({ status: "phase-not-editable", phaseId: "phase-1", reason });
    expect(value.pending("/work/app")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("returns no-changes, or invalid-proposal for bad input, without publishing", () => {
    const { value, onChange } = coordinator();
    expect(
      value.createEdit({
        cwd: "/work/app",
        sessionId: "s1",
        request: {
          expectedRevision: 3,
          summary: "Same",
          phaseId: "phase-1",
          title: " Backend ",
          doneWhen: ["Backend tests pass"],
        },
        phase: phase(),
      }),
    ).toEqual({ status: "no-changes", phaseId: "phase-1" });
    expect(
      value.createEdit({
        cwd: "/work/app",
        sessionId: "s1",
        request: { expectedRevision: 3, summary: "Nothing", phaseId: "phase-1" },
        phase: phase(),
      }),
    ).toMatchObject({ status: "invalid-proposal", path: "$" });
    expect(
      value.createEdit({
        cwd: "/work/app",
        sessionId: "s1",
        request: editRequest,
        phase: phase({ id: "phase-2" }),
      }),
    ).toMatchObject({ status: "invalid-proposal", path: "phaseId" });
    expect(value.pending("/work/app")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("records an edited approval tombstone and replays it idempotently", async () => {
    const { value, onChange } = coordinator();
    const created = value.createEdit({
      cwd: "/work/app",
      sessionId: "s1",
      request: editRequest,
      phase: phase(),
    });
    if (created.status !== "drafted") throw new Error("expected draft");
    const commit = vi.fn(async () => ({
      status: "edited" as const,
      revision: 4,
      phaseId: "phase-1",
    }));

    await expect(value.approve("/work/app", created.draft.id, commit)).resolves.toEqual({
      status: "edited",
      revision: 4,
      phaseId: "phase-1",
    });
    expect(commit).toHaveBeenCalledExactlyOnceWith(created.draft);
    await expect(value.approve("/work/app", created.draft.id, commit)).resolves.toEqual({
      status: "edited",
      revision: 4,
      phaseId: "phase-1",
    });
    await expect(value.reject("/work/app", created.draft.id)).resolves.toEqual({
      status: "already-decided",
      decision: "approved",
    });
    expect(commit).toHaveBeenCalledOnce();
    expect(value.pending("/work/app")).toBeNull();
    expect(onChange).toHaveBeenLastCalledWith("/work/app", null);
  });

  it.each([
    { status: "phase-changed" as const, phaseId: "phase-1" },
    { status: "phase-not-editable" as const, phaseId: "phase-1", reason: "deleted" as const },
  ])("marks an edit draft stale on $status and keeps it rejectable", async (outcome) => {
    const { value, onChange } = coordinator();
    const created = value.createEdit({
      cwd: "/work/app",
      sessionId: "s1",
      request: editRequest,
      phase: phase(),
    });
    if (created.status !== "drafted") throw new Error("expected draft");

    await expect(
      value.approve("/work/app", created.draft.id, async () => outcome),
    ).resolves.toEqual(outcome);
    expect(value.pending("/work/app")).toMatchObject({
      id: created.draft.id,
      kind: "edit",
      status: "stale",
    });
    expect(onChange).toHaveBeenLastCalledWith(
      "/work/app",
      expect.objectContaining({ kind: "edit", status: "stale" }),
    );
    await expect(
      value.reject("/work/app", created.draft.id, "Re-read the phase first"),
    ).resolves.toEqual({ status: "rejected" });
    expect(value.pending("/work/app")).toBeNull();
  });

  it("rejects invalid input without publishing or writing anything", () => {
    const { value, onChange } = coordinator();
    expect(
      value.create({
        cwd: "/work/app",
        sessionId: "s1",
        request: { ...request, phases: [{ ...request.phases[0]!, children: [] }] } as never,
      }),
    ).toMatchObject({ status: "invalid-proposal", path: "phases[0]" });
    expect(value.pending("/work/app")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });
});
