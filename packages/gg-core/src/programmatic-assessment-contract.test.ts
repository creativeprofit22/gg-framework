import { describe, expect, it } from "vitest";
import {
  isProgrammaticAssessment,
  isProgrammaticAssessmentEvent,
  type ProgrammaticAssessment,
} from "./programmatic-assessment-contract.js";

const assessment: ProgrammaticAssessment = {
  version: 1,
  mode: "configured",
  status: "completed",
  summary: "Scoped workflow assessment, not a clean bill of health.",
  limitations: ["Only delivered evidence was assessed."],
  coverage: [{ scope: "project", status: "inspected", summary: "Read WORKFLOW." }],
  observations: [
    {
      basis: "inferred",
      message: "Dispatch needs reconciliation.",
      evidenceSources: ["receipt-1"],
    },
  ],
  deterministic: { status: "succeeded", enabledCount: 0, applicableCount: 0 },
};

describe("bounded assessment display contract", () => {
  it("bounds completion receipts and rejects mismatched event correlation", () => {
    const lifecycle = {
      conversationId: "chat",
      sessionId: "session",
      sequence: 2,
      requestId: "request-1",
    };
    const completed = { ...assessment, lifecycle };
    expect(isProgrammaticAssessment(completed)).toBe(true);
    expect(isProgrammaticAssessmentEvent({ ...lifecycle, phase: "started" })).toBe(true);
    expect(
      isProgrammaticAssessmentEvent({ ...lifecycle, phase: "completed", assessment: completed }),
    ).toBe(true);
    for (const patch of [
      { sequence: 0 },
      { sequence: 1.5 },
      { sessionId: "" },
      { conversationId: "x".repeat(257) },
      { requestId: "" },
      { requestId: "x".repeat(129) },
      { requestId: "bad id" },
      { approved: true },
    ])
      expect(
        isProgrammaticAssessment({ ...assessment, lifecycle: { ...lifecycle, ...patch } }),
      ).toBe(false);
    for (const patch of [
      { sequence: 3 },
      { sessionId: "other" },
      { conversationId: "other" },
      { requestId: "other" },
    ])
      expect(
        isProgrammaticAssessmentEvent({
          ...lifecycle,
          ...patch,
          phase: "completed",
          assessment: completed,
        }),
      ).toBe(false);
  });
  it("adds history status without changing legacy assessment or scanner success", () => {
    expect(isProgrammaticAssessment(assessment)).toBe(true);
    const history = {
      status: "unsaved",
      assessmentId: "54df729b-2d8c-4a9f-abdc-ae6584a70742",
      reason: "Capacity exceeded",
    };
    expect(isProgrammaticAssessment({ ...assessment, history })).toBe(true);
    expect(
      isProgrammaticAssessment({ ...assessment, history: { ...history, approved: true } }),
    ).toBe(false);
  });
  it("validates host lifecycle identity and rejects authority or recommendations on events", () => {
    const identity = { conversationId: "chat", sessionId: "session", sequence: 1 };
    const started = { ...identity, phase: "started" };
    const completed = { ...identity, phase: "completed", assessment };
    expect(isProgrammaticAssessmentEvent(started)).toBe(true);
    expect(isProgrammaticAssessmentEvent(completed)).toBe(true);
    for (const invalid of [
      { ...started, assessment },
      { ...completed, proposalHandle: "a".repeat(64) },
      { ...completed, recommendations: [] },
      { ...completed, assessment: { ...assessment, approved: true } },
      { ...completed, sequence: 0 },
      { ...completed, sequence: 1.5 },
      { ...completed, conversationId: "" },
      { ...completed, sessionId: "x".repeat(257) },
    ])
      expect(isProgrammaticAssessmentEvent(invalid)).toBe(false);
  });
  it.each(["completed", "incomplete", "unavailable", "cancelled"] as const)(
    "keeps %s independent of scanner outcomes",
    (status) => {
      for (const deterministic of [
        { status: "succeeded", enabledCount: 0, applicableCount: 0 },
        ...["unavailable", "denied", "cancelled", "failed"].map((status) => ({
          status,
          reason: "Independent scanner limitation.",
        })),
      ])
        expect(isProgrammaticAssessment({ ...assessment, status, deterministic })).toBe(true);
      expect(
        isProgrammaticAssessment({
          ...assessment,
          mode: "setup",
          status,
          deterministic: { status: "not-run", reason: "setup" },
        }),
      ).toBe(true);
    },
  );
  it.each([
    "inspected",
    "uninspected",
    "budget-limited",
    "unreadable",
    "unsafe",
    "nonmatching",
    "not-applicable",
  ])("distinguishes %s project and catalog coverage", (status) => {
    for (const scope of ["project", "catalog"]) {
      expect(
        isProgrammaticAssessment({
          ...assessment,
          coverage: [{ scope, status, summary: "Scoped evidence." }],
        }),
      ).toBe(true);
    }
  });
  it("accepts exact bounds and existing validated focus without requiring recommendations", () => {
    expect(
      isProgrammaticAssessment({
        ...assessment,
        focus: "x".repeat(4000),
        summary: "x".repeat(4000),
        limitations: Array(50).fill("Limited"),
        coverage: Array(50).fill(assessment.coverage[0]),
        observations: Array(50).fill({
          ...assessment.observations[0],
          evidenceSources: Array.from({ length: 50 }, (_, i) => `${i}`.padEnd(100, "x")),
        }),
        deterministic: { status: "succeeded", enabledCount: 64, applicableCount: 64 },
      }),
    ).toBe(true);
    expect(isProgrammaticAssessment({ ...assessment, observations: [], coverage: [] })).toBe(true);
  });
  it.each([
    null,
    [],
    {},
    { ...assessment, version: 2 },
    { ...assessment, status: "success" },
    { ...assessment, mode: "model-selected" },
    { ...assessment, proposalHandle: "a".repeat(64) },
    { ...assessment, recommendations: [] },
    { ...assessment, focus: " " },
    { ...assessment, focus: "x".repeat(4001) },
    { ...assessment, focus: "bad\u007f" },
    { ...assessment, focus: undefined },
    { ...assessment, summary: "x".repeat(4001) },
    { ...assessment, summary: "bad\u0000" },
    { ...assessment, limitations: Array(51).fill("x") },
    { ...assessment, limitations: ["x".repeat(4001)] },
    { ...assessment, coverage: Array(51).fill(assessment.coverage[0]) },
    { ...assessment, observations: Array(51).fill(assessment.observations[0]) },
    { ...assessment, mode: "setup" },
    { ...assessment, deterministic: { status: "not-run", reason: "setup" } },
  ])("rejects malformed, oversized or authority-bearing envelopes %#", (value) => {
    expect(isProgrammaticAssessment(value)).toBe(false);
  });
  it.each([
    { status: "succeeded" },
    { status: "succeeded", enabledCount: 0, applicableCount: 1 },
    ...[-1, 0.5, 65, NaN, Infinity].map((enabledCount) => ({
      status: "succeeded",
      enabledCount,
      applicableCount: 0,
    })),
    { status: "succeeded", enabledCount: 1, applicableCount: -1 },
    { status: "succeeded", enabledCount: 0, applicableCount: 0, reason: "Advice submitted" },
    { status: "failed", reason: "" },
    { status: "denied", reason: "x".repeat(4001) },
    { status: "failed", reason: "Failed", enabledCount: 1 },
    { status: "complete", reason: "Done" },
  ])("rejects invalid deterministic outcome %#", (deterministic) => {
    expect(isProgrammaticAssessment({ ...assessment, deterministic })).toBe(false);
  });
  it.each([
    { scope: "all", status: "inspected", summary: "All" },
    { scope: "project", status: "complete", summary: "All" },
    { scope: "catalog", status: "inspected", summary: "All", projectCovered: true },
    { scope: "project", status: "unsafe", summary: "x".repeat(4001) },
  ])("rejects invalid coverage %#", (coverage) => {
    expect(isProgrammaticAssessment({ ...assessment, coverage: [coverage] })).toBe(false);
  });
  it.each([
    { evidenceSources: [] },
    { evidenceSources: ["same", "same"] },
    { evidenceSources: ["x".repeat(101)] },
    { evidenceSources: Array.from({ length: 51 }, (_, i) => `${i}`) },
    { evidenceSources: ["bad\u0080"] },
    { basis: "verified" },
    { message: "x".repeat(4001) },
    { run: true },
    { proposal: {} },
  ])("rejects invalid or unauthenticated observation display %#", (patch) => {
    expect(
      isProgrammaticAssessment({
        ...assessment,
        observations: [{ ...assessment.observations[0], ...patch }],
      }),
    ).toBe(false);
  });
});

