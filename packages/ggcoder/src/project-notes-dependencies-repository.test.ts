import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  canonicalProjectKey,
  notesPhaseDeletionGeneration,
  type NotesDocumentV3,
  type PhaseDeletionRequest,
  type ProjectNotesSnapshot,
} from "@kenkaiiii/gg-core/project-notes";
import {
  moveRoadmapPhaseOrderEntry,
  roadmapPhaseOrderEntries,
  type RoadmapPhaseEditDraft,
  type RoadmapPhaseMoveDraft,
} from "@kenkaiiii/gg-core/roadmap-workflow";
import { ProjectNotesRepository } from "./project-notes-repository.js";
import { AppSidecarRoadmapDraftCoordinator } from "./app-sidecar-roadmap-drafts.js";

const { completionCompatibilityFixture } = (await import(
  new URL(
    "../../gg-core/src/test-fixtures/project-notes-completion-compatibility.ts",
    import.meta.url,
  ).href
)) as { completionCompatibilityFixture(): Promise<NotesDocumentV3> };
const { validateNotesDocumentV3: frozenOldValidator } = (await import(
  new URL(
    "../../gg-core/src/test-fixtures/project-notes-pre-simplification-validator.ts",
    import.meta.url,
  ).href
)) as { validateNotesDocumentV3(document: unknown): { ok: boolean } };

/** Frozen v1-reader envelope branch: future versions are refused BEFORE backup fallback. */
function frozenV1Read(
  primary: string | null,
  backup: string | null,
): "ok" | "unsupported" | "corrupt" {
  for (const raw of [primary, backup]) {
    if (raw === null) continue;
    let value;
    try {
      value = JSON.parse(raw);
    } catch {
      continue;
    }
    if (
      (typeof value?.storeVersion === "number" && value.storeVersion > 1) ||
      (typeof value?.document?.version === "number" && value.document.version > 3)
    )
      return "unsupported";
    if (
      value?.storeVersion === 1 &&
      Number.isInteger(value.revision) &&
      typeof value.projectKey === "string" &&
      frozenOldValidator(value.document).ok
    )
      return "ok";
  }
  return "corrupt";
}

/** Deletion-era (storeVersion 2) envelope gate: refuses newer stores before any fallback. */
function v2EraEnvelopeGate(primary: string | null, backup: string | null): "unsupported" | "known" {
  for (const raw of [primary, backup]) {
    if (raw === null) continue;
    const value = JSON.parse(raw);
    if (typeof value?.storeVersion === "number" && value.storeVersion > 2) return "unsupported";
  }
  return "known";
}

const roots: string[] = [];
const now = "2026-11-06T12:00:00.000Z";
const allow = async () => null;
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gg-dependencies-repository-"));
  roots.push(root);
  const cwd = path.join(root, "project");
  const agentDir = path.join(root, "agent");
  const repository = new ProjectNotesRepository(agentDir);
  const document = await completionCompatibilityFixture();
  const template = document.phases[2]!;
  template.status = "not-started";
  template.completedAt = null;
  template.session = null;
  template.lifecycleEvents = [];
  template.roadmapEvents = [];
  template.reminder = null;
  document.phases = ["a", "b", "c"].map((key, order) => ({
    ...structuredClone(template),
    id: `phase-${key}`,
    title: `Phase ${key.toUpperCase()}`,
    order,
  }));
  const result = await repository.migrate(cwd, document);
  if (result.status !== "ok") throw Error(JSON.stringify(result));
  return {
    root,
    cwd,
    agentDir,
    repository,
    snapshot: result.snapshot,
    paths: repository.paths(cwd),
  };
}

function withLinks(
  snapshot: ProjectNotesSnapshot,
  links: Record<string, unknown>,
): NotesDocumentV3 {
  const document = structuredClone(snapshot.document);
  for (const phase of document.phases) {
    if (phase.id in links) (phase as { dependsOn?: unknown }).dependsOn = links[phase.id];
  }
  return document;
}

async function saveLinks(
  repository: ProjectNotesRepository,
  cwd: string,
  snapshot: ProjectNotesSnapshot,
  links: Record<string, unknown>,
): Promise<ProjectNotesSnapshot> {
  const saved = await repository.save(cwd, snapshot.revision, withLinks(snapshot, links));
  if (saved.status !== "ok") throw Error(JSON.stringify(saved));
  return saved.snapshot;
}

