import { describe, expect, it, vi } from "vitest";
import { DECISION_SUMMARY_CONTEXT_MAX_BYTES, type DecisionSummaryContext } from "./app-sidecar-decision-summary.js";
import { handleDecisionSummaryRequest } from "./app-sidecar-decision-summary-route.js";

const oid = "a".repeat(40);
const context: DecisionSummaryContext = {
  version: 1,
  recordedAt: "2026-08-24T10:00:15.000Z",
  evidence: { merge: oid, base: oid, localParent: oid, upstreamParent: oid },
  truncated: false,
  decisions: [{
    area: "update",
    outcome: "combined",
    files: [{
      path: "update.ts", role: "implementation",
      diffs: {
        baseToLocal: { status: "available", text: "local", truncated: false },
        baseToUpstream: { status: "available", text: "upstream", truncated: false },
        baseToMerged: { status: "available", text: "merged", truncated: false },
      },
    }],
  }],
};
const sourceSession = { getState: () => ({ provider: "anthropic" as const, model: "test", cwd: "/repo" }) };

describe("decision summary route", () => {
  it("returns only the validated summary envelope", async () => {
    const summarize = vi.fn(async () => ({ version: 1 as const, summary: "A useful summary that is comfortably longer than forty characters." }));
    const response = await handleDecisionSummaryRequest(JSON.stringify(context), sourceSession, { summarize });
    expect(response).toEqual({ status: 200, body: await summarize.mock.results[0]!.value });
    expect(summarize).toHaveBeenCalledWith(sourceSession, context);
  });

  it.each(["", "{bad-json", JSON.stringify({ ...context, decisions: [] })])(
    "rejects malformed input before model creation",
    async (raw) => {
      const summarize = vi.fn();
      expect((await handleDecisionSummaryRequest(raw, sourceSession, { summarize })).status).toBe(400);
      expect(summarize).not.toHaveBeenCalled();
    },
  );

  it("rejects oversized input before model creation", async () => {
    const summarize = vi.fn();
    const response = await handleDecisionSummaryRequest("x".repeat(DECISION_SUMMARY_CONTEXT_MAX_BYTES + 1), sourceSession, { summarize });
    expect(response.status).toBe(413);
    expect(summarize).not.toHaveBeenCalled();
  });

  it("does not echo evidence when synthesis fails", async () => {
    const summarize = vi.fn(async () => { throw new Error("provider saw secret-source-text"); });
    const response = await handleDecisionSummaryRequest(JSON.stringify(context), sourceSession, { summarize });
    expect(response).toEqual({ status: 502, body: { error: "decision summary unavailable" } });
    expect(JSON.stringify(response)).not.toContain("secret-source-text");
  });
});