describe("area progress contract", () => {
  const identity = { conversationId: "chat", sessionId: "session", sequence: 1 };
  const find = { need: "Release notes drift", where: "docs/", unsure: "Owner unclear" };
  const area = { id: "src/core", label: "src/core", status: "found", finds: [find] };
  const progress = { ...identity, phase: "progress", stage: "areas", areas: [area] };

  it("accepts bounded progress snapshots and the merging stage", () => {
    expect(isProgrammaticAssessmentEvent(progress)).toBe(true);
    expect(isProgrammaticAssessmentEvent({ ...progress, stage: "merging" })).toBe(true);
    for (const status of ["waiting", "reading", "found", "partly", "failed", "stopped"])
      expect(
        isProgrammaticAssessmentEvent({ ...progress, areas: [{ id: "a", label: "a", status }] }),
      ).toBe(true);
    const six = Array.from({ length: 6 }, (_, i) => ({
      id: `a${i}`,
      label: "x".repeat(120),
      status: "partly",
      finds: [find, find, find].map(() => ({
        need: "x".repeat(280),
        where: "x".repeat(280),
        unsure: "x".repeat(280),
      })),
    }));
    expect(isProgrammaticAssessmentEvent({ ...progress, areas: six })).toBe(true);
  });

  it("rejects oversize, unknown keys, duplicate ids and finds on unfinished areas", () => {
    for (const invalid of [
      { ...progress, stage: "done" },
      { ...progress, assessment },
      { ...progress, areas: Array.from({ length: 7 }, (_, i) => ({ ...area, id: `a${i}` })) },
      { ...progress, areas: [area, area] },
      { ...progress, areas: [{ ...area, id: "" }] },
      { ...progress, areas: [{ ...area, id: "x".repeat(129) }] },
      { ...progress, areas: [{ ...area, label: "x".repeat(121) }] },
      { ...progress, areas: [{ ...area, status: "approved" }] },
      { ...progress, areas: [{ ...area, approved: true }] },
      { ...progress, areas: [{ ...area, finds: [find, find, find, find] }] },
      { ...progress, areas: [{ ...area, finds: [{ ...find, need: "x".repeat(281) }] }] },
      { ...progress, areas: [{ ...area, finds: [{ ...find, review: true }] }] },
      { ...progress, areas: [{ ...area, status: "reading" }] },
      { ...progress, areas: [{ ...area, status: "waiting" }] },
      { ...progress, sequence: 0 },
    ])
      expect(isProgrammaticAssessmentEvent(invalid)).toBe(false);
  });

  it("adds optional per-area status to assessments without breaking legacy payloads", () => {
    const areas = [
      { id: "src", label: "src", status: "searched", retryable: false },
      { id: "docs", label: "docs", status: "partly", reason: "sample-limit", retryable: false },
      { id: "app", label: "app", status: "not-searched", reason: "timed-out", retryable: true },
    ];
    expect(isProgrammaticAssessment(assessment)).toBe(true);
    expect(isProgrammaticAssessment({ ...assessment, areas })).toBe(true);
    expect(isProgrammaticAssessment({ ...assessment, areas: [] })).toBe(true);
    const many = Array.from({ length: 24 }, (_, i) => ({ ...areas[0], id: `a${i}` }));
    expect(isProgrammaticAssessment({ ...assessment, areas: many })).toBe(true);
    for (const invalid of [
      [...many, { ...areas[0], id: "a24" }],
      [areas[0], areas[0]],
      [{ ...areas[0], retryable: true }],
      [{ ...areas[1], retryable: true }],
      [{ ...areas[2], reason: "model-said-so" }],
      [{ ...areas[0], retryable: "yes" }],
      [{ id: "src", label: "src", status: "searched" }],
      [{ ...areas[0], finds: [] }],
    ])
      expect(isProgrammaticAssessment({ ...assessment, areas: invalid })).toBe(false);
  });
});
