import { describe, expect, it } from "vitest";
import {
  ACTIVE_PHASE_CONTEXT_CLEAR_KIND,
  ACTIVE_PHASE_CONTEXT_KIND,
  parseActivePhaseContextClear,
  type ActivePhaseContextV1,
} from "../phase-context.js";
import { SessionManager, type SessionEntry } from "./session-manager.js";

const context: ActivePhaseContextV1 = {
  version: 1,
  projectKey: "c:/work/project",
  phase: {
    id: "phase-1",
    title: "Bind phase",
    goal: "Transfer authority",
    doneWhen: ["Current session is authoritative"],
    sourcePrompt: null,
    status: "in-progress",
    archivedAt: null,
  },
  session: { sessionId: "session-a", sessionPath: "C:\\sessions\\a.jsonl" },
  references: [],
  executionStage: "implementing",
};

function marker(kind: string, data: unknown, id: string): SessionEntry {
  return {
    type: "custom",
    kind,
    data,
    id,
    parentId: null,
    timestamp: "2026-07-25T12:35:00.000Z",
  };
}

describe("durable active phase context markers", () => {
  it("restores the latest bind marker until an exact clear marker", () => {
    const manager = new SessionManager("C:\\sessions");
    const clear = {
      version: 1,
      projectKey: context.projectKey,
      phaseId: context.phase.id,
      reason: "phase-rebound",
    } as const;
    const entries = [
      marker(ACTIVE_PHASE_CONTEXT_KIND, context, "bind"),
      marker(ACTIVE_PHASE_CONTEXT_CLEAR_KIND, clear, "clear"),
    ];

    expect(
      manager.getActivePhaseContext(entries, {
        projectKey: context.projectKey,
        phaseId: context.phase.id,
      }),
    ).toBeUndefined();
    expect(parseActivePhaseContextClear(clear, context.projectKey)).toEqual(clear);
  });

  it("does not let another project or phase clear the restored context", () => {
    const manager = new SessionManager("C:\\sessions");
    const entries = [
      marker(ACTIVE_PHASE_CONTEXT_KIND, context, "bind"),
      marker(
        ACTIVE_PHASE_CONTEXT_CLEAR_KIND,
        {
          version: 1,
          projectKey: context.projectKey,
          phaseId: "phase-other",
          reason: "binding-reconciliation",
        },
        "other-clear",
      ),
    ];

    expect(
      manager.getActivePhaseContext(entries, {
        projectKey: context.projectKey,
        phaseId: context.phase.id,
      }),
    ).toEqual(context);
  });

  it("fails closed for malformed clear markers", () => {
    expect(
      parseActivePhaseContextClear({
        version: 1,
        projectKey: context.projectKey,
        phaseId: context.phase.id,
        reason: "attacker-chosen",
      }),
    ).toBeNull();
  });
});
