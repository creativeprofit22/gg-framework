import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RoadmapPhaseDraft } from "@kenkaiiii/gg-core/roadmap-workflow";
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
  type ProjectNotesRoadmapStatusRequest,
  type StoredProjectNotesV1,
} from "./project-notes-repository.js";

const NOW = "2026-07-25T12:34:56.000Z";
const roots: string[] = [];

async function canonicalNotesFixture(): Promise<unknown> {
  return JSON.parse(
    await fs.readFile(new URL("../../../fixtures/project-notes-v3.json", import.meta.url), "utf8"),
  ) as unknown;
}

async function malformedLegacyV3Fixture(): Promise<unknown> {
  return JSON.parse(
    await fs.readFile(
      new URL("../../../fixtures/project-notes-v3-malformed-legacy.json", import.meta.url),
      "utf8",
    ),
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
        reminder: {
          id: "reminder-1",
          occurrenceKey: "occurrence-1",
          dueAt: NOW,
          note: "Review schema",
          createdAt: NOW,
          lastDelivery: null,
        },
        attentionReason: null,
        createdAt: "2026-07-24T10:00:00.000Z",
        updatedAt: NOW,
        completedAt: null,
        archivedAt: null,
        overrides: {
          status: { value: "in-progress", source: "user", updatedAt: NOW },
          referenceIds: { value: ["ref-1"], source: "user", updatedAt: NOW },
        },
        pendingAutomaticLifecycleTransition: null,
        lifecycleEvents: [
          {
            id: "event-1",
            fromStatus: "not-started",
            toStatus: "planning",
            source: "user",
            timestamp: "2026-07-25T12:30:00.000Z",
            reason: "Started planning",
            kind: "other",
          },
          {
            id: "event-2",
            fromStatus: "planning",
            toStatus: "in-progress",
            source: "session",
            timestamp: NOW,
            reason: null,
            kind: "other",
          },
        ],
        roadmapEvents: [],
      },
    ],
  };
}

function approvedPhaseDraft(
  cwd: string,
  basedOnRevision: number,
  phaseIds: string[] = ["approved-phase-1", "approved-phase-2"],
): RoadmapPhaseDraft {
  return {
    id: "draft-1",
    projectKey: canonicalProjectKey(cwd),
    basedOnRevision,
    createdAt: NOW,
    createdBySessionId: "session-draft",
    summary: "Create approved peer phases",
    status: "pending",
    references: [],
    phases: phaseIds.map((phaseId, index) => ({
      phaseId,
      title: `Approved phase ${index + 1}`,
      goal: `Deliver approved goal ${index + 1}.`,
      doneWhen: [`Approved criterion ${index + 1} passes`],
      sourcePrompt: `Implement approved phase ${index + 1} only.`,
      referenceIds: [],
    })),
  };
}

