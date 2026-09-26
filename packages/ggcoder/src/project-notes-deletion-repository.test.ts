import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  canonicalProjectKey, notesPhaseDeletionGeneration, type NotesDocumentV3,
  type PhaseDeletionRequest, type ProjectNotesSnapshot,
} from "@kenkaiiii/gg-core/project-notes";
import { ProjectNotesRepository, type ProjectNotesFileSystem } from "./project-notes-repository.js";

const { completionCompatibilityFixture, encodeCompatibleDone } = await import(new URL(
  "../../gg-core/src/test-fixtures/project-notes-completion-compatibility.ts", import.meta.url,
).href) as {
  completionCompatibilityFixture(): Promise<NotesDocumentV3>;
  encodeCompatibleDone(document: NotesDocumentV3): NotesDocumentV3;
};
const { validateNotesDocumentV3: frozenOldValidator } = await import(new URL(
  "../../gg-core/src/test-fixtures/project-notes-pre-simplification-validator.ts", import.meta.url,
).href) as { validateNotesDocumentV3(document: unknown): { ok: boolean } };

/** Frozen v1-reader envelope branch: future versions are refused BEFORE backup fallback.
 * Uses the existing frozen pre-deletion document validator, never the new validator.
 */
function frozenV1Read(primary: string | null, backup: string | null): "ok" | "unsupported" | "corrupt" {
  for (const raw of [primary, backup]) {
    if (raw === null) continue;
    let value;
    try { value = JSON.parse(raw); } catch { continue; }
    if (typeof value?.storeVersion === "number" && value.storeVersion > 1 ||
        typeof value?.document?.version === "number" && value.document.version > 3) return "unsupported";
    if (value?.storeVersion === 1 && Number.isInteger(value.revision) &&
        typeof value.projectKey === "string" && frozenOldValidator(value.document).ok) return "ok";
  }
  return "corrupt";
}

const roots: string[] = [];
const now = "2026-09-21T12:00:00.000Z";
const allow = async () => null;
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});
async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gg-deletion-repository-")); roots.push(root);
  const cwd = path.join(root, "project"); const agentDir = path.join(root, "agent");
  const repository = new ProjectNotesRepository(agentDir);
  const document = await completionCompatibilityFixture();
  const draft = document.phases[2]!;
  draft.status = "not-started"; draft.completedAt = null; draft.session = null;
  draft.lifecycleEvents = []; draft.roadmapEvents = []; draft.reminder = null;
  document.phases = [draft]; draft.order = 0;
  const result = await repository.migrate(cwd, document);
  if (result.status !== "ok") throw Error(JSON.stringify(result));
  return { root, cwd, agentDir, repository, document, snapshot: result.snapshot, paths: repository.paths(cwd) };
}
function request(snapshot: ProjectNotesSnapshot, action: "delete" | "recover" = "delete", operationId?: string): PhaseDeletionRequest {
  const phase = snapshot.document.phases[0]!;
  const generation = notesPhaseDeletionGeneration(phase);
  return { version: 1, action, operationId: operationId ?? `operation-${generation}`,
    phaseId: phase.id, expectedProjectKey: snapshot.projectKey,
    expectedRevision: snapshot.revision, expectedGeneration: generation };
}
async function readFiles(paths: { primary: string; backup: string }) {
  return Promise.all([fs.readFile(paths.primary, "utf8"), fs.readFile(paths.backup, "utf8")]);
}

