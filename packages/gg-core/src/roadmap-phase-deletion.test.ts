import { describe, expect, it } from "vitest";
import {
  applyNotesPhaseDeletion, classifyRoadmapAutoStartEligibility, isNotesPhaseDeleted,
  isPhaseDeletionOutcome, isPhaseDeletionRequest, notesPhaseDeletionGeneration,
  phaseDeletionFingerprint, validateNotesDocumentV3,
  type NotesPhase, type PhaseDeletionRequest,
} from "./project-notes.js";
import { completionCompatibilityFixture, encodeCompatibleDone } from "./test-fixtures/project-notes-completion-compatibility.js";

const now = "2026-09-21T12:00:00.000Z";
function request(phase: NotesPhase, action: "delete" | "recover" = "delete"): PhaseDeletionRequest {
  const generation = notesPhaseDeletionGeneration(phase);
  return { version: 1, action, operationId: `operation-${generation}`, phaseId: phase.id,
    expectedProjectKey: "synthetic", expectedRevision: generation + 1, expectedGeneration: generation };
}

describe("phase deletion contract", () => {
  it.each([
    { action: "purge" }, { actor: "admin" }, { operationId: "a".repeat(257) },
    { operationId: "\n" }, { expectedProjectKey: "x".repeat(4097) },
    { expectedRevision: -1 }, { expectedRevision: 0.5 }, { expectedGeneration: Infinity },
    { expectedRevision: Number.MAX_SAFE_INTEGER + 1 }, { version: 2 }, { phaseId: "" },
  ])("rejects malformed or unauthorized request fields %j", async (patch) => {
    const doc = await completionCompatibilityFixture();
    expect(isPhaseDeletionRequest({ ...request(doc.phases[2]!), ...patch })).toBe(false);
  });

  it("accepts documents without metadata and key-order-independent request fingerprints", async () => {
    const doc = await completionCompatibilityFixture();
    expect(validateNotesDocumentV3(doc).ok).toBe(true);
    expect(isNotesPhaseDeleted(doc.phases[2]!)).toBe(false);
    const input = request(doc.phases[2]!);
    expect(isPhaseDeletionRequest(input)).toBe(true);
    expect(phaseDeletionFingerprint(input)).toBe(phaseDeletionFingerprint(
      Object.fromEntries(Object.entries(input).reverse()) as unknown as PhaseDeletionRequest));
  });

  it.each(["draft", "archived", "history", "done"])("retains identity/content and retires authority for %s", async kind => {
    const doc = encodeCompatibleDone(await completionCompatibilityFixture());
    const index = kind === "history" ? 0 : 2;
    const phase = doc.phases[index]!;
    if (kind === "draft" || kind === "archived") {
      phase.status = "not-started"; phase.completedAt = null;
      phase.lifecycleEvents = []; phase.roadmapEvents = [];
    }
    if (kind === "archived") phase.archivedAt = now;
    expect(validateNotesDocumentV3(doc).ok).toBe(true);
    const original = structuredClone(doc);
    let current = applyNotesPhaseDeletion(phase, request(phase), now);
    doc.phases[index] = current;
    expect(validateNotesDocumentV3(doc)).toEqual({ ok: true, document: doc });
    expect(isNotesPhaseDeleted(current)).toBe(true);
    expect(current.session).toBeNull(); expect(current.execution).toBeUndefined();
    expect(current.reminder).toBeNull();
    expect(current.roadmapEvents).toEqual(phase.roadmapEvents);
    expect(current.lifecycleEvents).toEqual(phase.lifecycleEvents);
    expect(classifyRoadmapAutoStartEligibility([current], "other")).toEqual({ kind: "none" });
    current = applyNotesPhaseDeletion(current, request(current, "recover"), now);
    doc.phases[index] = current;
    expect(validateNotesDocumentV3(doc)).toEqual({ ok: true, document: doc });
    expect(current.id).toBe(phase.id); expect(current.title).toBe(phase.title);
    expect(current.sourcePrompt).toBe(phase.sourcePrompt);
    expect(current.archivedAt).toBe(phase.archivedAt);
    expect(current.status).toBe(phase.status === "done" ? "done" : "not-started");
    expect(current.session).toBeNull(); expect(current.execution).toBeUndefined();
    expect(current.reminder).toBeNull();
    expect(doc.references).toEqual(original.references);
    expect(doc.phases.filter((_, i) => i !== index)).toEqual(original.phases.filter((_, i) => i !== index));
    expect(original.phases[index]).toEqual(phase);
    const again = applyNotesPhaseDeletion(current, request(current), now);
    doc.phases[index] = applyNotesPhaseDeletion(again, request(again, "recover"), now);
    expect(validateNotesDocumentV3(doc).ok).toBe(true);
    expect(notesPhaseDeletionGeneration(doc.phases[index]!)).toBe(4);
  });

  it("validates shared outcomes and refuses unknown response fields", async () => {
    const document = await completionCompatibilityFixture();
    const result = { status: "committed", action: "delete", operationId: "operation-0",
      replayed: false, snapshot: { projectKey: "synthetic", revision: 2, document } };
    expect(isPhaseDeletionOutcome(result)).toBe(true);
    expect(isPhaseDeletionOutcome({ ...result, localOnly: true })).toBe(false);
    expect(isPhaseDeletionOutcome({ ...result, snapshot: { ...result.snapshot, revision: -1 } })).toBe(false);
    expect(isPhaseDeletionOutcome({ status: "uncertain", operationId: "operation-0", message: "Retry the same request" })).toBe(true);
  });

  it("rejects live capabilities, tampered history, malformed nested runtime and stale generations", async () => {
    const doc = await completionCompatibilityFixture();
    const phase = doc.phases[2]!;
    const input = request(phase);
    const deleted = applyNotesPhaseDeletion(phase, input, now);
    expect(() => applyNotesPhaseDeletion(deleted, input, now)).toThrow();
    const mutations = [
      (p: NotesPhase) => { p.session = { sessionId: "old", sessionPath: null }; },
      (p: NotesPhase) => { p.deletion!.currentDeletionId = null; },
      (p: NotesPhase) => { p.deletion!.events[0]!.fingerprint = "wrong"; },
      (p: NotesPhase) => { p.deletion!.events[0]!.request.expectedGeneration = 2; },
      (p: NotesPhase) => { const e = p.deletion!.events[0]!; if (e.action === "delete") e.retired.roadmapEventCount = 999; },
      (p: NotesPhase) => { const e = p.deletion!.events[0]!; if (e.action === "delete") Object.assign(e.retired.session = { sessionId: "old", sessionPath: null }, { arbitrary: true }); },
      (p: NotesPhase) => { p.deletion!.events.push(p.deletion!.events[0]!); },
      (p: NotesPhase) => { p.deletion!.events[0]!.timestamp = "2026-02-31T00:00:00.000Z"; },
    ];
    for (const mutate of mutations) {
      doc.phases[2] = structuredClone(deleted); mutate(doc.phases[2]!);
      expect(validateNotesDocumentV3(doc).ok).toBe(false);
    }
  });
});
