import { describe, expect, it } from "vitest";
import {
  agentPhaseStartRefusal,
  applyNotesPhaseDeletion,
  findCurrentDependencyOverride,
  roadmapOrderDependencyWarnings,
  validateRoadmapDraftDependencies,
  validateRoadmapEditDependencies,
  hasRoadmapPhaseDependencyLinks,
  isPhaseDeletionOutcome,
  listUnfinishedPrerequisites,
  notesPhaseDeletionGeneration,
  phaseDeletionDependencyConflict,
  validateNotesDocumentV3,
  validateRoadmapPhaseDependencies,
  type NotesDocumentV3,
  type NotesPhase,
} from "./project-notes.js";
import { completionCompatibilityFixture } from "./test-fixtures/project-notes-completion-compatibility.js";

const now = "2026-11-06T12:00:00.000Z";

// Phases: 0 needs-attention, 1 done + archived, 2 in-progress, 3 "a", 4 "b", 5 "c" not started.
async function document(): Promise<NotesDocumentV3> {
  const doc = await completionCompatibilityFixture();
  for (const [offset, id] of ["a", "b", "c"].entries()) {
    doc.phases.push({
      ...structuredClone(doc.phases[2]!),
      id,
      title: `Phase ${id.toUpperCase()}`,
      order: 3 + offset,
      status: "not-started",
      lifecycleEvents: [],
      roadmapEvents: [],
    });
  }
  expect(validateNotesDocumentV3(doc).ok).toBe(true);
  return doc;
}

function phase(doc: NotesDocumentV3, id: string): NotesPhase {
  return doc.phases.find((candidate) => candidate.id === id)!;
}

function remove(doc: NotesDocumentV3, id: string, action: "delete" | "recover" = "delete"): void {
  const index = doc.phases.findIndex((candidate) => candidate.id === id);
  const current = doc.phases[index]!;
  const generation = notesPhaseDeletionGeneration(current);
  doc.phases[index] = applyNotesPhaseDeletion(
    current,
    {
      version: 1,
      action,
      operationId: `${id}-${generation}`,
      phaseId: id,
      expectedProjectKey: "synthetic",
      expectedRevision: generation + 1,
      expectedGeneration: generation,
    },
    now,
  );
}

function expectInvalid(doc: NotesDocumentV3, path: string, message: RegExp): void {
  const result = validateNotesDocumentV3(doc);
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error.path).toBe(path);
  expect(result.error.message).toMatch(message);
}

