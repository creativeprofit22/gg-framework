import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ProjectNotesRepository,
  canonicalProjectKey,
  isNotesDocumentV3,
  NOTES_REFERENCE_METADATA_FIELDS,
  NOTES_REFERENCE_METADATA_MAX_LENGTH,
  NOTES_REFERENCE_URL_MAX_LENGTH,
  migrateNotesDocumentV2,
  projectNotesHash,
  projectNotesPaths,
  validateNotesDocumentV3,
  type NotesDocumentV2,
  type NotesDocumentV3,
  type ProjectNotesFileSystem,
  type StoredProjectNotesV1,
} from "./project-notes-repository.js";

const NOW = "2026-07-25T12:34:56.000Z";
const roots: string[] = [];

async function canonicalNotesFixture(): Promise<unknown> {
  return JSON.parse(
    await fs.readFile(new URL("../../../fixtures/project-notes-v3.json", import.meta.url), "utf8"),
  ) as unknown;
}

function legacyNotes(reference = "  reference\r\nbytes 😀\n"): NotesDocumentV2 {
  return {
    version: 2,
    reference,
    currentFocus: "Ship sidecar notes",
    tasks: [
      {
        id: "task-1",
        text: "Preserve every field",
        status: "done",
        createdAt: "2026-07-24T10:00:00.000Z",
        updatedAt: "2026-07-25T11:00:00.000Z",
        completedAt: "2026-07-25T11:00:00.000Z",
        archivedAt: "2026-07-25T12:00:00.000Z",
      },
      {
        id: "task-2",
        text: "Keep order",
        status: "todo",
        createdAt: NOW,
        updatedAt: NOW,
        completedAt: null,
        archivedAt: null,
      },
    ],
    handoff: {
      text: "Continue from this exact handoff",
      updatedAt: "2026-07-25T12:30:00.000Z",
      readAt: "2026-07-25T12:31:00.000Z",
    },
    updatedAt: NOW,
    legacyImportedAt: "2026-07-23T09:00:00.000Z",
  };
}

function notes(reference = "  reference\r\nbytes 😀\n"): NotesDocumentV3 {
  return {
    ...legacyNotes(reference),
    version: 3,
    references: [
      {
        id: "ref-1",
        provider: "github",
        tool: "kencode-search",
        canonicalUrl: "https://github.com/owner/repo/blob/abc123/src/file.ts#L10-L20",
        owner: "owner",
        repo: "repo",
        revision: "abc123",
        path: "src/file.ts",
        range: { startLine: 10, endLine: 20 },
        issue: null,
        pullRequest: null,
        query: "NotesDocumentV3",
        anchor: "L10-L20",
        relevance: "Authoritative schema source",
        capturedAt: NOW,
      },
    ],
    phases: [
      {
        id: "phase-1",
        title: "Add authoritative schema",
        goal: "Persist structured roadmap data",
        doneWhen: ["Round-trip passes", "Malformed data is rejected"],
        order: 0,
        status: "in-progress",
        sourcePrompt: "Implement Phase 16",
        referenceIds: ["ref-1"],
        session: { sessionId: "session-1", sessionPath: "/sessions/one.jsonl" },
        reminder: { id: "reminder-1", dueAt: NOW, note: "Review schema", createdAt: NOW },
        attentionReason: null,
        createdAt: "2026-07-24T10:00:00.000Z",
        updatedAt: NOW,
        completedAt: null,
        archivedAt: null,
        overrides: {
          status: { value: "in-progress", source: "user", updatedAt: NOW },
          referenceIds: { value: ["ref-1"], source: "user", updatedAt: NOW },
        },
        lifecycleEvents: [
          {
            id: "event-1",
            fromStatus: "not-started",
            toStatus: "planning",
            source: "user",
            timestamp: "2026-07-25T12:30:00.000Z",
            reason: "Started planning",
          },
          {
            id: "event-2",
            fromStatus: "planning",
            toStatus: "in-progress",
            source: "session",
            timestamp: NOW,
            reason: null,
          },
        ],
      },
    ],
  };
}

async function tempAgentDir(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gg-project-notes-"));
  roots.push(root);
  return path.join(root, ".gg");
}

