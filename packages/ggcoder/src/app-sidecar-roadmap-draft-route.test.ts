import { describe, expect, it } from "vitest";
import {
  parseRoadmapPhaseDraftRejectBody,
  parseRoadmapPhaseDraftRoute,
  roadmapPhaseDraftApprovalHttpStatus,
  roadmapPhaseDraftRejectionHttpStatus,
} from "./app-sidecar-roadmap-draft-route.js";

describe("Roadmap draft route protocol", () => {
  it("strictly parses pending, encoded approval, and encoded rejection paths", () => {
    expect(parseRoadmapPhaseDraftRoute("GET", "/roadmap/phase-drafts/pending")).toEqual({
      status: "matched",
      route: { action: "pending" },
    });
    expect(
      parseRoadmapPhaseDraftRoute("POST", "/roadmap/phase-drafts/draft%2Fone/approve"),
    ).toEqual({ status: "matched", route: { action: "approve", draftId: "draft/one" } });
    expect(parseRoadmapPhaseDraftRoute("POST", "/roadmap/phase-drafts/draft%20one/reject")).toEqual(
      { status: "matched", route: { action: "reject", draftId: "draft one" } },
    );
    expect(parseRoadmapPhaseDraftRoute("POST", "/roadmap/phase-drafts/%/approve")).toEqual({
      status: "invalid-path",
    });
    expect(parseRoadmapPhaseDraftRoute("PUT", "/roadmap/phase-drafts/id/approve")).toEqual({
      status: "not-matched",
    });
  });

  it("accepts only optional bounded normalized rejection feedback", () => {
    expect(parseRoadmapPhaseDraftRejectBody("")).toEqual({ status: "ok", feedback: null });
    expect(parseRoadmapPhaseDraftRejectBody('{"feedback":"  revise this\\r\\nplan  "}')).toEqual({
      status: "ok",
      feedback: "revise this\nplan",
    });
    expect(parseRoadmapPhaseDraftRejectBody('{"feedback":null}')).toEqual({
      status: "ok",
      feedback: null,
    });
    expect(parseRoadmapPhaseDraftRejectBody('{"feedback":3}').status).toBe("invalid");
    expect(parseRoadmapPhaseDraftRejectBody('{"feedback":"ok","phases":[]}').status).toBe(
      "invalid",
    );
    expect(parseRoadmapPhaseDraftRejectBody("not-json").status).toBe("invalid");
    expect(
      parseRoadmapPhaseDraftRejectBody(JSON.stringify({ feedback: "x".repeat(4_097) })).status,
    ).toBe("invalid");
  });

  it("maps every typed decision outcome to a stable HTTP class", () => {
    expect(
      roadmapPhaseDraftApprovalHttpStatus({ status: "created", revision: 2, phaseIds: ["p"] }),
    ).toBe(200);
    expect(roadmapPhaseDraftApprovalHttpStatus({ status: "proposal-not-found" })).toBe(404);
    expect(
      roadmapPhaseDraftApprovalHttpStatus({
        status: "stale-revision",
        expectedRevision: 1,
        currentRevision: 2,
      }),
    ).toBe(409);
    expect(
      roadmapPhaseDraftApprovalHttpStatus({ status: "invalid-proposal", message: "bad" }),
    ).toBe(422);
    expect(roadmapPhaseDraftApprovalHttpStatus({ status: "storage-failed", message: "disk" })).toBe(
      500,
    );
    expect(roadmapPhaseDraftRejectionHttpStatus({ status: "rejected" })).toBe(200);
    expect(roadmapPhaseDraftRejectionHttpStatus({ status: "proposal-not-found" })).toBe(404);
    expect(roadmapPhaseDraftRejectionHttpStatus({ status: "proposal-project-mismatch" })).toBe(409);
  });
});