describe("phase dependency links", () => {
  it("accepts valid links, including to archived and Done phases, and round-trips them", async () => {
    const doc = await document();
    phase(doc, "a").dependsOn = ["phase-migration-proof", "phase-explicit-done"];
    phase(doc, "b").dependsOn = ["a"];
    phase(doc, "c").dependsOn = ["a", "b"];
    expect(validateNotesDocumentV3(doc)).toEqual({ ok: true, document: doc });
    expect(validateNotesDocumentV3(JSON.parse(JSON.stringify(doc))).ok).toBe(true);
    expect(hasRoadmapPhaseDependencyLinks(doc.phases)).toBe(true);
  });

  it("keeps old documents without the field valid and byte-identical", async () => {
    const doc = await document();
    const before = JSON.stringify(doc);
    expect(validateNotesDocumentV3(doc)).toEqual({ ok: true, document: doc });
    expect(JSON.stringify(doc)).toBe(before);
    expect(doc.phases.some((candidate) => "dependsOn" in candidate)).toBe(false);
    expect(hasRoadmapPhaseDependencyLinks(doc.phases)).toBe(false);
  });

  it.each([
    [
      "missing",
      ["ghost"],
      "phases[3].dependsOn[0]",
      /"Phase A" \(a\) depends on missing phase ghost/,
    ],
    ["self", ["a"], "phases[3].dependsOn[0]", /"Phase A" \(a\) cannot depend on itself/],
    [
      "duplicate",
      ["b", "b"],
      "phases[3].dependsOn[1]",
      /"Phase A" \(a\) lists phase b more than once/,
    ],
    ["empty", [], "phases[3].dependsOn", /empty dependency list; omit dependsOn instead/],
    ["blank", [" "], "phases[3].dependsOn[0]", /expected a non-empty phase ID/],
    ["non-string", [7], "phases[3].dependsOn[0]", /expected a non-empty phase ID/],
    ["non-array", "b", "phases[3].dependsOn", /expected an array of phase IDs/],
  ])("rejects a %s link", async (_kind, links, path, message) => {
    const doc = await document();
    (phase(doc, "a") as { dependsOn?: unknown }).dependsOn = links;
    expectInvalid(doc, path, message);
  });

  it("rejects a present phase linking to a deleted phase", async () => {
    const doc = await document();
    remove(doc, "b");
    phase(doc, "a").dependsOn = ["b"];
    expectInvalid(
      doc,
      "phases[3].dependsOn[0]",
      /"Phase A" \(a\) depends on deleted phase "Phase B" \(b\)/,
    );
  });

  it("lets a deleted phase keep its link to another deleted phase", async () => {
    const doc = await document();
    phase(doc, "a").dependsOn = ["b"];
    remove(doc, "a");
    remove(doc, "b");
    expect(validateNotesDocumentV3(doc).ok).toBe(true);
    expect(phase(doc, "a").dependsOn).toEqual(["b"]);
  });

  it("rejects a two-phase circular chain and names it", async () => {
    const doc = await document();
    phase(doc, "a").dependsOn = ["b"];
    phase(doc, "b").dependsOn = ["a"];
    expectInvalid(
      doc,
      "phases[4].dependsOn[0]",
      /circular dependency chain: "Phase A" \(a\) → "Phase B" \(b\) → "Phase A" \(a\)/,
    );
  });

  it("rejects a three-phase circular chain and names it", async () => {
    const doc = await document();
    phase(doc, "a").dependsOn = ["b"];
    phase(doc, "b").dependsOn = ["c"];
    phase(doc, "c").dependsOn = ["phase-explicit-done", "a"];
    expectInvalid(
      doc,
      "phases[5].dependsOn[1]",
      /circular dependency chain: "Phase A" \(a\) → "Phase B" \(b\) → "Phase C" \(c\) → "Phase A" \(a\)/,
    );
  });

  it("detects cycles that pass through deleted phases", async () => {
    const doc = await document();
    phase(doc, "a").dependsOn = ["b"];
    phase(doc, "b").dependsOn = ["a"];
    expect(validateRoadmapPhaseDependencies(doc.phases)?.message).toMatch(/circular/);
    remove(doc, "a");
    remove(doc, "b");
    expectInvalid(doc, "phases[4].dependsOn[0]", /circular dependency chain/);
  });

  it("bounds long titles in messages", async () => {
    const doc = await document();
    phase(doc, "a").title = "x".repeat(4000);
    phase(doc, "a").dependsOn = ["ghost"];
    const result = validateNotesDocumentV3(doc);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message.length).toBeLessThan(200);
  });
});

describe("unfinished prerequisites", () => {
  it("counts only present Done phases as finished", async () => {
    const doc = await document();
    phase(doc, "b").archivedAt = now;
    phase(doc, "c").dependsOn = ["phase-migration-proof", "phase-schema-contract", "b", "a"];
    phase(doc, "phase-explicit-done").dependsOn = ["a"];
    expect(listUnfinishedPrerequisites(doc.phases, "c")?.map((p) => p.id)).toEqual([
      "phase-schema-contract",
      "b",
      "a",
    ]);
    expect(listUnfinishedPrerequisites(doc.phases, "a")).toEqual([]);
    expect(listUnfinishedPrerequisites(doc.phases, "ghost")).toBeNull();
  });

  it("treats a deleted prerequisite as unfinished even if it was Done", async () => {
    const doc = await document();
    phase(doc, "a").dependsOn = ["phase-migration-proof"];
    remove(doc, "a");
    remove(doc, "phase-migration-proof");
    expect(phase(doc, "phase-migration-proof").status).toBe("done");
    expect(listUnfinishedPrerequisites(doc.phases, "a")?.map((p) => p.id)).toEqual([
      "phase-migration-proof",
    ]);
  });
});

describe("deletion and recovery with dependency links", () => {
  it("refuses deleting a prerequisite of a present phase and names dependents", async () => {
    const doc = await document();
    phase(doc, "b").dependsOn = ["a"];
    phase(doc, "c").dependsOn = ["a"];
    const conflict = phaseDeletionDependencyConflict(doc.phases, "a", "delete");
    expect(conflict?.message).toMatch(/Cannot delete "Phase A" \(a\)/);
    expect(conflict?.message).toMatch(/"Phase B" \(b\), "Phase C" \(c\)/);
    expect(
      isPhaseDeletionOutcome({ status: "refused", reason: "dependency-links", ...conflict }),
    ).toBe(true);
    expect(phaseDeletionDependencyConflict(doc.phases, "b", "delete")).toBeNull();
    remove(doc, "b");
    remove(doc, "c");
    expect(phaseDeletionDependencyConflict(doc.phases, "a", "delete")).toBeNull();
  });

  it("refuses recovering a phase while its prerequisites stay deleted", async () => {
    const doc = await document();
    phase(doc, "b").dependsOn = ["a"];
    remove(doc, "b");
    remove(doc, "a");
    expect(phaseDeletionDependencyConflict(doc.phases, "b", "recover")?.message).toMatch(
      /Cannot recover "Phase B" \(b\).*"Phase A" \(a\)\. Recover that phase first\./,
    );
    expect(phaseDeletionDependencyConflict(doc.phases, "a", "recover")).toBeNull();
    remove(doc, "a", "recover");
    expect(phaseDeletionDependencyConflict(doc.phases, "b", "recover")).toBeNull();
    remove(doc, "b", "recover");
    expect(validateNotesDocumentV3(doc).ok).toBe(true);
  });

  it("keeps refusal messages within the outcome bound", async () => {
    const doc = await document();
    for (const candidate of doc.phases) candidate.title = "t".repeat(4000);
    for (const id of ["phase-schema-contract", "phase-explicit-done", "b", "c"]) {
      phase(doc, id).dependsOn = ["a"];
    }
    const conflict = phaseDeletionDependencyConflict(doc.phases, "a", "delete");
    expect(conflict!.message.length).toBeLessThanOrEqual(1024);
    expect(phaseDeletionDependencyConflict(doc.phases, "ghost", "delete")).toBeNull();
  });
});

