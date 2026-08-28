import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  canonicalProjectKey,
  validateNotesDocumentV3,
  type NotesDocumentV3,
  type ProjectNotesSnapshot,
} from "@kenkaiiii/gg-core/project-notes";
import type { PhaseBindingRequest } from "@kenkaiiii/gg-core/phase-binding-protocol";
import {
  createAppSidecarPhaseBindingService,
  type PhaseBindingSession,
} from "./app-sidecar-phase-binding.js";
import type { ActivePhaseContextV1 } from "./phase-context.js";
import { ProjectNotesRepository } from "./project-notes-repository.js";

const roots: string[] = [];
const sessionA = { sessionId: "session-a", sessionPath: "/sessions/a.jsonl" };
const sessionB = { sessionId: "session-b", sessionPath: "/sessions/b.jsonl" };

class FakeSession implements PhaseBindingSession {
  active: ActivePhaseContextV1 | undefined;
  readonly setCalls: Array<ActivePhaseContextV1 | undefined> = [];
  readonly clearReasons: string[] = [];

  constructor(
    readonly cwd: string,
    private readonly state: { sessionId: string; sessionPath: string | null },
  ) {}

  getState() {
    return { cwd: this.cwd, ...this.state };
  }

  getActivePhaseContext() {
    return this.active;
  }

  async setActivePhaseContext(context: ActivePhaseContextV1 | undefined) {
    this.setCalls.push(context);
    this.active = context;
  }

  async clearActivePhaseContext(reason: "cleared" | "binding-compensation" | "binding-reconciliation" | "phase-rebound") {
    this.clearReasons.push(reason);
    this.active = undefined;
  }
}

async function fixtureDocument(): Promise<NotesDocumentV3> {
  const raw = JSON.parse(
    await fs.readFile(new URL("../../../fixtures/project-notes-v3.json", import.meta.url), "utf8"),
  ) as unknown;
  const validation = validateNotesDocumentV3(raw);
  if (!validation.ok) throw new Error(`Invalid fixture: ${validation.error.path}`);
  return structuredClone(validation.document);
}

async function setup(name: string, previousSession = sessionA) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `gg-phase-binding-${name}-`));
  roots.push(root);
  const cwd = path.join(root, "project");
  const repository = new ProjectNotesRepository(path.join(root, "agent"));
  const document = await fixtureDocument();
  const phase = document.phases[0]!;
  phase.id = "phase-1";
  phase.status = "in-progress";
  phase.session = previousSession;
  phase.reminder = null;
  phase.attentionReason = null;
  phase.completedAt = null;
  phase.archivedAt = null;
  phase.overrides.status = null;
  phase.pendingAutomaticLifecycleTransition = null;
  phase.lifecycleEvents = [];
  phase.roadmapEvents = [];
  document.phases = [phase];
  const migrated = await repository.migrate(cwd, document);
  if (migrated.status !== "ok") throw new Error(`Failed binding fixture: ${migrated.status}`);
  return { cwd, repository };
}

