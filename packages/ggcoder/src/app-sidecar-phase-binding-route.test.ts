import { describe, expect, it } from "vitest";
import type { PhaseBindingOutcome } from "@kenkaiiii/gg-core/phase-binding-protocol";
import {
  isPhaseBindingRoute,
  parsePhaseBindingBody,
  phaseBindingHttpStatus,
} from "./app-sidecar-phase-binding-route.js";

const body = {
  version: 1,
  action: "rebind-current",
  phaseId: "phase-1",
  expectedProjectKey: "c:/work/project",
  expectedRevision: 4,
  expectedPreviousSession: {
    sessionId: "session-a",
    sessionPath: "C:\\sessions\\a.jsonl",
  },
  operationId: "operation-1",
  confirmRebind: true,
};

describe("phase binding route", () => {
  it("matches only the exact POST path", () => {
    expect(isPhaseBindingRoute("POST", "/notes/roadmap/phase-binding?source=native")).toBe(true);
    expect(isPhaseBindingRoute("GET", "/notes/roadmap/phase-binding")).toBe(false);
    expect(isPhaseBindingRoute("POST", "/notes/roadmap/phase-binding/other")).toBe(false);
  });

  it("parses only the strict shared request body", () => {
    expect(parsePhaseBindingBody(body)).toEqual(body);
    expect(parsePhaseBindingBody({ ...body, destinationSession: { sessionId: "chosen" } })).toBeNull();
    expect(parsePhaseBindingBody({ ...body, confirmRebind: false })).toBeNull();
  });

  it.each([
    [{ status: "committed", revision: 5, phaseId: "phase-1", previousSession: body.expectedPreviousSession, session: body.expectedPreviousSession }, 200],
    [{ status: "already-bound", revision: 5, phaseId: "phase-1", session: body.expectedPreviousSession }, 200],
    [{ status: "phase-not-found" }, 404],
    [{ status: "missing" }, 404],
    [{ status: "stale-revision", revision: 5 }, 409],
    [{ status: "missing-session-path" }, 409],
    [{ status: "corrupt", primary: "malformed-json", backup: null }, 500],
  ] as const)("maps %o to HTTP %s", (outcome, status) => {
    expect(phaseBindingHttpStatus(outcome as PhaseBindingOutcome)).toBe(status);
  });
});