function request(
  snapshot: ProjectNotesSnapshot,
  phaseId: string,
  action: "delete" | "recover" = "delete",
): PhaseDeletionRequest {
  const phase = snapshot.document.phases.find((candidate) => candidate.id === phaseId)!;
  const generation = notesPhaseDeletionGeneration(phase);
  return {
    version: 1,
    action,
    operationId: `${action}-${phaseId}-${generation}-${snapshot.revision}`,
    phaseId,
    expectedProjectKey: snapshot.projectKey,
    expectedRevision: snapshot.revision,
    expectedGeneration: generation,
  };
}

async function mutate(
  repository: ProjectNotesRepository,
  cwd: string,
  snapshot: ProjectNotesSnapshot,
  phaseId: string,
  action: "delete" | "recover" = "delete",
) {
  return repository.mutatePhaseDeletion(cwd, request(snapshot, phaseId, action), allow, now);
}

async function readFiles(paths: { primary: string; backup: string }) {
  return Promise.all([fs.readFile(paths.primary, "utf8"), fs.readFile(paths.backup, "utf8")]);
}
async function storeVersions(paths: { primary: string; backup: string }) {
  return (await readFiles(paths)).map((raw) => JSON.parse(raw).storeVersion);
}
async function loadOk(repository: ProjectNotesRepository, cwd: string) {
  const loaded = await repository.load(cwd);
  if (loaded.status !== "ok") throw Error(JSON.stringify(loaded));
  return loaded.snapshot;
}

