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
    const createBinding = vi.fn(async () => ({ sessionId: "next-session", sessionPath: "/sessions/next.jsonl" }));
    const result = await repository.confirmPhaseAdvancement(cwd, {
      checkpointId: "advancement-checkpoint", nextPhaseId: "phase-2",
      action: "start-next-phase", operationId: "advance-current",
    }, createBinding);
    expect(result).toMatchObject({ status: "accepted", phase: { id: "phase-2", status: "planning" } });
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
