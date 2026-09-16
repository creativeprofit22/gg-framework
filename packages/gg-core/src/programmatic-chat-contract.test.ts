import { describe, expect, it } from "vitest";
import {
  isProgrammaticChatRelativePath,
  isProgrammaticExecutionResult,
  isProgrammaticChatRequest,
  isProgrammaticChatResponse,
} from "./programmatic-chat-contract.js";

describe("execution result display boundary", () => {
  const item = { basis: "observed", source: "programmatic-execution", code: "tool-completed", severity: "info", message: "Tool read completed (manifest)." };
  const result = { version: 1, status: "succeeded", summary: "Summary", evidence: { version: 1, items: [item] } };
  it.each(["succeeded", "failed", "cancelled", "blocked"])("accepts bounded %s results", (status) => {
    expect(isProgrammaticExecutionResult({ ...result, status })).toBe(true);
  });
  it("accepts rejection separately", () => {
    expect(isProgrammaticExecutionResult({ version: 1, status: "rejected", reason: "approval-rejected" })).toBe(true);
    expect(isProgrammaticExecutionResult({ ...result, status: "rejected" })).toBe(false);
  });
  it.each([null, {}, { ...result, version: 2 }, { ...result, route: {} }, { ...result, transcript: [] }, { ...result, summary: "x".repeat(4001) }, { ...result, evidence: { version: 1, items: Array(201).fill(item) } }])("rejects malformed or oversized envelopes", (value) => {
    expect(isProgrammaticExecutionResult(value)).toBe(false);
  });
  it.each([{ message: "x".repeat(4001) }, { source: "x".repeat(101) }, { code: "x".repeat(101) }, { severity: "success" }, { basis: "verified" }, { output: "hidden body" }, { message: "bad\u0000text" }, { location: { path: "../secret" } }, { location: { path: "C:/secret" } }, { location: { path: "src/a.ts", endLine: 2 } }, { location: { path: "src/a.ts", startLine: 3, endLine: 2 } }])("rejects unsafe evidence fields", (patch) => {
    expect(isProgrammaticExecutionResult({ ...result, evidence: { version: 1, items: [{ ...item, ...patch }] } })).toBe(false);
  });
  it("accepts bounded citations and plain inert text", () => {
    expect(isProgrammaticExecutionResult({ ...result, evidence: { version: 1, items: [{ ...item, message: "<script>not executable</script>", location: { path: "src/a.ts", startLine: 1, endLine: 2 } }] } })).toBe(true);
  });
});

const hash = "a".repeat(64);
const route = { available: true, command: "research", reason: "Available", machineLocal: true };
const summary = {
  id: hash,
  expectedOutput: "Report",
  state: "discovered",
  presence: "present",
  route,
  mutationPaths: ["src/main.ts"],
  actions: { run: { available: true, reason: "Can run." }, dismiss: { available: true, reason: "Can dismiss." } },
};
const report = {
  status: "current",
  reason: "Current",
  scan: { available: true, reason: "Approved configuration is current." },
  snapshot: hash,
  fingerprint: hash,
  offset: 0,
  total: 1,
  rows: [summary],
};
const configuration = { status: "missing", currentFingerprint: hash, refreshAvailable: false,
  baselineUnavailable: false, diagnostic: null, drift: null };
const proposal = {
  handle: hash,
  operation: "initial",
  configuration,
  fingerprint: hash,
  profileJson: '{\n  "scanners": [],\n  "version": 1\n}\n',
  routes: [{ id: hash, route }],
  exclusions: ["node_modules/**"],
  configurationInputs: [{ path: "package.json", sha256: hash }],
};
const detail = {
  summary,
  trigger: "Changed input",
  verification: "Read report",
  risks: ["Machine-local configuration"],
  evidence: [
    {
      basis: "observed",
      message: "Manifest exists",
      location: { path: "package.json", startLine: 1, endLine: 2 },
    },
  ],
  evidenceTruncated: false,
};
const response = (action: string, fields: object) => ({ version: 1, action, ok: true, ...fields });

