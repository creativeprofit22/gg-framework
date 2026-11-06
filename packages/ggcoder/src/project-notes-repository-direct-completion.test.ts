import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as ProjectNotesModule from "@kenkaiiii/gg-core/project-notes";
import type { NotesDocumentV3, NotesRoadmapStatusUpdate } from "@kenkaiiii/gg-core/project-notes";

vi.mock("@kenkaiiii/gg-core/project-notes", async (importOriginal) => {
  const actual = await importOriginal<typeof ProjectNotesModule>();
  return {
    ...actual,
    // Isolate the repository authority check from the document-load validation gate.
    validateNotesDocumentV3: (document: unknown) => ({ ok: true, document }),
  };
});

const { ProjectNotesRepository } = await import("./project-notes-repository.js");

const NOW = "2026-08-29T00:00:00.000Z";
const session = { sessionId: "coding-session", sessionPath: "/sessions/coding.jsonl" };
const roots: string[] = [];

function statusUpdate(overrides: Partial<NotesRoadmapStatusUpdate> = {}): NotesRoadmapStatusUpdate {
  return {
    type: "status-update",
    id: "verification-passed",
    actor: "gg-coder",
    transition: "done",
    progress: "Verification passed",
    blocker: null,
    requiredExternalAction: null,
    evidence: ["pnpm test exited successfully"],
    verification: "passed",
    verificationReason: null,
    verificationSession: session,
    statusOutcome: "completion-pending",
    proposedReferences: [],
    timestamp: NOW,
    ...overrides,
  };
}

function document(kind: "current" | "mutated-fixture" | "later-untyped-status"): NotesDocumentV3 {
  const verification = statusUpdate(
    kind === "mutated-fixture" ? { transition: "in-progress", statusOutcome: "applied" } : {},
  );
  const events: NotesDocumentV3["phases"][number]["roadmapEvents"] = [verification];
  if (kind === "later-untyped-status") {
    events.push(
      statusUpdate({
        id: "status-after-verification",
        transition: "in-progress",
        progress: "Work continued after verification",
        evidence: [],
        verification: null,
        verificationSession: null,
        statusOutcome: "applied",
      }),
    );
  }
  events.push(
    {
      type: "implementation-checkpoint",
      id: "implementation-checkpoint",
      session,
      planStepTotal: 1,
      completedPlanSteps: kind === "mutated-fixture" ? [] : [1],
      runOutcome: "succeeded",
      verificationStatusUpdateId: verification.id,
      timestamp: NOW,
    },
    {
      type: "phase-advancement-checkpoint",
      id: "advancement-checkpoint",
      implementationCheckpointId: "implementation-checkpoint",
      verificationStatusUpdateId: verification.id,
      completedPhaseId: "phase-1",
      nextPhaseId: "phase-2",
      timestamp: NOW,
    },
  );
  const phase = {
    id: "phase-1",
    title: "Direct completion",
    goal: "Reject stale completion authority",
    doneWhen: ["Focused tests pass"],
    order: 0,
    status: "done" as const,
    sourcePrompt: "Complete directly",
    referenceIds: [],
    session,
    reminder: null,
    attentionReason: null,
    createdAt: NOW,
    updatedAt: NOW,
    completedAt: NOW,
    archivedAt: null,
    overrides: { status: null, referenceIds: null },
    pendingAutomaticLifecycleTransition: null,
    lifecycleEvents: [],
    roadmapEvents: events,
  };
  return {
    version: 3,
    reference: "",
    currentFocus: "Direct completion",
    tasks: [],
    handoff: { text: "", updatedAt: null, readAt: null },
    updatedAt: NOW,
    legacyImportedAt: null,
    phases: [
      phase,
      {
        ...structuredClone(phase),
        id: "phase-2",
        title: "Next phase",
        order: 1,
        status: "not-started",
        session: null,
        completedAt: null,
        roadmapEvents: [],
      },
    ],
    references: [],
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("ProjectNotesRepository direct completion authority", () => {
  it("retains explicit advancement for an intact persisted direct-completion chain", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "repository-direct-authority-"));
    roots.push(agentDir);
    const repository = new ProjectNotesRepository(agentDir);
    const cwd = "/project/current";
    await repository.migrate(cwd, document("current"));
    const createBinding = vi.fn(async () => ({
      sessionId: "next-session",
      sessionPath: "/sessions/next.jsonl",
    }));
    const result = await repository.confirmPhaseAdvancement(
      cwd,
      {
        checkpointId: "advancement-checkpoint",
        nextPhaseId: "phase-2",
        action: "start-next-phase",
        operationId: "advance-current",
      },
      createBinding,
    );
    expect(result).toMatchObject({
      status: "accepted",
      phase: { id: "phase-2", status: "planning" },
    });
    expect(createBinding).toHaveBeenCalledOnce();
  });
  it.each(["mutated-fixture", "later-untyped-status"] as const)(
    "does not authorize completion or advancement for %s evidence",
    async (kind) => {
      const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "repository-direct-authority-"));
      roots.push(agentDir);
      const repository = new ProjectNotesRepository(agentDir);
      const cwd = `/project/${kind}`;
      await repository.migrate(cwd, document(kind));
      const before = await repository.load(cwd);
      const createBinding = vi.fn(async () => ({
        sessionId: "next-session",
        sessionPath: "/sessions/next.jsonl",
      }));

      await expect(
        repository.confirmPhaseAdvancement(
          cwd,
          {
            checkpointId: "advancement-checkpoint",
            nextPhaseId: "phase-2",
            action: "start-next-phase",
            operationId: `advance-${kind}`,
          },
          createBinding,
        ),
      ).resolves.toEqual({ status: "stale", reason: "completion-not-authoritative" });
      expect(createBinding).not.toHaveBeenCalled();
      expect(await repository.load(cwd)).toEqual(before);
    },
  );
});

