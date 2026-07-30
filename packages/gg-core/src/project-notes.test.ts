import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  canonicalReferenceIdentity,
  isNotesDocumentV2,
  isNotesDocumentV3,
  migrateNotesDocumentV2,
  migrateNotesDocumentV3PhaseShape,
  normalizeCanonicalUrl,
  NOTES_REFERENCE_METADATA_FIELDS,
  NOTES_REFERENCE_METADATA_MAX_LENGTH,
  NOTES_REFERENCE_URL_MAX_LENGTH,
  NOTES_REMINDER_NOTE_MAX_LENGTH,
  validateNotesDocumentV3,
  type NotesDocumentV2,
  type NotesDocumentV3,
} from "./project-notes.js";

const NOW = "2026-07-25T12:34:56.000Z";

async function fixture(): Promise<NotesDocumentV3> {
  return JSON.parse(
    await fs.readFile(new URL("../../../fixtures/project-notes-v3.json", import.meta.url), "utf8"),
  ) as NotesDocumentV3;
}

function legacyV2(): NotesDocumentV2 {
  return {
    version: 2,
    reference: "legacy",
    currentFocus: "Migrate Notes",
    tasks: [
      {
        id: "",
        text: "Empty ID",
        status: "todo",
        createdAt: NOW,
        updatedAt: NOW,
        completedAt: null,
        archivedAt: null,
      },
      {
        id: "duplicate",
        text: "First duplicate",
        status: "todo",
        createdAt: NOW,
        updatedAt: NOW,
        completedAt: null,
        archivedAt: null,
      },
      {
        id: "duplicate",
        text: "Second duplicate",
        status: "done",
        createdAt: NOW,
        updatedAt: NOW,
        completedAt: NOW,
        archivedAt: null,
      },
    ],
    handoff: { text: "Continue", updatedAt: NOW, readAt: null },
    updatedAt: NOW,
    legacyImportedAt: null,
  };
}

function expectError(value: unknown, path: string, message?: string): void {
  const result = validateNotesDocumentV3(value);
  expect(result).toMatchObject({
    ok: false,
    error: { path, ...(message === undefined ? {} : { message }) },
  });
}

