import { describe, expect, it, vi } from "vitest";
import type { NotesDocumentV3, NotesPhase, ProjectNotesLoadOutcome } from "@kenkaiiii/gg-core";
import type { ActivePhaseContextV1 } from "./phase-context.js";
import { reconcileActivePhaseVerificationStage } from "./app-sidecar-phase-verification.js";

const now = "2026-08-05T00:00:00.000Z";
const sessionLink = { sessionId: "session-active", sessionPath: "/tmp/session-active.jsonl" };

function phase(): NotesPhase {
  return {
    id: "phase-active",
    title: "Verification handoff",
    goal: "Resume safely",
    doneWhen: ["Tests pass"],
    order: 0,
    status: "review",
    sourcePrompt: "Implement this phase",
    referenceIds: [],
    session: sessionLink,
    reminder: null,
    attentionReason: null,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    archivedAt: null,
    overrides: { status: null, referenceIds: null },
    pendingAutomaticLifecycleTransition: null,
    lifecycleEvents: [],
    roadmapEvents: [
      {
        type: "status-update",
        id: "verification-pass",
        actor: "gg-coder",
        transition: "review",
        progress: "Tests passed",
        blocker: null,
        requiredExternalAction: null,
        evidence: ["pnpm test: passed"],
        verification: "passed",
        verificationReason: null,
        verificationSession: sessionLink,
        statusOutcome: "applied",
        proposedReferences: [],
        timestamp: now,
      },
    ],
  };
}

function context(executionStage: "implementing" | "reviewing"): ActivePhaseContextV1 {
  return {
    version: 1,
    projectKey: "/tmp/project",
    phase: {
      id: "phase-active",
      title: "Verification handoff",
      goal: "Resume safely",
      doneWhen: ["Tests pass"],
      sourcePrompt: "Implement this phase",
      status: "in-progress",
      archivedAt: null,
    },
    session: sessionLink,
    references: [],
    executionStage,
  };
}

function loadOutcome(activePhase: NotesPhase): ProjectNotesLoadOutcome {
  const document: NotesDocumentV3 = {
    version: 3,
    reference: "",
    currentFocus: "",
    tasks: [],
    handoff: { text: "", updatedAt: null, readAt: null },
    updatedAt: now,
    legacyImportedAt: null,
    phases: [activePhase],
    references: [],
  };
  return {
    status: "ok",
    snapshot: { projectKey: "/tmp/project", revision: 4, document },
    recoveredFromBackup: false,
  };
}

describe("active phase verification restart reconciliation", () => {
  it("restores reviewing only from durable passed evidence for the exact session", async () => {
    const updateActivePhaseStage = vi.fn(async () => undefined);
    const stage = await reconcileActivePhaseVerificationStage({
      cwd: "/tmp/project",
      repository: { load: vi.fn(async () => loadOutcome(phase())) },
      session: {
        getActivePhaseContext: () => context("implementing"),
        updateActivePhaseStage,
      },
    });

    expect(stage).toBe("reviewing");
    expect(updateActivePhaseStage).toHaveBeenCalledOnce();
    expect(updateActivePhaseStage).toHaveBeenCalledWith("reviewing");
  });

  it("fails closed to implementing when durable review evidence is stale", async () => {
    const stalePhase = phase();
    stalePhase.session = { sessionId: "other", sessionPath: "/tmp/other.jsonl" };
    const updateActivePhaseStage = vi.fn(async () => undefined);
    const stage = await reconcileActivePhaseVerificationStage({
      cwd: "/tmp/project",
      repository: { load: vi.fn(async () => loadOutcome(stalePhase)) },
      session: {
        getActivePhaseContext: () => context("reviewing"),
        updateActivePhaseStage,
      },
    });

    expect(stage).toBe("implementing");
    expect(updateActivePhaseStage).toHaveBeenCalledWith("implementing");
  });
});
