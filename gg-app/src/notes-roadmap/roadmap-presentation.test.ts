import { describe, expect, it } from "vitest";
import type { NotesPhase } from "../notes-types";
import { isManuallyDone, statusBeforeManualDone } from "./roadmap-presentation";

const NOW = "2026-08-10T12:00:00.000Z";

function phase(id: string, order: number): NotesPhase {
  return {
    id,
    title: id,
    goal: "goal",
    doneWhen: ["done"],
    order,
    status: "not-started",
    sourcePrompt: "prompt",
    referenceIds: [],
    session: null,
    reminder: null,
    attentionReason: null,
    createdAt: NOW,
    updatedAt: NOW,
    completedAt: null,
    archivedAt: null,
    overrides: { status: null, referenceIds: null },
    pendingAutomaticLifecycleTransition: null,
    lifecycleEvents: [],
    roadmapEvents: [],
  };
}

describe("manual Done reopen target", () => {
  const manualDone = (fromStatus: NotesPhase["status"] | null): NotesPhase => ({
    ...phase("alpha", 0),
    status: "done",
    completedAt: NOW,
    overrides: { status: { value: "done", source: "user", updatedAt: NOW }, referenceIds: null },
    lifecycleEvents: [
      {
        id: "to-done",
        fromStatus,
        toStatus: "done",
        source: "user",
        timestamp: NOW,
        reason: null,
        kind: "other",
      },
    ],
  });

  it("restores the status recorded before the manual Done", () => {
    expect(isManuallyDone(manualDone("in-progress"))).toBe(true);
    expect(statusBeforeManualDone(manualDone("in-progress"))).toBe("in-progress");
  });

  it("falls back to Not started when no earlier status was recorded", () => {
    expect(statusBeforeManualDone(manualDone(null))).toBe("not-started");
    expect(statusBeforeManualDone({ lifecycleEvents: [] })).toBe("not-started");
  });

  it("does not treat an agent-reported Done as manual", () => {
    expect(
      isManuallyDone({ ...manualDone("review"), overrides: { status: null, referenceIds: null } }),
    ).toBe(false);
  });
});
