import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ProjectNotesRepository,
  type ProjectNotesRoadmapStatusRequest,
} from "./project-notes-repository.js";
import type { NotesDocumentV3 } from "@kenkaiiii/gg-core/project-notes";
// URL imports keep test-only cross-package source out of the production rootDir.
const {
  completionCompatibilityFixture,
  encodeCompatibleDone,
}: {
  completionCompatibilityFixture: () => Promise<NotesDocumentV3>;
  encodeCompatibleDone: (document: NotesDocumentV3) => NotesDocumentV3;
} = await import(
  new URL(
    "../../gg-core/src/test-fixtures/project-notes-completion-compatibility.ts",
    import.meta.url,
  ).href
);
const {
  validateNotesDocumentV3: validateOldNotes,
}: {
  validateNotesDocumentV3: (document: unknown) => { ok: boolean };
} = await import(
  new URL(
    "../../gg-core/src/test-fixtures/project-notes-pre-simplification-validator.ts",
    import.meta.url,
  ).href
);

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function copiedStore(done = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gg-notes-compatibility-"));
  roots.push(root);
  const cwd = path.join(root, "project");
  const repository = new ProjectNotesRepository(path.join(root, "agent"));
  const original = await completionCompatibilityFixture();
  const document = done ? encodeCompatibleDone(original) : original;
  expect(validateOldNotes(document)).toMatchObject({ ok: true });
  expect(await repository.migrate(cwd, document)).toMatchObject({ status: "ok" });
  const paths = repository.paths(cwd);
  // Preserve deliberately non-canonical bytes, not just the writer's own formatting.
  const envelope = JSON.parse(await fs.readFile(paths.primary, "utf8"));
  const copiedBytes = `  ${JSON.stringify(envelope, null, 3)}\n\n`;
  await fs.writeFile(paths.primary, copiedBytes);
  await fs.writeFile(paths.backup, copiedBytes);
  return { cwd, repository, document, paths };
}

async function bytes(paths: { primary: string; backup: string }) {
  return Promise.all([fs.readFile(paths.primary), fs.readFile(paths.backup)]);
}