async function readEnvelope(filePath: string): Promise<StoredProjectNotesV1> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as StoredProjectNotesV1;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("ProjectNotesRepository phase launch transaction", () => {
  it("creates one binding under a two-caller race and returns the winner to both", async () => {
    const agentDir = await tempAgentDir();
    const cwd = path.join(agentDir, "race-project");
    const document = notes();
    document.phases[0]!.session = null;
    document.phases[0]!.status = "not-started";
    document.phases[0]!.overrides.status = null;
    document.phases[0]!.lifecycleEvents = [];
    await new ProjectNotesRepository(agentDir).migrate(cwd, document);

    let createCalls = 0;
    const createBinding = async () => {
      createCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 25));
      return { sessionId: "winner", sessionPath: "/sessions/winner.jsonl" };
    };
    const firstRepository = new ProjectNotesRepository(agentDir);
    const secondRepository = new ProjectNotesRepository(agentDir);
    const [first, second] = await Promise.all([
      firstRepository.launchPhase(cwd, "phase-1", createBinding),
      secondRepository.launchPhase(cwd, "phase-1", createBinding),
    ]);

    expect(createCalls).toBe(1);
    expect(new Set([first.status, second.status])).toEqual(new Set(["accepted", "already-bound"]));
    if (!("session" in first) || !("session" in second)) throw new Error("Expected bindings");
    expect(first.session).toEqual(second.session);
    expect(first.session.sessionId).toBe("winner");
    expect(Math.max(first.snapshot.revision, second.snapshot.revision)).toBe(2);
    expect(first.phase.status).toBe("planning");
    expect(first.phase.lifecycleEvents).toMatchObject([
      {
        fromStatus: "not-started",
        toStatus: "planning",
        source: "user",
        reason: "Phase started by user",
      },
    ]);
    expect(first.references.map((reference) => reference.id)).toEqual(["ref-1"]);
  });

  it.each(["not-started", "needs-attention", "cancelled"] as const)(
    "atomically rebinds a null-path %s phase and makes the replacement authoritative",
    async (status) => {
      const agentDir = await tempAgentDir();
      const cwd = path.join(agentDir, `null-path-${status}`);
      const document = notes();
      document.phases[0]!.status = status;
      document.phases[0]!.session = { sessionId: "bound", sessionPath: null };
      document.phases[0]!.attentionReason =
        status === "needs-attention" ? "Previous launch lost its session path." : null;
      document.phases[0]!.completedAt = status === "cancelled" ? NOW : null;
      document.phases[0]!.overrides.status = null;
      document.phases[0]!.lifecycleEvents = [];
      const repository = new ProjectNotesRepository(agentDir);
      await repository.migrate(cwd, document);
      let createCalls = 0;

      const rebound = await repository.launchPhase(cwd, "phase-1", async (frozen) => {
        createCalls += 1;
        expect(frozen.phase.session).toEqual({ sessionId: "bound", sessionPath: null });
        return { sessionId: "rebound", sessionPath: "/sessions/rebound.jsonl" };
      });

      expect(rebound).toMatchObject({
        status: "accepted",
        snapshot: { revision: 2 },
        phase: {
          status: "planning",
          session: { sessionId: "rebound", sessionPath: "/sessions/rebound.jsonl" },
          attentionReason: null,
          completedAt: null,
          lifecycleEvents: [
            expect.objectContaining({ fromStatus: status, toStatus: "planning", source: "user" }),
          ],
        },
      });
      const repeated = await repository.launchPhase(cwd, "phase-1", async () => {
        createCalls += 1;
        return { sessionId: "duplicate", sessionPath: "/sessions/duplicate.jsonl" };
      });
      expect(repeated).toMatchObject({
        status: "already-bound",
        session: { sessionId: "rebound", sessionPath: "/sessions/rebound.jsonl" },
      });
      expect(createCalls).toBe(1);
    },
  );

  it("rejects stale and archived phases before creating a candidate", async () => {
    const agentDir = await tempAgentDir();
    const cwd = path.join(agentDir, "stale-project");
    const document = notes();
    document.phases[0]!.session = null;
    document.phases[0]!.archivedAt = NOW;
    await new ProjectNotesRepository(agentDir).migrate(cwd, document);
    let createCalls = 0;
    const repository = new ProjectNotesRepository(agentDir);

    expect(
      await repository.launchPhase(cwd, "missing", async () => {
        createCalls += 1;
        return { sessionId: "x", sessionPath: null };
      }),
    ).toEqual({ status: "phase-not-found" });
    expect(
      await repository.launchPhase(cwd, "phase-1", async () => {
        createCalls += 1;
        return { sessionId: "x", sessionPath: null };
      }),
    ).toEqual({ status: "phase-archived" });
    expect(createCalls).toBe(0);
  });

  it("keeps the phase unbound when creation fails and allows one retry", async () => {
    const agentDir = await tempAgentDir();
    const cwd = path.join(agentDir, "retry-project");
    const document = notes();
    document.phases[0]!.session = null;
    await new ProjectNotesRepository(agentDir).migrate(cwd, document);
    const repository = new ProjectNotesRepository(agentDir);

    await expect(
      repository.launchPhase(cwd, "phase-1", async () => {
        throw new Error("candidate failed");
      }),
    ).rejects.toThrow("candidate failed");
    expect(await repository.load(cwd)).toMatchObject({
      status: "ok",
      snapshot: { revision: 1, document: { phases: [{ session: null }] } },
    });
    await expect(
      repository.launchPhase(cwd, "phase-1", async () => ({
        sessionId: "retry",
        sessionPath: "/sessions/retry.jsonl",
      })),
    ).resolves.toMatchObject({ status: "accepted", session: { sessionId: "retry" } });
  });

  it("updates a checkpoint link and records launch attention as a lifecycle transition", async () => {
    const agentDir = await tempAgentDir();
    const cwd = path.join(agentDir, "checkpoint-project");
    const document = notes();
    document.phases[0]!.overrides.status = null;
    await new ProjectNotesRepository(agentDir).migrate(cwd, document);
    const repository = new ProjectNotesRepository(agentDir);
    const originalStatus = document.phases[0]!.status;
    const originalEvents = document.phases[0]!.lifecycleEvents;

    const linked = await repository.updatePhaseSessionLink(cwd, "phase-1", {
      sessionId: "checkpoint",
      sessionPath: "/sessions/checkpoint.jsonl",
    });
    expect(linked).toMatchObject({
      status: "ok",
      phase: {
        status: originalStatus,
        lifecycleEvents: originalEvents,
        session: { sessionId: "checkpoint" },
      },
    });
    const attention = await repository.recordPhaseLaunchAttention(
      cwd,
      "phase-1",
      `  Prompt   failed ${"x".repeat(600)}  `,
    );
    expect(attention).toMatchObject({
      status: "ok",
      phase: {
        status: "needs-attention",
        lifecycleEvents: [
          ...originalEvents,
          {
            fromStatus: originalStatus,
            toStatus: "needs-attention",
            source: "system",
          },
        ],
      },
    });
    if (attention.status !== "ok") throw new Error("Expected attention update");
    expect(attention.phase.attentionReason?.length).toBe(240);
    expect(attention.phase.attentionReason).toMatch(/^Prompt failed/);
  });
});

