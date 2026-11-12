import fs from "node:fs/promises";
import type { NotesDocumentV3 } from "../project-notes.js";

// Disposable derivative of the canonical V3 fixture, never a live Notes snapshot.
export async function completionCompatibilityFixture(): Promise<NotesDocumentV3> {
  const document: NotesDocumentV3 = JSON.parse(
    await fs.readFile(
      new URL(
        "../../../../fixtures/project-notes-v3-completion-compatibility.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  document.phases.push({
    ...structuredClone(document.phases[1]!),
    id: "phase-explicit-done",
    order: 2,
    status: "in-progress",
    completedAt: null,
    archivedAt: null,
    session: null,
    overrides: { status: null, referenceIds: null },
    pendingAutomaticLifecycleTransition: null,
    attentionReason: null,
    reminder: null,
    roadmapEvents: [],
    lifecycleEvents: [],
  });
  return document;
}

// Proposed wire encoding only; this is NOT a replacement repository writer.
export function encodeCompatibleDone(document: NotesDocumentV3): NotesDocumentV3 {
  const next = structuredClone(document);
  const phase = next.phases[2]!;
  const timestamp = "2026-09-07T12:00:00.000Z";
  phase.roadmapEvents.push({
    type: "status-update",
    id: "explicit-done",
    actor: "gg-coder",
    transition: "done",
    progress: "Reviewed the documentation against the acceptance criteria",
    blocker: null,
    requiredExternalAction: null,
    evidence: ["Documentation review found every required section present"],
    verification: "passed",
    verificationReason: null,
    verificationSession: null,
    statusOutcome: "completion-pending",
    proposedReferences: [],
    timestamp,
  });
  phase.lifecycleEvents.push({
    id: "explicit-done-lifecycle",
    fromStatus: phase.status,
    toStatus: "done",
    source: "agent",
    timestamp,
    reason: "Explicit completion report",
    kind: "other",
  });
  phase.status = "done";
  phase.completedAt = timestamp;
  phase.updatedAt = timestamp;
  next.updatedAt = timestamp;
  return next;
}