describe("phase dependency links in the Notes store", () => {
  it("saves an old document without links unchanged and keeps its store version", async () => {
    const { cwd, repository, snapshot, paths } = await setup();
    const before = JSON.parse((await readFiles(paths))[0]);
    const saved = await repository.save(cwd, snapshot.revision, snapshot.document);
    expect(saved.status).toBe("ok");
    const after = JSON.parse((await readFiles(paths))[0]);
    expect(await storeVersions(paths)).toEqual([1, 1]);
    expect(JSON.stringify(after.document.phases)).toBe(JSON.stringify(before.document.phases));
    expect(after.document.phases.some((phase: object) => "dependsOn" in phase)).toBe(false);
  });

  it("keeps a v2 store without links at version 2", async () => {
    const { cwd, repository, paths } = await setup();
    for (const file of [paths.primary, paths.backup]) {
      const envelope = JSON.parse(await fs.readFile(file, "utf8"));
      envelope.storeVersion = 2;
      await fs.writeFile(file, JSON.stringify(envelope));
    }
    const snapshot = await loadOk(repository, cwd);
    expect((await repository.save(cwd, snapshot.revision, snapshot.document)).status).toBe("ok");
    expect(await storeVersions(paths)).toEqual([2, 2]);
  });

  it("upgrades primary and backup to v3 on the first linked write and never downgrades", async () => {
    const { cwd, agentDir, repository, snapshot, paths } = await setup();
    const linked = await saveLinks(repository, cwd, snapshot, { "phase-b": ["phase-a"] });
    expect(await storeVersions(paths)).toEqual([3, 3]);
    const files = await readFiles(paths);
    expect(frozenV1Read(...(files as [string, string]))).toBe("unsupported");
    expect(frozenV1Read(null, files[1]!)).toBe("unsupported");
    expect(v2EraEnvelopeGate(...(files as [string, string]))).toBe("unsupported");
    expect(v2EraEnvelopeGate(null, files[1]!)).toBe("unsupported");

    const restarted = await loadOk(new ProjectNotesRepository(agentDir), cwd);
    expect(restarted.document.phases.find((phase) => phase.id === "phase-b")?.dependsOn).toEqual([
      "phase-a",
    ]);

    const unlinked = structuredClone(linked.document);
    for (const phase of unlinked.phases) delete phase.dependsOn;
    expect((await repository.save(cwd, linked.revision, unlinked)).status).toBe("ok");
    expect(await storeVersions(paths)).toEqual([3, 3]);
  });

  it("refuses links in v1 or v2 envelopes without overwriting them", async () => {
    for (const storeVersion of [1, 2]) {
      const { cwd, repository, snapshot, paths } = await setup();
      for (const file of [paths.primary, paths.backup]) {
        const envelope = JSON.parse(await fs.readFile(file, "utf8"));
        envelope.storeVersion = storeVersion;
        envelope.document = withLinks(snapshot, { "phase-b": ["phase-a"] });
        await fs.writeFile(file, JSON.stringify(envelope));
      }
      const before = await readFiles(paths);
      const loaded = await repository.load(cwd);
      expect(loaded.status).not.toBe("ok");
      expect(
        (await repository.save(cwd, snapshot.revision, withLinks(snapshot, {}))).status,
      ).not.toBe("ok");
      expect(await readFiles(paths)).toEqual(before);
    }
  });

  it("keeps a partial v3 upgrade (v3 backup, older primary) through a later save", async () => {
    const { cwd, repository, paths } = await setup();
    const backup = JSON.parse(await fs.readFile(paths.backup, "utf8"));
    backup.storeVersion = 3;
    await fs.writeFile(paths.backup, JSON.stringify(backup));
    const before = await readFiles(paths);
    const snapshot = await loadOk(repository, cwd);
    expect(await readFiles(paths)).toEqual(before);
    expect((await repository.save(cwd, snapshot.revision, snapshot.document)).status).toBe("ok");
    expect(await storeVersions(paths)).toEqual([3, 3]);
  });

  it("refuses migration that would create dependency links", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "gg-dependencies-migrate-"));
    roots.push(root);
    const repository = new ProjectNotesRepository(path.join(root, "agent"));
    const { snapshot } = await setup();
    const document = withLinks(snapshot, { "phase-b": ["phase-a"] });
    const cwd = path.join(root, "project");
    expect(await repository.migrate(cwd, document)).toMatchObject({
      status: "invalid",
      error: { message: "Migration cannot create dependency links" },
    });
    await expect(fs.access(repository.paths(cwd).primary)).rejects.toThrow();
  });

  it("rejects every broken link on save with the phases named and writes nothing", async () => {
    const f = await setup();
    const deleted = await mutate(f.repository, f.cwd, f.snapshot, "phase-c");
    if (deleted.status !== "committed") throw Error(JSON.stringify(deleted));
    const snapshot = deleted.snapshot;
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ "phase-a": ["phase-missing"] }, /"Phase A" \(phase-a\) depends on missing phase/],
      [{ "phase-a": ["phase-c"] }, /"Phase A" \(phase-a\) depends on deleted phase "Phase C"/],
      [{ "phase-a": ["phase-a"] }, /"Phase A" \(phase-a\) cannot depend on itself/],
      [{ "phase-a": ["phase-b", "phase-b"] }, /lists phase phase-b more than once/],
      [{ "phase-a": [] }, /omit dependsOn instead/],
      [{ "phase-a": [7] }, /expected a non-empty phase ID/],
      [{ "phase-a": ["phase-b"], "phase-b": ["phase-a"] }, /circular dependency chain: .*→/],
    ];
    for (const [links, message] of cases) {
      const before = await readFiles(f.paths);
      const saved = await f.repository.save(f.cwd, snapshot.revision, withLinks(snapshot, links));
      expect(saved.status, JSON.stringify(links)).toBe("invalid");
      if (saved.status !== "invalid") continue;
      expect(saved.error.message).toMatch(message);
      expect(saved.error.path).toMatch(/^phases\[[01]\]\.dependsOn/);
      expect(await readFiles(f.paths)).toEqual(before);
    }
  });

  it("names a 3-phase circular chain in order", async () => {
    const { cwd, repository, snapshot } = await setup();
    const saved = await repository.save(
      cwd,
      snapshot.revision,
      withLinks(snapshot, {
        "phase-a": ["phase-b"],
        "phase-b": ["phase-c"],
        "phase-c": ["phase-a"],
      }),
    );
    expect(saved).toMatchObject({ status: "invalid" });
    if (saved.status !== "invalid") return;
    expect(saved.error.message).toContain("circular dependency chain");
    expect(saved.error.message).toMatch(/Phase A.*→.*Phase B.*→.*Phase C.*→.*Phase A/);
  });

  it("allows links to archived phases", async () => {
    const { cwd, repository, snapshot, paths } = await setup();
    const document = withLinks(snapshot, { "phase-b": ["phase-a"] });
    document.phases[0]!.archivedAt = now;
    const saved = await repository.save(cwd, snapshot.revision, document);
    expect(saved.status).toBe("ok");
    expect(await storeVersions(paths)).toEqual([3, 3]);
  });

  it("refuses deleting a prerequisite, enforces recovery order and stays v3", async () => {
    const f = await setup();
    let snapshot = await saveLinks(f.repository, f.cwd, f.snapshot, { "phase-b": ["phase-a"] });
    const before = await readFiles(f.paths);
    const refused = await mutate(f.repository, f.cwd, snapshot, "phase-a");
    expect(refused).toMatchObject({ status: "refused", reason: "dependency-links" });
    if (refused.status !== "refused") throw Error("expected refusal");
    expect(refused.message).toContain('"Phase A" (phase-a)');
    expect(refused.message).toContain('"Phase B" (phase-b)');
    expect(await readFiles(f.paths)).toEqual(before);

    const unrelated = await mutate(f.repository, f.cwd, snapshot, "phase-c");
    if (unrelated.status !== "committed") throw Error(JSON.stringify(unrelated));
    expect(await storeVersions(f.paths)).toEqual([3, 3]);
    snapshot = unrelated.snapshot;

    const dependent = await mutate(f.repository, f.cwd, snapshot, "phase-b");
    if (dependent.status !== "committed") throw Error(JSON.stringify(dependent));
    const prerequisite = await mutate(f.repository, f.cwd, dependent.snapshot, "phase-a");
    if (prerequisite.status !== "committed") throw Error(JSON.stringify(prerequisite));
    snapshot = prerequisite.snapshot;

    const beforeRecover = await readFiles(f.paths);
    const early = await mutate(f.repository, f.cwd, snapshot, "phase-b", "recover");
    expect(early).toMatchObject({ status: "refused", reason: "dependency-links" });
    if (early.status !== "refused") throw Error("expected refusal");
    expect(early.message).toContain("Recover that phase first");
    expect(await readFiles(f.paths)).toEqual(beforeRecover);

    const first = await mutate(f.repository, f.cwd, snapshot, "phase-a", "recover");
    if (first.status !== "committed") throw Error(JSON.stringify(first));
    const second = await mutate(f.repository, f.cwd, first.snapshot, "phase-b", "recover");
    if (second.status !== "committed") throw Error(JSON.stringify(second));
    expect(second.snapshot.document.phases.find((p) => p.id === "phase-b")?.dependsOn).toEqual([
      "phase-a",
    ]);
    expect(await storeVersions(f.paths)).toEqual([3, 3]);
  });

  it("lets only one of two concurrent opposite links commit and rejects the retry as a cycle", async () => {
    const f = await setup();
    const other = new ProjectNotesRepository(f.agentDir);
    const results = await Promise.all([
      f.repository.save(
        f.cwd,
        f.snapshot.revision,
        withLinks(f.snapshot, { "phase-a": ["phase-b"] }),
      ),
      other.save(f.cwd, f.snapshot.revision, withLinks(f.snapshot, { "phase-b": ["phase-a"] })),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual(["conflict", "ok"]);
    const loserIndex = results.findIndex((result) => result.status === "conflict");
    const loser = results[loserIndex]!;
    if (loser.status !== "conflict") throw Error("expected conflict");
    const retryLinks = loserIndex === 0 ? { "phase-a": ["phase-b"] } : { "phase-b": ["phase-a"] };
    const retry = await (loserIndex === 0 ? f.repository : other).save(
      f.cwd,
      loser.snapshot.revision,
      withLinks(loser.snapshot, retryLinks),
    );
    expect(retry).toMatchObject({ status: "invalid" });
    if (retry.status === "invalid") expect(retry.error.message).toContain("circular dependency");
  });

  it("makes a stale delete of a newly linked prerequisite conflict, then refuses it fresh", async () => {
    const f = await setup();
    const staleRequest = request(f.snapshot, "phase-a");
    await saveLinks(f.repository, f.cwd, f.snapshot, { "phase-b": ["phase-a"] });
    const stale = await f.repository.mutatePhaseDeletion(f.cwd, staleRequest, allow, now);
    expect(stale.status).toBe("conflict");
    const fresh = await mutate(f.repository, f.cwd, await loadOk(f.repository, f.cwd), "phase-a");
    expect(fresh).toMatchObject({ status: "refused", reason: "dependency-links" });
  });

  it("keeps dependsOn intact through approved phase edits and moves", async () => {
    const f = await setup();
    const linked = await saveLinks(f.repository, f.cwd, f.snapshot, { "phase-b": ["phase-a"] });
    const phaseB = linked.document.phases.find((phase) => phase.id === "phase-b")!;
    const edit: RoadmapPhaseEditDraft = {
      kind: "edit",
      id: "edit-dependency",
      projectKey: canonicalProjectKey(f.cwd),
      basedOnRevision: linked.revision,
      createdAt: now,
      createdBySessionId: "session-draft",
      summary: "Rename B",
      phaseId: "phase-b",
      phaseTitle: phaseB.title,
      basedOnUpdatedAt: phaseB.updatedAt,
      changes: [{ field: "title", before: phaseB.title, after: "Phase B renamed" }],
      status: "pending",
    };
    expect(await f.repository.applyApprovedPhaseEdit(f.cwd, edit, now)).toMatchObject({
      status: "edited",
    });
    const edited = await loadOk(f.repository, f.cwd);
    const entries = roadmapPhaseOrderEntries(edited.document.phases);
    const placement = { position: "before" as const, targetPhaseId: "phase-a" };
    const move: RoadmapPhaseMoveDraft = {
      kind: "move",
      id: "move-dependency",
      projectKey: canonicalProjectKey(f.cwd),
      basedOnRevision: edited.revision,
      createdAt: now,
      createdBySessionId: "session-draft",
      summary: "Move B first",
      phaseId: "phase-b",
      phaseTitle: "Phase B renamed",
      position: placement.position,
      targetPhaseId: placement.targetPhaseId,
      targetPhaseTitle: "Phase A",
      orderPreview: {
        before: entries,
        after: moveRoadmapPhaseOrderEntry(entries, "phase-b", placement) ?? [],
      },
      status: "pending",
    };
    expect(await f.repository.applyApprovedPhaseMove(f.cwd, move, now)).toMatchObject({
      status: "moved",
    });
    const moved = await loadOk(f.repository, f.cwd);
    const movedB = moved.document.phases.find((phase) => phase.id === "phase-b")!;
    expect(movedB.title).toBe("Phase B renamed");
    expect(movedB.dependsOn).toEqual(["phase-a"]);
    expect(await storeVersions(f.paths)).toEqual([3, 3]);
  });
});

