import { describe, expect, it, vi } from "vitest";
import { handlePhaseStartRoute, parsePhaseStartBody } from "./app-sidecar-phase-route.js";

describe("phase-start HTTP route", () => {
  it("returns the typed invalid-phase-id failure for malformed percent encoding", () => {
    const respond = vi.fn();
    const start = vi.fn();

    expect(
      handlePhaseStartRoute({
        method: "POST",
        url: "/phases/%E0%A4%A/start",
        host: "127.0.0.1",
        respond,
        start,
      }),
    ).toBe(true);
    expect(respond).toHaveBeenCalledExactlyOnceWith(400, {
      status: "failed",
      code: "invalid-phase-id",
      operationId: null,
      message: "The phase identifier is malformed.",
    });
    expect(start).not.toHaveBeenCalled();
  });

  it("accepts exactly the confirmed prerequisite ids body", () => {
    expect(parsePhaseStartBody({ confirmedPrerequisiteIds: [] })).toEqual({
      confirmedPrerequisiteIds: [],
    });
    expect(parsePhaseStartBody({ confirmedPrerequisiteIds: ["phase-a", "phase-b"] })).toEqual({
      confirmedPrerequisiteIds: ["phase-a", "phase-b"],
    });
  });

  it.each([
    ["no body", undefined],
    ["null", null],
    ["array", []],
    ["missing field", {}],
    ["extra field", { confirmedPrerequisiteIds: [], sessionId: "s" }],
    ["non-array", { confirmedPrerequisiteIds: "phase-a" }],
    ["empty id", { confirmedPrerequisiteIds: [""] }],
    ["non-string id", { confirmedPrerequisiteIds: [1] }],
    ["long id", { confirmedPrerequisiteIds: ["x".repeat(513)] }],
    ["too many", { confirmedPrerequisiteIds: Array.from({ length: 201 }, (_, i) => `p-${i}`) }],
  ])("rejects an invalid start body: %s", (_label, body) => {
    expect(parsePhaseStartBody(body)).toBeNull();
  });
});
