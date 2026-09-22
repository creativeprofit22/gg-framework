import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type NotesDocumentV3, type PhaseDeletionRequest, type ProjectNotesSnapshot } from "@kenkaiiii/gg-core/project-notes";
import { createAppSidecarPhaseDeletionCoordinator, type PhaseDeletionSession } from "./app-sidecar-phase-deletion.js";
import { AppSidecarRoadmapReconciliationCoordinator } from "./app-sidecar-roadmap-reconciliation.js";
import { AppSidecarSessionMutationCoordinator } from "./app-sidecar-session-mutation.js";
import { ProjectNotesRepository } from "./project-notes-repository.js";
import { RoadmapPhaseLeaseRepository } from "./roadmap-phase-lease-repository.js";

const roots: string[] = [];
const now = "2026-09-21T12:00:00.000Z";
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gg-deletion-coordinator-")); roots.push(root);
  const cwd = path.join(root, "project");
  const repository = new ProjectNotesRepository(root);
  const leases = new RoadmapPhaseLeaseRepository(root, { processLiveness: async () => "alive" });
  const document: NotesDocumentV3 = { version: 3, reference: "Retain reference text", currentFocus: "", tasks: [],
    handoff: { text: "Retain handoff", updatedAt: now, readAt: null }, legacyImportedAt: null, references: [], updatedAt: now,
    phases: [{ id: "draft", title: "Draft", goal: "Retain content", doneWhen: [], status: "not-started", order: 0,
      sourcePrompt: "", referenceIds: [], session: null, reminder: null, attentionReason: null,
      createdAt: now, updatedAt: now, completedAt: null, archivedAt: null, overrides: { status: null, referenceIds: null },
      pendingAutomaticLifecycleTransition: null, lifecycleEvents: [], roadmapEvents: [] }] };
  const loaded = await repository.migrate(cwd, document);
  if (loaded.status !== "ok") throw Error(JSON.stringify(loaded));
  const busy = { running: false, autopilotActive: false, runLifecycleRunning: false };
  const makeSession = (id: string, scope = cwd): PhaseDeletionSession => ({
    getState: () => ({ cwd: scope, sessionId: id, sessionPath: path.join(root, id + ".jsonl") }),
    getBusyState: () => busy, getActivePhaseContext: () => undefined, setActivePhaseContext: async () => {},
    mutations: new AppSidecarSessionMutationCoordinator(),
  });
  const session = makeSession("current"); const sibling = makeSession("sibling");
  const other = makeSession("other", path.join(root, "other-project"));
  const sessions = [session, sibling, other]; const broadcasts: ProjectNotesSnapshot[] = [];
  const coordinator = createAppSidecarPhaseDeletionCoordinator({ repository, leases,
    reconciliations: new AppSidecarRoadmapReconciliationCoordinator(),
    listSessions: () => sessions, onCommittedSnapshot: snapshot => broadcasts.push(snapshot) });
  const request: PhaseDeletionRequest = { version: 1, action: "delete", operationId: "delete-1", phaseId: "draft",
    expectedProjectKey: loaded.snapshot.projectKey, expectedRevision: 1, expectedGeneration: 0 };
  return { root, cwd, repository, leases, session, sibling, other, sessions, busy, coordinator, request, broadcasts };
}

describe("daemon phase deletion coordinator", () => {
  it("commits only scoped authenticated actions, broadcasts durable snapshots, and leaves other projects alone", async () => {
    const f = await setup(); const otherMutation = f.other.mutations.tryAcquire("prompt-start")!;
    expect(await f.coordinator.execute({ ...f.request, actor: "admin" }, f.session)).toMatchObject({ status: "unavailable" });
    expect(await f.coordinator.execute(f.request, f.other)).toMatchObject({ status: "unavailable" });
    expect(f.broadcasts).toHaveLength(0);
    expect(await f.coordinator.execute(f.request, f.session)).toMatchObject({ status: "committed", replayed: false });
    expect(f.broadcasts).toHaveLength(1);
    expect(f.broadcasts[0]!.revision).toBe(2);
    expect(f.other.mutations.owner?.operationId).toBe(otherMutation.operationId);
    expect(f.session.mutations.owner).toBeNull(); expect(f.sibling.mutations.owner).toBeNull();
    otherMutation.release();
  });

  it.each(["phase-start", "prompt-start"] as const)("refuses an accepted %s before provider execution", async kind => {
    const f = await setup(); const mutation = f.sibling.mutations.tryAcquire(kind)!;
    expect(await f.coordinator.execute(f.request, f.session)).toMatchObject({ status: "refused", reason: "active-execution" });
    expect(f.broadcasts).toHaveLength(0); expect(f.session.mutations.owner).toBeNull();
    expect(f.sibling.mutations.owner?.operationId).toBe(mutation.operationId);
    mutation.release();
    f.busy.runLifecycleRunning = true; // Accepted prompt, mutation released, provider not yet running.
    expect(await f.coordinator.execute(f.request, f.session)).toMatchObject({ status: "refused", reason: "active-execution" });
    const loaded = await f.repository.load(f.cwd);
    expect(loaded.status === "ok" && loaded.snapshot.revision).toBe(1);
  });

  it("holds sibling startup gates through the real Notes write and prevents delete/start races", async () => {
    const f = await setup();
    let signal!: () => void; const entered = new Promise<void>(r => { signal = r; });
    let release!: () => void; const held = new Promise<void>(r => { release = r; });
    const original = f.repository.mutatePhaseDeletion.bind(f.repository);
    f.repository.mutatePhaseDeletion = async (...args) => { signal(); await held; return original(...args); };
    const deleting = f.coordinator.execute(f.request, f.session); await entered;
    expect(f.sibling.mutations.tryAcquire("phase-start")).toBeNull();
    expect(f.session.mutations.tryAcquire("prompt-start")).toBeNull();
    release(); expect((await deleting).status).toBe("committed");
  });

  it("refuses newly attached sessions at commit time", async () => {
    const f = await setup(); const original = f.repository.mutatePhaseDeletion.bind(f.repository);
    f.repository.mutatePhaseDeletion = async (...args) => {
      f.sessions.push({ ...f.session, mutations: new AppSidecarSessionMutationCoordinator() });
      return original(...args);
    };
    expect(await f.coordinator.execute(f.request, f.session)).toMatchObject({ status: "refused", reason: "active-execution" });
  });

  it("resolves a lost acknowledgement by replay even while a later run is busy", async () => {
    const f = await setup(); expect((await f.coordinator.execute(f.request, f.session)).status).toBe("committed");
    f.busy.runLifecycleRunning = true;
    expect(await f.coordinator.execute(f.request, f.session)).toMatchObject({ status: "committed", replayed: true });
    expect(f.broadcasts.map(snapshot => snapshot.revision)).toEqual([2, 2]);
  });
});
