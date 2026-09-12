import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RunLifecycle } from "./core/run-lifecycle.js";
import {
  AppSidecarPhaseCancellationCoordinator,
  type PhaseCancellationSession,
} from "./app-sidecar-phase-cancellation.js";
import type { ActivePhaseContextV1 } from "./phase-context.js";
import {
  ProjectNotesRepository,
  canonicalProjectKey,
  type NotesDocumentV3,
  type NotesSessionLink,
} from "./project-notes-repository.js";

const NOW = "2026-08-03T00:00:00.000Z";
const roots: string[] = [];

function notesDocument(
  session: NotesSessionLink,
  statusOverride: NotesDocumentV3["phases"][number]["overrides"]["status"] = null,
): NotesDocumentV3 {
  return {
    version: 3,
    reference: "",
    currentFocus: "Cancel the bound phase",
    tasks: [],
    handoff: { text: "", updatedAt: null, readAt: null },
    updatedAt: NOW,
    legacyImportedAt: null,
    references: [],
    phases: [
      {
        id: "phase-cancel",
        title: "Bound phase",
        goal: "Stop the actual operation",
        doneWhen: ["The run and Notes stop together"],
        order: 0,
        status: "in-progress",
        sourcePrompt: "Implement the phase",
        referenceIds: [],
        session,
        reminder: null,
        attentionReason: null,
        createdAt: NOW,
        updatedAt: NOW,
        completedAt: null,
        archivedAt: null,
        overrides: { status: statusOverride, referenceIds: null },
        pendingAutomaticLifecycleTransition: null,
        lifecycleEvents: [],
        roadmapEvents: [],
      },
    ],
  };
}

function activeContext(projectKey: string, session: NotesSessionLink): ActivePhaseContextV1 {
  return {
    version: 1,
    projectKey,
    phase: {
      id: "phase-cancel",
      title: "Bound phase",
      goal: "Stop the actual operation",
      doneWhen: ["The run and Notes stop together"],
      sourcePrompt: "Implement the phase",
      status: "in-progress",
      archivedAt: null,
    },
    session,
    references: [],
    executionStage: "implementing",
  };
}

async function setup(withStatusOverride = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gg-phase-cancel-"));
  roots.push(root);
  const cwd = path.join(root, "project");
  await fs.mkdir(cwd, { recursive: true });
  const repository = new ProjectNotesRepository(path.join(root, ".gg"));
  const session = { sessionId: "bound-session", sessionPath: "/sessions/bound.jsonl" };
  await repository.migrate(
    cwd,
    notesDocument(
      session,
      withStatusOverride ? { value: "in-progress", source: "user", updatedAt: NOW } : null,
    ),
  );
  return { cwd, repository, session };
}

function runningSession(
  cwd: string,
  context: ActivePhaseContextV1,
  lifecycle: RunLifecycle,
  timeoutMs: number,
): PhaseCancellationSession {
  return {
    cwd,
    getActivePhaseContext: () => structuredClone(context),
    isRunning: () => lifecycle.running,
    cancelActiveOperation: async () => {
      const result = await lifecycle.cancel(timeoutMs);
      return result.status === "failed"
        ? { status: "failed", reason: result.reason }
        : { status: result.status };
    },
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("AppSidecarPhaseCancellationCoordinator", () => {
  it("stops the phase’s bound agent operation before Notes becomes Cancelled", async () => {
    const { cwd, repository, session } = await setup(true);
    const lifecycle = new RunLifecycle();
    const abort = vi.fn();
    const lease = lifecycle.begin(() => {
      abort();
      queueMicrotask(() => lifecycle.settle(lease.generation, "aborted"));
    });
    const matching = runningSession(
      cwd,
      activeContext(canonicalProjectKey(cwd), session),
      lifecycle,
      1_000,
    );
    const wrongSessionCancel = vi.fn();
    const wrongSession: PhaseCancellationSession = {
      cwd,
      getActivePhaseContext: () =>
        activeContext(canonicalProjectKey(cwd), {
          sessionId: "other-session",
          sessionPath: "/sessions/other.jsonl",
        }),
      isRunning: () => true,
      cancelActiveOperation: async () => {
        wrongSessionCancel();
        return { status: "cancelled" };
      },
    };
    const broadcasts: string[] = [];
    const coordinator = new AppSidecarPhaseCancellationCoordinator({
      repository,
      sessions: () => [wrongSession, matching],
      broadcastSnapshot: (snapshot) => {
        expect(lifecycle.state).toBe("idle");
        broadcasts.push(snapshot.document.phases[0]?.status ?? "missing");
      },
      now: () => NOW,
    });

    await expect(coordinator.cancel(cwd, "phase-cancel")).resolves.toEqual({
      status: "cancelled",
      phaseId: "phase-cancel",
      session,
    });

    expect(wrongSessionCancel).not.toHaveBeenCalled();
    expect(abort).toHaveBeenCalledOnce();
    expect(lifecycle.state).toBe("idle");
    expect(broadcasts).toEqual(["cancelled"]);
    const loaded = await repository.load(cwd);
    expect(loaded.status).toBe("ok");
    if (loaded.status !== "ok") throw new Error("Project Notes did not load");
    expect(loaded.snapshot.document.phases[0]).toMatchObject({
      status: "cancelled",
      completedAt: NOW,
      session,
      overrides: {
        status: { value: "cancelled", source: "user", updatedAt: NOW },
      },
    });
  });

  it("keeps Notes active when the bound agent operation fails to stop", async () => {
    const { cwd, repository, session } = await setup();
    const lifecycle = new RunLifecycle();
    const lease = lifecycle.begin(vi.fn());
    const coordinator = new AppSidecarPhaseCancellationCoordinator({
      repository,
      sessions: () => [
        runningSession(cwd, activeContext(canonicalProjectKey(cwd), session), lifecycle, 0),
      ],
      broadcastSnapshot: vi.fn(),
      now: () => NOW,
    });

    await expect(coordinator.cancel(cwd, "phase-cancel")).resolves.toMatchObject({
      status: "failed",
      code: "cancellation-failed",
      operationStopped: false,
    });

    expect(lifecycle.state).toBe("running");
    const loaded = await repository.load(cwd);
    expect(loaded.status).toBe("ok");
    if (loaded.status !== "ok") throw new Error("Project Notes did not load");
    expect(loaded.snapshot.document.phases[0]).toMatchObject({
      status: "in-progress",
      completedAt: null,
      session,
      lifecycleEvents: [],
    });
    lifecycle.settle(lease.generation, "failed");
  });
});