describe("copied Notes completion compatibility (real validators)", () => {
  it.each([false, true])(
    "loads copied pending/evidence history without any writes (Done=%s)",
    async (done) => {
      const { cwd, repository, document, paths } = await copiedStore(done);
      const before = await bytes(paths);
      const write = vi.spyOn(fs, "writeFile");
      const rename = vi.spyOn(fs, "rename");
      const open = vi.spyOn(fs, "open");
      for (let attempt = 0; attempt < 2; attempt++) {
        const loaded = await repository.load(cwd);
        expect(loaded).toMatchObject({ status: "ok", snapshot: { revision: 1 } });
        if (loaded.status !== "ok") throw new Error("Expected readable copied Notes");
        expect(loaded.snapshot.document).toEqual(document);
      }
      expect(await bytes(paths)).toEqual(before);
      expect(write).not.toHaveBeenCalled();
      expect(rename).not.toHaveBeenCalled();
      expect(
        open.mock.calls.filter(([, flags]) => typeof flags === "string" && /[wa+]/.test(flags)),
      ).toEqual([]);
    },
  );

  it("writer round-trips legacy-compatible Done history without consuming pending intent", async () => {
    const { cwd, repository, document, paths } = await copiedStore(true);
    const next = structuredClone(document);
    next.currentFocus = "An unrelated audit, not a new verification";
    expect(await repository.save(cwd, 1, next)).toMatchObject({
      status: "ok",
      snapshot: { revision: 2 },
    });
    const persisted = JSON.parse(await fs.readFile(paths.primary, "utf8"));
    expect(validateOldNotes(persisted.document)).toMatchObject({ ok: true });
    expect(persisted.document.phases).toEqual(document.phases);
    expect(persisted.document.references).toEqual(document.references);
    expect(persisted.document.tasks).toEqual(document.tasks);
    expect(persisted.document.handoff).toEqual(document.handoff);
  });

  it.each(["document", "store", "metadata", "phase-metadata", "envelope-metadata"])(
    "never replaces an unsupported %s with an older valid backup",
    async (format) => {
      const { cwd, repository, paths, document } = await copiedStore();
      const primary = JSON.parse(await fs.readFile(paths.primary, "utf8"));
      primary.revision = 9;
      primary.document.currentFocus = "Newer content must survive";
      if (format === "document") primary.document.version = 4;
      else if (format === "store") primary.storeVersion = 2;
      else if (format === "metadata") primary.document.futureMetadata = { preserve: true };
      else if (format === "phase-metadata") primary.document.phases[0].futureMetadata = true;
      else primary.futureMetadata = true;
      await fs.writeFile(paths.primary, JSON.stringify(primary));
      const before = await bytes(paths);
      expect(await repository.load(cwd)).toMatchObject({ status: "unsupported", source: "primary" });
      expect(await repository.save(cwd, 1, document)).toMatchObject({ status: "unsupported" });
      expect(await repository.save(cwd, 9, document)).toMatchObject({ status: "unsupported" });
      expect(await repository.migrate(cwd, document)).toMatchObject({ status: "unsupported" });
      expect(await repository.recordRoadmapStatusUpdate(cwd, {
        updateId: "blocked-done", phaseId: document.phases[2]!.id,
        expectedRevision: 9, actor: "gg-coder", transition: "done",
        progress: "Verified criteria", blocker: null, requiredExternalAction: null,
        evidence: ["Criteria verified"], verification: "passed", verificationReason: null,
        proposedReferences: [], timestamp: "2026-09-07T12:00:00.000Z",
        expectedSession: null, requireBoundPhase: false, autopilotEnabled: false,
      })).toMatchObject({ status: "unsupported" });
      expect(await bytes(paths)).toEqual(before);
    },
  );

  it.each(["document", "store", "metadata"])(
    "uses a valid primary despite an unsupported %s backup",
    async (format) => {
      const { cwd, repository, paths, document } = await copiedStore();
      const backup = JSON.parse(await fs.readFile(paths.backup, "utf8"));
      if (format === "document") backup.document.version = 4;
      else if (format === "store") backup.storeVersion = 2;
      else backup.document.futureMetadata = true;
      await fs.writeFile(paths.backup, JSON.stringify(backup));
      const before = await bytes(paths);
      expect(await repository.load(cwd)).toMatchObject({
        status: "ok", recoveredFromBackup: false, snapshot: { revision: 1, document },
      });
      expect(await bytes(paths)).toEqual(before);
      expect(await repository.save(cwd, 1, document)).toMatchObject({ status: "ok" });
    },
  );

  it.each(["missing", "corrupt"])(
    "preserves an unsupported backup when the primary is %s",
    async (primaryState) => {
      const { cwd, repository, paths, document } = await copiedStore();
      const backup = JSON.parse(await fs.readFile(paths.backup, "utf8"));
      backup.document.futureMetadata = true;
      await fs.writeFile(paths.backup, JSON.stringify(backup));
      if (primaryState === "missing") await fs.unlink(paths.primary);
      else await fs.writeFile(paths.primary, "{broken-json");
      const beforeBackup = await fs.readFile(paths.backup);
      expect(await repository.load(cwd)).toMatchObject({ status: "unsupported", source: "backup" });
      expect(await repository.save(cwd, 1, document)).toMatchObject({ status: "unsupported" });
      expect(await fs.readFile(paths.backup)).toEqual(beforeBackup);
      if (primaryState === "missing") await expect(fs.readFile(paths.primary)).rejects.toMatchObject({ code: "ENOENT" });
      else expect(await fs.readFile(paths.primary, "utf8")).toBe("{broken-json");
    },
  );

  it("protects a user-selected status without scheduling automatic Done", async () => {
    const { repository, cwd, paths, document } = await copiedStore();
    const phase = document.phases[0]!;
    expect(phase.overrides.status).not.toBeNull();
    const before = await bytes(paths);
    expect(
      await repository.recordRoadmapStatusUpdate(cwd, {
        updateId: "protected-done",
        phaseId: phase.id,
        expectedRevision: 1,
        actor: "gg-coder",
        transition: "done",
        progress: "Current code inspected",
        evidence: ["Documentation reviewed"],
        verification: "passed",
        verificationReason: null,
        blocker: null,
        requiredExternalAction: null,
        proposedReferences: [],
        timestamp: "2026-09-07T12:00:00.000Z",
        autopilotEnabled: false,
      }),
    ).toMatchObject({ status: "operation-conflict", revision: 1 });
    expect(await bytes(paths)).toEqual(before);
  });

  it("commits explicit Done in one CAS revision without synthetic execution/checkpoints, and replays idempotently", async () => {
    const { cwd, repository, document, paths } = await copiedStore();
    const request: ProjectNotesRoadmapStatusRequest = {
      updateId: "explicit-done",
      phaseId: document.phases[2]!.id,
      expectedRevision: 1,
      actor: "gg-coder",
      transition: "done",
      progress: "Reviewed documentation against the criteria",
      blocker: null,
      requiredExternalAction: null,
      evidence: ["Every required section is present"],
      verification: "passed",
      verificationReason: null,
      proposedReferences: [],
      timestamp: "2026-09-07T12:00:00.000Z",
      expectedSession: null,
      requireBoundPhase: false,
      autopilotEnabled: false,
    };
    const result = await repository.recordRoadmapStatusUpdate(cwd, request);
    expect(result).toMatchObject({
      status: "committed",
      snapshot: { revision: 2 },
      phase: { status: "done", completedAt: request.timestamp },
    });
    const persisted = JSON.parse(await fs.readFile(paths.primary, "utf8"));
    expect(validateOldNotes(persisted.document)).toMatchObject({ ok: true });
    expect(persisted.document.phases.slice(0, 2)).toEqual(document.phases.slice(0, 2));
    const phase = persisted.document.phases[2];
    expect(phase.execution).toBeUndefined();
    expect(phase.roadmapEvents).toHaveLength(1);
    expect(phase.roadmapEvents[0]).toMatchObject({
      type: "status-update",
      statusOutcome: "completion-pending",
    });
    expect(phase.lifecycleEvents).toHaveLength(1);
    const committed = await bytes(paths);
    expect(await repository.recordRoadmapStatusUpdate(cwd, request)).toMatchObject({
      status: "duplicate",
      revision: 2,
    });
    expect(
      await repository.recordRoadmapStatusUpdate(cwd, { ...request, progress: "Different intent" }),
    ).toMatchObject({ status: "duplicate-id-conflict", revision: 2 });
    expect(
      await repository.recordRoadmapStatusUpdate(cwd, { ...request, updateId: "losing-writer" }),
    ).toMatchObject({ status: "stale-revision", revision: 2 });
    expect(await bytes(paths)).toEqual(committed);
  });
});