describe("ProjectNotesRepository authoritative lifecycle transitions", () => {
  async function createLifecycleRepository(projectName: string) {
    const agentDir = await tempAgentDir();
    const cwd = path.join(agentDir, projectName);
    const document = notes();
    document.phases[0]!.overrides.status = null;
    await new ProjectNotesRepository(agentDir).migrate(cwd, document);
    return { agentDir, cwd, repository: new ProjectNotesRepository(agentDir) };
  }

  it("appends transitions, clamps chronology, clears attention, and timestamps cancellation", async () => {
    const { cwd, repository } = await createLifecycleRepository("lifecycle-project");
    const expectedSession = { sessionId: "session-1", sessionPath: "/sessions/one.jsonl" };
    const attention = await repository.recordPhaseLifecycleTransition(cwd, "phase-1", {
      status: "needs-attention",
      source: "agent",
      reason: `  Tool   failed\n${"x".repeat(500)}`,
      timestamp: "2026-07-25T12:35:00.000Z",
      expectedSession,
    });
    expect(attention).toMatchObject({
      status: "ok",
      phase: { status: "needs-attention", completedAt: null },
    });
    if (attention.status !== "ok") throw new Error("Expected lifecycle transition");
    expect(attention.phase.attentionReason).toHaveLength(240);
    expect(attention.phase.lifecycleEvents).toHaveLength(3);

    const restored = await repository.recordPhaseLifecycleTransition(cwd, "phase-1", {
      status: "review",
      source: "session",
      reason: "Review session resumed",
      timestamp: "2026-07-24T00:00:00.000Z",
      expectedSession,
    });
    expect(restored).toMatchObject({
      status: "ok",
      phase: { status: "review", attentionReason: null, completedAt: null },
    });
    if (restored.status !== "ok") throw new Error("Expected restored transition");
    const restoredEvent = restored.phase.lifecycleEvents.at(-1)!;
    expect(restoredEvent.timestamp).toBe("2026-07-25T12:35:00.000Z");

    const cancelled = await repository.recordPhaseLifecycleTransition(cwd, "phase-1", {
      status: "cancelled",
      source: "user",
      reason: "Phase run cancelled by user",
      timestamp: "2026-07-25T12:36:00.000Z",
      expectedSession,
    });
    expect(cancelled).toMatchObject({
      status: "ok",
      phase: {
        status: "cancelled",
        completedAt: "2026-07-25T12:36:00.000Z",
        lifecycleEvents: expect.arrayContaining([
          expect.objectContaining({
            fromStatus: "review",
            toStatus: "cancelled",
            source: "user",
          }),
        ]),
      },
    });
  });

  it("matches an explicit unbound guard only while the phase session is null", async () => {
    const { agentDir, cwd, repository } = await createLifecycleRepository("null-session-guard");

    await expect(
      repository.recordPhaseLaunchAttention(cwd, "phase-1", "Launch failed", null),
    ).resolves.toEqual({ status: "stale-session" });

    const unboundCwd = path.join(agentDir, "unbound-session-guard");
    const unboundDocument = notes();
    unboundDocument.phases[0]!.session = null;
    unboundDocument.phases[0]!.status = "not-started";
    unboundDocument.phases[0]!.overrides.status = null;
    unboundDocument.phases[0]!.lifecycleEvents = [];
    await repository.migrate(unboundCwd, unboundDocument);

    await expect(
      repository.recordPhaseLaunchAttention(unboundCwd, "phase-1", "Launch failed", null),
    ).resolves.toMatchObject({
      status: "ok",
      phase: {
        status: "needs-attention",
        session: null,
        lifecycleEvents: [
          expect.objectContaining({
            fromStatus: "not-started",
            toStatus: "needs-attention",
            source: "system",
          }),
        ],
      },
    });
  });

  it("makes duplicates idempotent and refuses stale sessions, overrides, archives, missing phases, and Done", async () => {
    const { cwd, repository } = await createLifecycleRepository("guard-project");
    const transition = {
      status: "review" as const,
      source: "agent" as const,
      reason: "Implementation verification started",
      timestamp: "2026-07-25T12:40:00.000Z",
      expectedSession: { sessionId: "session-1", sessionPath: "/sessions/one.jsonl" },
    };
    await expect(
      repository.recordPhaseLifecycleTransition(cwd, "phase-1", {
        ...transition,
        expectedSession: { sessionId: "stale", sessionPath: null },
      }),
    ).resolves.toEqual({ status: "stale-session" });
    const accepted = await repository.recordPhaseLifecycleTransition(cwd, "phase-1", transition);
    expect(accepted).toMatchObject({ status: "ok", snapshot: { revision: 2 } });
    await expect(
      repository.recordPhaseLifecycleTransition(cwd, "phase-1", transition),
    ).resolves.toEqual({ status: "same-status" });
    await expect(
      repository.recordPhaseLifecycleTransition(cwd, "missing", transition),
    ).resolves.toEqual({ status: "phase-not-found" });

    if (accepted.status !== "ok") throw new Error("Expected transition");
    const overridden = structuredClone(accepted.snapshot.document);
    overridden.phases[0]!.overrides.status = {
      value: "review",
      source: "user",
      updatedAt: "2026-07-25T12:41:00.000Z",
    };
    const savedOverride = await repository.save(cwd, accepted.snapshot.revision, overridden);
    if (savedOverride.status !== "ok") throw new Error("Expected override save");
    await expect(
      repository.recordPhaseLifecycleTransition(cwd, "phase-1", {
        ...transition,
        status: "in-progress",
      }),
    ).resolves.toEqual({ status: "manual-override" });

    const doneDocument = structuredClone(savedOverride.snapshot.document);
    doneDocument.phases[0]!.overrides.status = null;
    doneDocument.phases[0]!.status = "done";
    doneDocument.phases[0]!.completedAt = "2026-07-25T12:42:00.000Z";
    doneDocument.phases[0]!.lifecycleEvents.push({
      id: "manual-done",
      fromStatus: "review",
      toStatus: "done",
      source: "user",
      timestamp: "2026-07-25T12:42:00.000Z",
      reason: "Marked done by user",
    });
    const savedDone = await repository.save(cwd, savedOverride.snapshot.revision, doneDocument);
    if (savedDone.status !== "ok") throw new Error("Expected Done save");
    await expect(
      repository.recordPhaseLifecycleTransition(cwd, "phase-1", {
        ...transition,
        status: "in-progress",
      }),
    ).resolves.toEqual({ status: "done-terminal" });
  });

  it("serializes cross-window status races under the project lock", async () => {
    const { agentDir, cwd } = await createLifecycleRepository("status-race");
    const first = new ProjectNotesRepository(agentDir);
    const second = new ProjectNotesRepository(agentDir);
    const transition = {
      status: "review" as const,
      source: "agent" as const,
      reason: "Autopilot review started",
      timestamp: "2026-07-25T13:00:00.000Z",
      expectedSession: { sessionId: "session-1", sessionPath: "/sessions/one.jsonl" },
    };
    const outcomes = await Promise.all([
      first.recordPhaseLifecycleTransition(cwd, "phase-1", transition),
      second.recordPhaseLifecycleTransition(cwd, "phase-1", transition),
    ]);
    expect(new Set(outcomes.map((outcome) => outcome.status))).toEqual(
      new Set(["ok", "same-status"]),
    );
    const loaded = await first.load(cwd);
    expect(loaded).toMatchObject({
      status: "ok",
      snapshot: {
        revision: 2,
        document: { phases: [{ status: "review", lifecycleEvents: expect.any(Array) }] },
      },
    });
    if (loaded.status !== "ok") throw new Error("Expected loaded Notes");
    expect(loaded.snapshot.document.phases[0]!.lifecycleEvents).toHaveLength(3);
  });
});