describe("programmatic chat transport", () => {
  const assessment = {
    version: 1, mode: "setup", status: "incomplete", summary: "Limited read-only assessment.",
    limitations: ["Model stopped early."], coverage: [], observations: [],
    deterministic: { status: "not-run", reason: "setup" },
  };
  const configuredAssessment = { ...assessment, mode: "configured", status: "unavailable",
    deterministic: { status: "succeeded", enabledCount: 0, applicableCount: 0 } };
  it("accepts optional setup and scan projections while preserving legacy responses", () => {
    for (const extra of [{}, { assessment }]) {
      expect(isProgrammaticChatResponse(response("inspect-setup", { proposal, ...extra }))).toBe(true);
    }
    for (const extra of [{}, { assessment: configuredAssessment }]) {
      expect(isProgrammaticChatResponse(response("scan", { changed: false, ...extra }))).toBe(true);
    }
  });
  it("retains limited assessment on setup/scan failure without authorizing replacement settings", () => {
    for (const [action, projection] of [["inspect-setup", assessment], ["scan", configuredAssessment]]) {
      expect(isProgrammaticChatResponse({ version: 1, action, ok: false, error: "Unavailable", reconcile: false, assessment: projection })).toBe(true);
    }
    expect(isProgrammaticChatResponse(response("inspect-setup", { assessment }))).toBe(false);
    expect(isProgrammaticChatResponse(response("inspect-setup", { proposal: { ...proposal, handle: null }, assessment }))).toBe(false);
  });
  it("rejects mode spoofing, malformed projections and assessment approval authority", () => {
    expect(isProgrammaticChatResponse(response("scan", { changed: false, assessment }))).toBe(false);
    expect(isProgrammaticChatResponse(response("inspect-setup", { proposal, assessment: configuredAssessment }))).toBe(false);
    expect(isProgrammaticChatResponse(response("scan", { changed: false, assessment: { ...configuredAssessment, summary: "x".repeat(4001) } }))).toBe(false);
    expect(isProgrammaticChatResponse(response("inspect-setup", { proposal, assessment: { ...assessment, proposalHandle: hash } }))).toBe(false);
    for (const action of ["approve-setup", "dismiss"]) {
      expect(isProgrammaticChatResponse(response(action, { changed: true, assessment }))).toBe(false);
      expect(isProgrammaticChatResponse({ version: 1, action, ok: false, error: "Failed", reconcile: false, assessment })).toBe(false);
    }
    expect(isProgrammaticChatRequest({ version: 1, action: "approve-setup", proposalHandle: hash, assessment })).toBe(false);
    expect(isProgrammaticChatRequest({ version: 1, action: "scan", assessment: configuredAssessment })).toBe(false);
  });
  it("requires current setup to have no approvable handle", () => {
    const current = { ...proposal, handle: null, operation: "current",
      configuration: { ...configuration, status: "current" } };
    expect(isProgrammaticChatResponse(response("inspect-setup", { proposal: current }))).toBe(true);
    expect(isProgrammaticChatResponse(response("inspect-setup", { proposal: { ...current, handle: hash } }))).toBe(false);
    expect(isProgrammaticChatResponse(response("inspect-setup", { proposal: { ...proposal, handle: null } }))).toBe(false);
  });
  it("validates exact bounded drift without unsafe paths or invented before hashes", () => {
    const change = { path: "package.json", kind: "modified", before: hash, after: "b".repeat(64) };
    const drift = { files: [change], policy: null, schema: null, exclusions: null };
    const refresh = { ...proposal, operation: "refresh", configuration: { ...configuration,
      status: "refresh-required", refreshAvailable: true, drift } };
    const valid = (value: unknown) => isProgrammaticChatResponse(response("inspect-setup", { proposal: value }));
    expect(valid(refresh)).toBe(true);
    for (const files of [[{ ...change, path: "../secret" }], [change, change],
      [{ ...change, kind: "added" }], [{ ...change, after: hash }],
      Array.from({ length: 20_001 }, (_, index) => ({ ...change, path: `${index}.json` }))]) {
      expect(valid({ ...refresh, configuration: { ...refresh.configuration, drift: { ...drift, files } } })).toBe(false);
    }
    expect(valid({ ...refresh, configuration: { ...refresh.configuration, baselineUnavailable: true } })).toBe(false);
    expect(valid({ ...refresh, configuration: { ...refresh.configuration, baselineUnavailable: true, drift: null } })).toBe(true);
    expect(isProgrammaticChatResponse(response("report", { report: { ...report,
      configuration: { ...configuration, status: "unreadable", currentFingerprint: null, diagnostic: "Repair required" } } }))).toBe(true);
  });
  it("accepts only strict setup-failure handle preservation markers", () => {
    const failure = { version: 1, action: "approve-setup", ok: false, error: "Busy", reconcile: false };
    expect(isProgrammaticChatResponse(failure)).toBe(true);
    for (const action of ["approve-setup", "inspect-setup"]) {
      expect(isProgrammaticChatResponse({ ...failure, action, approvableProposalHandle: hash })).toBe(true);
      for (const invalid of [true, false, null, "", "not-a-handle", undefined])
        expect(isProgrammaticChatResponse({ ...failure, action, approvableProposalHandle: invalid })).toBe(false);
    }
    for (const action of ["report", "detail", "scan", "dismiss"])
      expect(isProgrammaticChatResponse({ ...failure, action, approvableProposalHandle: hash })).toBe(false);
    expect(isProgrammaticChatResponse({ version: 1, action: "approve-setup", ok: true,
      changed: true, approvableProposalHandle: hash })).toBe(false);
  });
  it.each([
    { action: "report", offset: 0 },
    { action: "detail", id: hash },
    { action: "inspect-setup" },
    { action: "approve-setup", proposalHandle: hash },
    { action: "scan" },
    { action: "dismiss", id: hash, snapshot: hash },
  ])("accepts strict $action requests", (request) => {
    expect(isProgrammaticChatRequest({ version: 1, ...request })).toBe(true);
    expect(isProgrammaticChatRequest({ version: 1, ...request, command: "run" })).toBe(false);
    expect(isProgrammaticChatRequest({ version: 2, ...request })).toBe(false);
  });
  it.each([
    null,
    [],
    {},
    { version: 1, action: "run" },
    { version: 1, action: "report", offset: -1 },
    { version: 1, action: "report", offset: 0.5 },
    { version: 1, action: "report", offset: 1_001 },
    { version: 1, action: "detail", id: "../state" },
    { version: 1, action: "dismiss", id: hash },
    { version: 1, action: "approve-setup", profile: {} },
  ])("rejects malformed request %j", (request) => {
    expect(isProgrammaticChatRequest(request)).toBe(false);
  });
  it.each([
    "/etc/passwd",
    "C:/data",
    "C:data",
    "\\\\host\\share",
    "../data",
    "a/../b",
    "a//b",
    "./a",
    "a\\b",
    "a\u0000b",
    "a/",
    "",
  ])("rejects unsafe location %j", (path) => {
    expect(isProgrammaticChatRelativePath(path)).toBe(false);
  });
  it("accepts normalized Unicode relative paths", () => {
    expect(isProgrammaticChatRelativePath("src/日本語 file.ts")).toBe(true);
  });
  it.each([
    response("report", { report }),
    response("detail", { snapshot: hash, detail }),
    response("detail", { snapshot: null, detail: null }),
    response("inspect-setup", { proposal }),
    ...["approve-setup", "scan", "dismiss"].map((action) => response(action, { changed: false })),
    { version: 1, action: "scan", ok: false, error: "Reconcile before retry", reconcile: true },
  ])("accepts bounded response $action", (value) => {
    expect(isProgrammaticChatResponse(value)).toBe(true);
    expect(isProgrammaticChatResponse({ ...value, credentials: "forbidden" })).toBe(false);
    expect(isProgrammaticChatResponse({ ...value, version: 2 })).toBe(false);
  });
  it("requires bounded scan availability independently of scan freshness", () => {
    for (const available of [true, false]) {
      expect(isProgrammaticChatResponse(response("report", { report: {
        ...report, status: "stale", scan: { available, reason: "Current profile validation" },
      } }))).toBe(true);
    }
    for (const scan of [undefined, null, {}, { available: "true", reason: "Invalid" },
      { available: true, reason: "" }, { available: false, reason: "x".repeat(1_001) },
      { available: true, reason: "Valid", command: "scan" }]) {
      expect(isProgrammaticChatResponse(response("report", { report: { ...report, scan } }))).toBe(false);
    }
  });
  it("requires bounded action eligibility in reports and details without replacing route reasons", () => {
    const blocked = { available: false, reason: "An opportunity is running in this project." };
    const selected = { ...summary, actions: { run: blocked, dismiss: blocked } };
    expect(isProgrammaticChatResponse(response("report", { report: { ...report, scan: blocked, rows: [selected] } }))).toBe(true);
    expect(isProgrammaticChatResponse(response("detail", { snapshot: hash, detail: { ...detail, summary: selected } }))).toBe(true);
    for (const invalid of [undefined, null, {}, { available: "false", reason: "Invalid" },
      { available: false, reason: "" }, { available: false, reason: "x".repeat(1_001) },
      { ...blocked, owner: hash }]) {
      for (const key of ["run", "dismiss"]) {
        const bad = { ...selected, actions: { ...selected.actions, [key]: invalid } };
        expect(isProgrammaticChatResponse(response("report", { report: { ...report, rows: [bad] } }))).toBe(false);
        expect(isProgrammaticChatResponse(response("detail", { snapshot: hash, detail: { ...detail, summary: bad } }))).toBe(false);
      }
    }
    expect(isProgrammaticChatResponse(response("report", { report: { ...report, rows: [{ ...selected, actions: undefined }] } }))).toBe(false);
  });
  it("bounds pages, rejects duplicates and enforces page identity", () => {
    for (const fields of [
      { rows: Array.from({ length: 51 }, () => summary), total: 51 },
      { rows: [summary, summary], total: 2 },
      { offset: 1 },
      { snapshot: null },
      { fingerprint: null },
      { total: 1_001 },
      { rows: [{ ...summary, sourceBody: "private" }] },
      { rows: [{ ...summary, route: { ...route, command: null } }] },
      { rows: [{ ...summary, mutationPaths: ["../secret"] }] },
    ])
      expect(
        isProgrammaticChatResponse(response("report", { report: { ...report, ...fields } })),
      ).toBe(false);
    const rows = Array.from({ length: 50 }, (_, index) => ({
      ...summary,
      id: index.toString(16).padStart(64, "0"),
    }));
    expect(
      isProgrammaticChatResponse(response("report", { report: { ...report, rows, total: 50 } })),
    ).toBe(true);
  });
  it("bounds selected evidence and validates line ranges", () => {
    for (const fields of [
      { evidence: Array.from({ length: 51 }, () => detail.evidence[0]) },
      { evidence: [{ ...detail.evidence[0], location: { path: "a", endLine: 2 } }] },
      { evidence: [{ ...detail.evidence[0], location: { path: "a", startLine: 3, endLine: 2 } }] },
      { evidence: [{ ...detail.evidence[0], location: { path: "a", startLine: 0 } }] },
      { childHistory: [] },
      { trigger: "x".repeat(4_001) },
    ])
      expect(
        isProgrammaticChatResponse(
          response("detail", { snapshot: hash, detail: { ...detail, ...fields } }),
        ),
      ).toBe(false);
  });
  it("requires an exact canonical, non-executable profile", () => {
    for (const profileJson of [
      "{}",
      '{"version":1,"scanners":[]}',
      "[1]",
      "null",
      "x".repeat(32_001),
      '{\n  "command": "shell",\n  "scanners": [],\n  "version": 1\n}\n',
    ])
      expect(
        isProgrammaticChatResponse(
          response("inspect-setup", { proposal: { ...proposal, profileJson } }),
        ),
      ).toBe(false);
    expect(
      isProgrammaticChatResponse(
        response("inspect-setup", {
          proposal: {
            ...proposal,
            configurationInputs: [{ path: "C:/secret", sha256: hash }],
          },
        }),
      ),
    ).toBe(false);
  });
  it("bounds errors and requires explicit uncertain-write reconciliation", () => {
    const error = {
      version: 1,
      action: "dismiss",
      ok: false,
      error: "x".repeat(1_000),
      reconcile: true,
    };
    expect(isProgrammaticChatResponse(error)).toBe(true);
    expect(isProgrammaticChatResponse({ ...error, error: "x".repeat(1_001) })).toBe(false);
    expect(isProgrammaticChatResponse({ ...error, reconcile: undefined })).toBe(false);
  });
});