const S1 = { sessionId: "s-1", sessionPath: "/sessions/s-1.jsonl" };
const S2 = { sessionId: "s-2", sessionPath: "/sessions/s-2.jsonl" };

function addOverride(
  target: NotesPhase,
  patch: Partial<{
    actor: "user" | "ken" | "ken-autopilot";
    origin: "app" | "automatic-advancement";
  }> = {},
): void {
  target.roadmapEvents.push({
    type: "dependency-override",
    id: `override-${target.roadmapEvents.length}`,
    actor: "user",
    origin: "app",
    session: S1,
    unfinishedPrerequisiteIds: [...(target.dependsOn ?? [])],
    timestamp: now,
    ...patch,
  });
}

async function startedByUser(): Promise<NotesDocumentV3> {
  const doc = await document();
  phase(doc, "c").dependsOn = ["a", "b"];
  phase(doc, "c").session = S1;
  addOverride(phase(doc, "c"));
  expect(validateNotesDocumentV3(doc).ok).toBe(true);
  return doc;
}

describe("agent start gate", () => {
  it("refuses unfinished prerequisites, naming them and pointing at the app", async () => {
    const doc = await document();
    phase(doc, "c").dependsOn = ["a", "b"];
    const refusal = agentPhaseStartRefusal(doc.phases, "c", S1);
    expect(refusal?.prerequisites).toEqual([
      { id: "a", title: "Phase A", status: "not-started" },
      { id: "b", title: "Phase B", status: "not-started" },
    ]);
    expect(refusal?.message).toBe(
      `Can't start "Phase C" (c): these prerequisite phases aren't Done: "Phase A" (a), "Phase B" (b). The user can start it from the app.`,
    );
  });

  it("allows phases without links, with finished prerequisites, or unknown ids", async () => {
    const doc = await document();
    expect(agentPhaseStartRefusal(doc.phases, "c", S1)).toBeNull();
    phase(doc, "c").dependsOn = ["phase-migration-proof"];
    expect(agentPhaseStartRefusal(doc.phases, "c", S1)).toBeNull();
    expect(agentPhaseStartRefusal(doc.phases, "ghost", S1)).toBeNull();
  });

  it("allows the session the user started from the app", async () => {
    const doc = await startedByUser();
    expect(findCurrentDependencyOverride(phase(doc, "c"))).toMatchObject({ actor: "user" });
    expect(agentPhaseStartRefusal(doc.phases, "c", S1)).toBeNull();
  });

  it("refuses a different session than the override and the phase", async () => {
    const doc = await startedByUser();
    expect(agentPhaseStartRefusal(doc.phases, "c", S2)).not.toBeNull();
    phase(doc, "c").session = S2;
    expect(agentPhaseStartRefusal(doc.phases, "c", S2)).not.toBeNull();
    expect(agentPhaseStartRefusal(doc.phases, "c", S1)).not.toBeNull();
  });

  it("never counts Ken, Autopilot Ken or automatic advancement starts", async () => {
    for (const patch of [
      { actor: "ken" as const },
      { actor: "ken-autopilot" as const },
      { origin: "automatic-advancement" as const },
    ]) {
      const doc = await startedByUser();
      addOverride(phase(doc, "c"), patch);
      expect(validateNotesDocumentV3(doc).ok).toBe(true);
      expect(findCurrentDependencyOverride(phase(doc, "c"))).toBeNull();
      expect(agentPhaseStartRefusal(doc.phases, "c", S1)).not.toBeNull();
    }
  });

  it("stops counting a start after a reopen", async () => {
    const doc = await startedByUser();
    phase(doc, "c").lifecycleEvents.push({
      id: "reopen",
      fromStatus: "done",
      toStatus: "planning",
      source: "user",
      timestamp: "2026-11-06T12:05:00.000Z",
      reason: "Reopened",
      kind: "other",
    });
    expect(findCurrentDependencyOverride(phase(doc, "c"))).toBeNull();
    expect(agentPhaseStartRefusal(doc.phases, "c", S1)).not.toBeNull();
  });

  it("stops counting a start after a rebind", async () => {
    const doc = await startedByUser();
    phase(doc, "c").roadmapEvents.push({
      type: "phase-binding",
      id: "rebind",
      action: "rebind-current",
      actor: "coding-session",
      previousSession: S2,
      session: S1,
      timestamp: "2026-11-06T12:05:00.000Z",
    });
    expect(findCurrentDependencyOverride(phase(doc, "c"))).toBeNull();
    expect(agentPhaseStartRefusal(doc.phases, "c", S1)).not.toBeNull();
  });

  it("stops counting a start after delete and recovery", async () => {
    const doc = await startedByUser();
    remove(doc, "c");
    remove(doc, "c", "recover");
    phase(doc, "c").session = S1;
    expect(findCurrentDependencyOverride(phase(doc, "c"))).toBeNull();
    expect(agentPhaseStartRefusal(doc.phases, "c", S1)).not.toBeNull();
  });

  it("keeps the refusal message bounded", async () => {
    const doc = await document();
    for (const candidate of doc.phases) candidate.title = "t".repeat(4000);
    phase(doc, "c").dependsOn = ["phase-schema-contract", "phase-explicit-done", "a", "b"];
    expect(agentPhaseStartRefusal(doc.phases, "c", S1)!.message.length).toBeLessThanOrEqual(1024);
  });
});

