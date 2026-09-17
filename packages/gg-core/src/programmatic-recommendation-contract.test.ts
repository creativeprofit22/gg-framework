import { describe, expect, it } from "vitest";
import { isRecommendationHistoryReport, isRecommendationHistoryRequest, isRecommendationSaveStatus, isRecommendationSummary, isRecommendationDetail, isRecommendationReview } from "./programmatic-recommendation-contract.js";

const id = "54df729b-2d8c-4a9f-abdc-ae6584a70742";
const other = "ad5bb9ba-4d86-485a-8d74-613fe59b12df";
const row = { id, revision: 1, outcome: "Review entries", decision: "open", ambiguity: "none", observationCount: 1 };
describe("browser-safe recommendation boundary", () => {
  it.each(["\n", "\r", "\t", "\r\n\t"])("accepts advisory whitespace %j only in outcome text", (separator) => {
    const outcome = `Review entries${separator}by package`;
    expect(isRecommendationSummary({ ...row, outcome })).toBe(true);
    expect(isRecommendationSummary({ ...row, id: outcome })).toBe(false);
    expect(isRecommendationSaveStatus({ status: "unsaved", assessmentId: id, reason: outcome })).toBe(false);
  });
  it("matches advisory outcome text bounds and forbidden controls", () => {
    expect(isRecommendationSummary({ ...row, outcome: "界".repeat(4_000) })).toBe(true);
    for (const outcome of ["", " \n\r\t", "a".repeat(4_001), ...Array.from({ length: 160 }, (_, code) => code)
      .filter((code) => (code < 32 && ![9, 10, 13].includes(code)) || code >= 127)
      .map((code) => `Review${String.fromCharCode(code)}entries`)]) {
      expect(isRecommendationSummary({ ...row, outcome }), JSON.stringify(outcome)).toBe(false);
    }
  });
  it("bounds detail pages and exact review projections without accepting executable fields", () => {
    const detail = { version: 1, historyRevision: 1, candidate: row, offset: 0, total: 1,
      records: [{ id, kind: "observation", displayJson: '{"outcome":"Historical text only"}' }] };
    expect(isRecommendationDetail(detail)).toBe(true);
    expect(isRecommendationDetail({ ...detail, records: [...detail.records, ...detail.records] })).toBe(false);
    expect(isRecommendationDetail({ ...detail, records: [{ ...detail.records[0], displayJson: "x".repeat(262_145) }] })).toBe(false);
    const review = { version: 1, reviewId: id, historyRevision: 1, operation: "completed", candidates: [row], details: ["Historical record"], warning: "User-declared, not verified" };
    expect(isRecommendationReview(review)).toBe(true);
    expect(isRecommendationReview({ ...review, operation: "correspondence" })).toBe(false);
    expect(isRecommendationReview({ ...review, approved: true })).toBe(false);
    expect(isRecommendationReview({ ...review, candidates: [{ ...row, route: {} }] })).toBe(false);
  });
  it("accepts bounded summaries and paged historical status", () => {
    expect(isRecommendationSummary(row)).toBe(true);
    expect(isRecommendationHistoryReport({ version: 1, status: "recovered", revision: 1, total: 1, offset: 0, candidates: [row], warning: "Previous revision; not repaired" })).toBe(true);
    expect(isRecommendationHistoryReport({ version: 1, status: "ready", revision: 1, total: 1, offset: 1, candidates: [row] })).toBe(false);
  });
  it.each(["approval", "receipt", "tools", "route", "body", "snapshot"])("rejects authority field %s", (key) => {
    expect(isRecommendationSummary({ ...row, [key]: "forged" })).toBe(false);
    expect(isRecommendationHistoryRequest({ action: "history-apply", reviewId: id, [key]: "forged" })).toBe(false);
  });
  it("accepts only compact review requests with IDs/revisions", () => {
    const requests = [
      { action: "history-report", offset: 0 }, { action: "history-detail", candidateId: id, offset: 0 },
      { action: "history-inspect-decision", candidateId: id, expectedRevision: 1, decision: "completed" },
      { action: "history-inspect-correspondence", candidateId: id, expectedRevision: 1, otherId: other, otherExpectedRevision: 2 },
      { action: "history-apply", reviewId: id },
    ];
    for (const request of requests) {
      expect(isRecommendationHistoryRequest(request)).toBe(true);
      expect(new TextEncoder().encode(JSON.stringify(request)).length).toBeLessThan(2_048);
    }
    expect(isRecommendationHistoryRequest({ ...requests[3], otherId: id })).toBe(false);
    expect(isRecommendationHistoryRequest({ ...requests[2], expectedRevision: 0 })).toBe(false);
    expect(isRecommendationHistoryRequest({ action: "history-report", offset: 1_001 })).toBe(false);
    expect(isRecommendationHistoryRequest({ action: "history-apply", reviewId: "x".repeat(3_000) })).toBe(false);
  });
  it("separates save failure from completed assessment status", () => {
    expect(isRecommendationSaveStatus({ status: "saved", assessmentId: id, historyRevision: 1 })).toBe(true);
    expect(isRecommendationSaveStatus({ status: "unsaved", assessmentId: id, reason: "Capacity exceeded" })).toBe(true);
    expect(isRecommendationSaveStatus({ status: "acknowledgement-unknown", assessmentId: id, reason: "Read before retry" })).toBe(true);
    expect(isRecommendationSaveStatus({ status: "setup-not-saved" })).toBe(true);
    expect(isRecommendationSaveStatus({ status: "disabled", assessmentId: id })).toBe(false);
    expect(isRecommendationSaveStatus({ status: "saved", assessmentId: "detector-key", historyRevision: 1 })).toBe(false);
  });
});