describe("project Notes identity and validation", () => {
  it("accepts and exactly round-trips the canonical v3 contract fixture", async () => {
    const fixture = await canonicalNotesFixture();
    const validated = validateNotesDocumentV3(fixture);

    expect(validated).toEqual({ ok: true, document: fixture });
    if (!validated.ok) throw new Error(validated.error.message);

    const agentDir = await tempAgentDir();
    const cwd = "/work/canonical-fixture";
    const repository = new ProjectNotesRepository(agentDir);
    const migrated = await repository.migrate(cwd, validated.document);
    const restarted = await new ProjectNotesRepository(agentDir).load(cwd);

    expect(migrated).toMatchObject({
      status: "ok",
      snapshot: { document: fixture },
    });
    expect(restarted).toMatchObject({
      status: "ok",
      recoveredFromBackup: false,
      snapshot: { document: fixture },
    });
    expect((await readEnvelope(repository.paths(cwd).primary)).document).toEqual(fixture);
  });

  it("enforces canonical reference identity and GitHub coordinate parity", () => {
    const valid = notes();
    const first = valid.references[0]!;
    const duplicate = {
      ...first,
      id: "ref-duplicate",
      provider: " GitHub ",
      canonicalUrl: "HTTPS://GITHUB.COM:443/owner/repo/blob/abc123/src/file.ts/#L10-L20",
    };

    expect(validateNotesDocumentV3({ ...valid, references: [first, duplicate] })).toMatchObject({
      ok: false,
      error: { path: "references[1].canonicalUrl", message: expect.stringContaining("duplicate") },
    });
    expect(
      validateNotesDocumentV3({
        ...valid,
        references: [{ ...first, canonicalUrl: "https://gitlab.com/owner/repo" }],
      }),
    ).toMatchObject({ ok: false, error: { path: "references[0].canonicalUrl" } });
    expect(
      validateNotesDocumentV3({
        ...valid,
        references: [
          {
            ...first,
            canonicalUrl: "https://github.com/owner/repo/pull/12",
            pullRequest: 11,
          },
        ],
      }),
    ).toMatchObject({ ok: false, error: { path: "references[0].pullRequest" } });
  });

  it.each([
    ["username", "https://user@github.com/owner/repo/blob/abc123/src/file.ts#L10-L20"],
    ["password", "https://:secret@github.com/owner/repo/blob/abc123/src/file.ts#L10-L20"],
  ])(
    "rejects a reference URL containing a %s before persistence",
    async (_credential, canonicalUrl) => {
      const agentDir = await tempAgentDir();
      const cwd = "/work/credential-url";
      const repository = new ProjectNotesRepository(agentDir);
      const invalid = notes("invalid credentials");
      invalid.references[0] = { ...invalid.references[0]!, canonicalUrl };

      await expect(repository.migrate(cwd, invalid)).resolves.toEqual({
        status: "invalid",
        error: {
          path: "references[0].canonicalUrl",
          message: "expected an absolute http(s) URL without username or password",
        },
      });
      await expect(repository.load(cwd)).resolves.toEqual({ status: "missing" });

      const valid = notes("valid baseline");
      await expect(repository.migrate(cwd, valid)).resolves.toMatchObject({ status: "ok" });
      await expect(repository.save(cwd, 1, invalid)).resolves.toMatchObject({
        status: "invalid",
        error: { path: "references[0].canonicalUrl" },
      });
      expect(await readEnvelope(repository.paths(cwd).primary)).toMatchObject({
        revision: 1,
        document: {
          reference: "valid baseline",
          references: [{ canonicalUrl: valid.references[0]!.canonicalUrl }],
        },
      });
    },
  );

  it.each(NOTES_REFERENCE_METADATA_FIELDS)(
    "matches app validation at the shared metadata limit for %s",
    (field) => {
      const exact = notes("metadata limit");
      exact.references[0] = {
        ...exact.references[0]!,
        provider: "example",
        [field]: "x".repeat(NOTES_REFERENCE_METADATA_MAX_LENGTH),
      };
      const oversized = notes("metadata limit");
      oversized.references[0] = {
        ...oversized.references[0]!,
        provider: "example",
        [field]: "x".repeat(NOTES_REFERENCE_METADATA_MAX_LENGTH + 1),
      };

      expect(validateNotesDocumentV3(exact).ok).toBe(true);
      expect(validateNotesDocumentV3(oversized)).toMatchObject({
        ok: false,
        error: { path: `references[0].${field}`, message: expect.stringContaining("4,096") },
      });
    },
  );

  it("matches app validation at the shared canonical URL limit", () => {
    const prefix = "https://example.com/";
    const canonicalUrl = `${prefix}${"x".repeat(NOTES_REFERENCE_URL_MAX_LENGTH - prefix.length)}`;
    const exact = notes("URL limit");
    exact.references[0] = { ...exact.references[0]!, provider: "example", canonicalUrl };
    const oversized = notes("URL limit");
    oversized.references[0] = {
      ...oversized.references[0]!,
      provider: "example",
      canonicalUrl: `${canonicalUrl}x`,
    };

    expect(validateNotesDocumentV3(exact).ok).toBe(true);
    expect(validateNotesDocumentV3(oversized)).toMatchObject({
      ok: false,
      error: { path: "references[0].canonicalUrl", message: expect.stringContaining("2,048") },
    });
  });

  it("rewrites the original v3 phase shape with a null archive marker", async () => {
    const agentDir = await tempAgentDir();
    const cwd = "/work/original-v3";
    const repository = new ProjectNotesRepository(agentDir);
    const paths = repository.paths(cwd);
    const original = notes() as unknown as { phases: Array<Record<string, unknown>> };
    delete original.phases[0]!.archivedAt;
    const envelope = {
      storeVersion: 1,
      projectKey: canonicalProjectKey(cwd),
      revision: 3,
      document: original,
    };
    await fs.mkdir(paths.directory, { recursive: true });
    await fs.writeFile(paths.primary, JSON.stringify(envelope), "utf8");

    const loaded = await repository.load(cwd);

    expect(loaded).toMatchObject({
      status: "ok",
      snapshot: { revision: 3, document: { phases: [{ archivedAt: null }] } },
    });
    expect((await readEnvelope(paths.primary)).document.phases[0]!.archivedAt).toBeNull();
    expect((await readEnvelope(paths.backup)).document.phases[0]!.archivedAt).toBeNull();
  });

  it("rejects original-v3 archive lookalikes with unknown phase keys", async () => {
    const agentDir = await tempAgentDir();
    const original = notes() as unknown as { phases: Array<Record<string, unknown>> };
    delete original.phases[0]!.archivedAt;
    original.phases[0]!.unexpected = true;

    await expect(
      new ProjectNotesRepository(agentDir).migrate("/work/lookalike", original),
    ).resolves.toMatchObject({
      status: "invalid",
      error: { path: "phases[0]" },
    });
  });

  it("uses the full SHA-256 canonical key under the GG data directory", () => {
    const paths = projectNotesPaths("/home/ken/.gg", "/work/project");

    expect(projectNotesHash("/work/project")).toBe(
      "65d80d2c48b3d23b89fb7644fbb034a40f899515baa72f5ae8d871bd81823e11",
    );
    expect(paths).toEqual({
      directory: path.join("/home/ken/.gg", "project-notes"),
      primary: path.join(
        "/home/ken/.gg",
        "project-notes",
        "65d80d2c48b3d23b89fb7644fbb034a40f899515baa72f5ae8d871bd81823e11.json",
      ),
      backup: path.join(
        "/home/ken/.gg",
        "project-notes",
        "65d80d2c48b3d23b89fb7644fbb034a40f899515baa72f5ae8d871bd81823e11.backup.json",
      ),
      lock: path.join(
        "/home/ken/.gg",
        "project-notes",
        "65d80d2c48b3d23b89fb7644fbb034a40f899515baa72f5ae8d871bd81823e11.json.lock",
      ),
    });
    expect(projectNotesHash("/work/project")).toBe(
      createHash("sha256").update("/work/project", "utf8").digest("hex"),
    );
  });

  it.each([
    ["C:\\Work\\.\\App\\..\\Project\\", "c:/work/project"],
    ["C:/WORK/PROJECT", "c:\\work\\project"],
    ["\\\\Server\\Share\\Folder\\..\\Project", "//server/share/project"],
    ["/work/./app/../project/", "/work/project"],
    ["work/../project", "project"],
  ])("canonicalizes alias %s to %s", (left, right) => {
    expect(canonicalProjectKey(left)).toBe(canonicalProjectKey(right));
    expect(projectNotesHash(canonicalProjectKey(left))).toBe(
      projectNotesHash(canonicalProjectKey(right)),
    );
  });

  it("preserves POSIX case", () => {
    expect(canonicalProjectKey("/Work/Project")).not.toBe(canonicalProjectKey("/work/project"));
  });

  it("strictly rejects malformed references, links, statuses, and transition records", () => {
    const valid = notes();
    const invalidDocuments: Array<{ value: unknown; path: string }> = [
      { value: { ...valid, version: 2 }, path: "version" },
      { value: { ...valid, extra: true }, path: "$" },
      {
        value: {
          ...valid,
          references: [{ ...valid.references[0], canonicalUrl: "not a URL" }],
        },
        path: "references[0].canonicalUrl",
      },
      {
        value: { ...valid, references: [{ ...valid.references[0], owner: "" }] },
        path: "references[0].owner",
      },
      {
        value: { ...valid, phases: [{ ...valid.phases[0], referenceIds: ["missing"] }] },
        path: "phases[0].referenceIds[0]",
      },
      {
        value: { ...valid, phases: [{ ...valid.phases[0], status: "blocked" }] },
        path: "phases[0].status",
      },
      {
        value: { ...valid, phases: [{ ...valid.phases[0], archivedAt: "next week" }] },
        path: "phases[0].archivedAt",
      },
      {
        value: {
          ...valid,
          phases: [
            {
              ...valid.phases[0],
              lifecycleEvents: [
                valid.phases[0]!.lifecycleEvents[0],
                { ...valid.phases[0]!.lifecycleEvents[1], fromStatus: "not-started" },
              ],
            },
          ],
        },
        path: "phases[0].lifecycleEvents[1].fromStatus",
      },
    ];

    expect(isNotesDocumentV3(valid)).toBe(true);
    for (const invalidDocument of invalidDocuments) {
      const result = validateNotesDocumentV3(invalidDocument.value);
      expect(result).toEqual({
        ok: false,
        error: { path: invalidDocument.path, message: expect.any(String) },
      });
      expect(isNotesDocumentV3(invalidDocument.value)).toBe(false);
    }
  });
});

