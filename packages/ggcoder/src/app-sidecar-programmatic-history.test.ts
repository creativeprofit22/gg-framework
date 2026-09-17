import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isProgrammaticChatResponse } from "@kenkaiiii/gg-core/programmatic-chat-contract";
import { AppSidecarProgrammaticChat, type ProgrammaticChatTarget } from "./app-sidecar-programmatic-chat.js";
import { buildProgrammaticProfileProposal, persistProgrammaticProfile } from "./core/programmatic/profile.js";
import { readRecommendationHistory, updateRecommendationHistory, requireRecommendationHistoryPolicy } from "./core/programmatic/recommendation-history.js";
import { programmaticAssessmentResultV2Schema } from "./core/programmatic/contracts.js";
import { recommendationHistoryV1Schema } from "./core/programmatic/recommendation-contracts.js";
import { captureRecommendationAssessment, reconcileRecommendations, type CapturedRecommendationAssessment } from "./core/programmatic/recommendations.js";
import { sha256 } from "./core/tauri-package/paths.js";
const roots: string[] = [], at = "2026-09-16T00:00:00.000Z";
function capture(trigger = "Entries changed"): CapturedRecommendationAssessment {
  return { assessment: { version: 1, id: randomUUID(), startedAt: at, finishedAt: at, mode: "configured", outcome: "completed", hostCoverage: [] },
    observations: [{ version: 1, outcome: "Review entries", rationale: "Local workflow", uncertainty: "Not verified",
      workflow: { trigger, representativeCase: "New entry", inputs: ["Entries"], currentProcess: ["Review"], output: "Report", successCheck: "Compare entries",
        affectedSubproject: { scope: "repository-wide" }, mutationBoundary: "Read only", repeatability: { basis: "inferred", explanation: "Entries change" } },
      choice: { kind: "manual", steps: ["Review separately"] }, alternatives: [], evidence: [] }] };
}
async function fixture(initial = capture()) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "gg-history-adapter-")); roots.push(cwd);
  const proposal = await buildProgrammaticProfileProposal(cwd, { offerHistory: true });
  expect((await persistProgrammaticProfile(cwd, proposal.configurationFingerprint, proposal.profile, {
    historyPolicy: proposal.historyPolicy, expectedRecoveryDigest: proposal.expectedRecoveryDigest,
  })).ok).toBe(true);
  const digest = sha256(await readFile(path.join(cwd, ".gg/programmatic/profile.json")));
  const append = (input = capture()) => updateRecommendationHistory(cwd, (root) => requireRecommendationHistoryPolicy(root, digest),
    (history) => reconcileRecommendations(history, input).history);
  const saved = await append(initial);
  const target: ProgrammaticChatTarget = { identity: "session-a", cwd, codeMode: true, planMode: false, busy: false };
  let claimed = false;
  const adapter = new AppSidecarProgrammaticChat(() => target, () => { if (claimed) return false; claimed = true; return true; }, () => { claimed = false; });
  const candidate = saved.history.candidates[0]!;
  const inspect = async () => {
    const result = await adapter.handle({ version: 1, action: "history-inspect-decision", candidateId: candidate.id, expectedRevision: 1, decision: "completed" });
    expect(result.status).toBe(200); expect(isProgrammaticChatResponse(result.body)).toBe(true);
    if (!("review" in result.body)) throw new Error("Expected review");
    return result.body.review;
  };
  return { cwd, target, adapter, candidate, inspect, append };
}
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
describe("authenticated host history interfaces", () => {
  it.each([51, 100, 101])("returns bounded reversible pages for %i saved candidates without changing storage", async (total) => {
    const { cwd, adapter, append, candidate } = await fixture();
    for (let start = 1; start < total; start += 10) {
      const input = capture();
      input.observations = Array.from({ length: Math.min(10, total - start) }, (_, index) =>
        capture(`Unique trigger ${start + index}`).observations[0]!);
      await append(input);
    }
    const file = path.join(cwd, ".gg/programmatic/recommendations.json"), before = await readFile(file);
    const stored = recommendationHistoryV1Schema.parse(JSON.parse(before.toString("utf8")));
    const offsets = total === 101 ? [0, 50, 0, 50, 100, 50] : [0, 50, 0];
    for (const offset of offsets) {
      const result = await adapter.handle({ version: 1, action: "history-report", offset });
      expect(result.status).toBe(200);
      expect(isProgrammaticChatResponse(result.body)).toBe(true);
      if (!("report" in result.body) || result.body.action !== "history-report") throw new Error("Expected history report");
      expect(result.body.report).toMatchObject({ offset, total, status: "ready" });
      expect(result.body.report.candidates.map((item) => item.id)).toEqual(stored.candidates.slice(offset, offset + 50).map((item) => item.id));
      expect(result.body.report.candidates).toHaveLength(Math.min(50, total - offset));
      expect(result.body.report.candidates.every((item) => !("records" in item) && !("discovery" in item))).toBe(true);
    }
    const detail = await adapter.handle({ version: 1, action: "history-detail", candidateId: candidate.id, offset: 0 });
    expect(isProgrammaticChatResponse(detail.body)).toBe(true);
    expect(detail.body).toMatchObject({ detail: { candidate: { id: candidate.id }, records: [{ kind: "observation" }] } });
    for (const offset of [-1, 1.5, 1_001]) {
      expect((await adapter.handle({ version: 1, action: "history-report", offset })).status).toBe(400);
    }
    expect(await readFile(file)).toEqual(before);
  });
  it.each(["\n", "\r", "\t", "\r\n\t"])("accepts actual history projections with advisory whitespace %j without rewriting records", async (separator) => {
    const outcome = `Review entries${separator}by package <b>as plain text</b>`;
    const input = capture();
    const accepted = programmaticAssessmentResultV2Schema.parse({ version: 2, kind: "advisory",
      coverage: { status: "limited", scope: "Fixture", reason: "Bounded inspection" },
      recommendations: [{ ...input.observations[0], version: 2, kind: "advisory", outcome, evidence: { version: 1, items: [] } }] });
    const captured = captureRecommendationAssessment({ id: input.assessment.id, startedAt: at }, {
      version: 1, mode: "configured", status: "completed", summary: "Fixture", limitations: [], coverage: [], observations: [],
      deterministic: { status: "unavailable", reason: "Fixture" },
    }, accepted, [], at);
    const { cwd, adapter, candidate, append } = await fixture(captured);
    await append({ ...captured, assessment: { ...captured.assessment, id: randomUUID() },
      observations: captured.observations.map((observation) => ({ ...observation, workflow: { ...observation.workflow, trigger: "Other trigger" } })) });
    const file = path.join(cwd, ".gg/programmatic/recommendations.json");
    const before = await readFile(file);
    const history = recommendationHistoryV1Schema.parse(JSON.parse(before.toString("utf8")));
    const other = history.candidates.find((entry) => entry.id !== candidate.id)!;
    const observation = history.observations.find((entry) => entry.candidateId === candidate.id)!;
    expect(observation.outcome).toBe(outcome);
    const requests = [
      { version: 1, action: "history-report", offset: 0 },
      { version: 1, action: "history-detail", candidateId: candidate.id, offset: 0 },
      { version: 1, action: "history-inspect-decision", candidateId: candidate.id, expectedRevision: 1, decision: "completed" },
      { version: 1, action: "history-inspect-correspondence", candidateId: candidate.id, expectedRevision: 1, otherId: other.id, otherExpectedRevision: 1 },
    ];
    for (const request of requests) {
      const result = await adapter.handle(request);
      expect(result.status).toBe(200);
      expect(isProgrammaticChatResponse(result.body), request.action).toBe(true);
      const body = result.body;
      if ("report" in body && body.action === "history-report") expect(body.report.candidates.every((entry) => entry.outcome === outcome)).toBe(true);
      if ("detail" in body && body.action === "history-detail") {
        expect(body.detail?.candidate.outcome).toBe(outcome);
        expect(body.detail?.records[0]?.displayJson).toBe(JSON.stringify(observation));
      }
      if ("review" in body) {
        expect(body.review.candidates.every((entry) => entry.outcome === outcome)).toBe(true);
        expect(body.review.details[0]).toBe(JSON.stringify({ observation }));
      }
      for (const code of Array.from({ length: 160 }, (_, code) => code)
        .filter((code) => (code < 32 && ![9, 10, 13].includes(code)) || code >= 127)) {
        const invalidOutcome = `Review${String.fromCharCode(code)}entries`;
        expect(programmaticAssessmentResultV2Schema.safeParse({ ...accepted,
          recommendations: accepted.recommendations.map((item) => ({ ...item, outcome: invalidOutcome })) }).success).toBe(false);
        expect(recommendationHistoryV1Schema.safeParse({ ...history,
          observations: history.observations.map((item) => ({ ...item, outcome: invalidOutcome })) }).success).toBe(false);
        const invalid = structuredClone(body);
        if ("report" in invalid && invalid.action === "history-report") invalid.report.candidates[0]!.outcome = invalidOutcome;
        if ("detail" in invalid && invalid.action === "history-detail") invalid.detail!.candidate.outcome = invalidOutcome;
        if ("review" in invalid) invalid.review.candidates[0]!.outcome = invalidOutcome;
        expect(isProgrammaticChatResponse(invalid), `${request.action}: control ${code}`).toBe(false);
      }
    }
    expect(await readFile(file)).toEqual(before);
  });
  it("reads bounded history/detail, inspects without writing, applies a single-use user-declared decision", async () => {
    const { cwd, adapter, candidate, inspect } = await fixture();
    const before = await readFile(path.join(cwd, ".gg/programmatic/recommendations.json"));
    const report = await adapter.handle({ version: 1, action: "history-report", offset: 0 });
    expect(report.status).toBe(200); expect(isProgrammaticChatResponse(report.body)).toBe(true);
    expect(report.body).toMatchObject({ report: { status: "ready", total: 1, candidates: [{ id: candidate.id, decision: "open" }] } });
    const detail = await adapter.handle({ version: 1, action: "history-detail", candidateId: candidate.id, offset: 0 });
    expect(isProgrammaticChatResponse(detail.body)).toBe(true);
    expect(detail.body).toMatchObject({ detail: { total: 2, records: [{ kind: "observation" }] } });
    const assessment = await adapter.handle({ version: 1, action: "history-detail", candidateId: candidate.id, offset: 1 });
    expect(assessment.body).toMatchObject({ detail: { records: [{ kind: "assessment" }] } });
    const review = await inspect();
    expect(review.warning).toContain("user-declared, not verified");
    expect(await readFile(path.join(cwd, ".gg/programmatic/recommendations.json"))).toEqual(before);
    expect((await adapter.handle({ version: 1, action: "history-apply", reviewId: review.reviewId })).status).toBe(200);
    expect((await adapter.handle({ version: 1, action: "history-apply", reviewId: review.reviewId })).status).toBe(409);
    const stored = await readRecommendationHistory(cwd);
    expect(stored).toMatchObject({ status: "ready", history: { decisions: [{ decision: "completed", completion: "user-declared" }] } });
  });
  it.each(["owner", "project", "reset", "dispose", "revision", "policy"] as const)("refuses %s changes after inspection", async (change) => {
    const { cwd, adapter, target, inspect, append } = await fixture(), review = await inspect();
    if (change === "owner") target.identity = "session-b";
    if (change === "project") { target.cwd = await mkdtemp(path.join(os.tmpdir(), "gg-other-project-")); roots.push(target.cwd); }
    if (change === "reset") adapter.reset();
    if (change === "dispose") adapter.dispose();
    if (change === "revision") await append();
    if (change === "policy") {
      const file = path.join(cwd, ".gg/programmatic/profile.json"), profile = JSON.parse(await readFile(file, "utf8"));
      profile.historyPolicy.enabled = false; await writeFile(file, JSON.stringify(profile));
    }
    const before = await readFile(path.join(cwd, ".gg/programmatic/recommendations.json"));
    expect((await adapter.handle({ version: 1, action: "history-apply", reviewId: review.reviewId })).status).toBe(change === "dispose" ? 403 : 409);
    expect(await readFile(path.join(cwd, ".gg/programmatic/recommendations.json"))).toEqual(before);
  });
  it("preserves read-only plan access and denies review/apply outside Code mode or under a run claim", async () => {
    const { adapter, target, candidate, inspect } = await fixture(), review = await inspect();
    target.planMode = true;
    expect((await adapter.handle({ version: 1, action: "history-report", offset: 0 })).status).toBe(200);
    expect((await adapter.handle({ version: 1, action: "history-inspect-decision", candidateId: candidate.id, expectedRevision: 1, decision: "dismissed" })).status).toBe(403);
    expect((await adapter.handle({ version: 1, action: "history-apply", reviewId: review.reviewId })).status).toBe(403);
    target.planMode = false; target.codeMode = false;
    expect((await adapter.handle({ version: 1, action: "history-apply", reviewId: review.reviewId })).status).toBe(403);
    target.codeMode = true; target.busy = true;
    expect((await adapter.handle({ version: 1, action: "history-report", offset: 0 })).status).toBe(409);
  });
  it("requires two inspected revisions for human-confirmed correspondence, retaining both records", async () => {
    const { cwd, adapter, candidate, append } = await fixture();
    const later = await append(capture("Paraphrased trigger")), other = later.history.candidates.find((c) => c.id !== candidate.id)!;
    const request = { version: 1, action: "history-inspect-correspondence", candidateId: candidate.id, expectedRevision: 1, otherId: other.id, otherExpectedRevision: 1 };
    expect((await adapter.handle({ ...request, expectedRevision: 2 })).status).toBe(409);
    const inspected = await adapter.handle(request);
    expect(isProgrammaticChatResponse(inspected.body)).toBe(true);
    if (!("review" in inspected.body)) throw new Error("Expected review");
    expect(inspected.body.review.candidates).toHaveLength(2);
    expect((await adapter.handle({ version: 1, action: "history-apply", reviewId: inspected.body.review.reviewId })).status).toBe(200);
    const stored = await readRecommendationHistory(cwd);
    if (stored.status !== "ready") throw new Error("Expected saved history");
    expect(stored.history.candidates).toHaveLength(2);
    expect(stored.history.correspondences).toHaveLength(1);
    expect(stored.history.observations[1]!.candidateId).toBe(other.id);
  });
  it("rejects executable, oversized and fake authority-bearing requests", async () => {
    const { adapter } = await fixture();
    for (const field of ["body", "tools", "approval", "evidence", "route", "snapshot"]) {
      expect((await adapter.handle({ version: 1, action: "history-apply", reviewId: randomUUID(), [field]: "forged" })).status).toBe(400);
    }
    expect((await adapter.handle({ version: 1, action: "history-apply", reviewId: "x".repeat(2_049) })).status).toBe(400);
  });
});