function request(cwd: string, overrides: Partial<PhaseBindingRequest> = {}): PhaseBindingRequest {
  return {
    version: 1,
    action: "rebind-current",
    phaseId: "phase-1",
    expectedProjectKey: canonicalProjectKey(cwd),
    expectedRevision: 1,
    expectedPreviousSession: sessionA,
    operationId: "operation-1",
    confirmRebind: true,
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("app sidecar phase binding service", () => {
  it("persists destination context and fans out one authoritative snapshot", async () => {
    const { cwd, repository } = await setup("commit");
    const aliasCwd = `${cwd}${path.sep}.`;
    const otherCwd = path.join(cwd, "..", "other-project");
    const deliveries = new Map<string, ProjectNotesSnapshot[]>([
      [cwd, []],
      [aliasCwd, []],
      [otherCwd, []],
    ]);
    const service = createAppSidecarPhaseBindingService({
      repository,
      now: () => "2026-07-25T12:36:00.000Z",
      onCommittedSnapshot: (snapshot) => {
        for (const [projectCwd, events] of deliveries) {
          if (canonicalProjectKey(projectCwd) === snapshot.projectKey) events.push(snapshot);
        }
      },
    });
    const session = new FakeSession(cwd, sessionB);

    await expect(service.bind(request(cwd), session)).resolves.toMatchObject({
      status: "committed",
      revision: 2,
      previousSession: sessionA,
      session: sessionB,
    });
    expect(session.setCalls).toHaveLength(1);
    expect(session.active).toMatchObject({
      projectKey: canonicalProjectKey(cwd),
      phase: { id: "phase-1" },
      session: sessionB,
    });
    await expect(repository.load(cwd)).resolves.toMatchObject({
      status: "ok",
      snapshot: { revision: 2, document: { phases: [{ session: sessionB }] } },
    });
    expect(deliveries.get(cwd)).toHaveLength(1);
    expect(deliveries.get(aliasCwd)).toHaveLength(1);
    expect(deliveries.get(otherCwd)).toHaveLength(0);
  });

  it("does not publish when repository compare-and-swap rejects", async () => {
    const { cwd, repository } = await setup("compensation");
    const bindPhaseToCurrentSession = vi.fn(async () => ({
      status: "stale-revision" as const,
      revision: 2,
    }));
    const onCommittedSnapshot = vi.fn();
    const service = createAppSidecarPhaseBindingService({
      repository: { load: (project) => repository.load(project), bindPhaseToCurrentSession },
      onCommittedSnapshot,
    });
    const session = new FakeSession(cwd, sessionB);

    await expect(service.bind(request(cwd), session)).resolves.toEqual({
      status: "stale-revision",
      revision: 2,
    });
    expect(session.setCalls).toHaveLength(1);
    expect(session.clearReasons).toEqual(["binding-compensation"]);
    expect(session.active).toBeUndefined();
    expect(onCommittedSnapshot).not.toHaveBeenCalled();
  });

  it("does not call the repository when context persistence fails", async () => {
    const { cwd, repository } = await setup("context-failure");
    const bindPhaseToCurrentSession = vi.fn(repository.bindPhaseToCurrentSession.bind(repository));
    const service = createAppSidecarPhaseBindingService({
      repository: { load: (project) => repository.load(project), bindPhaseToCurrentSession },
    });
    const session = new FakeSession(cwd, sessionB);
    session.setActivePhaseContext = vi.fn(async () => {
      throw new Error("transcript append failed");
    });

    await expect(service.bind(request(cwd), session)).rejects.toThrow("transcript append failed");
    expect(bindPhaseToCurrentSession).not.toHaveBeenCalled();
  });

  it("clears a former session after restoration detects a rebind", async () => {
    const { cwd, repository } = await setup("reconcile");
    const service = createAppSidecarPhaseBindingService({ repository });
    const destination = new FakeSession(cwd, sessionB);
    await service.bind(request(cwd), destination);
    const former = new FakeSession(cwd, sessionA);
    former.active = destination.active ? { ...destination.active, session: sessionA } : undefined;

    await expect(service.reconcile(former)).resolves.toBe("cleared");
    expect(former.clearReasons).toEqual(["phase-rebound"]);
    expect(former.active).toBeUndefined();
    await expect(service.reconcile(destination)).resolves.toBe("consistent");
  });

  it("fails closed when the authenticated destination lacks a persistent path", async () => {
    const { cwd, repository } = await setup("missing-path");
    const service = createAppSidecarPhaseBindingService({ repository });
    const session = new FakeSession(cwd, { sessionId: "ephemeral", sessionPath: null });

    await expect(service.bind(request(cwd), session)).resolves.toEqual({
      status: "missing-session-path",
    });
    expect(session.setCalls).toHaveLength(0);
  });
});