describe("ProjectNotesRepository durability", () => {
  it("migrates once at revision 1 and round-trips every v3 field and byte after restart", async () => {
    const agentDir = await tempAgentDir();
    const cwd = "C:\\Work\\Project";
    const document = notes();
    const repository = new ProjectNotesRepository(agentDir);

    const migrated = await repository.migrate(cwd, document);
    const restarted = await new ProjectNotesRepository(agentDir).load("c:/work/project");
    const paths = repository.paths(cwd);

    expect(migrated).toEqual({
      status: "ok",
      migrated: true,
      snapshot: { projectKey: "c:/work/project", revision: 1, document },
    });
    expect(restarted).toEqual({
      status: "ok",
      recoveredFromBackup: false,
      snapshot: { projectKey: "c:/work/project", revision: 1, document },
    });
    expect(await readEnvelope(paths.primary)).toEqual({
      storeVersion: 1,
      projectKey: "c:/work/project",
      revision: 1,
      document,
    });
    expect(await readEnvelope(paths.backup)).toEqual(await readEnvelope(paths.primary));
    expect((await fs.readFile(paths.primary, "utf8")).endsWith("\n")).toBe(true);
  });

  it("migrates v2 to v3 without changing any existing Notes field and persists it across restart", async () => {
    const agentDir = await tempAgentDir();
    const cwd = "/work/v2-project";
    const legacy = legacyNotes("  legacy\r\nbytes 😀\n");
    const expected = { ...legacy, version: 3 as const, phases: [], references: [] };

    expect(migrateNotesDocumentV2(legacy)).toEqual({ ok: true, document: expected });

    const repository = new ProjectNotesRepository(agentDir);
    const migrated = await repository.migrate(cwd, legacy);
    const restarted = await new ProjectNotesRepository(agentDir).load(cwd);

    expect(migrated).toMatchObject({
      status: "ok",
      migrated: true,
      snapshot: { revision: 1, document: expected },
    });
    expect(restarted).toMatchObject({
      status: "ok",
      recoveredFromBackup: false,
      snapshot: { revision: 1, document: expected },
    });
    expect((await readEnvelope(repository.paths(cwd).primary)).document).toEqual(expected);
  });

  it("repairs empty and duplicate task IDs while migrating legacy v2 Notes", async () => {
    const agentDir = await tempAgentDir();
    const cwd = "/work/v2-task-ids";
    const legacy = legacyNotes("legacy IDs");
    const task = legacy.tasks[0]!;
    legacy.tasks = [
      { ...task, id: "", text: "empty" },
      { ...task, id: "duplicate", text: "first duplicate" },
      { ...task, id: "duplicate", text: "second duplicate" },
    ];

    const repository = new ProjectNotesRepository(agentDir);
    const migrated = await repository.migrate(cwd, legacy);
    const restarted = await new ProjectNotesRepository(agentDir).load(cwd);
    const expectedIds = ["legacy-task-1", "duplicate", "legacy-task-3"];

    expect(migrated.status).toBe("ok");
    if (migrated.status !== "ok") throw new Error("migration failed");
    expect(migrated.snapshot.document.tasks.map(({ id }) => id)).toEqual(expectedIds);
    expect(isNotesDocumentV3(migrated.snapshot.document)).toBe(true);
    expect(restarted.status).toBe("ok");
    if (restarted.status !== "ok") throw new Error("restart load failed");
    expect(restarted.snapshot.document.tasks.map(({ id }) => id)).toEqual(expectedIds);
  });

  it("upgrades a v2 disk envelope in place before the next restart", async () => {
    const agentDir = await tempAgentDir();
    const cwd = "/work/disk-v2";
    const repository = new ProjectNotesRepository(agentDir);
    const paths = repository.paths(cwd);
    const legacy = legacyNotes("disk v2");
    await fs.mkdir(paths.directory, { recursive: true });
    await fs.writeFile(
      paths.primary,
      `${JSON.stringify({
        storeVersion: 1,
        projectKey: cwd,
        revision: 4,
        document: legacy,
      })}\n`,
      "utf8",
    );

    const loaded = await repository.load(cwd);
    const restarted = await new ProjectNotesRepository(agentDir).load(cwd);

    expect(loaded).toMatchObject({
      status: "ok",
      snapshot: { revision: 4, document: { version: 3, reference: "disk v2" } },
    });
    expect(restarted).toEqual(loaded);
    expect((await readEnvelope(paths.primary)).document).toMatchObject({
      version: 3,
      phases: [],
      references: [],
    });
  });

  it("allows exactly one of two simultaneous migrations to create the store", async () => {
    const agentDir = await tempAgentDir();
    const first = new ProjectNotesRepository(agentDir);
    const second = new ProjectNotesRepository(agentDir);

    const outcomes = await Promise.all([
      first.migrate("/work/project", notes("first")),
      second.migrate("/work/project", notes("second")),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === "ok" && outcome.migrated)).toHaveLength(
      1,
    );
    expect(outcomes.filter((outcome) => outcome.status === "ok" && !outcome.migrated)).toHaveLength(
      1,
    );
    const snapshots = outcomes.map((outcome) =>
      outcome.status === "ok" ? outcome.snapshot : null,
    );
    expect(snapshots[0]).toEqual(snapshots[1]);
    expect((await first.load("/work/project")).status).toBe("ok");
  });

  it("recovers a missing or corrupt primary from a fully validated backup", async () => {
    const agentDir = await tempAgentDir();
    const repository = new ProjectNotesRepository(agentDir);
    const paths = repository.paths("/work/project");
    await repository.migrate("/work/project", notes());

    await fs.writeFile(paths.primary, "{broken", "utf8");
    const recovered = await repository.load("/work/project");

    expect(recovered).toMatchObject({ status: "ok", recoveredFromBackup: true });
    expect(await readEnvelope(paths.primary)).toEqual(await readEnvelope(paths.backup));
  });

  it("reports dual corruption without replacing either file", async () => {
    const agentDir = await tempAgentDir();
    const repository = new ProjectNotesRepository(agentDir);
    const paths = repository.paths("/work/project");
    await fs.mkdir(paths.directory, { recursive: true });
    await fs.writeFile(paths.primary, "{primary", "utf8");
    await fs.writeFile(paths.backup, "{backup", "utf8");

    const outcome = await repository.load("/work/project");

    expect(outcome).toEqual({
      status: "corrupt",
      primary: "malformed-json",
      backup: "malformed-json",
    });
    expect(await fs.readFile(paths.primary, "utf8")).toBe("{primary");
    expect(await fs.readFile(paths.backup, "utf8")).toBe("{backup");
  });

  it("rejects an envelope stored under the wrong project hash", async () => {
    const agentDir = await tempAgentDir();
    const repository = new ProjectNotesRepository(agentDir);
    const paths = repository.paths("/work/project");
    await fs.mkdir(paths.directory, { recursive: true });
    await fs.writeFile(
      paths.primary,
      JSON.stringify({
        storeVersion: 1,
        projectKey: "/another/project",
        revision: 1,
        document: notes(),
      }),
      "utf8",
    );

    expect(await repository.load("/work/project")).toEqual({
      status: "corrupt",
      primary: "project-key-mismatch",
      backup: null,
    });
  });

  it("rejects a save before acceptance when flushing the new primary fails", async () => {
    const agentDir = await tempAgentDir();
    const baseline = new ProjectNotesRepository(agentDir);
    const paths = baseline.paths("/work/project");
    await baseline.migrate("/work/project", notes("old"));
    const injected = failingSyncFileSystem(paths.primary);
    const repository = new ProjectNotesRepository(agentDir, {
      fileSystem: injected.fileSystem,
      createId: () => "flush-failure",
    });

    await expect(repository.save("/work/project", 1, notes("new"))).rejects.toThrow(
      "injected sync failure",
    );

    expect(await new ProjectNotesRepository(agentDir).load("/work/project")).toMatchObject({
      status: "ok",
      snapshot: { revision: 1, document: { reference: "old" } },
    });
    expect(injected.failed).toBe(true);
    expect((await fs.readdir(paths.directory)).some((entry) => entry.endsWith(".tmp"))).toBe(false);
  });

  it("keeps a first migration recoverable when flushing the primary fails", async () => {
    const agentDir = await tempAgentDir();
    const paths = projectNotesPaths(agentDir, "/work/project");
    const injected = failingSyncFileSystem(paths.primary);
    const repository = new ProjectNotesRepository(agentDir, {
      fileSystem: injected.fileSystem,
      createId: () => "migration-flush-failure",
    });

    await expect(repository.migrate("/work/project", notes("imported"))).rejects.toThrow(
      "injected sync failure",
    );

    expect(await new ProjectNotesRepository(agentDir).load("/work/project")).toMatchObject({
      status: "ok",
      recoveredFromBackup: true,
      snapshot: { revision: 1, document: { reference: "imported" } },
    });
    expect(injected.failed).toBe(true);
  });

  it("leaves the old revision recoverable when the final rename fails", async () => {
    const agentDir = await tempAgentDir();
    const baseline = new ProjectNotesRepository(agentDir);
    const paths = baseline.paths("/work/project");
    await baseline.migrate("/work/project", notes("old"));
    const injected = failingRenameFileSystem(paths.primary);
    const repository = new ProjectNotesRepository(agentDir, {
      fileSystem: injected.fileSystem,
      createId: () => "failure",
    });

    await expect(repository.save("/work/project", 1, notes("new"))).rejects.toThrow(
      "injected rename failure",
    );

    expect(await new ProjectNotesRepository(agentDir).load("/work/project")).toMatchObject({
      status: "ok",
      snapshot: { revision: 1, document: { reference: "old" } },
    });
    expect(injected.failed).toBe(true);
    expect((await fs.readdir(paths.directory)).some((entry) => entry.endsWith(".tmp"))).toBe(false);
  });

  it("keeps a first migration recoverable when installing the primary fails", async () => {
    const agentDir = await tempAgentDir();
    const paths = projectNotesPaths(agentDir, "/work/project");
    const injected = failingRenameFileSystem(paths.primary);
    const repository = new ProjectNotesRepository(agentDir, {
      fileSystem: injected.fileSystem,
      createId: () => "migration-failure",
    });

    await expect(repository.migrate("/work/project", notes("imported"))).rejects.toThrow(
      "injected rename failure",
    );

    const recovered = await new ProjectNotesRepository(agentDir).load("/work/project");
    expect(recovered).toMatchObject({
      status: "ok",
      recoveredFromBackup: true,
      snapshot: { revision: 1, document: { reference: "imported" } },
    });
  });

  it("keeps reference capture times immutable while allowing create, edit, and delete", async () => {
    const agentDir = await tempAgentDir();
    const cwd = "/work/reference-transitions";
    const repository = new ProjectNotesRepository(agentDir);
    const initial = notes("reference transitions");
    initial.references = [];
    initial.phases[0] = {
      ...initial.phases[0]!,
      referenceIds: [],
      overrides: { ...initial.phases[0]!.overrides, referenceIds: null },
    };
    await repository.migrate(cwd, initial);

    const reference = notes().references[0]!;
    const created = { ...initial, references: [reference] };
    await expect(repository.save(cwd, 1, created)).resolves.toMatchObject({
      status: "ok",
      snapshot: { revision: 2, document: created },
    });

    const editedReference = { ...reference, relevance: "Edited provenance note" };
    const edited = { ...created, references: [editedReference] };
    await expect(repository.save(cwd, 2, edited)).resolves.toMatchObject({
      status: "ok",
      snapshot: { revision: 3, document: edited },
    });

    const paths = repository.paths(cwd);
    const primaryBeforeRejectedSave = await fs.readFile(paths.primary, "utf8");
    const backupBeforeRejectedSave = await fs.readFile(paths.backup, "utf8");
    const changedCapturedAt = {
      ...edited,
      references: [{ ...editedReference, capturedAt: "2026-07-26T12:34:56.000Z" }],
    };

    await expect(repository.save(cwd, 3, changedCapturedAt)).resolves.toEqual({
      status: "invalid",
      error: {
        path: "references[0].capturedAt",
        message: "existing reference capture time cannot be changed",
      },
    });
    expect(await fs.readFile(paths.primary, "utf8")).toBe(primaryBeforeRejectedSave);
    expect(await fs.readFile(paths.backup, "utf8")).toBe(backupBeforeRejectedSave);
    await expect(repository.load(cwd)).resolves.toMatchObject({
      status: "ok",
      snapshot: { revision: 3, document: edited },
    });

    const deleted = { ...edited, references: [] };
    await expect(repository.save(cwd, 3, deleted)).resolves.toMatchObject({
      status: "ok",
      snapshot: { revision: 4, document: deleted },
    });
  });

  it("keeps phase and reference IDs stable through reorder, edit, and restart", async () => {
    const agentDir = await tempAgentDir();
    const repository = new ProjectNotesRepository(agentDir);
    const initial = notes("stable IDs");
    const secondReference = {
      ...initial.references[0]!,
      id: "ref-2",
      canonicalUrl: "https://github.com/owner/repo/issues/22",
      revision: null,
      path: null,
      range: null,
      issue: 22,
      query: null,
      anchor: null,
    };
    const secondPhase = {
      ...initial.phases[0]!,
      id: "phase-2",
      title: "Second phase",
      order: 1,
      status: "not-started" as const,
      referenceIds: ["ref-2"],
      session: null,
      reminder: null,
      overrides: { status: null, referenceIds: null },
      lifecycleEvents: [],
    };
    const withTwo = {
      ...initial,
      references: [...initial.references, secondReference],
      phases: [...initial.phases, secondPhase],
    };
    await repository.migrate("/work/project", withTwo);
    const reordered = {
      ...withTwo,
      references: [secondReference, initial.references[0]!],
      phases: [
        { ...secondPhase, title: "Second phase edited", order: 0 },
        { ...initial.phases[0]!, goal: "Edited without replacing identity", order: 1 },
      ],
    };

    expect(await repository.save("/work/project", 1, reordered)).toMatchObject({ status: "ok" });
    const restarted = await new ProjectNotesRepository(agentDir).load("/work/project");

    expect(restarted).toMatchObject({
      status: "ok",
      snapshot: {
        revision: 2,
        document: {
          phases: [{ id: "phase-2" }, { id: "phase-1" }],
          references: [{ id: "ref-2" }, { id: "ref-1" }],
        },
      },
    });
  });

  it("round-trips many-to-many links and rejects deletion until every link and override is removed", async () => {
    const agentDir = await tempAgentDir();
    const repository = new ProjectNotesRepository(agentDir);
    const initial = notes("many to many");
    const archivedPhase = {
      ...initial.phases[0]!,
      id: "phase-archived",
      title: "Archived evidence",
      order: 1,
      archivedAt: NOW,
      session: null,
      reminder: null,
      referenceIds: ["ref-1"],
      overrides: {
        status: null,
        referenceIds: { value: ["ref-1"], source: "user" as const, updatedAt: NOW },
      },
      lifecycleEvents: [],
      status: "not-started" as const,
    };
    const linked = {
      ...initial,
      phases: [
        {
          ...initial.phases[0]!,
          overrides: {
            ...initial.phases[0]!.overrides,
            referenceIds: { value: ["ref-1"], source: "user" as const, updatedAt: NOW },
          },
        },
        archivedPhase,
      ],
    };

    await expect(repository.migrate("/work/project", linked)).resolves.toMatchObject({
      status: "ok",
      snapshot: { document: linked },
    });
    const oneUnlinked = {
      ...linked,
      phases: [
        {
          ...linked.phases[0]!,
          referenceIds: [],
          overrides: {
            ...linked.phases[0]!.overrides,
            referenceIds: { value: [], source: "user" as const, updatedAt: NOW },
          },
        },
        archivedPhase,
      ],
    };
    await expect(repository.save("/work/project", 1, oneUnlinked)).resolves.toMatchObject({
      status: "ok",
    });

    const brokenDelete = { ...oneUnlinked, references: [] };
    await expect(repository.save("/work/project", 2, brokenDelete)).resolves.toMatchObject({
      status: "invalid",
      error: { path: "phases[1].referenceIds[0]" },
    });

    const fullyUnlinked = {
      ...oneUnlinked,
      phases: [
        oneUnlinked.phases[0]!,
        {
          ...archivedPhase,
          referenceIds: [],
          overrides: {
            ...archivedPhase.overrides,
            referenceIds: { value: [], source: "user" as const, updatedAt: NOW },
          },
        },
      ],
      references: [],
    };
    await expect(repository.save("/work/project", 2, fullyUnlinked)).resolves.toMatchObject({
      status: "ok",
      snapshot: { revision: 3, document: fullyUnlinked },
    });
    await expect(new ProjectNotesRepository(agentDir).load("/work/project")).resolves.toMatchObject(
      {
        status: "ok",
        snapshot: { revision: 3, document: fullyUnlinked },
      },
    );
  });

  it("accepts unchanged lifecycle events rebuilt with a different property order", async () => {
    const agentDir = await tempAgentDir();
    const repository = new ProjectNotesRepository(agentDir);
    const initial = notes("property order");
    await repository.migrate("/work/project", initial);
    const firstEvent = initial.phases[0]!.lifecycleEvents[0]!;
    const reversedFirstEvent = {
      reason: firstEvent.reason,
      timestamp: firstEvent.timestamp,
      source: firstEvent.source,
      toStatus: firstEvent.toStatus,
      fromStatus: firstEvent.fromStatus,
      id: firstEvent.id,
    };
    const rebuilt = {
      ...initial,
      phases: [
        {
          ...initial.phases[0]!,
          lifecycleEvents: [reversedFirstEvent, initial.phases[0]!.lifecycleEvents[1]!],
        },
      ],
    };

    expect(await repository.save("/work/project", 1, rebuilt)).toMatchObject({ status: "ok" });
    expect(await new ProjectNotesRepository(agentDir).load("/work/project")).toMatchObject({
      status: "ok",
      snapshot: { document: rebuilt },
    });
  });

  it("enforces append-only events and preserves manual override markers on shaped writes", async () => {
    const agentDir = await tempAgentDir();
    const repository = new ProjectNotesRepository(agentDir);
    const initial = notes("append only");
    await repository.migrate("/work/project", initial);
    const changedHistory = {
      ...initial,
      phases: [
        {
          ...initial.phases[0]!,
          lifecycleEvents: [
            { ...initial.phases[0]!.lifecycleEvents[0]!, reason: "rewritten" },
            initial.phases[0]!.lifecycleEvents[1]!,
          ],
        },
      ],
    };

    expect(await repository.save("/work/project", 1, changedHistory)).toEqual({
      status: "invalid",
      error: {
        path: "phases[0].lifecycleEvents[0]",
        message: "existing lifecycle events cannot be changed",
      },
    });

    const originalOverrides = initial.phases[0]!.overrides;
    const reconciled = {
      ...initial,
      phases: [
        {
          ...initial.phases[0]!,
          status: "review" as const,
          overrides: originalOverrides,
          lifecycleEvents: [
            ...initial.phases[0]!.lifecycleEvents,
            {
              id: "event-3",
              fromStatus: "in-progress" as const,
              toStatus: "review" as const,
              source: "agent" as const,
              timestamp: "2026-07-25T12:35:00.000Z",
              reason: "Implementation complete",
            },
          ],
        },
      ],
    };

    expect(await repository.save("/work/project", 1, reconciled)).toMatchObject({ status: "ok" });
    expect(await new ProjectNotesRepository(agentDir).load("/work/project")).toMatchObject({
      status: "ok",
      snapshot: { document: { phases: [{ overrides: originalOverrides }] } },
    });
  });

  it("accepts one CAS writer and returns the winner to the stale writer", async () => {
    const agentDir = await tempAgentDir();
    const first = new ProjectNotesRepository(agentDir);
    const second = new ProjectNotesRepository(agentDir);
    await first.migrate("/work/project", notes("base"));

    const outcomes = await Promise.all([
      first.save("/work/project", 1, notes("first")),
      second.save("/work/project", 1, notes("second")),
    ]);
    const success = outcomes.find((outcome) => outcome.status === "ok");
    const conflict = outcomes.find((outcome) => outcome.status === "conflict");

    expect(success?.status).toBe("ok");
    expect(conflict?.status).toBe("conflict");
    if (success?.status === "ok" && conflict?.status === "conflict") {
      expect(conflict.snapshot).toEqual(success.snapshot);
      expect(success.snapshot.revision).toBe(2);
    }
  });
});

