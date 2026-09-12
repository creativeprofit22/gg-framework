import { describe, expect, it } from "vitest";
import {
  isProgrammaticChatRelativePath,
  isProgrammaticChatRequest,
  isProgrammaticChatResponse,
} from "./programmatic-chat-contract.js";

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
const proposal = {
  handle: hash,
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