describe("draft, edit and move dependency checks", () => {
  it("accepts draft links to existing phases and to phases in the same draft", async () => {
    const doc = await document();
    expect(
      validateRoadmapDraftDependencies(doc.phases, [
        { id: "n1", title: "New 1", dependsOn: ["a"] },
        { id: "n2", title: "New 2", dependsOn: ["n1", "b"] },
        { id: "n3", title: "New 3" },
      ]),
    ).toBeNull();
  });

  it("rejects bad draft links with the same errors as saving", async () => {
    const doc = await document();
    const draft = [
      { id: "n1", title: "New 1", dependsOn: ["n2"] },
      { id: "n2", title: "New 2", dependsOn: ["n1"] },
    ];
    const error = validateRoadmapDraftDependencies(doc.phases, draft);
    expect(error?.message).toMatch(/circular dependency chain: "New 1" \(n1\) → "New 2" \(n2\)/);
    const saved = structuredClone(doc);
    for (const [offset, entry] of draft.entries()) {
      saved.phases.push({
        ...structuredClone(phase(doc, "a")),
        ...entry,
        order: doc.phases.length + offset,
      });
    }
    const result = validateNotesDocumentV3(saved);
    expect(result.ok ? null : result.error).toEqual(error);
    expect(
      validateRoadmapDraftDependencies(doc.phases, [{ id: "n1", title: "N", dependsOn: ["ghost"] }])
        ?.message,
    ).toMatch(/missing phase ghost/);
  });

  it("validates, clears and rejects edited links", async () => {
    const doc = await document();
    phase(doc, "b").dependsOn = ["a"];
    expect(validateRoadmapEditDependencies(doc.phases, "c", ["a", "b"])).toBeNull();
    expect(validateRoadmapEditDependencies(doc.phases, "b", [])).toBeNull();
    expect(validateRoadmapEditDependencies(doc.phases, "a", ["b"])?.message).toMatch(/circular/);
    expect(validateRoadmapEditDependencies(doc.phases, "a", ["a"])?.message).toMatch(/itself/);
  });

  it("warns when a move puts a phase above a prerequisite or below a dependent", async () => {
    const doc = await document();
    phase(doc, "b").dependsOn = ["a"];
    expect(roadmapOrderDependencyWarnings(doc.phases, ["a", "b", "c"], "b")).toEqual([]);
    expect(roadmapOrderDependencyWarnings(doc.phases, ["b", "a", "c"], "b")).toEqual([
      `"Phase B" (b) would sit above its prerequisite "Phase A" (a).`,
    ]);
    expect(roadmapOrderDependencyWarnings(doc.phases, ["b", "c", "a"], "a")).toEqual([
      `"Phase A" (a) would sit below "Phase B" (b), which depends on it.`,
    ]);
    expect(roadmapOrderDependencyWarnings(doc.phases, ["a", "b"], "ghost")).toEqual([]);
  });
});