function failingSyncFileSystem(destinationToFail: string): {
  fileSystem: ProjectNotesFileSystem;
  failed: boolean;
} {
  const result = {
    failed: false,
    fileSystem: {
      mkdir: (directory, options) => fs.mkdir(directory, options),
      chmod: (filePath, mode) => fs.chmod(filePath, mode),
      readFile: (filePath, encoding) => fs.readFile(filePath, encoding),
      writeFile: (filePath, data, options) => fs.writeFile(filePath, data, options),
      open: async (filePath, flags) => {
        const handle = await fs.open(filePath, flags);
        return {
          sync: async () => {
            if (
              !result.failed &&
              filePath.startsWith(`${destinationToFail}.`) &&
              filePath.endsWith(".tmp")
            ) {
              result.failed = true;
              throw new Error("injected sync failure");
            }
            await handle.sync();
          },
          close: () => handle.close(),
        };
      },
      rename: (from, to) => fs.rename(from, to),
      unlink: (filePath) => fs.unlink(filePath),
    } satisfies ProjectNotesFileSystem,
  };
  return result;
}

function failingRenameFileSystem(destinationToFail: string): {
  fileSystem: ProjectNotesFileSystem;
  failed: boolean;
} {
  const result = {
    failed: false,
    fileSystem: {
      mkdir: (directory, options) => fs.mkdir(directory, options),
      chmod: (filePath, mode) => fs.chmod(filePath, mode),
      readFile: (filePath, encoding) => fs.readFile(filePath, encoding),
      writeFile: (filePath, data, options) => fs.writeFile(filePath, data, options),
      open: (filePath, flags) => fs.open(filePath, flags),
      rename: async (from, to) => {
        if (!result.failed && to === destinationToFail) {
          result.failed = true;
          throw new Error("injected rename failure");
        }
        await fs.rename(from, to);
      },
      unlink: (filePath) => fs.unlink(filePath),
    } satisfies ProjectNotesFileSystem,
  };
  return result;
}