describe("durable phase deletion repository", () => {
  it("rejects delayed progress, completion and in-flight reminder delivery after deletion and recovery", async () => {
    const f = await setup(); const phaseId = f.snapshot.document.phases[0]!.id;
    const deleted = await f.repository.mutatePhaseDeletion(f.cwd, request(f.snapshot), allow, now);
    if (deleted.status !== "committed") throw Error(JSON.stringify(deleted));
    const lateUpdate = { updateId: "late", phaseId, expectedRevision: 1, actor: "gg-coder" as const,
      transition: "in-progress" as const, progress: "Old run", blocker: null, requiredExternalAction: null,
      evidence: [], verification: null, verificationReason: null, proposedReferences: [], timestamp: now,
      expectedSession: { sessionId: "old", sessionPath: null }, autopilotEnabled: false };
    expect(await f.repository.recordRoadmapStatusUpdate(f.cwd, lateUpdate)).toMatchObject({ status: "phase-not-found" });
    expect(await f.repository.recordReminderDelivery(f.cwd, { phaseId, occurrenceKey: "in-flight",
      channel: "in-app", permission: "not-required", attemptedAt: now })).toMatchObject({ status: "phase-not-found" });
    const recovered = await f.repository.mutatePhaseDeletion(f.cwd, request(deleted.snapshot, "recover"), allow, now);
    if (recovered.status !== "committed") throw Error(JSON.stringify(recovered));
    for (const transition of ["in-progress", "done"] as const) {
      expect(await f.repository.recordRoadmapStatusUpdate(f.cwd, { ...lateUpdate, transition }))
        .toMatchObject({ status: "stale-revision" });
    }
    expect(await f.repository.recordPhaseLifecycleTransition(f.cwd, phaseId, {
      status: "in-progress", source: "agent", reason: "Delayed legacy callback", timestamp: now,
    })).toMatchObject({ status: "stale-session" });
    expect((await f.repository.load(f.cwd))).toMatchObject({ status: "ok", snapshot: { revision: recovered.snapshot.revision } });
  });

  it.each(["draft", "archived", "done", "history"])("deletes and recovers %s through restart, preserving unrelated data", async kind => {
    const fixture = await setup(); const { cwd, agentDir, paths, repository } = fixture;
    const document = fixture.document;
    const phase = document.phases[0]!;
    if (kind === "archived") phase.archivedAt = now;
    if (kind === "done" || kind === "history") {
      phase.status = kind === "done" ? "done" : "planning";
      phase.completedAt = kind === "done" ? now : null;
      phase.lifecycleEvents = [{ id: "old-status", source: "user", kind: "other",
        fromStatus: null, toStatus: phase.status, timestamp: now, reason: "Synthetic history" }];
    }
    // Seed historical status as fixture data, never through an unauthorized generic status edit.
    const seed = { storeVersion: 1, projectKey: fixture.snapshot.projectKey, revision: 2, document };
    await fs.writeFile(paths.primary, JSON.stringify(seed)); await fs.writeFile(paths.backup, JSON.stringify(seed));
    const saved = await repository.load(cwd);
    expect(saved.status).toBe("ok"); if (saved.status !== "ok") throw Error(JSON.stringify(saved));
    const before = structuredClone(saved.snapshot.document);
    const started = performance.now();
    const deletion = request(saved.snapshot);
    const deleted = await repository.mutatePhaseDeletion(cwd, deletion, allow, now);
    expect(deleted.status).toBe("committed"); if (deleted.status !== "committed") throw Error(JSON.stringify(deleted));
    const files = await readFiles(paths);
    expect(files.map(raw => JSON.parse(raw).storeVersion)).toEqual([2, 2]);
    expect(frozenV1Read(...files as [string, string])).toBe("unsupported");
    expect(frozenV1Read(null, files[1]!)).toBe("unsupported");
    const restarted = new ProjectNotesRepository(agentDir);
    const loaded = await restarted.load(cwd);
    expect(loaded.status).toBe("ok"); if (loaded.status !== "ok") throw Error("load");
    const recovered = await restarted.mutatePhaseDeletion(cwd, request(loaded.snapshot, "recover"), allow, now);
    expect(recovered.status).toBe("committed"); if (recovered.status !== "committed") throw Error(JSON.stringify(recovered));
    const restored = recovered.snapshot.document.phases[0]!;
    expect(restored.id).toBe(phase.id); expect(restored.archivedAt).toBe(phase.archivedAt);
    expect(restored.status).toBe(kind === "done" ? "done" : "not-started");
    expect(restored.session).toBeNull(); expect(restored.execution).toBeUndefined();
    expect(restored.reminder).toBeNull(); expect(restored.roadmapEvents).toEqual(phase.roadmapEvents);
    const { phases: _before, updatedAt: _beforeTime, ...beforeContent } = before;
    const { phases: _after, updatedAt: _afterTime, ...afterContent } = recovered.snapshot.document;
    expect(afterContent).toEqual(beforeContent);
    expect((await readFiles(paths)).map(raw => JSON.parse(raw).storeVersion)).toEqual([2, 2]);
    const replay = await restarted.mutatePhaseDeletion(cwd, deletion, allow, now);
    expect(replay).toMatchObject({ status: "committed", replayed: true, action: "delete",
      snapshot: { revision: recovered.snapshot.revision, document: { phases: [{ deletion: { currentDeletionId: null } }] } } });
    const again = await restarted.mutatePhaseDeletion(cwd, request(recovered.snapshot), allow, now);
    expect(again.status).toBe("committed");
    console.log(`Isolated ${kind} delete/restart/recover drill: ${Math.round(performance.now() - started)}ms`);
  });

  it("serializes duplicate and conflicting windows and rejects payload reuse", async () => {
    const { cwd, repository, snapshot } = await setup(); const input = request(snapshot);
    const results = await Promise.all([repository.mutatePhaseDeletion(cwd, input, allow, now),
      repository.mutatePhaseDeletion(cwd, input, allow, now)]);
    expect(results.map(r => r.status)).toEqual(["committed", "committed"]);
    expect(results.filter(r => r.status === "committed" && r.replayed)).toHaveLength(1);
    expect(await repository.mutatePhaseDeletion(cwd, { ...input, action: "recover" }, allow, now))
      .toMatchObject({ status: "refused", reason: "operation-id-reused" });
    expect(await repository.mutatePhaseDeletion(cwd, { ...input, operationId: "other-window" }, allow, now))
      .toMatchObject({ status: "conflict" });
    expect(await repository.mutatePhaseDeletion(cwd, { ...input, expectedProjectKey: "wrong" }, allow, now))
      .toMatchObject({ status: "unavailable" });
  });

  it("refuses operations from backup recovery and refuses a missing host guard", async () => {
    const { cwd, paths, repository, snapshot } = await setup();
    await fs.writeFile(paths.primary, "{broken");
    expect(await repository.mutatePhaseDeletion(cwd, request(snapshot), allow, now)).toMatchObject({
      status: "refused", reason: "recovery-required",
    });
    expect(await repository.mutatePhaseDeletion(cwd, request(snapshot), undefined as never, now)).toMatchObject({ status: "unavailable" });
  });

  it("rechecks host policy under the Notes lock without committing on refusal", async () => {
    const { cwd, paths, repository, snapshot } = await setup(); const before = await readFiles(paths);
    let observed = 0;
    const result = await repository.mutatePhaseDeletion(cwd, request(snapshot), async (fresh, phase) => {
      observed++; expect(fresh.revision).toBe(1); expect(phase.id).toBe(request(snapshot).phaseId);
      return { status: "refused", reason: "active-execution", message: "Cancel the run first." };
    }, now);
    expect(result).toMatchObject({ status: "refused", reason: "active-execution" });
    expect(observed).toBe(1); expect(await readFiles(paths)).toEqual(before);
  });

  it("preserves all unresolved advancement checkpoints, including unrelated phase decisions", async () => {
    const { cwd, repository, paths } = await setup();
    const document = encodeCompatibleDone(await completionCompatibilityFixture());
    document.phases[0]!.roadmapEvents.push({ type: "phase-advancement-checkpoint", id: "pending-next",
      completionReviewId: "review-schema-contract", completedPhaseId: document.phases[0]!.id,
      nextPhaseId: document.phases[2]!.id, reviewer: "ken-autopilot", timestamp: now });
    // Isolated fixture, not an authorized operation: seed the real persisted historical shape.
    const envelope = { storeVersion: 1, projectKey: canonicalProjectKey(cwd), revision: 3, document };
    await fs.writeFile(paths.primary, JSON.stringify(envelope)); await fs.writeFile(paths.backup, JSON.stringify(envelope));
    const before = await readFiles(paths);
    expect(await repository.mutatePhaseDeletion(cwd, request(envelope), allow, now))
      .toMatchObject({ status: "refused", reason: "protected-advancement" });
    expect(await readFiles(paths)).toEqual(before);
  });

  it.each(["backup-write", "backup-sync", "backup-rename", "primary-write", "primary-sync", "primary-rename", "after-primary-rename"])(
    "retains retry identity and resolves interrupted upgrade at %s", async fault => {
      const { cwd, repository, agentDir, paths, snapshot } = await setup();
      let armed = true;
      const target = fault.startsWith("backup") ? paths.backup : paths.primary;
      const failure = () => { armed = false; throw Object.assign(Error("Synthetic I/O failure"), { code: "EIO" }); };
      const io: ProjectNotesFileSystem = {
        ...fs,
        writeFile: async (file, contents, options) => {
          if (armed && fault.endsWith("write") && String(file).startsWith(target + ".")) failure();
          return fs.writeFile(file, contents, options);
        },
        open: async (file, flags) => {
          if (armed && fault.endsWith("sync") && String(file).startsWith(target + ".")) failure();
          return fs.open(file, flags);
        },
        rename: async (from, to) => {
          if (armed && String(to) === target && fault.endsWith("rename") && fault !== "after-primary-rename") failure();
          await fs.rename(from, to);
          if (armed && String(to) === target && fault === "after-primary-rename") failure();
        },
      };
      const failing = new ProjectNotesRepository(agentDir, { fileSystem: io });
      const input = request(snapshot);
      expect(await failing.mutatePhaseDeletion(cwd, input, allow, now)).toMatchObject({ status: "uncertain", operationId: input.operationId });
      expect(armed).toBe(false);
      const interrupted = await readFiles(paths);
      const oldState = frozenV1Read(...interrupted as [string, string]);
      expect(oldState).toBe(fault === "after-primary-rename" ? "unsupported" : "ok");
      expect((await fs.readdir(paths.directory)).filter(name => name.endsWith(".tmp"))).toEqual([]);
      const result = await repository.mutatePhaseDeletion(cwd, input, allow, now);
      expect(result).toMatchObject({ status: "committed", replayed: fault === "after-primary-rename" });
      const final = await readFiles(paths);
      expect(final.map(raw => JSON.parse(raw).storeVersion)).toEqual([2, 2]);
      expect(frozenV1Read(...final as [string, string])).toBe("unsupported");
    },
  );

  it("keeps a partial envelope upgrade sticky even through an ordinary save", async () => {
    const { cwd, repository, paths, document } = await setup();
    const backup = JSON.parse(await fs.readFile(paths.backup, "utf8")); backup.storeVersion = 2;
    await fs.writeFile(paths.backup, JSON.stringify(backup)); const before = await readFiles(paths);
    expect((await repository.load(cwd)).status).toBe("ok"); expect(await readFiles(paths)).toEqual(before);
    expect((await repository.save(cwd, 1, document)).status).toBe("ok");
    expect((await readFiles(paths)).map(raw => JSON.parse(raw).storeVersion)).toEqual([2, 2]);
  });

  it("blocks generic tombstone tampering and recovered-session revival", async () => {
    const { cwd, repository, snapshot, paths } = await setup();
    const deleted = await repository.mutatePhaseDeletion(cwd, request(snapshot), allow, now);
    if (deleted.status !== "committed") throw Error("delete");
    const before = await readFiles(paths);
    for (const field of ["title", "deletion", "omission"]) {
      const next = structuredClone(deleted.snapshot.document);
      if (field === "title") next.phases[0]!.title = "Changed behind deletion";
      if (field === "deletion") delete next.phases[0]!.deletion;
      if (field === "omission") next.phases = [];
      expect((await repository.save(cwd, deleted.snapshot.revision, next)).status).toBe("invalid");
    }
    expect(await readFiles(paths)).toEqual(before);
    const recovered = await repository.mutatePhaseDeletion(cwd, request(deleted.snapshot, "recover"), allow, now);
    if (recovered.status !== "committed") throw Error("recover");
    const next = structuredClone(recovered.snapshot.document);
    next.phases[0]!.session = { sessionId: "stale-session", sessionPath: null };
    expect((await repository.save(cwd, recovered.snapshot.revision, next)).status).toBe("invalid");
  });
});