describe("agent dependency links through approvals and app starts", () => {
  function draftRequest(revision: number) {
    const phase = (title: string) => ({
      title,
      goal: `${title} goal`,
      doneWhen: [`${title} done`],
      sourcePrompt: `${title} prompt`,
      referenceKeys: [],
    });
    return {
      expectedRevision: revision,
      summary: "Add two linked phases",
      phases: [
        { ...phase("New D"), dependsOn: ["phase-a"] },
        { ...phase("New E"), dependsOnDraftPhases: [0] },
      ],
    };
  }

  it("stores approved links, including same-draft links, and upgrades the store to v3", async () => {
    const f = await setup();
    const drafts = new AppSidecarRoadmapDraftCoordinator();
    const created = drafts.create({
      cwd: f.cwd,
      sessionId: "session-draft",
      request: draftRequest(f.snapshot.revision),
      currentPhases: f.snapshot.document.phases,
    });
    if (created.status !== "drafted") throw Error(JSON.stringify(created));
    expect(created.draft.dependencyPhases).toEqual([
      { phaseId: "phase-a", title: "Phase A", archived: false },
    ]);
    const [d, e] = created.draft.phases;
    expect(d!.dependsOn).toEqual(["phase-a"]);
    expect(e!.dependsOn).toEqual([d!.phaseId]);
    const approved = await f.repository.createApprovedPhases(f.cwd, created.draft);
    expect(approved).toMatchObject({ status: "created" });
    const saved = await loadOk(f.repository, f.cwd);
    const byId = (id: string) => saved.document.phases.find((phase) => phase.id === id)!;
    expect(byId(d!.phaseId).dependsOn).toEqual(["phase-a"]);
    expect(byId(e!.phaseId).dependsOn).toEqual([d!.phaseId]);
    expect(await storeVersions(f.paths)).toEqual([3, 3]);
  });

  it("refuses an approved draft that links a phase missing from Notes", async () => {
    const f = await setup();
    const drafts = new AppSidecarRoadmapDraftCoordinator();
    const created = drafts.create({
      cwd: f.cwd,
      sessionId: "session-draft",
      request: { ...draftRequest(f.snapshot.revision), phases: [draftRequest(0).phases[0]!] },
      currentPhases: f.snapshot.document.phases,
    });
    if (created.status !== "drafted") throw Error(JSON.stringify(created));
    const stale = structuredClone(created.draft);
    stale.phases[0]!.dependsOn = ["phase-ghost"];
    stale.dependencyPhases = [{ phaseId: "phase-ghost", title: "Ghost", archived: false }];
    const outcome = await f.repository.createApprovedPhases(f.cwd, stale);
    expect(outcome).toMatchObject({ status: "invalid-proposal" });
    expect((outcome as { message: string }).message).toContain("depends on missing phase");
  });

  it("applies and clears dependsOn through approved edits", async () => {
    const f = await setup();
    const drafts = new AppSidecarRoadmapDraftCoordinator();
    const phaseC = f.snapshot.document.phases.find((phase) => phase.id === "phase-c")!;
    const set = drafts.createEdit({
      cwd: f.cwd,
      sessionId: "session-draft",
      request: {
        expectedRevision: f.snapshot.revision,
        summary: "C waits for A and B",
        phaseId: "phase-c",
        dependsOn: ["phase-a", "phase-b"],
      },
      phase: phaseC,
      currentPhases: f.snapshot.document.phases,
    });
    if (set.status !== "drafted") throw Error(JSON.stringify(set));
    expect(await f.repository.applyApprovedPhaseEdit(f.cwd, set.draft, now)).toMatchObject({
      status: "edited",
    });
    const linked = await loadOk(f.repository, f.cwd);
    const linkedC = linked.document.phases.find((phase) => phase.id === "phase-c")!;
    expect(linkedC.dependsOn).toEqual(["phase-a", "phase-b"]);
    const clear = drafts.createEdit({
      cwd: f.cwd,
      sessionId: "session-draft",
      request: {
        expectedRevision: linked.revision,
        summary: "C no longer waits",
        phaseId: "phase-c",
        dependsOn: [],
      },
      phase: linkedC,
      currentPhases: linked.document.phases,
    });
    if (clear.status !== "drafted") throw Error(JSON.stringify(clear));
    expect(await f.repository.applyApprovedPhaseEdit(f.cwd, clear.draft, now)).toMatchObject({
      status: "edited",
    });
    const cleared = await loadOk(f.repository, f.cwd);
    expect(cleared.document.phases.find((phase) => phase.id === "phase-c")).not.toHaveProperty(
      "dependsOn",
    );
  });

  it("records one user/app override per start session, only over unfinished prerequisites", async () => {
    const f = await setup();
    await saveLinks(f.repository, f.cwd, f.snapshot, { "phase-c": ["phase-a"] });
    const session = { sessionId: "user-start", sessionPath: "/s/user.jsonl" };
    const overrides = async (phaseId: string) =>
      (await loadOk(f.repository, f.cwd)).document.phases
        .find((phase) => phase.id === phaseId)!
        .roadmapEvents.filter((event) => event.type === "dependency-override");

    expect(await f.repository.launchPhase(f.cwd, "phase-b", async () => session)).toMatchObject({
      status: "accepted",
    });
    expect(await overrides("phase-b")).toEqual([]);

    expect(
      await f.repository.launchPhase(
        f.cwd,
        "phase-c",
        async () => ({ sessionId: "c-start", sessionPath: "/s/c.jsonl" }),
        { confirmedPrerequisiteIds: ["phase-a"] },
      ),
    ).toMatchObject({ status: "accepted" });
    const first = await overrides("phase-c");
    expect(first).toMatchObject([
      {
        actor: "user",
        origin: "app",
        session: { sessionId: "c-start", sessionPath: "/s/c.jsonl" },
        unfinishedPrerequisiteIds: ["phase-a"],
      },
    ]);
    expect(await f.repository.launchPhase(f.cwd, "phase-c", async () => session)).toMatchObject({
      status: "already-bound",
    });
    expect(await overrides("phase-c")).toEqual(first);
  });

  it("asks before a manual start over unfinished prerequisites without binding or writing", async () => {
    const f = await setup();
    const linked = await saveLinks(f.repository, f.cwd, f.snapshot, { "phase-c": ["phase-a"] });
    const createBinding = vi.fn(async () => ({ sessionId: "c", sessionPath: "/s/c.jsonl" }));
    for (const confirmedPrerequisiteIds of [undefined, [], ["phase-b"], ["phase-a", "phase-b"]]) {
      expect(
        await f.repository.launchPhase(f.cwd, "phase-c", createBinding, {
          confirmedPrerequisiteIds,
        }),
      ).toEqual({
        status: "prerequisites-confirmation-required",
        prerequisites: [{ id: "phase-a", title: "Phase A", status: "not-started" }],
      });
    }
    expect(await f.repository.launchPhase(f.cwd, "phase-c", createBinding)).toMatchObject({
      status: "prerequisites-confirmation-required",
    });
    expect(createBinding).not.toHaveBeenCalled();
    expect((await loadOk(f.repository, f.cwd)).revision).toBe(linked.revision);
  });

  it("asks again when the unfinished set changed after the user confirmed", async () => {
    const f = await setup();
    const linked = await saveLinks(f.repository, f.cwd, f.snapshot, {
      "phase-c": ["phase-a", "phase-b"],
    });
    const changed = structuredClone(linked.document);
    changed.phases.find((phase) => phase.id === "phase-c")!.dependsOn = ["phase-b"];
    expect((await f.repository.save(f.cwd, linked.revision, changed)).status).toBe("ok");
    const createBinding = vi.fn(async () => ({ sessionId: "c", sessionPath: "/s/c.jsonl" }));
    expect(
      await f.repository.launchPhase(f.cwd, "phase-c", createBinding, {
        confirmedPrerequisiteIds: ["phase-a", "phase-b"],
      }),
    ).toMatchObject({
      status: "prerequisites-confirmation-required",
      prerequisites: [{ id: "phase-b" }],
    });
    expect(createBinding).not.toHaveBeenCalled();
    expect(
      await f.repository.launchPhase(f.cwd, "phase-c", createBinding, {
        confirmedPrerequisiteIds: ["phase-b"],
      }),
    ).toMatchObject({ status: "accepted" });
    const phaseC = (await loadOk(f.repository, f.cwd)).document.phases.find(
      (phase) => phase.id === "phase-c",
    )!;
    const [override] = phaseC.roadmapEvents.filter((event) => event.type === "dependency-override");
    expect(override).toMatchObject({
      actor: "user",
      origin: "app",
      session: { sessionId: "c", sessionPath: "/s/c.jsonl" },
      unfinishedPrerequisiteIds: ["phase-b"],
    });
    expect(Number.isNaN(Date.parse((override as { timestamp: string }).timestamp))).toBe(false);
  });

  it("records the grown set when the user confirms again on an already-bound run", async () => {
    const f = await setup();
    const session = { sessionId: "c", sessionPath: "/s/c.jsonl" };
    const linked = await saveLinks(f.repository, f.cwd, f.snapshot, { "phase-c": ["phase-a"] });
    expect(
      await f.repository.launchPhase(f.cwd, "phase-c", async () => session, {
        confirmedPrerequisiteIds: ["phase-a"],
      }),
    ).toMatchObject({ status: "accepted" });
    const started = await loadOk(f.repository, f.cwd);
    const grown = structuredClone(started.document);
    grown.phases.find((phase) => phase.id === "phase-c")!.dependsOn = ["phase-a", "phase-b"];
    expect((await f.repository.save(f.cwd, started.revision, grown)).status).toBe("ok");
    expect(await f.repository.launchPhase(f.cwd, "phase-c", async () => session)).toMatchObject({
      status: "prerequisites-confirmation-required",
      prerequisites: [{ id: "phase-a" }, { id: "phase-b" }],
    });
    expect(
      await f.repository.launchPhase(f.cwd, "phase-c", async () => session, {
        confirmedPrerequisiteIds: ["phase-a", "phase-b"],
      }),
    ).toMatchObject({ status: "already-bound" });
    expect(await f.repository.launchPhase(f.cwd, "phase-c", async () => session)).toMatchObject({
      status: "already-bound",
    });
    expect(linked.revision).toBeLessThan(started.revision);
    const overrides = (await loadOk(f.repository, f.cwd)).document.phases
      .find((phase) => phase.id === "phase-c")!
      .roadmapEvents.filter((event) => event.type === "dependency-override");
    expect(overrides.map((event) => event.unfinishedPrerequisiteIds)).toEqual([
      ["phase-a"],
      ["phase-a", "phase-b"],
    ]);
  });
});
