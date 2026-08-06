import { describe, expect, it, vi } from "vitest";
import { AppSidecarRoadmapDraftCoordinator } from "./app-sidecar-roadmap-drafts.js";

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
    created.draft.phases[0]!.doneWhen.push("mutated");
    expect(value.pending("c:/work/app")?.phases[0]!.doneWhen).toEqual(["Backend tests pass"]);
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
