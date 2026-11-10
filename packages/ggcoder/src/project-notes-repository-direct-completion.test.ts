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

async function project(name: string, linked = false) {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "repository-old-advancement-"));
  roots.push(agentDir);
  const repository = new ProjectNotesRepository(agentDir);
  const cwd = `/project/${name}`;
  const base = document("current");
  /** Phase 3 is still in progress in another session. */
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
  // Migration cannot create dependency links, so link the stored copy directly.
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

function sourceEvents(document: NotesDocumentV3) {
  return document.phases.find((phase) => phase.id === "phase-1")!.roadmapEvents;
}

describe("old phase advancement checkpoints are ignored", () => {
  it("starts the old target normally and keeps the checkpoint", async () => {
    const { repository, cwd } = await project("normal-start");
    const before = await repository.load(cwd);
    if (before.status !== "ok") throw Error(before.status);
    const createBinding = vi.fn(async () => ({
      sessionId: "next-session",
      sessionPath: "/sessions/next.jsonl",
    }));
    await expect(repository.launchPhase(cwd, "phase-2", createBinding)).resolves.toMatchObject({
      status: "accepted",
      phase: { id: "phase-2", status: "planning" },
    });
    expect(createBinding).toHaveBeenCalledOnce();
    const after = await repository.load(cwd);
    if (after.status !== "ok") throw Error(after.status);
    expect(sourceEvents(after.snapshot.document)).toEqual(sourceEvents(before.snapshot.document));
  });

  it("still asks about unfinished prerequisites and records the user/app override", async () => {
    const { repository, cwd } = await project("linked", true);
    const next = { sessionId: "next-session", sessionPath: "/sessions/next.jsonl" };
    const createBinding = vi.fn(async () => next);
    await expect(repository.launchPhase(cwd, "phase-2", createBinding)).resolves.toMatchObject({
      status: "prerequisites-confirmation-required",
      prerequisites: [{ id: "phase-3" }],
    });
    expect(createBinding).not.toHaveBeenCalled();
    await expect(
      repository.launchPhase(cwd, "phase-2", createBinding, {
        confirmedPrerequisiteIds: ["phase-3"],
      }),
    ).resolves.toMatchObject({ status: "accepted", phase: { id: "phase-2" } });
    const loaded = await repository.load(cwd);
    if (loaded.status !== "ok") throw Error(loaded.status);
    const phase2 = loaded.snapshot.document.phases.find((phase) => phase.id === "phase-2")!;
    expect(
      phase2.roadmapEvents.filter((event) => event.type === "dependency-override"),
    ).toMatchObject([
      { actor: "user", origin: "app", session: next, unfinishedPrerequisiteIds: ["phase-3"] },
    ]);
  });

  it.each(["reorder", "archive"] as const)(
    "accepts a generic save that changes the old target (%s)",
    async (change) => {
      const { repository, cwd, revision } = await project(`save-${change}`);
      const loaded = await repository.load(cwd);
      if (loaded.status !== "ok") throw Error(loaded.status);
      const next = structuredClone(loaded.snapshot.document);
      const target = next.phases.find((phase) => phase.id === "phase-2")!;
      if (change === "reorder") {
        const other = next.phases.find((phase) => phase.id === "phase-3")!;
        [target.order, other.order] = [other.order, target.order];
      } else {
        target.archivedAt = NOW;
      }
      await expect(repository.save(cwd, revision, next)).resolves.toMatchObject({ status: "ok" });
      const saved = await repository.load(cwd);
      if (saved.status !== "ok") throw Error(saved.status);
      expect(sourceEvents(saved.snapshot.document)).toEqual(sourceEvents(next));
    },
  );
});