describe("project Notes contract", () => {
  it("accepts the canonical fixture without cloning or rewriting it", async () => {
    const document = await fixture();

    expect(validateNotesDocumentV3(document)).toEqual({ ok: true, document });
    expect(isNotesDocumentV3(document)).toBe(true);
    expect(migrateNotesDocumentV3PhaseShape(document)).toEqual({ ok: true, document });
  });

  it("accepts the backend final-review evidence-only status outcome", async () => {
    const document = await fixture();
    const update = document.phases[0]!.roadmapEvents.find(
      (event) => event.type === "status-update",
    )!;
    update.statusOutcome = "evidence-only";

    expect(validateNotesDocumentV3(document)).toEqual({ ok: true, document });
  });

  it("deterministically stabilizes missing and duplicate v2 task IDs", () => {
    const legacy = legacyV2();

    expect(isNotesDocumentV2(legacy)).toBe(true);
    const first = migrateNotesDocumentV2(legacy);
    const second = migrateNotesDocumentV2(structuredClone(legacy));

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      ok: true,
      document: {
        version: 3,
        phases: [],
        references: [],
        tasks: [{ id: "legacy-task-1" }, { id: "duplicate" }, { id: "legacy-task-3" }],
      },
    });
  });

  it("migrates every additive legacy-v3 field family and nothing else", async () => {
    const expected = await fixture();
    const legacy = structuredClone(expected) as unknown as {
      phases: Array<Record<string, unknown>>;
    };
    const firstPhase = legacy.phases[0]!;
    const secondPhase = legacy.phases[1]!;
    delete firstPhase.archivedAt;
    delete secondPhase.archivedAt;
    delete secondPhase.roadmapEvents;

    const reminder = firstPhase.reminder as Record<string, unknown>;
    delete reminder.occurrenceKey;
    delete reminder.lastDelivery;

    const events = firstPhase.roadmapEvents as Array<Record<string, unknown>>;
    const statusUpdate = events.find((event) => event.type === "status-update")!;
    firstPhase.roadmapEvents = [statusUpdate];
    delete statusUpdate.verification;
    delete statusUpdate.verificationReason;
    delete statusUpdate.verificationSession;
    const source = expected.references[0]!;
    statusUpdate.proposedReferences = [
      {
        provider: source.provider,
        tool: source.tool,
        canonicalUrl: source.canonicalUrl,
        owner: source.owner,
        repo: source.repo,
        revision: source.revision,
        path: source.path,
        range: source.range,
        issue: source.issue,
        pullRequest: source.pullRequest,
        query: source.query,
        anchor: source.anchor,
        relevance: source.relevance,
        id: "legacy-proposal",
        disposition: "pending",
        referenceId: null,
      },
    ];

    const migrated = migrateNotesDocumentV3PhaseShape(legacy);

    expect(migrated).toMatchObject({
      ok: true,
      document: {
        phases: [
          {
            archivedAt: null,
            reminder: {
              occurrenceKey: "reminder-review-contract",
              lastDelivery: null,
            },
            roadmapEvents: [
              {
                verification: null,
                verificationReason: null,
                verificationSession: null,
                proposedReferences: [{ policyOutcome: "manual-review" }],
              },
            ],
          },
          { archivedAt: null, roadmapEvents: [] },
        ],
      },
    });
  });

  it("adds only verificationSession to the recognized intermediate status-update shape", async () => {
    const legacy = await fixture();
    const update = legacy.phases[0]!.roadmapEvents.find(
      (event) => event.type === "status-update",
    )! as unknown as Record<string, unknown>;
    legacy.phases[0]!.roadmapEvents = [update as never];
    delete update.verificationSession;

    const migrated = migrateNotesDocumentV3PhaseShape(legacy);
    expect(migrated.ok).toBe(true);
    if (!migrated.ok) throw new Error(migrated.error.message);
    expect(migrated.document.phases[0]!.roadmapEvents).toMatchObject([
      { verificationSession: null },
    ]);
  });

  it("does not strip unknown keys from legacy-v3 lookalikes", async () => {
    const legacy = (await fixture()) as unknown as {
      phases: Array<Record<string, unknown>>;
    };
    delete legacy.phases[0]!.archivedAt;
    legacy.phases[0]!.privateState = true;

    const strict = validateNotesDocumentV3(legacy);
    const migrated = migrateNotesDocumentV3PhaseShape(legacy);

    expect(strict).toMatchObject({ ok: false, error: { path: "phases[0]" } });
    expect(migrated).toEqual(strict);
  });

  it.each([
    [
      "task",
      (document: NotesDocumentV3) => Object.assign(document.tasks[0]!, { extra: true }),
      "tasks[0]",
    ],
    [
      "reference range",
      (document: NotesDocumentV3) => Object.assign(document.references[1]!.range!, { extra: true }),
      "references[1].range",
    ],
    [
      "reminder delivery",
      (document: NotesDocumentV3) =>
        Object.assign(document.phases[0]!.reminder!.lastDelivery!, { extra: true }),
      "phases[0].reminder.lastDelivery",
    ],
    [
      "lifecycle event",
      (document: NotesDocumentV3) =>
        Object.assign(document.phases[0]!.lifecycleEvents[0]!, { extra: true }),
      "phases[0].lifecycleEvents[0]",
    ],
    [
      "roadmap event",
      (document: NotesDocumentV3) =>
        Object.assign(document.phases[0]!.roadmapEvents[0]!, { extra: true }),
      "phases[0].roadmapEvents[0]",
    ],
  ])("rejects unknown keys in a nested %s at a stable path", async (_name, mutate, path) => {
    const document = await fixture();
    mutate(document);
    expectError(document, path);
  });

  it("normalizes URL identity while preserving path, query, and fragment", () => {
    expect(normalizeCanonicalUrl("HTTPS://EXAMPLE.COM:443/a/b/?q=A#L2")).toBe(
      "https://example.com/a/b?q=A#L2",
    );
    expect(normalizeCanonicalUrl("ftp://example.com/a")).toBeNull();
    expect(normalizeCanonicalUrl("https://user@example.com/a")).toBeNull();
    expect(
      canonicalReferenceIdentity({
        provider: " GitHub ",
        canonicalUrl: "HTTPS://GITHUB.COM:443/owner/repo/",
      }),
    ).toBe("github\nhttps://github.com/owner/repo");
  });

  it.each(NOTES_REFERENCE_METADATA_FIELDS)("enforces the metadata limit for %s", async (field) => {
    const exact = await fixture();
    exact.references[0] = {
      ...exact.references[0]!,
      provider: "example",
      [field]: "x".repeat(NOTES_REFERENCE_METADATA_MAX_LENGTH),
    };
    const oversized = structuredClone(exact);
    oversized.references[0] = {
      ...oversized.references[0]!,
      [field]: "x".repeat(NOTES_REFERENCE_METADATA_MAX_LENGTH + 1),
    };

    expect(validateNotesDocumentV3(exact).ok).toBe(true);
    expectError(oversized, `references[0].${field}`);
  });

  it("enforces URL and reminder limits", async () => {
    const prefix = "https://example.com/";
    const exactUrl = `${prefix}${"x".repeat(NOTES_REFERENCE_URL_MAX_LENGTH - prefix.length)}`;
    const exact = await fixture();
    exact.references[0] = { ...exact.references[0]!, provider: "example", canonicalUrl: exactUrl };
    exact.phases[0]!.reminder!.note = "x".repeat(NOTES_REMINDER_NOTE_MAX_LENGTH);
    expect(validateNotesDocumentV3(exact).ok).toBe(true);

    const longUrl = structuredClone(exact);
    longUrl.references[0]!.canonicalUrl += "x";
    expectError(longUrl, "references[0].canonicalUrl");

    const longNote = structuredClone(exact);
    longNote.phases[0]!.reminder!.note += "x";
    expectError(longNote, "phases[0].reminder.note");
  });

  it("rejects duplicate task, phase, reference IDs, and canonical identities", async () => {
    const duplicateTask = await fixture();
    duplicateTask.tasks[1]!.id = duplicateTask.tasks[0]!.id;
    expectError(duplicateTask, "tasks[1].id");

    const duplicatePhase = await fixture();
    duplicatePhase.phases[1]!.id = duplicatePhase.phases[0]!.id;
    expectError(duplicatePhase, "phases[1].id");

    const duplicateReferenceId = await fixture();
    duplicateReferenceId.references[1]!.id = duplicateReferenceId.references[0]!.id;
    expectError(duplicateReferenceId, "references[1].id");

    const duplicateIdentity = await fixture();
    duplicateIdentity.references[1] = {
      ...duplicateIdentity.references[0]!,
      id: "duplicate-source",
      provider: " GitHub ",
      canonicalUrl: `${duplicateIdentity.references[0]!.canonicalUrl}/`,
    };
    expectError(duplicateIdentity, "references[1].canonicalUrl");
  });

  it("enforces lifecycle and roadmap chronology", async () => {
    const lifecycle = await fixture();
    lifecycle.phases[0]!.lifecycleEvents[1]!.timestamp = "2026-07-22T00:00:00.000Z";
    expectError(
      lifecycle,
      "phases[0].lifecycleEvents[1].timestamp",
      "events must be chronological",
    );

    const roadmap = await fixture();
    roadmap.phases[0]!.roadmapEvents[1]!.timestamp = "2026-07-24T00:00:00.000Z";
    expectError(roadmap, "phases[0].roadmapEvents[1].timestamp", "events must be chronological");
  });

  it.each([
    [
      "failed run",
      (document: NotesDocumentV3) => {
        const checkpoint = document.phases[0]!.roadmapEvents.find(
          (event) => event.type === "implementation-checkpoint",
        )!;
        checkpoint.runOutcome = "failed";
      },
    ],
    [
      "incomplete plan",
      (document: NotesDocumentV3) => {
        const checkpoint = document.phases[0]!.roadmapEvents.find(
          (event) => event.type === "implementation-checkpoint",
        )!;
        checkpoint.completedPlanSteps = [1, 2];
      },
    ],
    [
      "failed verification",
      (document: NotesDocumentV3) => {
        const update = document.phases[0]!.roadmapEvents.find(
          (event) => event.type === "status-update",
        )!;
        update.verification = "failed";
        update.verificationReason = "Focused verification failed";
      },
    ],
    [
      "unaccepted exception",
      (document: NotesDocumentV3) => {
        const update = document.phases[0]!.roadmapEvents.find(
          (event) => event.type === "status-update",
        )!;
        update.verification = "exception-requested";
        update.verificationReason = "Needs reviewer acceptance";
      },
    ],
    [
      "different verification session",
      (document: NotesDocumentV3) => {
        const update = document.phases[0]!.roadmapEvents.find(
          (event) => event.type === "status-update",
        )!;
        update.verificationSession = { sessionId: "other", sessionPath: "/sessions/other.jsonl" };
      },
    ],
  ])("rejects Done when the completion gate has a %s", async (_name, mutate) => {
    const document = await fixture();
    mutate(document);
    expectError(document, "phases[0].roadmapEvents[2]");
  });
});