describe("phase advancement into a phase with unfinished prerequisites", () => {
  /** Phase 2 depends on phase 3, which is still in progress in another session. */
  async function linkedProject(linked: boolean) {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "repository-advance-deps-"));
    roots.push(agentDir);
    const repository = new ProjectNotesRepository(agentDir);
    const cwd = `/project/advance-deps-${linked}`;
    const base = document("current");
    base.phases.push({
      ...structuredClone(base.phases[1]!),
      id: "phase-3",
      title: "Prerequisite",
      order: 2,
      status: "in-progress",
      session: { sessionId: "prereq-session", sessionPath: "/sessions/prereq.jsonl" },
    });
    const migrated = await repository.migrate(cwd, base);
    if (migrated.status !== "ok") throw Error(JSON.stringify(migrated));
    if (!linked) return { repository, cwd, revision: migrated.snapshot.revision };
    // Saves refuse topology edits under a pending checkpoint, so link the stored copy directly.
    const paths = repository.paths(cwd);
    for (const file of [paths.primary, paths.backup]) {
      const envelope = JSON.parse(await fs.readFile(file, "utf8"));
      envelope.storeVersion = 3;
      envelope.document.phases.find((phase: { id: string }) => phase.id === "phase-2").dependsOn = [
        "phase-3",
      ];
      await fs.writeFile(file, JSON.stringify(envelope));
    }
    const loaded = await repository.load(cwd);
    if (loaded.status !== "ok") throw Error(JSON.stringify(loaded));
    return { repository, cwd, revision: loaded.snapshot.revision };
  }

  it("refuses automatic advancement and writes nothing", async () => {
    const { repository, cwd, revision } = await linkedProject(true);
    const before = await repository.load(cwd);
    await expect(
      repository.confirmAutomaticPhaseAdvancement(cwd, {
        checkpointId: "advancement-checkpoint",
        expectedRevision: revision,
        destinationSession: session,
        timestamp: NOW,
      }),
    ).resolves.toEqual({ status: "stale", reason: "target-ineligible" });
    expect(await repository.load(cwd)).toEqual(before);
  });

  it("still advances automatically when the next phase has no links", async () => {
    const { repository, cwd, revision } = await linkedProject(false);
    await expect(
      repository.confirmAutomaticPhaseAdvancement(cwd, {
        checkpointId: "advancement-checkpoint",
        expectedRevision: revision,
        destinationSession: session,
        timestamp: NOW,
      }),
    ).resolves.toMatchObject({ status: "accepted", phase: { id: "phase-2" } });
  });

  it("records a user/app override when the user confirms the start", async () => {
    const { repository, cwd } = await linkedProject(true);
    const next = { sessionId: "next-session", sessionPath: "/sessions/next.jsonl" };
    const result = await repository.confirmPhaseAdvancement(
      cwd,
      {
        checkpointId: "advancement-checkpoint",
        nextPhaseId: "phase-2",
        action: "start-next-phase",
        operationId: "advance-linked",
      },
      async () => next,
    );
    expect(result).toMatchObject({ status: "accepted", phase: { id: "phase-2" } });
    const loaded = await repository.load(cwd);
    if (loaded.status !== "ok") throw Error(loaded.status);
    const phase2 = loaded.snapshot.document.phases.find((phase) => phase.id === "phase-2")!;
    expect(
      phase2.roadmapEvents.filter((event) => event.type === "dependency-override"),
    ).toMatchObject([
      { actor: "user", origin: "app", session: next, unfinishedPrerequisiteIds: ["phase-3"] },
    ]);
  });
});