function approvedPhaseDraftWithReference(cwd: string, basedOnRevision: number): RoadmapPhaseDraft {
  const draft = approvedPhaseDraft(cwd, basedOnRevision);
  draft.references = [
    {
      id: "draft-reference-1",
      provider: "github",
      tool: "searchCode",
      canonicalUrl: "https://github.com/KenKaiiii/gg-framework",
      owner: "KenKaiiii",
      repo: "gg-framework",
      revision: "main",
      path: "packages/gg-core/src/roadmap-workflow.ts",
      range: { startLine: 1, endLine: 10 },
      issue: null,
      pullRequest: null,
      query: null,
      anchor: null,
      relevance: "Shared Roadmap contract",
    },
  ];
  draft.phases.forEach((phase) => {
    phase.referenceIds = ["draft-reference-1"];
  });
  return draft;
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

describe("ProjectNotesRepository reminder occurrence contract", () => {
  it("deterministically upgrades legacy v3 reminders without changing their existing fields", async () => {
    const agentDir = await tempAgentDir();
    const cwd = "/work/legacy-reminder";
    const legacy = structuredClone(notes()) as unknown as {
      phases: Array<{ reminder: Record<string, unknown> | null }>;
    };
    const current = legacy.phases[0]!.reminder!;
    delete current.occurrenceKey;
    delete current.lastDelivery;

    expect(validateNotesDocumentV3(legacy)).toMatchObject({
      ok: false,
      error: { path: "phases[0].reminder" },
    });
    await expect(new ProjectNotesRepository(agentDir).migrate(cwd, legacy)).resolves.toMatchObject({
      status: "ok",
      snapshot: {
        document: {
          phases: [
            {
              reminder: {
                id: "reminder-1",
                occurrenceKey: "reminder-1",
                dueAt: NOW,
                note: "Review schema",
                createdAt: NOW,
                lastDelivery: null,
              },
            },
          ],
        },
      },
    });
    await expect(new ProjectNotesRepository(agentDir).load(cwd)).resolves.toMatchObject({
      status: "ok",
      snapshot: {
        revision: 1,
        document: { phases: [{ reminder: { occurrenceKey: "reminder-1", lastDelivery: null } }] },
      },
    });
  });

  it("rejects duplicate reminder IDs during repository migration without creating the store", async () => {
    const repository = new ProjectNotesRepository(await tempAgentDir());
    const cwd = "/work/duplicate-reminder-id";
    const document = notes();
    const secondPhase = structuredClone(document.phases[0]!);
    secondPhase.id = "phase-2";
    secondPhase.order = 1;
    secondPhase.reminder = {
      ...secondPhase.reminder!,
      occurrenceKey: "occurrence-2",
      lastDelivery: null,
    };
    document.phases.push(secondPhase);

    await expect(repository.migrate(cwd, document)).resolves.toEqual({
      status: "invalid",
      error: {
        path: "phases[1].reminder.id",
        message: "duplicate reminder ID; already used at phases[0].reminder.id",
      },
    });
    await expect(repository.load(cwd)).resolves.toEqual({ status: "missing" });
  });

  it("strictly validates bounded reminder notes and nested delivery evidence", () => {
    const valid = notes();
    valid.phases[0]!.reminder!.lastDelivery = {
      occurrenceKey: "occurrence-1",
      attemptedAt: NOW,
      channel: "native",
      permission: "granted",
    };
    expect(validateNotesDocumentV3(valid)).toEqual({ ok: true, document: valid });

    const malformedDelivery = structuredClone(valid) as NotesDocumentV3 & {
      phases: Array<{ reminder: Record<string, unknown> | null }>;
    };
    malformedDelivery.phases[0]!.reminder!.unexpected = true;
    expect(validateNotesDocumentV3(malformedDelivery)).toMatchObject({
      ok: false,
      error: { path: "phases[0].reminder" },
    });

    const invalidChannel = structuredClone(valid) as unknown as {
      phases: Array<{ reminder: { lastDelivery: { channel: string } } }>;
    };
    invalidChannel.phases[0]!.reminder.lastDelivery.channel = "email";
    expect(validateNotesDocumentV3(invalidChannel)).toMatchObject({
      ok: false,
      error: { path: "phases[0].reminder.lastDelivery.channel" },
    });

    const oversized = structuredClone(valid);
    oversized.phases[0]!.reminder!.note = "x".repeat(501);
    expect(validateNotesDocumentV3(oversized)).toMatchObject({
      ok: false,
      error: { path: "phases[0].reminder.note" },
    });
  });

  it("rejects impossible current-v3 delivery evidence before migration persistence", async () => {
    const repository = new ProjectNotesRepository(await tempAgentDir());
    const cwd = "/work/impossible-delivery-migration";
    const invalid = notes();
    invalid.phases[0]!.reminder!.lastDelivery = {
      occurrenceKey: "occurrence-1",
      attemptedAt: NOW,
      channel: "native",
      permission: "denied",
    };

    await expect(repository.migrate(cwd, invalid)).resolves.toEqual({
      status: "invalid",
      error: {
        path: "phases[0].reminder.lastDelivery.permission",
        message: "permission does not match delivery channel",
      },
    });
    await expect(repository.load(cwd)).resolves.toEqual({ status: "missing" });
  });

  it("allows create, reschedule, and dismiss while keeping delivery evidence repository-owned", async () => {
    const repository = new ProjectNotesRepository(await tempAgentDir());
    const cwd = "/work/reminder-authority";
    const initial = notes();
    await repository.migrate(cwd, initial);

    const forged = structuredClone(initial);
    forged.phases[0]!.reminder!.lastDelivery = {
      occurrenceKey: "occurrence-1",
      attemptedAt: NOW,
      channel: "in-app",
      permission: "not-required",
    };
    await expect(repository.save(cwd, 1, forged)).resolves.toEqual({
      status: "invalid",
      error: {
        path: "phases[0].reminder.lastDelivery",
        message: "delivery evidence is repository-owned",
      },
    });

    const rescheduled = structuredClone(initial);
    rescheduled.phases[0]!.reminder = {
      ...rescheduled.phases[0]!.reminder!,
      occurrenceKey: "occurrence-2",
      dueAt: "2026-07-26T12:34:56.000Z",
      createdAt: "2026-07-25T13:00:00.000Z",
    };
    await expect(repository.save(cwd, 1, rescheduled)).resolves.toMatchObject({
      status: "ok",
      snapshot: { revision: 2 },
    });

    const dismissed = structuredClone(rescheduled);
    dismissed.phases[0]!.reminder = null;
    await expect(repository.save(cwd, 2, dismissed)).resolves.toMatchObject({
      status: "ok",
      snapshot: { revision: 3 },
    });

    const recreated = structuredClone(dismissed);
    recreated.phases[0]!.reminder = {
      id: "reminder-2",
      occurrenceKey: "occurrence-3",
      dueAt: "2026-07-27T12:34:56.000Z",
      note: "Try again",
      createdAt: "2026-07-25T14:00:00.000Z",
      lastDelivery: null,
    };
    await expect(repository.save(cwd, 3, recreated)).resolves.toMatchObject({
      status: "ok",
      snapshot: { revision: 4, document: recreated },
    });
  });
});

describe("ProjectNotesRepository reminder delivery claims", () => {
  it("records one durable revision under concurrent claims and does not replay after restart", async () => {
    const agentDir = await tempAgentDir();
    const cwd = "/work/concurrent-reminder-claim";
    await new ProjectNotesRepository(agentDir).migrate(cwd, notes());
    const request = {
      phaseId: "phase-1",
      occurrenceKey: "occurrence-1",
      attemptedAt: NOW,
      channel: "in-app" as const,
      permission: "not-required" as const,
    };

    const [first, second] = await Promise.all([
      new ProjectNotesRepository(agentDir).recordReminderDelivery(cwd, request),
      new ProjectNotesRepository(agentDir).recordReminderDelivery(cwd, request),
    ]);
    expect(new Set([first.status, second.status])).toEqual(new Set(["ok", "already-delivered"]));

    const restarted = new ProjectNotesRepository(agentDir);
    await expect(restarted.load(cwd)).resolves.toMatchObject({
      status: "ok",
      snapshot: {
        revision: 2,
        document: {
          phases: [
            {
              reminder: {
                occurrenceKey: "occurrence-1",
                lastDelivery: {
                  occurrenceKey: "occurrence-1",
                  attemptedAt: NOW,
                  channel: "in-app",
                  permission: "not-required",
                },
              },
            },
          ],
        },
      },
    });
    await expect(restarted.recordReminderDelivery(cwd, request)).resolves.toEqual({
      status: "already-delivered",
    });
  });

  it.each([
    ["archived", { archivedAt: NOW }, "phase-archived"],
    ["done", { status: "done", completedAt: NOW }, "phase-inactive"],
    ["cancelled", { status: "cancelled", completedAt: NOW }, "phase-inactive"],
    ["missing reminder", { reminder: null }, "reminder-not-found"],
  ] as const)(
    "rejects a %s phase without changing its stored reminder",
    async (_label, patch, status) => {
      const agentDir = await tempAgentDir();
      const cwd = `/work/reminder-${status}-${Math.random()}`;
      const initial = notes();
      Object.assign(initial.phases[0]!, patch);
      initial.phases[0]!.overrides.status = null;
      initial.phases[0]!.lifecycleEvents = [];
      await new ProjectNotesRepository(agentDir).migrate(cwd, initial);
      const repository = new ProjectNotesRepository(agentDir);

      await expect(
        repository.recordReminderDelivery(cwd, {
          phaseId: "phase-1",
          occurrenceKey: "occurrence-1",
          attemptedAt: NOW,
          channel: "native",
          permission: "granted",
        }),
      ).resolves.toEqual({ status });
      await expect(repository.load(cwd)).resolves.toMatchObject({
        status: "ok",
        snapshot: { revision: 1 },
      });
    },
  );

  it("rejects missing, stale, not-due, and incoherent delivery requests", async () => {
    const repository = new ProjectNotesRepository(await tempAgentDir());
    const cwd = "/work/reminder-guards";
    const initial = notes();
    initial.phases[0]!.reminder!.dueAt = "2026-07-26T12:34:56.000Z";
    await repository.migrate(cwd, initial);

    const base = {
      phaseId: "phase-1",
      occurrenceKey: "occurrence-1",
      attemptedAt: NOW,
      channel: "native" as const,
      permission: "granted" as const,
    };
    await expect(
      repository.recordReminderDelivery(cwd, { ...base, phaseId: "missing" }),
    ).resolves.toEqual({ status: "phase-not-found" });
    await expect(
      repository.recordReminderDelivery(cwd, { ...base, occurrenceKey: "stale" }),
    ).resolves.toEqual({ status: "stale-occurrence" });
    await expect(repository.recordReminderDelivery(cwd, base)).resolves.toEqual({
      status: "not-due",
    });
    await expect(
      repository.recordReminderDelivery(cwd, {
        ...base,
        channel: "in-app",
        permission: "granted",
      }),
    ).resolves.toMatchObject({
      status: "invalid",
      error: { path: "permission" },
    });
    await expect(repository.load(cwd)).resolves.toMatchObject({
      status: "ok",
      snapshot: { revision: 1 },
    });
  });

  it("persists unavailable platform evidence only for in-app fallback delivery", async () => {
    const repository = new ProjectNotesRepository(await tempAgentDir());
    const cwd = "/work/reminder-unavailable";
    await repository.migrate(cwd, notes());

    await expect(
      repository.recordReminderDelivery(cwd, {
        phaseId: "phase-1",
        occurrenceKey: "occurrence-1",
        attemptedAt: NOW,
        channel: "in-app-fallback",
        permission: "unavailable",
      }),
    ).resolves.toMatchObject({
      status: "ok",
      snapshot: {
        revision: 2,
        document: {
          phases: [
            {
              reminder: {
                lastDelivery: { channel: "in-app-fallback", permission: "unavailable" },
              },
            },
          ],
        },
      },
    });
  });

  it("keeps the occurrence retryable after storage failure and can claim from backup recovery", async () => {
    const agentDir = await tempAgentDir();
    const cwd = "/work/reminder-storage-failure";
    const initialRepository = new ProjectNotesRepository(agentDir);
    await initialRepository.migrate(cwd, notes());
    const paths = initialRepository.paths(cwd);
    const injected = failingRenameFileSystem(paths.primary);
    const request = {
      phaseId: "phase-1",
      occurrenceKey: "occurrence-1",
      attemptedAt: NOW,
      channel: "in-app-fallback" as const,
      permission: "denied" as const,
    };

    await expect(
      new ProjectNotesRepository(agentDir, {
        fileSystem: injected.fileSystem,
      }).recordReminderDelivery(cwd, request),
    ).rejects.toThrow("injected rename failure");
    await expect(new ProjectNotesRepository(agentDir).load(cwd)).resolves.toMatchObject({
      status: "ok",
      snapshot: { revision: 1, document: { phases: [{ reminder: { lastDelivery: null } }] } },
    });

    await fs.writeFile(paths.primary, "{broken", "utf8");
    await expect(
      new ProjectNotesRepository(agentDir).recordReminderDelivery(cwd, request),
    ).resolves.toMatchObject({
      status: "ok",
      snapshot: { revision: 2 },
    });
    await expect(new ProjectNotesRepository(agentDir).load(cwd)).resolves.toMatchObject({
      status: "ok",
      recoveredFromBackup: false,
      snapshot: {
        revision: 2,
        document: {
          phases: [
            {
              reminder: {
                lastDelivery: { channel: "in-app-fallback", permission: "denied" },
              },
            },
          ],
        },
      },
    });
  });
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

  it.each(["planning", "waiting-for-approval", "in-progress"] as const)(
    "starts and binds an unbound manually active %s phase",
    async (status) => {
      const agentDir = await tempAgentDir();
      const cwd = path.join(agentDir, `manual-active-${status}`);
      const document = notes();
      document.phases[0]!.status = status;
      document.phases[0]!.session = null;
      document.phases[0]!.overrides.status = { value: status, source: "user", updatedAt: NOW };
      document.phases[0]!.lifecycleEvents = [];
      const repository = new ProjectNotesRepository(agentDir);
      await expect(repository.migrate(cwd, document)).resolves.toMatchObject({ status: "ok" });

      const launched = await repository.launchPhase(cwd, "phase-1", async (frozen) => {
        expect(frozen.phase).toMatchObject({ status, session: null });
        return {
          sessionId: `started-${status}`,
          sessionPath: `/sessions/started-${status}.jsonl`,
        };
      });

      expect(launched).toMatchObject({
        status: "accepted",
        snapshot: { revision: 2 },
        phase: {
          status,
          session: {
            sessionId: `started-${status}`,
            sessionPath: `/sessions/started-${status}.jsonl`,
          },
          overrides: { status: { value: status, source: "user" } },
        },
      });
      await expect(repository.load(cwd)).resolves.toMatchObject({
        status: "ok",
        snapshot: {
          revision: 2,
          document: {
            phases: [
              {
                status,
                session: { sessionId: `started-${status}` },
              },
            ],
          },
        },
      });
    },
  );

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

  it("rejects a terminal Done phase before candidate creation and leaves its binding untouched", async () => {
    const agentDir = await tempAgentDir();
    const cwd = path.join(agentDir, "done-launch");
    const document = notes();
    const originalSession = { ...document.phases[0]!.session! };
    document.phases[0]!.status = "done";
    document.phases[0]!.completedAt = NOW;
    document.phases[0]!.overrides.status = null;
    document.phases[0]!.lifecycleEvents.push({
      id: "event-done",
      fromStatus: "in-progress",
      toStatus: "done",
      source: "user",
      timestamp: NOW,
      reason: "Completion review accepted",
      kind: "other",
    });
    const repository = new ProjectNotesRepository(agentDir);
    await repository.migrate(cwd, document);
    let createCalls = 0;

    await expect(
      repository.launchPhase(cwd, "phase-1", async () => {
        createCalls += 1;
        return { sessionId: "stale", sessionPath: "/sessions/stale.jsonl" };
      }),
    ).resolves.toEqual({ status: "done-terminal" });

    expect(createCalls).toBe(0);
    await expect(repository.load(cwd)).resolves.toMatchObject({
      status: "ok",
      snapshot: {
        revision: 1,
        document: { phases: [{ status: "done", session: originalSession }] },
      },
    });
  });

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
    await expect(
      repository.updatePhaseSessionLink(
        cwd,
        "phase-1",
        { sessionId: "wrong-owner", sessionPath: "/sessions/wrong.jsonl" },
        { sessionId: "stale-owner", sessionPath: "/sessions/stale.jsonl" },
      ),
    ).resolves.toEqual({ status: "stale-session" });
    expect(await repository.load(cwd)).toMatchObject({
      status: "ok",
      snapshot: { document: { phases: [{ session: { sessionId: "checkpoint" } }] } },
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

describe("ProjectNotesRepository phase binding compare-and-swap", () => {
  const sessionA = { sessionId: "session-a", sessionPath: "/sessions/a.jsonl" };
  const sessionB = { sessionId: "session-b", sessionPath: "/sessions/b.jsonl" };

  async function bindingRepository(name: string, session: typeof sessionA | null) {
    const agentDir = await tempAgentDir();
    const cwd = path.join(agentDir, name);
    const document = notes();
    document.phases[0]!.session = session;
    document.phases[0]!.overrides.status = null;
    await new ProjectNotesRepository(agentDir).migrate(cwd, document);
    return { cwd, repository: new ProjectNotesRepository(agentDir) };
  }

  function request(cwd: string, overrides: Record<string, unknown> = {}) {
    return {
      action: "rebind-current" as const,
      phaseId: "phase-1",
      expectedProjectKey: canonicalProjectKey(cwd),
      expectedRevision: 1,
      expectedPreviousSession: sessionA,
      operationId: "binding-operation-1",
      destinationSession: sessionB,
      timestamp: "2026-07-25T12:35:00.000Z",
      ...overrides,
    };
  }

  it("binds an unbound phase once and returns duplicate on replay", async () => {
    const { cwd, repository } = await bindingRepository("bind-unbound", null);
    const bind = request(cwd, {
      action: "bind-current",
      expectedPreviousSession: null,
      destinationSession: sessionA,
    });

    await expect(repository.bindPhaseToCurrentSession(cwd, bind)).resolves.toMatchObject({
      status: "committed",
      revision: 2,
      previousSession: null,
      session: sessionA,
    });
    await expect(repository.bindPhaseToCurrentSession(cwd, bind)).resolves.toMatchObject({
      status: "duplicate",
      revision: 2,
    });
    const loaded = await repository.load(cwd);
    expect(loaded).toMatchObject({
      status: "ok",
      snapshot: {
        revision: 2,
        document: {
          phases: [
            {
              session: sessionA,
              roadmapEvents: [
                expect.objectContaining({
                  type: "phase-binding",
                  id: "binding-operation-1",
                  action: "bind-current",
                  previousSession: null,
                  session: sessionA,
                }),
              ],
            },
          ],
        },
      },
    });
  });

  it("serializes duplicate concurrent delivery into one revision", async () => {
    const { cwd, repository } = await bindingRepository("bind-concurrent", null);
    const bind = request(cwd, {
      action: "bind-current",
      expectedPreviousSession: null,
      destinationSession: sessionA,
    });

    const outcomes = await Promise.all([
      repository.bindPhaseToCurrentSession(cwd, bind),
      repository.bindPhaseToCurrentSession(cwd, bind),
    ]);
    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(["committed", "duplicate"]);
    await expect(repository.load(cwd)).resolves.toMatchObject({
      status: "ok",
      snapshot: { revision: 2 },
    });
  });

  it("fails closed for stale revision, project, previous link, and operation conflicts", async () => {
    const { cwd, repository } = await bindingRepository("rebind-guards", sessionA);

    await expect(
      repository.bindPhaseToCurrentSession(cwd, request(cwd, { expectedRevision: 0 })),
    ).resolves.toEqual({ status: "stale-revision", revision: 1 });
    await expect(
      repository.bindPhaseToCurrentSession(cwd, request(cwd, { expectedProjectKey: "/wrong" })),
    ).resolves.toMatchObject({ status: "project-mismatch", revision: 1 });
    await expect(
      repository.bindPhaseToCurrentSession(
        cwd,
        request(cwd, {
          expectedPreviousSession: {
            sessionId: "session-stale",
            sessionPath: "/sessions/stale.jsonl",
          },
        }),
      ),
    ).resolves.toEqual({
      status: "stale-previous-session",
      revision: 1,
      currentSession: sessionA,
    });

    const committed = await repository.bindPhaseToCurrentSession(cwd, request(cwd));
    expect(committed.status).toBe("committed");
    await expect(
      repository.bindPhaseToCurrentSession(
        cwd,
        request(cwd, { destinationSession: { ...sessionB, sessionId: "conflict" } }),
      ),
    ).resolves.toEqual({ status: "duplicate-id-conflict", revision: 2 });
  });

  it("rejects archived, terminal, and non-persistent destination sessions", async () => {
    const archived = await bindingRepository("bind-archived", sessionA);
    const archivedLoad = await archived.repository.load(archived.cwd);
    if (archivedLoad.status !== "ok") throw new Error("Expected archived fixture");
    const archivedDocument = structuredClone(archivedLoad.snapshot.document);
    archivedDocument.phases[0]!.archivedAt = "2026-07-25T12:36:00.000Z";
    await archived.repository.save(archived.cwd, 1, archivedDocument);
    await expect(
      archived.repository.bindPhaseToCurrentSession(
        archived.cwd,
        request(archived.cwd, { expectedRevision: 2 }),
      ),
    ).resolves.toEqual({ status: "phase-archived" });

    const terminal = await bindingRepository("bind-terminal", sessionA);
    const terminalLoad = await terminal.repository.load(terminal.cwd);
    if (terminalLoad.status !== "ok") throw new Error("Expected terminal fixture");
    const terminalDocument = structuredClone(terminalLoad.snapshot.document);
    const donePhase = terminalDocument.phases[0]!;
    donePhase.status = "done";
    donePhase.completedAt = "2026-07-25T12:36:00.000Z";
    donePhase.updatedAt = donePhase.completedAt;
    donePhase.overrides.status = {
      value: "done",
      source: "user",
      updatedAt: donePhase.completedAt,
    };
    donePhase.lifecycleEvents.push({
      id: "manual-done-binding-fixture",
      fromStatus: "in-progress",
      toStatus: "done",
      source: "user",
      timestamp: donePhase.completedAt,
      reason: "Status changed by user",
      kind: "other",
    });
    terminalDocument.updatedAt = donePhase.completedAt;
    const doneAgentDir = await tempAgentDir();
    const doneCwd = path.join(doneAgentDir, "bind-terminal-migrated");
    const doneRepository = new ProjectNotesRepository(doneAgentDir);
    await expect(doneRepository.migrate(doneCwd, terminalDocument)).resolves.toMatchObject({
      status: "ok",
      snapshot: { revision: 1 },
    });
    await expect(
      doneRepository.bindPhaseToCurrentSession(doneCwd, request(doneCwd, { expectedRevision: 1 })),
    ).resolves.toEqual({ status: "phase-terminal" });

    await expect(
      doneRepository.bindPhaseToCurrentSession(
        doneCwd,
        request(doneCwd, {
          expectedRevision: 1,
          destinationSession: { sessionId: "ephemeral", sessionPath: null },
        }),
      ),
    ).resolves.toEqual({ status: "missing-session-path" });
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
    const protectedOutcome = await repository.recordPhaseLifecycleTransition(cwd, "phase-1", {
      ...transition,
      status: "in-progress",
    });
    expect(protectedOutcome).toMatchObject({
      status: "manual-override",
      snapshot: { revision: savedOverride.snapshot.revision + 1 },
      phase: {
        status: "review",
        pendingAutomaticLifecycleTransition: {
          status: "in-progress",
          source: "agent",
          reason: "Implementation verification started",
          kind: "other",
          timestamp: transition.timestamp,
          expectedSession: transition.expectedSession,
        },
      },
    });
    if (protectedOutcome.status !== "manual-override") {
      throw new Error("Expected protected lifecycle transition");
    }

    const resetDocument = structuredClone(protectedOutcome.snapshot.document);
    resetDocument.phases[0]!.overrides.status = null;
    resetDocument.phases[0]!.pendingAutomaticLifecycleTransition = null;
    resetDocument.phases[0]!.status = "in-progress";
    resetDocument.phases[0]!.lifecycleEvents.push({
      id: "automatic-resumed",
      fromStatus: "review",
      toStatus: "in-progress",
      source: "agent",
      timestamp: "2026-07-25T12:42:00.000Z",
      reason: "Implementation verification started",
      kind: "other",
    });
    resetDocument.phases[0]!.roadmapEvents.push({
      type: "override-reset",
      id: "manual-reset",
      field: "status",
      timestamp: "2026-07-25T12:42:00.000Z",
    });
    const savedReset = await repository.save(
      cwd,
      protectedOutcome.snapshot.revision,
      resetDocument,
    );
    if (savedReset.status !== "ok") throw new Error("Expected override reset save");

    const doneDocument = structuredClone(savedReset.snapshot.document);
    doneDocument.phases[0]!.status = "done";
    doneDocument.phases[0]!.completedAt = "2026-07-25T12:43:00.000Z";
    doneDocument.phases[0]!.lifecycleEvents.push({
      id: "manual-done",
      fromStatus: "in-progress",
      toStatus: "done",
      source: "user",
      timestamp: "2026-07-25T12:43:00.000Z",
      reason: "Marked done by user",
      kind: "other",
    });
    await expect(
      repository.save(cwd, savedReset.snapshot.revision, doneDocument),
    ).resolves.toMatchObject({
      status: "invalid",
      error: { path: "phases[0].status" },
    });
  });

  it("persists, replaces, and restores the latest suppressed target without accepting a stale session", async () => {
    const { agentDir, cwd, repository } = await createLifecycleRepository("pending-lifecycle");
    const loaded = await repository.load(cwd);
    if (loaded.status !== "ok") throw new Error("Expected lifecycle Notes");
    const overridden = structuredClone(loaded.snapshot.document);
    overridden.phases[0]!.overrides.status = {
      value: overridden.phases[0]!.status,
      source: "user",
      updatedAt: "2026-07-25T12:40:00.000Z",
    };
    const savedOverride = await repository.save(cwd, loaded.snapshot.revision, overridden);
    if (savedOverride.status !== "ok") throw new Error("Expected override save");

    await expect(
      repository.recordPhaseLifecycleTransition(cwd, "phase-1", {
        status: "in-progress",
        source: "user",
        reason: "Plan approved by user",
        kind: "approval-resolved",
        timestamp: "2026-07-25T12:41:00.000Z",
        expectedSession: { sessionId: "stale", sessionPath: null },
      }),
    ).resolves.toEqual({ status: "stale-session" });

    const expectedSession = { sessionId: "session-1", sessionPath: "/sessions/one.jsonl" };
    const approved = await repository.recordPhaseLifecycleTransition(cwd, "phase-1", {
      status: "in-progress",
      source: "user",
      reason: "Plan approved by user",
      kind: "approval-resolved",
      timestamp: "2026-07-25T12:41:00.000Z",
      expectedSession,
    });
    expect(approved).toMatchObject({
      status: "manual-override",
      snapshot: { revision: savedOverride.snapshot.revision + 1 },
      phase: {
        status: "in-progress",
        pendingAutomaticLifecycleTransition: {
          status: "in-progress",
          source: "user",
          reason: "Plan approved by user",
          kind: "approval-resolved",
          expectedSession,
        },
      },
    });
    if (approved.status !== "manual-override") throw new Error("Expected approval marker");
    await expect(
      repository.recordPhaseLifecycleTransition(cwd, "phase-1", {
        status: "in-progress",
        source: "user",
        reason: "Plan approved by user",
        kind: "approval-resolved",
        timestamp: "2026-07-25T12:41:30.000Z",
        expectedSession,
      }),
    ).resolves.toMatchObject({
      status: "manual-override",
      snapshot: { revision: approved.snapshot.revision },
      phase: {
        pendingAutomaticLifecycleTransition: { timestamp: "2026-07-25T12:41:00.000Z" },
      },
    });

    const reviewing = await repository.recordPhaseLifecycleTransition(cwd, "phase-1", {
      status: "review",
      source: "agent",
      reason: "Autopilot review started",
      kind: "other",
      timestamp: "2026-07-25T12:42:00.000Z",
      expectedSession,
    });
    expect(reviewing).toMatchObject({
      status: "manual-override",
      phase: {
        status: "in-progress",
        pendingAutomaticLifecycleTransition: {
          status: "review",
          source: "agent",
          reason: "Autopilot review started",
          kind: "other",
          timestamp: "2026-07-25T12:42:00.000Z",
          expectedSession,
        },
      },
    });
    if (reviewing.status !== "manual-override") throw new Error("Expected reviewing marker");
    expect(reviewing.phase.lifecycleEvents).toHaveLength(2);

    const restarted = await new ProjectNotesRepository(agentDir).load(cwd);
    expect(restarted).toMatchObject({
      status: "ok",
      snapshot: {
        revision: reviewing.snapshot.revision,
        document: {
          phases: [
            {
              pendingAutomaticLifecycleTransition: {
                status: "review",
                reason: "Autopilot review started",
              },
            },
          ],
        },
      },
    });
    if (restarted.status !== "ok") throw new Error("Expected restarted pending lifecycle");
    const reset = structuredClone(restarted.snapshot.document);
    const resetPhase = reset.phases[0]!;
    resetPhase.status = "review";
    resetPhase.overrides.status = null;
    resetPhase.pendingAutomaticLifecycleTransition = null;
    resetPhase.updatedAt = "2026-07-25T12:43:00.000Z";
    resetPhase.lifecycleEvents.push({
      id: "resume-reviewing",
      fromStatus: "in-progress",
      toStatus: "review",
      source: "agent",
      timestamp: "2026-07-25T12:43:00.000Z",
      reason: "Autopilot review started",
      kind: "other",
    });
    resetPhase.roadmapEvents.push({
      type: "override-reset",
      id: "resume-automatic-status",
      field: "status",
      timestamp: "2026-07-25T12:43:00.000Z",
    });
    reset.updatedAt = "2026-07-25T12:43:00.000Z";
    await expect(repository.save(cwd, restarted.snapshot.revision, reset)).resolves.toMatchObject({
      status: "ok",
      snapshot: {
        document: {
          phases: [
            {
              status: "review",
              overrides: { status: null },
              pendingAutomaticLifecycleTransition: null,
              lifecycleEvents: [
                expect.any(Object),
                expect.any(Object),
                expect.objectContaining({
                  id: "resume-reviewing",
                  source: "agent",
                  reason: "Autopilot review started",
                }),
              ],
            },
          ],
        },
      },
    });
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

describe("ProjectNotesRepository roadmap status reconciliation", () => {
  function roadmapDocument(): NotesDocumentV3 {
    const document = notes("roadmap status");
    const phase = document.phases[0]!;
    phase.status = "not-started";
    phase.attentionReason = null;
    phase.session = { sessionId: "session-roadmap", sessionPath: "/sessions/roadmap.jsonl" };
    phase.overrides = { status: null, referenceIds: null };
    phase.lifecycleEvents = [];
    phase.roadmapEvents = [];
    phase.referenceIds = [];
    document.references = [];
    return document;
  }

  it.each([
    ["pending", "planning"],
    ["in-progress", "in-progress"],
    ["blocked", "needs-attention"],
    ["review", "review"],
  ] as const)("maps %s without any automatic Done path", async (transition, expectedStatus) => {
    const repository = new ProjectNotesRepository(await tempAgentDir());
    const cwd = `/work/roadmap-${transition}`;
    await repository.migrate(cwd, roadmapDocument());
    const outcome = await repository.recordRoadmapStatusUpdate(cwd, {
      updateId: `update-${transition}`,
      phaseId: "phase-1",
      actor: "gg-coder",
      transition,
      progress: `Progress for ${transition}`,
      blocker: transition === "blocked" ? "CI is unavailable" : null,
      requiredExternalAction: transition === "blocked" ? "Restore CI access" : null,
      evidence: transition === "review" ? ["Round-trip passes", "Malformed data is rejected"] : [],
      verification: transition === "review" ? "passed" : null,
      verificationReason: null,
      proposedReferences: [],
      timestamp: NOW,
      expectedSession: { sessionId: "session-roadmap", sessionPath: "/sessions/roadmap.jsonl" },
      requireBoundPhase: true,
      autopilotEnabled: false,
    });

    expect(outcome).toMatchObject({
      status: "committed",
      statusOutcome: "applied",
      phase: { status: expectedStatus },
      snapshot: { revision: 2 },
    });
    if (outcome.status === "committed") expect(outcome.phase.status).not.toBe("done");
  });

  it("gates GG Coder Done intent on complete passed evidence and preserves retries", async () => {
    const repository = new ProjectNotesRepository(await tempAgentDir());
    const cwd = "/work/roadmap-verification-gate";
    const document = roadmapDocument();
    const phase = document.phases[0]!;
    phase.status = "in-progress";
    phase.doneWhen = ["Focused tests pass", "Package build passes"];
    await repository.migrate(cwd, document);
    const expectedSession = {
      sessionId: "session-roadmap",
      sessionPath: "/sessions/roadmap.jsonl",
    };

    const failed = await repository.recordRoadmapStatusUpdate(cwd, {
      updateId: "verification-failed",
      phaseId: "phase-1",
      expectedRevision: 1,
      actor: "gg-coder",
      transition: "in-progress",
      progress: "Focused tests still fail",
      blocker: null,
      requiredExternalAction: null,
      evidence: ["pnpm test: one failure"],
      verification: "failed",
      verificationReason: "The focused test command reports one failing assertion.",
      proposedReferences: [],
      timestamp: NOW,
      expectedSession,
      requireBoundPhase: true,
      autopilotEnabled: false,
    });
    expect(failed).toMatchObject({
      status: "committed",
      phase: { status: "in-progress" },
      snapshot: { revision: 2 },
    });

    const passingRequest: ProjectNotesRoadmapStatusRequest = {
      updateId: "verification-passed",
      phaseId: "phase-1",
      expectedRevision: 2,
      actor: "gg-coder",
      transition: "done",
      progress: "All completion checks pass",
      blocker: null,
      requiredExternalAction: null,
      evidence: ["pnpm test: passed", "pnpm build: passed"],
      verification: "passed",
      verificationReason: null,
      proposedReferences: [],
      timestamp: "2026-07-25T12:01:00.000Z",
      expectedSession,
      requireBoundPhase: true,
      autopilotEnabled: false,
    };
    await expect(
      repository.recordRoadmapStatusUpdate(cwd, {
        ...passingRequest,
        updateId: "verification-missing",
        evidence: ["pnpm test: passed"],
      }),
    ).resolves.toEqual({
      status: "verification-incomplete",
      revision: 2,
      message: "Done requires exactly one evidence item per Done When criterion.",
    });
    await expect(
      repository.recordRoadmapStatusUpdate(cwd, {
        ...passingRequest,
        updateId: "verification-exception",
        verification: "exception-requested",
        verificationReason: "The native runner is unavailable.",
      }),
    ).resolves.toEqual({
      status: "verification-incomplete",
      revision: 2,
      message: "Done requires a passed verification result.",
    });

    const passed = await repository.recordRoadmapStatusUpdate(cwd, passingRequest);
    expect(passed).toMatchObject({
      status: "committed",
      phase: { status: "in-progress" },
      statusOutcome: "completion-pending",
      snapshot: { revision: 3 },
    });
    await expect(repository.recordRoadmapStatusUpdate(cwd, passingRequest)).resolves.toMatchObject({
      status: "duplicate",
      revision: 3,
      phase: { status: "in-progress" },
      statusOutcome: "completion-pending",
    });
    await expect(
      repository.recordRoadmapStatusUpdate(cwd, {
        ...passingRequest,
        updateId: "verification-stale-session",
        expectedRevision: 3,
        expectedSession: { sessionId: "stale", sessionPath: "/sessions/stale.jsonl" },
      }),
    ).resolves.toEqual({ status: "stale-session" });
  });

  it("persists an explicit blocker, resumes automatically, and protects user resolution", async () => {
    const agentDir = await tempAgentDir();
    const repository = new ProjectNotesRepository(agentDir);
    const cwd = "/work/roadmap-blocker";
    const expectedSession = {
      sessionId: "session-roadmap",
      sessionPath: "/sessions/roadmap.jsonl",
    };
    await repository.migrate(cwd, roadmapDocument());
    const blockedRequest: ProjectNotesRoadmapStatusRequest = {
      updateId: "blocked-by-access",
      phaseId: "phase-1",
      expectedRevision: 1,
      actor: "gg-coder",
      transition: "blocked",
      progress: "Repository access is required before implementation can continue",
      blocker: "The private repository cannot be read.",
      requiredExternalAction: "Grant this session read access to the private repository.",
      evidence: [],
      verification: null,
      verificationReason: null,
      proposedReferences: [],
      timestamp: "2026-07-25T13:00:00.000Z",
      expectedSession,
      requireBoundPhase: true,
      autopilotEnabled: false,
    };

    await expect(repository.recordRoadmapStatusUpdate(cwd, blockedRequest)).resolves.toMatchObject({
      status: "committed",
      statusOutcome: "applied",
      snapshot: { revision: 2 },
      phase: {
        status: "needs-attention",
        attentionReason: blockedRequest.blocker,
        roadmapEvents: [
          expect.objectContaining({
            id: "blocked-by-access",
            transition: "blocked",
            blocker: blockedRequest.blocker,
            requiredExternalAction: blockedRequest.requiredExternalAction,
          }),
        ],
      },
    });
    await expect(repository.recordRoadmapStatusUpdate(cwd, blockedRequest)).resolves.toEqual(
      expect.objectContaining({ status: "duplicate", revision: 2 }),
    );
    await expect(
      repository.recordRoadmapStatusUpdate(cwd, {
        ...blockedRequest,
        progress: "Conflicting retry",
      }),
    ).resolves.toEqual({ status: "duplicate-id-conflict", revision: 2 });
    await expect(
      repository.recordRoadmapStatusUpdate(cwd, {
        ...blockedRequest,
        updateId: "stale-blocker",
      }),
    ).resolves.toEqual({ status: "stale-revision", revision: 2 });
    await expect(
      repository.recordRoadmapStatusUpdate(cwd, {
        ...blockedRequest,
        updateId: "wrong-session-blocker",
        expectedRevision: 2,
        expectedSession: { sessionId: "wrong-session", sessionPath: null },
      }),
    ).resolves.toEqual({ status: "stale-session" });

    const restartedRepository = new ProjectNotesRepository(agentDir);
    await expect(restartedRepository.load(cwd)).resolves.toMatchObject({
      status: "ok",
      snapshot: {
        revision: 2,
        document: {
          phases: [
            expect.objectContaining({
              status: "needs-attention",
              attentionReason: blockedRequest.blocker,
              roadmapEvents: [expect.objectContaining({ id: "blocked-by-access" })],
            }),
          ],
        },
      },
    });

    const resumed = await restartedRepository.recordRoadmapStatusUpdate(cwd, {
      ...blockedRequest,
      updateId: "access-restored",
      expectedRevision: 2,
      transition: "in-progress",
      progress: "Repository access is restored and implementation resumed",
      blocker: null,
      requiredExternalAction: null,
      timestamp: "2026-07-25T13:01:00.000Z",
    });
    expect(resumed).toMatchObject({
      status: "committed",
      statusOutcome: "applied",
      snapshot: { revision: 3 },
      phase: { status: "in-progress", attentionReason: null },
    });
    if (resumed.status !== "committed") throw new Error("Expected automatic blocker resume");

    const reblocked = await restartedRepository.recordRoadmapStatusUpdate(cwd, {
      ...blockedRequest,
      updateId: "second-access-blocker",
      expectedRevision: 3,
      timestamp: "2026-07-25T13:02:00.000Z",
    });
    if (reblocked.status !== "committed") throw new Error("Expected second blocker");
    const resolvedDocument = structuredClone(reblocked.snapshot.document);
    const resolvedPhase = resolvedDocument.phases[0]!;
    resolvedPhase.status = "in-progress";
    resolvedPhase.attentionReason = null;
    resolvedPhase.updatedAt = "2026-07-25T13:03:00.000Z";
    resolvedPhase.overrides.status = {
      value: "in-progress",
      source: "user",
      updatedAt: "2026-07-25T13:03:00.000Z",
    };
    resolvedPhase.lifecycleEvents.push({
      id: "user-resolved-blocker",
      fromStatus: "needs-attention",
      toStatus: "in-progress",
      source: "user",
      timestamp: "2026-07-25T13:03:00.000Z",
      reason: "Status changed by user",
      kind: "other",
    });
    resolvedDocument.updatedAt = "2026-07-25T13:03:00.000Z";
    const userResolved = await restartedRepository.save(
      cwd,
      reblocked.snapshot.revision,
      resolvedDocument,
    );
    if (userResolved.status !== "ok") throw new Error("Expected user resolution save");

    await expect(
      restartedRepository.recordRoadmapStatusUpdate(cwd, {
        ...blockedRequest,
        updateId: "agent-cannot-reblock-user-resolution",
        expectedRevision: userResolved.snapshot.revision,
        timestamp: "2026-07-25T13:04:00.000Z",
      }),
    ).resolves.toMatchObject({
      status: "committed",
      statusOutcome: "manual-override",
      phase: {
        status: "in-progress",
        attentionReason: null,
        overrides: { status: { value: "in-progress", source: "user" } },
        roadmapEvents: expect.arrayContaining([
          expect.objectContaining({ id: "agent-cannot-reblock-user-resolution" }),
        ]),
      },
    });
  });

  it("keeps retries idempotent, rejects conflicting IDs, and preserves a status override", async () => {
    const repository = new ProjectNotesRepository(await tempAgentDir());
    const document = roadmapDocument();
    document.phases[0]!.overrides.status = {
      value: "not-started",
      source: "user",
      updatedAt: NOW,
    };
    await repository.migrate("/work/roadmap-duplicates", document);
    const request = {
      updateId: "update-stable",
      phaseId: "phase-1",
      actor: "ken" as const,
      transition: "in-progress" as const,
      progress: "Implementation is underway",
      blocker: null,
      requiredExternalAction: null,
      evidence: [],
      verification: null,
      verificationReason: null,
      proposedReferences: [],
      timestamp: NOW,
      expectedRevision: 1,
      autopilotEnabled: false,
    };

    await expect(
      repository.recordRoadmapStatusUpdate("/work/roadmap-duplicates", request),
    ).resolves.toMatchObject({
      status: "committed",
      statusOutcome: "manual-override",
      phase: { status: "not-started", roadmapEvents: [{ id: "update-stable" }] },
    });
    await expect(
      repository.recordRoadmapStatusUpdate("/work/roadmap-duplicates", request),
    ).resolves.toMatchObject({
      status: "duplicate",
      revision: 2,
    });
    await expect(
      repository.recordRoadmapStatusUpdate("/work/roadmap-duplicates", {
        ...request,
        progress: "Different content",
      }),
    ).resolves.toEqual({ status: "duplicate-id-conflict", revision: 2 });
  });

  it("canonicalizes reference coordinates before matching an update ID retry", async () => {
    const repository = new ProjectNotesRepository(await tempAgentDir());
    const cwd = "/work/roadmap-normalized-retry";
    await repository.migrate(cwd, roadmapDocument());
    const reference = {
      provider: " GitHub ",
      tool: null,
      canonicalUrl: " HTTPS://GITHUB.COM:443/owner/repo/ ",
      owner: " owner ",
      repo: " repo ",
      revision: null,
      path: null,
      range: null,
      issue: null,
      pullRequest: null,
      query: null,
      anchor: null,
      relevance: "Repository source",
    };
    const request = {
      updateId: "normalized-retry",
      phaseId: "phase-1",
      actor: "ken" as const,
      transition: "in-progress" as const,
      progress: "Verified normalized coordinates",
      blocker: null,
      requiredExternalAction: null,
      evidence: [],
      verification: null,
      verificationReason: null,
      proposedReferences: [reference],
      timestamp: NOW,
      autopilotEnabled: false,
    };

    await expect(repository.recordRoadmapStatusUpdate(cwd, request)).resolves.toMatchObject({
      status: "committed",
      proposals: [{ outcome: "pending" }],
      snapshot: {
        document: {
          phases: [
            {
              roadmapEvents: [
                {
                  proposedReferences: [
                    {
                      provider: "github",
                      canonicalUrl: "https://github.com/owner/repo",
                      owner: "owner",
                      repo: "repo",
                    },
                  ],
                },
              ],
            },
          ],
        },
      },
    });
    await expect(
      repository.recordRoadmapStatusUpdate(cwd, {
        ...request,
        proposedReferences: [
          {
            ...reference,
            provider: "github",
            canonicalUrl: "https://github.com/owner/repo",
            owner: "owner",
            repo: "repo",
          },
        ],
      }),
    ).resolves.toMatchObject({
      status: "duplicate",
      revision: 2,
      proposals: [{ outcome: "pending" }],
    });
  });

  it("keeps manual proposals pending and auto-accepts or reuses references under Autopilot", async () => {
    const repository = new ProjectNotesRepository(await tempAgentDir());
    const reference = {
      provider: "github",
      tool: "kencode-search",
      canonicalUrl: "https://github.com/owner/repo/blob/main/src/index.ts",
      owner: "owner",
      repo: "repo",
      revision: "main",
      path: "src/index.ts",
      range: null,
      issue: null,
      pullRequest: null,
      query: null,
      anchor: null,
      relevance: "Implementation source",
    };
    await repository.migrate("/work/roadmap-references", roadmapDocument());
    const baseRequest = {
      phaseId: "phase-1",
      actor: "ken-autopilot" as const,
      transition: "in-progress" as const,
      progress: "Verified source",
      blocker: null,
      requiredExternalAction: null,
      evidence: [],
      verification: null,
      verificationReason: null,
      proposedReferences: [reference],
      timestamp: NOW,
    };

    await expect(
      repository.recordRoadmapStatusUpdate("/work/roadmap-references", {
        ...baseRequest,
        updateId: "manual",
        autopilotEnabled: false,
      }),
    ).resolves.toMatchObject({
      status: "committed",
      proposals: [{ outcome: "pending", policyOutcome: "manual-review" }],
      snapshot: {
        document: {
          phases: [
            {
              roadmapEvents: [
                {
                  proposedReferences: [{ policyOutcome: "manual-review" }],
                },
              ],
            },
          ],
        },
      },
    });
    const autoRequest = {
      ...baseRequest,
      updateId: "auto",
      autopilotEnabled: true,
    };
    const accepted = await repository.recordRoadmapStatusUpdate(
      "/work/roadmap-references",
      autoRequest,
    );
    expect(accepted).toMatchObject({
      status: "committed",
      proposals: [
        {
          outcome: "accepted",
          policyOutcome: "accepted",
          referenceId: expect.any(String),
        },
      ],
      snapshot: { revision: 3, document: { references: [expect.objectContaining(reference)] } },
    });
    await expect(
      repository.recordRoadmapStatusUpdate("/work/roadmap-references", autoRequest),
    ).resolves.toMatchObject({
      status: "duplicate",
      revision: 3,
      proposals: [
        {
          outcome: "accepted",
          policyOutcome: "accepted",
          referenceId: expect.any(String),
        },
      ],
    });
    await expect(
      repository.recordRoadmapStatusUpdate("/work/roadmap-references", {
        ...baseRequest,
        updateId: "reuse",
        autopilotEnabled: true,
      }),
    ).resolves.toMatchObject({
      status: "committed",
      proposals: [{ outcome: "reused", policyOutcome: "reused" }],
    });

    const protectedDocument = roadmapDocument();
    protectedDocument.phases[0]!.overrides.referenceIds = {
      value: [],
      source: "user",
      updatedAt: NOW,
    };
    await repository.migrate("/work/roadmap-protected-references", protectedDocument);
    await expect(
      repository.recordRoadmapStatusUpdate("/work/roadmap-protected-references", {
        ...baseRequest,
        updateId: "protected",
        autopilotEnabled: true,
      }),
    ).resolves.toMatchObject({
      status: "committed",
      proposals: [
        {
          outcome: "pending",
          policyOutcome: "reference-override-protected",
          referenceId: null,
        },
      ],
    });
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

  it.each([
    "failed implementation checkpoint",
    "incomplete implementation checkpoint",
    "failed verification",
    "unaccepted verification exception",
    "exception acceptance without an exception",
    "verification from a different session",
    "evidence from before the latest rejection",
  ] as const)("rejects an impossible automatic Done with %s", async (shape) => {
    const fixture = (await canonicalNotesFixture()) as NotesDocumentV3;
    const events = fixture.phases[0]!.roadmapEvents;
    const checkpoint = events.find((event) => event.type === "implementation-checkpoint")!;
    const verification = events.find((event) => event.type === "status-update")!;
    const review = events.find((event) => event.type === "completion-review")!;

    switch (shape) {
      case "failed implementation checkpoint":
        checkpoint.runOutcome = "failed";
        break;
      case "incomplete implementation checkpoint":
        checkpoint.completedPlanSteps = [1, 2];
        break;
      case "failed verification":
        verification.verification = "failed";
        verification.verificationReason = "Focused verification failed";
        break;
      case "unaccepted verification exception":
        verification.verification = "exception-requested";
        verification.verificationReason = "Verification exception requires review";
        break;
      case "exception acceptance without an exception":
        review.acceptsVerificationException = true;
        break;
      case "verification from a different session":
        verification.verificationSession = {
          sessionId: "replacement-session",
          sessionPath: "/sessions/replacement.jsonl",
        };
        break;
      case "evidence from before the latest rejection":
        events.splice(events.indexOf(review), 0, {
          type: "completion-review",
          id: "review-rejected-before-acceptance",
          reviewer: "ken-autopilot",
          decision: "rejected",
          evidence: [],
          reason: "Revise the implementation",
          implementationCheckpointId: checkpoint.id,
          verificationStatusUpdateId: verification.id,
          acceptsVerificationException: false,
          gateOutcome: "review",
          unmetGateCodes: [],
          timestamp: review.timestamp,
        });
        break;
    }

    expect(validateNotesDocumentV3(fixture)).toMatchObject({ ok: false });
    await expect(
      new ProjectNotesRepository(await tempAgentDir()).migrate(`/work/${shape}`, fixture),
    ).resolves.toMatchObject({ status: "invalid" });
  });

  it("accepts and persists automatic Done with an accepted verification exception", async () => {
    const fixture = (await canonicalNotesFixture()) as NotesDocumentV3;
    const events = fixture.phases[0]!.roadmapEvents;
    const verification = events.find((event) => event.type === "status-update")!;
    const review = events.find((event) => event.type === "completion-review")!;
    verification.verification = "exception-requested";
    verification.verificationReason = "The approved environment cannot run this verification";
    review.acceptsVerificationException = true;

    expect(validateNotesDocumentV3(fixture)).toEqual({ ok: true, document: fixture });
    const repository = new ProjectNotesRepository(await tempAgentDir());
    await expect(repository.migrate("/work/accepted-exception", fixture)).resolves.toMatchObject({
      status: "ok",
      snapshot: { document: fixture },
    });
    await expect(repository.load("/work/accepted-exception")).resolves.toMatchObject({
      status: "ok",
      snapshot: { document: fixture },
    });
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

  it.each([
    ["archivedAt present and roadmapEvents absent", ["roadmapEvents"]],
    ["both additive fields absent", ["archivedAt", "roadmapEvents"]],
    ["archivedAt absent and roadmapEvents present", ["archivedAt"]],
  ])(
    "rewrites a v3 phase with %s without changing its revision or existing data",
    async (caseName, missingFields) => {
      const agentDir = await tempAgentDir();
      const cwd = `/work/${caseName.replace(/ /g, "-")}`;
      const repository = new ProjectNotesRepository(agentDir);
      const paths = repository.paths(cwd);
      const expected = notes(caseName);
      const original = structuredClone(expected) as unknown as {
        phases: Array<Record<string, unknown>>;
      };
      for (const field of missingFields) delete original.phases[0]![field];
      const envelope = {
        storeVersion: 1 as const,
        projectKey: canonicalProjectKey(cwd),
        revision: 22,
        document: original,
      };
      await fs.mkdir(paths.directory, { recursive: true });
      await fs.writeFile(paths.primary, JSON.stringify(envelope), "utf8");

      const loaded = await repository.load(cwd);
      const expectedEnvelope = { ...envelope, document: expected };

      expect(loaded).toEqual({
        status: "ok",
        snapshot: {
          projectKey: envelope.projectKey,
          revision: envelope.revision,
          document: expected,
        },
        recoveredFromBackup: false,
      });
      expect(await readEnvelope(paths.primary)).toEqual(expectedEnvelope);
      expect(await readEnvelope(paths.backup)).toEqual(expectedEnvelope);
    },
  );

  it("returns the shared post-normalization error for malformed legacy v3 Notes", async () => {
    const repository = new ProjectNotesRepository(await tempAgentDir());
    const fixture = await malformedLegacyV3Fixture();

    expect(validateNotesDocumentV3(fixture)).toMatchObject({
      ok: false,
      error: { path: "phases[0]" },
    });
    await expect(repository.migrate("/work/malformed-legacy-v3", fixture)).resolves.toEqual({
      status: "invalid",
      error: {
        path: "phases[0].status",
        message: "unknown phase status",
      },
    });
  });

  it("migrates legacy v3 proposal outcomes without inferring override protection", async () => {
    const agentDir = await tempAgentDir();
    const cwd = "/work/legacy-roadmap-proposal";
    const repository = new ProjectNotesRepository(agentDir);
    const paths = repository.paths(cwd);
    const original = notes("legacy roadmap proposal");
    const { id: _referenceId, capturedAt: _capturedAt, ...proposal } = original.references[0]!;
    (original.phases[0] as unknown as { roadmapEvents: unknown[] }).roadmapEvents = [
      {
        type: "status-update",
        id: "legacy-update",
        actor: "gg-coder",
        transition: "in-progress",
        progress: "Legacy report",
        blocker: null,
        evidence: [],
        statusOutcome: "same-status",
        proposedReferences: [
          {
            ...proposal,
            id: "legacy-proposal",
            disposition: "pending",
            referenceId: null,
          },
        ],
        timestamp: NOW,
      },
    ];
    const envelope = {
      storeVersion: 1,
      projectKey: canonicalProjectKey(cwd),
      revision: 4,
      document: original,
    };
    await fs.mkdir(paths.directory, { recursive: true });
    await fs.writeFile(paths.primary, JSON.stringify(envelope), "utf8");

    const loaded = await repository.load(cwd);

    expect(loaded).toMatchObject({
      status: "ok",
      snapshot: {
        revision: 4,
        document: {
          phases: [
            {
              roadmapEvents: [
                {
                  proposedReferences: [
                    {
                      disposition: "pending",
                      policyOutcome: "manual-review",
                      referenceId: null,
                    },
                  ],
                },
              ],
            },
          ],
        },
      },
    });
    expect((await readEnvelope(paths.primary)).document.phases[0]!.roadmapEvents[0]).toMatchObject({
      proposedReferences: [{ policyOutcome: "manual-review" }],
    });
  });

  it("rejects proposal policy outcomes that contradict their disposition", () => {
    const invalid = notes("invalid roadmap policy");
    const { id: _referenceId, capturedAt: _capturedAt, ...proposal } = invalid.references[0]!;
    invalid.phases[0]!.roadmapEvents = [
      {
        type: "status-update",
        id: "invalid-policy-update",
        actor: "gg-coder",
        transition: "in-progress",
        progress: "Invalid policy report",
        blocker: null,
        requiredExternalAction: null,
        evidence: [],
        verification: null,
        verificationReason: null,
        verificationSession: null,
        statusOutcome: "same-status",
        proposedReferences: [
          {
            ...proposal,
            id: "invalid-policy-proposal",
            disposition: "pending",
            policyOutcome: "accepted",
            referenceId: null,
          },
        ],
        timestamp: NOW,
      },
    ];

    expect(validateNotesDocumentV3(invalid)).toMatchObject({
      ok: false,
      error: {
        path: "phases[0].roadmapEvents[0].proposedReferences[0].policyOutcome",
        message: "must match the proposal disposition",
      },
    });
  });

  it.each([
    ["roadmapEvents absent", ["roadmapEvents"]],
    ["both additive fields absent", ["archivedAt", "roadmapEvents"]],
    ["archivedAt absent", ["archivedAt"]],
  ])("rejects %s lookalikes with unknown phase keys", async (caseName, missingFields) => {
    const agentDir = await tempAgentDir();
    const original = notes() as unknown as { phases: Array<Record<string, unknown>> };
    for (const field of missingFields) delete original.phases[0]![field];
    original.phases[0]!.unexpected = true;

    await expect(
      new ProjectNotesRepository(agentDir).migrate(`/work/lookalike-${caseName}`, original),
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

  it("upgrades legacy lifecycle events in place and preserves semantic kinds after restart", async () => {
    const agentDir = await tempAgentDir();
    const cwd = "/work/legacy-lifecycle-kind";
    const repository = new ProjectNotesRepository(agentDir);
    const paths = repository.paths(cwd);
    const legacy = structuredClone(notes("legacy lifecycle kinds")) as unknown as {
      phases: Array<{ lifecycleEvents: Array<Record<string, unknown>> }>;
    };
    for (const event of legacy.phases[0]!.lifecycleEvents) delete event.kind;
    await fs.mkdir(paths.directory, { recursive: true });
    await fs.writeFile(
      paths.primary,
      `${JSON.stringify({
        storeVersion: 1,
        projectKey: canonicalProjectKey(cwd),
        revision: 7,
        document: legacy,
      })}\n`,
      "utf8",
    );

    const loaded = await repository.load(cwd);
    expect(loaded).toMatchObject({
      status: "ok",
      snapshot: {
        revision: 7,
        document: { phases: [{ lifecycleEvents: [{ kind: "other" }, { kind: "other" }] }] },
      },
    });
    const persisted = await readEnvelope(paths.primary);
    expect(persisted.document.phases[0]!.lifecycleEvents.map(({ kind }) => kind)).toEqual([
      "other",
      "other",
    ]);
    await expect(new ProjectNotesRepository(agentDir).load(cwd)).resolves.toMatchObject({
      status: "ok",
      recoveredFromBackup: false,
      snapshot: { revision: 7, document: persisted.document },
    });
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

  it("recovers and rewrites a Phase 22 backup without changing revision or data", async () => {
    const agentDir = await tempAgentDir();
    const cwd = "/work/phase-22-backup";
    const repository = new ProjectNotesRepository(agentDir);
    const paths = repository.paths(cwd);
    const expected = notes("Phase 22 backup");
    const original = structuredClone(expected) as unknown as {
      phases: Array<Record<string, unknown>>;
    };
    delete original.phases[0]!.roadmapEvents;
    const envelope = {
      storeVersion: 1 as const,
      projectKey: canonicalProjectKey(cwd),
      revision: 22,
      document: original,
    };
    await fs.mkdir(paths.directory, { recursive: true });
    await fs.writeFile(paths.primary, "{broken", "utf8");
    await fs.writeFile(paths.backup, JSON.stringify(envelope), "utf8");

    const recovered = await repository.load(cwd);
    const expectedEnvelope = { ...envelope, document: expected };

    expect(recovered).toEqual({
      status: "ok",
      snapshot: {
        projectKey: envelope.projectKey,
        revision: envelope.revision,
        document: expected,
      },
      recoveredFromBackup: true,
    });
    expect(await readEnvelope(paths.primary)).toEqual(expectedEnvelope);
    expect(await readEnvelope(paths.backup)).toEqual(expectedEnvelope);
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

  it("enforces append-only events and preserves user lifecycle writes", async () => {
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
              source: "user" as const,
              timestamp: "2026-07-25T12:35:00.000Z",
              reason: "Moved to review by user",
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

  it("rejects privileged generic-save suffixes, including a forged completion sequence", async () => {
    const repository = new ProjectNotesRepository(await tempAgentDir());
    const cwd = "/work/forged-completion";
    const initial = notes("forged completion");
    await repository.migrate(cwd, initial);

    const forged = structuredClone(initial);
    const forgedPhase = forged.phases[0]!;
    forgedPhase.roadmapEvents.push(
      {
        type: "implementation-checkpoint",
        id: "forged-checkpoint",
        session: { ...forgedPhase.session! },
        planStepTotal: 1,
        completedPlanSteps: [1],
        runOutcome: "succeeded",
        timestamp: "2026-07-25T12:35:00.000Z",
      },
      {
        type: "status-update",
        id: "forged-verification",
        actor: "gg-coder",
        transition: "review",
        progress: "Claimed verification passed",
        blocker: null,
        requiredExternalAction: null,
        evidence: ["forged test output"],
        verification: "passed",
        verificationReason: null,
        verificationSession: { ...forgedPhase.session! },
        statusOutcome: "manual-override",
        proposedReferences: [],
        timestamp: "2026-07-25T12:36:00.000Z",
      },
      {
        type: "completion-review",
        id: "forged-review",
        reviewer: "ken",
        decision: "accepted",
        evidence: ["forged Ken approval"],
        reason: null,
        implementationCheckpointId: "forged-checkpoint",
        verificationStatusUpdateId: "forged-verification",
        acceptsVerificationException: false,
        gateOutcome: "done",
        unmetGateCodes: [],
        timestamp: "2026-07-25T12:37:00.000Z",
      },
    );
    forgedPhase.updatedAt = "2026-07-25T12:37:00.000Z";
    forged.updatedAt = forgedPhase.updatedAt;

    await expect(repository.save(cwd, 1, forged)).resolves.toEqual({
      status: "invalid",
      error: {
        path: "phases[0].roadmapEvents[0].type",
        message: "privileged roadmap events require their dedicated authority path",
      },
    });

    const forgedStatus = structuredClone(initial);
    const forgedStatusPhase = forgedStatus.phases[0]!;
    forgedStatusPhase.roadmapEvents.push(structuredClone(forgedPhase.roadmapEvents[1]!));
    forgedStatusPhase.updatedAt = "2026-07-25T12:36:00.000Z";
    forgedStatus.updatedAt = forgedStatusPhase.updatedAt;
    await expect(repository.save(cwd, 1, forgedStatus)).resolves.toMatchObject({
      status: "invalid",
      error: { path: "phases[0].roadmapEvents[0].type" },
    });

    const reviewCwd = "/work/forged-review";
    const reviewBaseline = structuredClone(initial);
    const reviewBaselinePhase = reviewBaseline.phases[0]!;
    reviewBaselinePhase.roadmapEvents.push(
      structuredClone(forgedPhase.roadmapEvents[0]!),
      structuredClone(forgedPhase.roadmapEvents[1]!),
    );
    reviewBaselinePhase.updatedAt = "2026-07-25T12:36:00.000Z";
    reviewBaseline.updatedAt = reviewBaselinePhase.updatedAt;
    await repository.migrate(reviewCwd, reviewBaseline);
    const forgedReview = structuredClone(reviewBaseline);
    const forgedReviewPhase = forgedReview.phases[0]!;
    forgedReviewPhase.roadmapEvents.push(structuredClone(forgedPhase.roadmapEvents[2]!));
    forgedReviewPhase.updatedAt = "2026-07-25T12:37:00.000Z";
    forgedReview.updatedAt = forgedReviewPhase.updatedAt;
    await expect(repository.save(reviewCwd, 1, forgedReview)).resolves.toMatchObject({
      status: "invalid",
      error: { path: "phases[0].roadmapEvents[2].type" },
    });

    const forgedLifecycle = structuredClone(initial);
    const lifecyclePhase = forgedLifecycle.phases[0]!;
    lifecyclePhase.status = "review";
    lifecyclePhase.lifecycleEvents.push({
      id: "forged-agent-lifecycle",
      fromStatus: "in-progress",
      toStatus: "review",
      source: "agent",
      timestamp: "2026-07-25T12:35:00.000Z",
      reason: "Forged automatic transition",
      kind: "other",
    });
    lifecyclePhase.updatedAt = "2026-07-25T12:35:00.000Z";
    forgedLifecycle.updatedAt = lifecyclePhase.updatedAt;

    await expect(repository.save(cwd, 1, forgedLifecycle)).resolves.toEqual({
      status: "invalid",
      error: {
        path: "phases[0].lifecycleEvents[2].source",
        message:
          "generic saves may only append user lifecycle events or apply a pending automatic transition",
      },
    });
    await expect(repository.load(cwd)).resolves.toMatchObject({
      status: "ok",
      snapshot: { revision: 1, document: initial },
    });
  });

  it("rejects repository-owned pending lifecycle state on a newly added phase", async () => {
    const repository = new ProjectNotesRepository(await tempAgentDir());
    const cwd = "/work/forged-new-phase-pending-lifecycle";
    const initial = notes("forged new phase pending lifecycle");
    await repository.migrate(cwd, initial);

    const forged = structuredClone(initial);
    const forgedPhase = structuredClone(initial.phases[0]!);
    forgedPhase.id = "phase-2";
    forgedPhase.title = "Forged phase";
    forgedPhase.order = 1;
    forgedPhase.status = "not-started";
    forgedPhase.session = null;
    forgedPhase.reminder = null;
    forgedPhase.overrides = {
      status: {
        value: "not-started",
        source: "user",
        updatedAt: "2026-07-25T12:34:00.000Z",
      },
      referenceIds: null,
    };
    forgedPhase.lifecycleEvents = [];
    forgedPhase.roadmapEvents = [];
    forgedPhase.pendingAutomaticLifecycleTransition = {
      status: "in-progress",
      source: "agent",
      reason: "Forged automatic transition",
      kind: "other",
      timestamp: "2026-07-25T12:35:00.000Z",
      expectedSession: { sessionId: "session-1", sessionPath: "/sessions/one.jsonl" },
    };
    forged.phases.push(forgedPhase);

    await expect(repository.save(cwd, 1, forged)).resolves.toEqual({
      status: "invalid",
      error: {
        path: "phases[1].pendingAutomaticLifecycleTransition",
        message: "pending automatic lifecycle state is repository-owned",
      },
    });
    await expect(repository.load(cwd)).resolves.toMatchObject({
      status: "ok",
      snapshot: { revision: 1, document: initial },
    });
  });

  it("rejects manual Done while allowing proposal decisions and override resets", async () => {
    const repository = new ProjectNotesRepository(await tempAgentDir());
    const cwd = "/work/frontend-event-suffixes";
    const initial = notes("frontend suffixes");
    const initialPhase = initial.phases[0]!;
    initialPhase.roadmapEvents.push({
      type: "status-update",
      id: "protected-update",
      actor: "gg-coder",
      transition: "review",
      progress: "Proposed evidence for user review",
      blocker: null,
      requiredExternalAction: null,
      evidence: ["focused tests passed"],
      verification: null,
      verificationReason: null,
      verificationSession: null,
      statusOutcome: "manual-override",
      proposedReferences: [
        {
          id: "proposal-1",
          provider: "github",
          tool: "kencode-search",
          canonicalUrl: "https://github.com/owner/proposed/issues/1",
          owner: "owner",
          repo: "proposed",
          revision: null,
          path: null,
          range: null,
          issue: 1,
          pullRequest: null,
          query: null,
          anchor: null,
          relevance: "Proposed reference",
          disposition: "pending",
          policyOutcome: "reference-override-protected",
          referenceId: null,
        },
      ],
      timestamp: "2026-07-25T12:35:00.000Z",
    });
    await repository.migrate(cwd, initial);

    const manualDone = structuredClone(initial);
    const donePhase = manualDone.phases[0]!;
    donePhase.status = "done";
    donePhase.completedAt = "2026-07-25T12:36:00.000Z";
    donePhase.updatedAt = donePhase.completedAt;
    donePhase.overrides.status = {
      value: "done",
      source: "user",
      updatedAt: donePhase.completedAt,
    };
    donePhase.lifecycleEvents.push({
      id: "manual-done",
      fromStatus: "in-progress",
      toStatus: "done",
      source: "user",
      timestamp: donePhase.completedAt,
      reason: "Status changed by user",
      kind: "other",
    });
    manualDone.updatedAt = donePhase.completedAt;
    const savedDone = await repository.save(cwd, 1, manualDone);
    expect(savedDone).toMatchObject({
      status: "invalid",
      error: {
        path: "phases[0].status",
        message: "phase completion requires the dedicated completion authority path",
      },
    });

    const decided = structuredClone(initial);
    const decidedPhase = decided.phases[0]!;
    decidedPhase.roadmapEvents.push({
      type: "reference-decision",
      id: "decision-1",
      proposalId: "proposal-1",
      decision: "rejected",
      referenceId: null,
      timestamp: "2026-07-25T12:36:00.000Z",
    });
    decidedPhase.updatedAt = "2026-07-25T12:36:00.000Z";
    decided.updatedAt = decidedPhase.updatedAt;
    const savedDecision = await repository.save(cwd, 1, decided);
    expect(savedDecision).toMatchObject({ status: "ok", snapshot: { revision: 2 } });
    if (savedDecision.status !== "ok") throw new Error("Expected proposal decision save");

    const reset = structuredClone(savedDecision.snapshot.document);
    const resetPhase = reset.phases[0]!;
    resetPhase.overrides = { status: null, referenceIds: null };
    resetPhase.roadmapEvents.push(
      {
        type: "override-reset",
        id: "status-reset",
        field: "status",
        timestamp: "2026-07-25T12:37:00.000Z",
      },
      {
        type: "override-reset",
        id: "references-reset",
        field: "references",
        timestamp: "2026-07-25T12:37:00.000Z",
      },
    );
    resetPhase.updatedAt = "2026-07-25T12:37:00.000Z";
    reset.updatedAt = resetPhase.updatedAt;

    await expect(repository.save(cwd, 2, reset)).resolves.toMatchObject({
      status: "ok",
      snapshot: { revision: 3, document: reset },
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

describe("ProjectNotesRepository approved phase creation", () => {
  it("appends every approved phase with canonical defaults in one revision", async () => {
    const cwd = "/work/approved-phases";
    const repository = new ProjectNotesRepository(await tempAgentDir());
    const initial = notes("approved phase baseline");
    await repository.migrate(cwd, initial);

    await expect(repository.createApprovedPhases(cwd, approvedPhaseDraft(cwd, 1))).resolves.toEqual(
      {
        status: "created",
        revision: 2,
        phaseIds: ["approved-phase-1", "approved-phase-2"],
      },
    );

    const loaded = await repository.load(cwd);
    expect(loaded).toMatchObject({
      status: "ok",
      snapshot: {
        revision: 2,
        document: {
          phases: [
            { id: "phase-1", order: 0 },
            {
              id: "approved-phase-1",
              title: "Approved phase 1",
              goal: "Deliver approved goal 1.",
              doneWhen: ["Approved criterion 1 passes"],
              order: 1,
              status: "not-started",
              sourcePrompt: "Implement approved phase 1 only.",
              referenceIds: [],
              session: null,
              reminder: null,
              attentionReason: null,
              completedAt: null,
              archivedAt: null,
              overrides: { status: null, referenceIds: null },
              pendingAutomaticLifecycleTransition: null,
              lifecycleEvents: [],
              roadmapEvents: [],
            },
            { id: "approved-phase-2", order: 2, status: "not-started" },
          ],
        },
      },
    });
    if (loaded.status !== "ok") throw new Error("expected Notes to load");
    const appended = loaded.snapshot.document.phases.slice(1);
    expect(appended).toHaveLength(2);
    expect(appended[0]!.createdAt).toBe(appended[0]!.updatedAt);
    expect(appended[1]!.createdAt).toBe(appended[0]!.createdAt);
    expect(loaded.snapshot.document.updatedAt).toBe(appended[0]!.createdAt);
    expect(loaded.snapshot.document.phases[0]).toEqual(initial.phases[0]);
  });

  it("appends references and links multiple phases in the same revision", async () => {
    const cwd = "/work/approved-phase-references";
    const repository = new ProjectNotesRepository(await tempAgentDir());
    await repository.migrate(cwd, notes("reference baseline"));

    await expect(
      repository.createApprovedPhases(cwd, approvedPhaseDraftWithReference(cwd, 1)),
    ).resolves.toMatchObject({ status: "created", revision: 2 });
    const loaded = await repository.load(cwd);
    if (loaded.status !== "ok") throw new Error("expected Notes to load");
    expect(loaded.snapshot.document.references).toHaveLength(2);
    expect(loaded.snapshot.document.references[1]).toMatchObject({
      id: "draft-reference-1",
      relevance: "Shared Roadmap contract",
    });
    expect(loaded.snapshot.document.references[1]!.capturedAt).toBe(
      loaded.snapshot.document.phases[1]!.createdAt,
    );
    expect(loaded.snapshot.document.phases.slice(1).map((phase) => phase.referenceIds)).toEqual([
      ["draft-reference-1"],
      ["draft-reference-1"],
    ]);
  });

  it("reuses an existing canonical reference without overwriting its metadata", async () => {
    const cwd = "/work/approved-phase-reference-reuse";
    const repository = new ProjectNotesRepository(await tempAgentDir());
    const initial = notes("reuse baseline");
    await repository.migrate(cwd, initial);
    const draft = approvedPhaseDraftWithReference(cwd, 1);
    const { capturedAt: _capturedAt, ...existingProjection } = initial.references[0]!;
    draft.references[0] = {
      ...existingProjection,
      id: "generated-reference-id",
      relevance: "new relevance must not overwrite",
    };
    draft.phases.forEach((phase) => (phase.referenceIds = ["generated-reference-id"]));

    const approval = await repository.createApprovedPhases(cwd, draft);
    expect(approval).toEqual({
      status: "created",
      revision: 2,
      phaseIds: ["approved-phase-1", "approved-phase-2"],
    });
    const loaded = await repository.load(cwd);
    if (loaded.status !== "ok") throw new Error("expected Notes to load");
    expect(loaded.snapshot.document.references).toEqual(initial.references);
    expect(loaded.snapshot.document.phases.slice(1).map((phase) => phase.referenceIds)).toEqual([
      ["ref-1"],
      ["ref-1"],
    ]);
  });

  it("rejects a generated reference ID collision atomically", async () => {
    const cwd = "/work/approved-phase-reference-collision";
    const repository = new ProjectNotesRepository(await tempAgentDir());
    await repository.migrate(cwd, notes("collision baseline"));
    const draft = approvedPhaseDraftWithReference(cwd, 1);
    draft.references[0]!.id = "ref-1";
    draft.phases.forEach((phase) => (phase.referenceIds = ["ref-1"]));
    const paths = repository.paths(cwd);
    const primaryBefore = await fs.readFile(paths.primary, "utf8");
    const backupBefore = await fs.readFile(paths.backup, "utf8");

    await expect(repository.createApprovedPhases(cwd, draft)).resolves.toMatchObject({
      status: "invalid-proposal",
      message: expect.stringContaining("collides"),
    });
    expect(await fs.readFile(paths.primary, "utf8")).toBe(primaryBefore);
    expect(await fs.readFile(paths.backup, "utf8")).toBe(backupBefore);
  });

  it("checks the exact revision under the lock and lets only one concurrent batch commit", async () => {
    const cwd = "/work/approved-phase-cas";
    const repository = new ProjectNotesRepository(await tempAgentDir());
    await repository.migrate(cwd, notes("CAS baseline"));

    const [left, right] = await Promise.all([
      repository.createApprovedPhases(cwd, approvedPhaseDraft(cwd, 1, ["phase-left"])),
      repository.createApprovedPhases(cwd, approvedPhaseDraft(cwd, 1, ["phase-right"])),
    ]);

    expect([left.status, right.status].sort()).toEqual(["created", "stale-revision"]);
    expect([left, right].find((result) => result.status === "stale-revision")).toEqual({
      status: "stale-revision",
      expectedRevision: 1,
      currentRevision: 2,
    });
    const loaded = await repository.load(cwd);
    expect(loaded).toMatchObject({ status: "ok", snapshot: { revision: 2 } });
    if (loaded.status !== "ok") throw new Error("expected Notes to load");
    expect(loaded.snapshot.document.phases).toHaveLength(2);
    expect(["phase-left", "phase-right"]).toContain(loaded.snapshot.document.phases[1]!.id);
  });

  it("rejects an invalid batch without appending any of its phases or writing either envelope", async () => {
    const cwd = "/work/approved-phase-atomic-validation";
    const repository = new ProjectNotesRepository(await tempAgentDir());
    await repository.migrate(cwd, notes("atomic validation baseline"));
    const paths = repository.paths(cwd);
    const primaryBefore = await fs.readFile(paths.primary, "utf8");
    const backupBefore = await fs.readFile(paths.backup, "utf8");
    const draft = approvedPhaseDraft(cwd, 1, ["new-phase", "phase-1"]);

    await expect(repository.createApprovedPhases(cwd, draft)).resolves.toMatchObject({
      status: "invalid-proposal",
      message: expect.stringContaining("duplicate ID: phase-1"),
    });
    expect(await fs.readFile(paths.primary, "utf8")).toBe(primaryBefore);
    expect(await fs.readFile(paths.backup, "utf8")).toBe(backupBefore);
    await expect(repository.load(cwd)).resolves.toMatchObject({
      status: "ok",
      snapshot: { revision: 1, document: { phases: [{ id: "phase-1" }] } },
    });
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
