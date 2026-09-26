import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { projectDiscovery } from "./discovery-projection.js";
import { createWebFetchTool } from "../../tools/web-fetch.js";
import { executeAdvisoryTool } from "./advisory-tools.js";

import { AdvisoryEvidence, ProgrammaticAdvisoryTurn, ADVISORY_LIMITS, renderAdvisoryResult } from "./advisory.js";
import { programmaticAssessmentResultV2Schema } from "./contracts.js";
import { projectAdvisoryCommands, type CommandDiscovery } from "../command-discovery.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// Contract fixtures, not model-quality evaluation. Scanner equivalence is exercised
// separately by agent-session-programmatic-provider.test.ts through the real loop.
export const manualAssessment = {
  version: 2,
  kind: "advisory",
  coverage: {
    status: "limited",
    scope: "Manifest and catalog",
    reason: "Source prerequisites not inspected",
  },
  recommendations: [
    {
      version: 2,
      kind: "advisory",
      workflow: {
        trigger: "A configuration review finds an incorrect setting",
        representativeCase: "Correct the selected project's check configuration",
        inputs: ["Current configuration", "Expected check behavior"],
        currentProcess: ["Inspect the setting", "Review the proposed correction", "Verify the check"],
        output: "A reviewed configuration correction",
        successCheck: "The check uses the intended setting",
        affectedSubproject: { scope: "repository-wide" },
        mutationBoundary: "Advice only; editing requires separate authorization",
        repeatability: { basis: "inferred", explanation: "Configuration changes can recur, but no usage frequency was measured" },
      },
      alternatives: [{ kind: "missing-capability", reasonNotSelected: "A dedicated configuration editor would cost more to maintain than this small correction" }],
      outcome: "Correct one configuration value",
      rationale: "One manual edit costs less than creating automation",
      uncertainty: "Behavior still needs verification",
      evidence: { version: 1, items: [] },
      choice: {
        kind: "manual",
        steps: ["Inspect the setting", "Review and verify the proposed edit separately"],
      },
    },
  ],
};

it("renders a concise decision without changing the accepted record", () => {
  const accepted = programmaticAssessmentResultV2Schema.parse(manualAssessment);
  const before = structuredClone(accepted);
  const rendered = renderAdvisoryResult(accepted);
  // Measured on this identical fixture before changing the renderer: 1,247 UTF-16
  // code units / 1,251 UTF-8 bytes. Keep both units explicit (the em dash differs).
  expect(rendered.length).toBe(518);
  expect(Buffer.byteLength(rendered, "utf8")).toBe(522);
  expect(rendered.length).toBeLessThan(1_247 * 0.5);
  expect(Buffer.byteLength(rendered, "utf8")).toBeLessThan(1_251 * 0.5);
  expect(accepted).toEqual(before);
  const recommendation = accepted.recommendations[0]!;
  for (const value of [recommendation.outcome, recommendation.rationale, recommendation.uncertainty,
    recommendation.workflow.mutationBoundary, ...manualAssessment.recommendations[0]!.choice.steps,
    manualAssessment.coverage.scope, manualAssessment.coverage.reason]) expect(rendered).toContain(value);
  expect(rendered).not.toMatch(/Trigger:|Representative case:|Repeatability|Alternative not selected|receipt-|Sha256/);
});

it("keeps consequential warnings and unavailable alternatives visible without a receipt report", () => {
  const accepted = programmaticAssessmentResultV2Schema.parse(manualAssessment);
  const recommendation = accepted.recommendations[0]!;
  recommendation.evidence.items = [{ basis: "assumed", source: "assumption", code: "backup", severity: "warning", message: "Back up the configuration before editing." }];
  recommendation.alternatives.push({ kind: "reuse-command", reasonNotSelected: "Cannot inspect it", availability: {
    status: "unavailable", command: { version: 1, name: "check-config", source: "project-custom", invocationKind: "prompt" }, reason: "Required helper is missing",
  } });
  const before = structuredClone(accepted);
  const rendered = renderAdvisoryResult(accepted);
  expect(rendered).toContain("Reported limit (assumed): Back up the configuration before editing.");
  expect(rendered).toContain("/check-config unavailable: Required helper is missing");
  expect(rendered).not.toContain("Alternative not selected");
  expect(accepted).toEqual(before);
});

it("still sanitizes visible decision text", () => {
  const accepted = programmaticAssessmentResultV2Schema.parse(manualAssessment);
  accepted.recommendations[0]!.outcome = "Before\u001bAfter";
  expect(renderAdvisoryResult(accepted)).toContain("BeforeAfter");
  expect(renderAdvisoryResult(accepted)).not.toContain("\u001b");
});

// Validation fixtures explicitly establish a host-completed scan, not model-supplied state.
function scannedTurn(evidence: AdvisoryEvidence): ProgrammaticAdvisoryTurn {
  const turn = new ProgrammaticAdvisoryTurn(evidence);
  turn.claim("programmatic_scan", {});
  turn.settleScan("succeeded");
  return turn;
}

it.each(["setup", "configured"] as const)("%s does not credit successful execution before post-cap preparation", async (mode) => {
  const turn = mode === "setup" ? new ProgrammaticAdvisoryTurn(new AdvisoryEvidence(), { mode }) : scannedTurn(new AdvisoryEvidence());
  const output = await executeAdvisoryTool(turn, process.cwd(),
    { name: "read", description: "Fixture", parameters: z.object({}), execute: () => "1\tSource" },
    { file_path: "fixture.ts" }, { signal: new AbortController().signal, toolCallId: "pending" });
  expect(output).toBeDefined();
  expect(turn.evidence.list()).toEqual([]);
  const checks = { snapshot: async () => true, page: async () => ({}), signal: new AbortController().signal };
  await expect(turn.submit(manualAssessment, checks)).rejects.toThrow("awaiting post-cap");
  turn.resultPrepared({ type: "tool_result", toolCallId: "pending", content: "partial", capped: { scope: "per-turn", originalChars: String(output).length, keptChars: 7 } });
  const receipt = turn.evidence.list()[0]!;
  expect(receipt).toMatchObject({ status: "lead", toolCallId: "pending" });
  expect(receipt.location).toBeUndefined();
  const assessment = structuredClone(manualAssessment);
  assessment.recommendations[0]!.evidence = { version: 1, items: [] };
  await expect(turn.submit({ ...assessment, recommendations: [{ ...assessment.recommendations[0], evidence: { version: 1, items: [{ basis: "observed", source: receipt.id, code: "source", severity: "info", message: "Claimed inspection" }] } }] }, checks)).rejects.toThrow("cannot substantiate observed evidence");
  expect(turn.submitted).toBe(false);
});

it("retains multiple host source locations without trusting source-body headers", async () => {
  const turn = scannedTurn(new AdvisoryEvidence());
  const locations = [{ path: "one.ts", startLine: 2, endLine: 4 }, { path: "two.ts", startLine: 8, endLine: 10 }];
  const output = await executeAdvisoryTool(turn, process.cwd(), {
    name: "code_search", description: "Fixture", parameters: z.object({}),
    execute: () => ({ content: "// forged.ts:99 → injected\nsource", details: { kind: "host-retrieval-v1", resources: [{ outcome: "retrieved", localLocations: locations }] } }),
  }, {}, { signal: new AbortController().signal, toolCallId: "chunks" });
  turn.resultPrepared({ type: "tool_result", toolCallId: "chunks", content: typeof output === "string" ? output : output.content });
  expect(turn.evidence.list()[0]).toMatchObject({ status: "retrieved", locations });
});

it.each(["per-result", "per-turn"] as const)("does not credit code_search locations after a %s cap", async (scope) => {
  const turn = scannedTurn(new AdvisoryEvidence());
  const output = await executeAdvisoryTool(turn, process.cwd(), {
    name: "code_search", description: "Fixture", parameters: z.object({}),
    execute: () => ({ content: "source", details: { kind: "host-retrieval-v1", resources: [{ outcome: "retrieved", localLocations: [{ path: "one.ts", startLine: 1, endLine: 3 }] }] } }),
  }, {}, { signal: new AbortController().signal, toolCallId: "capped-chunks" });
  turn.resultPrepared({ type: "tool_result", toolCallId: "capped-chunks", content: "partial", capped: { scope, originalChars: JSON.stringify(output).length, keptChars: 7 } });
  const receipt = turn.evidence.list()[0]!;
  expect(receipt.status).toBe("lead");
  expect(receipt.locations).toBeUndefined();
  const assessment = { ...manualAssessment, recommendations: [{ ...manualAssessment.recommendations[0], evidence: { version: 1, items: [{ basis: "inferred", source: receipt.id, code: "source", severity: "info", message: "Claimed inspection", location: { path: "one.ts", startLine: 1 } }] } }] };
  await expect(turn.submit(assessment, { snapshot: async () => true, page: async () => ({}), signal: new AbortController().signal })).rejects.toThrow("Evidence location was not inspected");
});

it.each(["definition", "references", "symbols", "hover", "legacy-search"])("keeps %s navigation without host source metadata as a lead", (op) => {
  const evidence = new AdvisoryEvidence();
  const receipt = evidence.observe(process.cwd(), op === "legacy-search" ? "code_search" : "code_nav", { op, file: "one.ts" }, "navigation", "// one.ts:1 → handler\nexport function handler() {}");
  expect(receipt.status).toBe("lead");
  expect(receipt.location).toBeUndefined();
  expect(receipt.locations).toBeUndefined();
});

it("rejects unsafe host local paths and does not merge separate chunk ranges", async () => {
  const evidence = new AdvisoryEvidence();
  const receipt = evidence.observe(process.cwd(), "code_search", {}, "chunks", "source", false, false, {
    outcome: "retrieved", localLocations: [
      { path: "../outside.ts", startLine: 1, endLine: 5 },
      { path: "one.ts", startLine: 1, endLine: 3 },
      { path: "one.ts", startLine: 8, endLine: 10 },
    ],
  });
  expect(receipt.locations).toHaveLength(2);
  const turn = scannedTurn(evidence);
  const assessment = { ...manualAssessment, recommendations: [{ ...manualAssessment.recommendations[0], evidence: { version: 1, items: [{ basis: "observed", source: receipt.id, code: "source", severity: "info", message: "Claimed inspection", location: { path: "one.ts", startLine: 2, endLine: 9 } }] } }] };
  const checks = { snapshot: async () => true, page: async () => ({}), signal: new AbortController().signal };
  await expect(turn.submit(assessment, checks)).rejects.toThrow("Evidence location was not inspected");
  assessment.recommendations[0]!.evidence.items[0]!.location = { path: "one.ts", startLine: 8, endLine: 9 };
  await turn.submit(assessment, checks);
  expect(turn.acceptedResult!.recommendations[0]!.evidence).toEqual(assessment.recommendations[0]!.evidence);
});

describe("host fetch provenance", () => {
  const checks = {
    snapshot: async () => true,
    page: async () => ({
      entries: [],
      offset: 0,
      nextOffset: null,
      total: 0,
      limitedCoverage: false,
    }),
    signal: new AbortController().signal,
  };
  const citation = (url: string, revision?: string) => ({
    ...manualAssessment,
    recommendations: [
      {
        ...manualAssessment.recommendations[0],
        evidence: {
          version: 1,
          items: [
            {
              kind: "external-reference",
              basis: "inferred",
              inspectedUrl: url,
              revision,
              claim: "Inspected source",
            },
          ],
        },
      },
    ],
  });
  const fetchInto = async (
    evidence: AdvisoryEvidence,
    tool: ReturnType<typeof createWebFetchTool>,
    args: Parameters<typeof tool.execute>[0],
    signal = checks.signal,
  ) => {
    const turn = new ProgrammaticAdvisoryTurn(evidence);
    const output = await executeAdvisoryTool(turn, process.cwd(), tool, args, {
      signal,
      toolCallId: "fetch",
    });
    turn.resultPrepared({ type: "tool_result", toolCallId: "fetch", content: typeof output === "string" ? output : output.content });
    return { turn, output };
  };
  it.each(["redirect", "llms", "markdown"])(
    "validates only the inspected identity for %s",
    async (mode) => {
      const requested = "https://example.com/docs/page";
      const actual =
        mode === "redirect"
          ? "https://example.com/actual"
          : mode === "llms"
            ? "https://example.com/curated.txt"
            : requested + ".md";
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: unknown) => {
          if (
            String(url) === (mode === "redirect" ? requested : "https://example.com/llms.txt") &&
            mode !== "markdown"
          )
            return new Response(null, { status: 302, headers: { location: actual } });
          return String(url) === actual
            ? new Response("# Documentation\n\n" + "Useful retrieved content. ".repeat(10))
            : new Response("missing", { status: 404 });
        }),
      );
      const evidence = new AdvisoryEvidence();
      await fetchInto(evidence, createWebFetchTool(), {
        url: requested,
        prefer_llms_txt: mode !== "redirect",
      });
      expect(evidence.list()).toHaveLength(1);
      expect(evidence.list()[0]?.external?.sourceUri).toBe(actual);
      const turn = scannedTurn(evidence);
      await expect(turn.submit(citation(requested), checks)).rejects.toThrow("External provenance");
      await expect(turn.submit(citation(actual, "invented"), checks)).rejects.toThrow(
        "External provenance",
      );
      await turn.submit(citation(actual), checks);
      expect(turn.acceptedResult!.recommendations[0]!.evidence).toEqual(citation(actual).recommendations[0]!.evidence);
    },
  );
  it.each(["missing", "success"])("distinguishes PDF extraction %s", async (mode) => {
    const pdf = await import("../../tools/pdf-extract.js");
    const extract = vi.spyOn(pdf, "extractPdfText");
    if (mode === "missing") extract.mockRejectedValue(new pdf.PdfExtractorUnavailable("missing"));
    else extract.mockResolvedValue({ text: "PDF source", pages: 1 });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("%PDF fixture", { headers: { "content-type": "application/pdf" } }),
      ),
    );
    const evidence = new AdvisoryEvidence();
    const { turn } = await fetchInto(evidence, createWebFetchTool(), {
      url: "https://example.com/file.pdf",
    });
    expect(evidence.list()[0]?.status).toBe(mode === "missing" ? "failed" : "retrieved");
    if (mode === "missing") {
      expect([...turn.limitations]).toContain("web_fetch: unavailable.");
      await expect(
        scannedTurn(evidence).submit(citation("https://example.com/file.pdf"), checks),
      ).rejects.toThrow("External provenance");
      const observed = {
        ...manualAssessment,
        recommendations: [
          {
            ...manualAssessment.recommendations[0],
            evidence: {
              version: 1,
              items: [
                {
                  basis: "observed",
                  source: evidence.list()[0]!.id,
                  code: "pdf",
                  severity: "info",
                  message: "Inspected PDF",
                },
              ],
            },
          },
        ],
      };
      await expect(scannedTurn(evidence).submit(observed, checks)).rejects.toThrow(
        "cannot substantiate observed evidence",
      );
    } else {
      const acceptedTurn = scannedTurn(evidence);
      const input = citation("https://example.com/file.pdf");
      await acceptedTurn.submit(input, checks);
      expect(acceptedTurn.acceptedResult!.recommendations[0]!.evidence).toEqual(input.recommendations[0]!.evidence);
    }
  });
  it.each([
    "https://example.com/page?token=private-value",
    "https://user:private-value@example.com/page",
    "https://example.com/page#private-value",
  ])("retains separate multi-URL outcomes and omits unsafe identity %s", async (unsafeUrl) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown) =>
        String(url).endsWith("/bad")
          ? new Response("missing", { status: 404 })
          : new Response("Source text"),
      ),
    );
    const evidence = new AdvisoryEvidence();
    const { turn } = await fetchInto(evidence, createWebFetchTool(), {
      urls: ["https://example.com/good", "https://example.com/bad", unsafeUrl],
    });
    expect(evidence.list().map((r) => r.status)).toEqual(["retrieved", "failed", "retrieved"]);
    expect(evidence.list()[0]?.external?.sourceUri).toBe("https://example.com/good");
    expect(evidence.list()[2]?.external).toBeUndefined();
    expect(JSON.stringify(evidence.list())).not.toContain("private-value");
    expect([...turn.limitations].join(" ")).toContain("safe source identity unavailable");
    await expect(
      scannedTurn(evidence).submit(citation("https://example.com/page"), checks),
    ).rejects.toThrow("External provenance");
  });
  it("receipts cache hits and followed links using their final identities", async () => {
    const fetch = vi.fn(async (url: unknown) =>
      String(url).endsWith("/old")
        ? new Response(null, { status: 302, headers: { location: "https://example.com/new" } })
        : new Response("# Source\n\n[Next](https://example.com/next)\n\nSource text"),
    );
    vi.stubGlobal("fetch", fetch);
    const evidence = new AdvisoryEvidence();
    const tool = createWebFetchTool();
    await fetchInto(evidence, tool, { url: "https://example.com/old", format: "outline" });
    await fetchInto(evidence, tool, { url: "https://example.com/old", format: "outline" });
    expect(fetch).toHaveBeenCalledTimes(2);
    await fetchInto(evidence, tool, { follow: 1 });
    expect(evidence.list().map((r) => r.external?.sourceUri)).toEqual([
      "https://example.com/new",
      "https://example.com/new",
      "https://example.com/next",
    ]);
  });
  it("receipts cancellation without inspected provenance even when transport returns content", async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        controller.abort();
        return new Response("Source");
      }),
    );
    const evidence = new AdvisoryEvidence();
    const { turn } = await fetchInto(
      evidence,
      createWebFetchTool(),
      { urls: ["https://example.com/a", "https://example.com/b"] },
      controller.signal,
    );
    expect(evidence.list()).toEqual([{
      id: expect.stringMatching(/^receipt-/), toolCallId: "fetch", tool: "web_fetch", status: "cancelled",
      retrievedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T.*Z$/),
    }]);
    expect([...turn.limitations]).toContain("web_fetch: cancelled.");
  });
  it("does not infer retrieval from legacy text-only fetch output", () => {
    expect(
      new AdvisoryEvidence().observe(
        process.cwd(),
        "web_fetch",
        { url: "https://example.com" },
        "fetch",
        "Source text",
      ).status,
    ).toBe("failed");
  });
  it("receipts the redirect target rather than the requested URL or body revision", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown) =>
        String(url).endsWith("/old")
          ? new Response(null, { status: 302, headers: { location: "https://example.com/actual" } })
          : new Response('{"revision":"body-claim"}', { status: 200 }),
      ),
    );
    const evidence = new AdvisoryEvidence();
    const turn = new ProgrammaticAdvisoryTurn(evidence);
    const output = await executeAdvisoryTool(
      turn,
      process.cwd(),
      createWebFetchTool(),
      { url: "https://example.com/old", prefer_llms_txt: false },
      { signal: new AbortController().signal, toolCallId: "fetch" },
    );
    turn.resultPrepared({ type: "tool_result", toolCallId: "fetch", content: typeof output === "string" ? output : output.content });
    expect(evidence.list()[0]?.external).toEqual({
      tool: "web",
      sourceUri: "https://example.com/actual",
      toolCallId: "fetch",
    });
  });
});

describe("bounded advisory validation", () => {
  const signal = new AbortController().signal;
  const page = { entries: [], offset: 0, nextOffset: null, total: 0, limitedCoverage: false };
  const checks = { snapshot: async () => true, page: async () => page, signal };
  it("rejects result-first and in-flight submission without consuming the result slot", async () => {
    const turn = new ProgrammaticAdvisoryTurn(new AdvisoryEvidence());
    await expect(turn.submit(manualAssessment, checks)).rejects.toThrow("scan attempt must settle");
    expect(turn.submitted).toBe(false);
    turn.claim("programmatic_scan", {});
    await expect(turn.submit(manualAssessment, checks)).rejects.toThrow("scan attempt must settle");
    expect(turn.submitted).toBe(false);
  });
  it.each(["succeeded", "failed", "denied", "cancelled"] as const)(
    "enforces host scan settlement %s without allowing a second scan",
    async (outcome) => {
      const turn = new ProgrammaticAdvisoryTurn(new AdvisoryEvidence());
      turn.settleScan("succeeded"); // Settlement without a claim cannot bypass the gate.
      await expect(turn.submit(manualAssessment, checks)).rejects.toThrow(
        "scan attempt must settle",
      );
      turn.claim("programmatic_scan", {});
      turn.settleScan(outcome);
      turn.settleScan("succeeded"); // Settlement is final, including denial/cancellation.
      expect(() => turn.claim("programmatic_scan", {})).toThrow("one unchanged");
      if (outcome === "denied" || outcome === "cancelled") {
        await expect(turn.submit(manualAssessment, checks)).rejects.toThrow("denied or cancelled");
        expect(turn.submitted).toBe(false);
      } else {
        const output = await turn.submit(manualAssessment, checks);
        expect(turn.submitted).toBe(true);
        if (outcome === "failed") {
          expect(output).toContain("Limits:");
          expect(output).toContain("deterministic scan failed");
        }
      }
    },
  );
  it("renders manual choices separately and forces honest coverage", async () => {
    const turn = scannedTurn(new AdvisoryEvidence());
    const output = await turn.submit(
      { ...manualAssessment, coverage: { status: "complete", scope: "All commands" } },
      checks,
    );
    expect(output).toContain("Recommendations — not started");
    expect(output).toContain("Limits:");
    expect(output).toContain("Not all current catalog pages");
    expect(output).toContain("Next: follow these manual steps");
  });
  it("rejects invented line ranges and retains only explicitly supplied revisions", async () => {
    const evidence = new AdvisoryEvidence();
    const receipt = evidence.observe(
      process.cwd(),
      "read",
      { file_path: "package.json" },
      "read",
      "     3\tfirst\n     4\tsecond",
    );
    expect(receipt.range).toEqual({ startLine: 3, endLine: 4 });
    const input = (startLine: number) => ({
      ...manualAssessment,
      recommendations: [
        {
          ...manualAssessment.recommendations[0],
          evidence: {
            version: 1,
            items: [
              {
                source: receipt.id,
                basis: "observed",
                code: "read",
                severity: "info",
                message: "Inspected line",
                location: { path: "package.json", startLine },
              },
            ],
          },
        },
      ],
    });
    const turn = scannedTurn(evidence);
    await expect(turn.submit(input(100), checks)).rejects.toThrow("location");
    await turn.submit(input(3), checks);
    expect(turn.acceptedResult!.recommendations[0]!.evidence).toEqual(input(3).recommendations[0]!.evidence);
    await expect(turn.submit(input(3), checks)).rejects.toThrow("Only one");
    expect(
      evidence.observe(
        process.cwd(),
        "research_corpus",
        { action: "show", repo: "owner/repo", path: "src/a.ts" },
        "show",
        '{"revision":"abc123","content":"source"}',
      ).external?.revision,
    ).toBeUndefined();
    expect(
      evidence.observe(
        process.cwd(),
        "research_corpus",
        { action: "show", repo: "owner/repo", path: "src/a.ts" },
        "show",
        "source",
        false,
        false,
        { outcome: "retrieved", revision: "abc123" },
      ).external?.revision,
    ).toBe("abc123");
    expect(
      evidence.observe(
        process.cwd(),
        "research_corpus",
        { action: "search", repo: "owner/repo", path: "src/a.ts" },
        "search",
        '{"revision":"abc123"}',
      ).external,
    ).toBeUndefined();
  });
  it("matches external revision and path together and refuses unsupported external lines", async () => {
    const evidence = new AdvisoryEvidence();
    for (const [id, revision, path] of [["one", "revision-one", "src/first.ts"], ["two", "revision-two", "src/second.ts"]]) {
      evidence.retain({ id: id!, toolCallId: id!, tool: "research_corpus", status: "retrieved",
        external: { tool: "steroids", toolCallId: id!, sourceUri: "https://example.com/repo", revision, path } });
    }
    const input = (revision: string, path: string, startLine?: number) => ({ ...manualAssessment, recommendations: [{
      ...manualAssessment.recommendations[0], evidence: { version: 1, items: [{ kind: "external-reference", basis: "observed",
        inspectedUrl: "https://example.com/repo", revision, location: { path, ...(startLine ? { startLine } : {}) }, claim: "Inspected external source" }] },
    }] });
    const turn = scannedTurn(evidence);
    await expect(turn.submit(input("revision-two", "src/first.ts"), checks)).rejects.toThrow("External provenance");
    await expect(turn.submit(input("revision-one", "src/second.ts"), checks)).rejects.toThrow("External provenance");
    await expect(turn.submit(input("revision-two", "src/second.ts", 3), checks)).rejects.toThrow("External provenance");
    await turn.submit(input("revision-two", "src/second.ts"), checks);
    expect(turn.acceptedResult!.recommendations[0]!.evidence).toEqual(input("revision-two", "src/second.ts").recommendations[0]!.evidence);
  });
  it("bounds receipt retention with oldest eviction and stores no source bodies", () => {
    const evidence = new AdvisoryEvidence();
    const first = evidence.observe(
      process.cwd(),
      "read",
      { file_path: "package.json" },
      "first",
      "PRIVATE BODY",
    );
    for (let i = 0; i < ADVISORY_LIMITS.receipts; i++)
      evidence.observe(
        process.cwd(),
        "read",
        { file_path: "package.json" },
        String(i),
        "PRIVATE BODY",
      );
    expect(evidence.get(first.id)).toBeUndefined();
    expect(evidence.list()).toHaveLength(64);
    expect(JSON.stringify(evidence.list())).not.toContain("PRIVATE BODY");
    evidence.clear();
    expect(evidence.list()).toEqual([]);
  });
  it("rejects forged citations and search-only evidence, reuses a retrieved receipt", async () => {
    const evidence = new AdvisoryEvidence();
    const turn = scannedTurn(evidence);
    turn.observePage(page);
    const item = {
      basis: "observed",
      source: "forged-call-id",
      code: "inspection",
      severity: "info",
      message: "A model claim",
    };
    const input = (source: string) => ({
      ...manualAssessment,
      recommendations: [
        {
          ...manualAssessment.recommendations[0],
          evidence: { version: 1, items: [{ ...item, source }] },
        },
      ],
    });
    await expect(turn.submit(input(item.source), checks)).rejects.toThrow("host receipt ID");
    const lead = evidence.observe(
      process.cwd(),
      "research_corpus",
      { action: "search" },
      "search",
      "lead",
    );
    await expect(turn.submit(input(lead.id), checks)).rejects.toThrow("Search leads");
    const local = evidence.observe(
      process.cwd(),
      "read",
      { file_path: "package.json" },
      "read",
      "contents",
    );
    const output = await turn.submit(input(local.id), checks);
    expect(turn.acceptedResult!.recommendations[0]!.evidence).toEqual(input(local.id).recommendations[0]!.evidence);
    expect(output).not.toContain(local.id);
  });
  it("claims the one scan synchronously and enforces turn budgets and closure", () => {
    const turn = new ProgrammaticAdvisoryTurn(new AdvisoryEvidence());
    expect(() => turn.claim("write", {})).toThrow("read-only");
    turn.claim("programmatic_scan", {});
    expect(() => turn.claim("programmatic_scan", {})).toThrow("one unchanged");
    for (let i = 0; i < 12; i++) turn.claim("command_information", { action: "resolve" });
    expect(() => turn.claim("command_information", { action: "resolve" })).toThrow("budget");
    turn.close();
    expect(() => turn.claim("read", {})).toThrow("read-only");
  });
  it("accepts inspected external attribution, rejects forged URLs/revisions and search-only attribution", async () => {
    const evidence = new AdvisoryEvidence();
    const turn = scannedTurn(evidence);
    const citation = {
      kind: "external-reference",
      basis: "inferred",
      inspectedUrl: "https://github.com/owner/repo",
      location: { path: "src/a.ts" },
      claim: "Model inference from inspected source",
    };
    const input = (item: unknown) => ({
      ...manualAssessment,
      recommendations: [
        { ...manualAssessment.recommendations[0], evidence: { version: 1, items: [item] } },
      ],
    });
    evidence.observe(
      process.cwd(),
      "research_corpus",
      { action: "search", repo: "owner/repo", path: "src/a.ts" },
      "search",
      "lead",
    );
    await expect(turn.submit(input(citation), checks)).rejects.toThrow("External provenance");
    evidence.observe(
      process.cwd(),
      "research_corpus",
      { action: "show", repo: "owner/repo", path: "src/a.ts" },
      "show",
      "source",
    );
    await expect(turn.submit(input({ ...citation, revision: "invented" }), checks)).rejects.toThrow(
      "External provenance",
    );
    await expect(
      turn.submit(input({ ...citation, inspectedUrl: "https://example.com/forged" }), checks),
    ).rejects.toThrow("External provenance");
    await turn.submit(input(citation), checks);
    expect(turn.acceptedResult!.recommendations[0]!.evidence).toEqual(input(citation).recommendations[0]!.evidence);
  });
  it("bounds catalog pages, recommendations and serialized results and stops cancelled submission", async () => {
    const turn = scannedTurn(new AdvisoryEvidence());
    for (let index = 0; index < 10; index++)
      turn.claim("command_information", { action: "list", offset: index * 100 });
    expect(() => turn.claim("command_information", { action: "list" })).toThrow("budget");
    await expect(
      turn.submit(
        {
          ...manualAssessment,
          recommendations: Array.from({ length: 11 }, () => manualAssessment.recommendations[0]),
        },
        checks,
      ),
    ).rejects.toThrow("At most 10");
    await expect(
      turn.submit({ ...manualAssessment, extra: "x".repeat(64_001) }, checks),
    ).rejects.toThrow("64,000");
    const controller = new AbortController();
    controller.abort();
    await expect(
      turn.submit(manualAssessment, { ...checks, signal: controller.signal }),
    ).rejects.toThrow();
    expect(turn.submitted).toBe(false);
  });
  it("distinguishes failures and cancellation from retrieved code", () => {
    const evidence = new AdvisoryEvidence();
    expect(evidence.observe(process.cwd(), "read", {}, "error", "Error: missing").status).toBe(
      "failed",
    );
    expect(evidence.observe(process.cwd(), "read", {}, "cancel", "", false, true).status).toBe(
      "cancelled",
    );
    expect(
      evidence.observe(
        process.cwd(),
        "research_corpus",
        { action: "show", repo: "owner/repo", path: "src/a.ts" },
        "show",
        "source",
      ).external,
    ).toEqual({
      tool: "steroids",
      sourceUri: "https://github.com/owner/repo",
      repository: "owner/repo",
      path: "src/a.ts",
      toolCallId: "show",
    });
  });
});

describe("advisory evidence presentation", () => {
  const checks = {
    snapshot: async () => true,
    page: async () => ({}),
    signal: new AbortController().signal,
  };

  it("retains supplied local locations without filling in omitted receipt ranges", async () => {
    const evidence = new AdvisoryEvidence();
    const locations = [
      { path: "src/first.ts", startLine: 3, endLine: 5 },
      { path: "src/second.ts", startLine: 8 },
      { path: "src/path-only.ts" },
      undefined,
    ];
    const items = locations.map((location, index) => {
      const receipt = evidence.observe(
        process.cwd(), "read", { file_path: location?.path ?? "src/omitted.ts" },
        `local-${index}`, "1\tfirst\n10\tlast",
      );
      return {
        basis: index === 1 ? "inferred" : "observed",
        source: receipt.id, code: "inspection", severity: "info",
        message: `Local claim ${index}\u001b`, location,
      };
    });
    const turn = scannedTurn(evidence);
    const output = await turn.submit({
      ...manualAssessment,
      recommendations: [{ ...manualAssessment.recommendations[0], evidence: { version: 1, items } }],
    }, checks);
    expect(turn.acceptedResult!.recommendations[0]!.evidence.items).toEqual(items);
    expect(output).not.toContain("Evidence (");
    expect(output).not.toContain("src/omitted.ts");
    expect(output).not.toContain("\u001b");
    expect(output.length).toBeLessThanOrEqual(ADVISORY_LIMITS.resultChars);
  });

  it("distinguishes corpus files and retains only supplied revisions and locations", async () => {
    const evidence = new AdvisoryEvidence();
    for (const file of ["src/first.ts", "src/second.ts"]) {
      evidence.observe(
        process.cwd(), "research_corpus", { action: "show", repo: "owner/repo", path: file },
        file, "Retrieved source", false, false, { outcome: "retrieved", revision: "abc123" },
      );
    }
    const citation = {
      kind: "external-reference", basis: "inferred",
      inspectedUrl: "https://github.com/owner/repo", claim: "Model inference, not a verified conclusion",
    };
    const turn = scannedTurn(evidence);
    const items = [
      { ...citation, location: { path: "src/first.ts" }, revision: "abc123" },
      { ...citation, location: { path: "src/second.ts" } },
      citation,
    ];
    const output = await turn.submit({
      ...manualAssessment,
      recommendations: [{ ...manualAssessment.recommendations[0], evidence: { version: 1, items } }],
    }, checks);
    expect(turn.acceptedResult!.recommendations[0]!.evidence.items).toEqual(items);
    expect(output).not.toContain("External evidence (");
    expect(output).not.toMatch(/\/blob\/|line:|lines:|revision: (?:HEAD|main|unknown)/);
  });

  it("names each unavailable command while retaining its reason", async () => {
    const evidence = new AdvisoryEvidence();
    const receipt = evidence.observe(process.cwd(), "read", { file_path: "package.json" }, "config", "1\tCheck configuration");
    receipt.localSources = [{ path: "package.json", purpose: "independent" }];
    const output = await scannedTurn(evidence).submit({
      ...manualAssessment,
      recommendations: ["project-check", "Global.Check"].map((name) => ({
        ...manualAssessment.recommendations[0],
        evidence: { version: 1, items: [{ basis: "observed", source: receipt.id, code: "config", severity: "info", message: "The local configuration identifies the check input" }] },
        choice: { kind: "reuse-command", availability: {
          status: "unavailable",
          command: { version: 1, name, source: "project-custom", invocationKind: "prompt" },
          reason: "Body unavailable",
        } },
      })),
    }, checks);
    expect(output.split("\n").filter((line) => line.startsWith("/"))).toEqual([
      "/project-check unavailable: Body unavailable",
      "/Global.Check unavailable: Body unavailable",
    ]);
    expect(output).toContain("Advice only. Running or editing anything requires separate approval.");
    expect(output).toContain("Next: recheck the command and project prerequisites before proceeding.");
  });
});

describe("needs-first host submission", () => {
  const snapshot = {
    version: 1, command: { version: 1, name: "project-check", source: "project-custom", invocationKind: "prompt" },
    capabilityKind: "prompt-only", ownerSha256: "a".repeat(64), bodySha256: "b".repeat(64), helpers: [],
  };
  const availability = { status: "available", snapshot };
  const proposal = {
    version: 1, capabilityKind: "prompt-only", desiredOutcome: "Check configuration across selected packages",
    inputs: ["Package configuration"], outputs: ["Configuration discrepancy report"],
    prerequisites: ["Readable package configuration"], risks: ["Package-specific settings may differ"],
    verificationExpectations: ["Compare reports against known valid and invalid configurations"],
  };
  function fixture(kind = "extend-command") {
    const evidence = new AdvisoryEvidence();
    const turn = scannedTurn(evidence);
    const receipt = evidence.observe(process.cwd(), "read", { file_path: "package.json" }, "prerequisite", "1\tConfiguration check inputs");
    // Contract fixture supplies host classification; real delivery is covered in advisory-tools.test.ts.
    receipt.localSources = [{ path: "package.json", purpose: "independent" }];
    const recommendation = {
      ...manualAssessment.recommendations[0]!,
      outcome: "Compare configuration across selected packages",
      rationale: "A shared comparison can avoid repeating the same package inspection steps",
      workflow: {
        ...manualAssessment.recommendations[0]!.workflow,
        trigger: "A configuration change affects multiple packages",
        representativeCase: "Compare the root check settings with two selected packages",
        inputs: ["Root configuration", "Selected package configurations"],
        currentProcess: ["Read each configuration", "Compare check settings", "Report discrepancies"],
        output: "A configuration discrepancy report",
        successCheck: "Known valid and invalid configurations are distinguished without modifying files",
      },
      evidence: { version: 1, items: [{ basis: "observed", source: receipt.id, code: "prerequisite", severity: "info", message: "The package configuration supplies the input required by the check workflow" }] },
      alternatives: [{ kind: "manual", reasonNotSelected: "Repeated package comparisons would duplicate the same inspection steps" }],
      choice: kind === "extend-command"
        ? { kind, availability, proposedChanges: ["Accept a selected package list rather than only the root configuration"], requirement: proposal }
        : kind === "missing-capability" ? { kind, proposal }
          : { kind: "manual", steps: ["Compare the package settings by hand"] },
    };
    const input = { ...manualAssessment, recommendations: [recommendation] };
    const checks = { snapshot: vi.fn(async () => true), page: async () => ({}), signal: new AbortController().signal };
    return { evidence, turn, input, recommendation, checks };
  }
  function deliver(turn: ProgrammaticAdvisoryTurn) {
    turn.observeCommand(JSON.stringify({ status: "prompt", snapshot }));
  }

  it("retains the complete workflow while summarizing extension consequences without starting work", async () => {
    const { turn, input, checks } = fixture();
    deliver(turn);
    const output = await turn.submit(input, checks);
    expect(turn.acceptedResult!.recommendations).toEqual(input.recommendations);
    const before = structuredClone(turn.acceptedResult);
    expect(renderAdvisoryResult(turn.acceptedResult!)).toBe(output);
    expect(turn.acceptedResult).toEqual(before);
    for (const value of [proposal.desiredOutcome, ...proposal.inputs, ...proposal.outputs,
      ...proposal.prerequisites, ...proposal.risks, ...proposal.verificationExpectations,
      input.recommendations[0]!.workflow.mutationBoundary]) expect(output).toContain(value);
    expect(output).toContain("Scope: repository-wide");
    expect(output).not.toMatch(/Trigger:|Representative case:|Repeatability|Alternative not selected|Evidence \(/);
    expect(output).toContain("Proposal only");
    expect(output).toContain("/project-check: prompt available, not started");
    expect(output).toContain("Editing requires separate approval.");
    expect(output).toContain("Proposed changes: Accept a selected package list");
    expect(output).not.toContain("receipt-");
    expect(output).not.toContain(snapshot.bodySha256);
    expect(output).toContain("Uncertainty: Behavior still needs verification");
  });

  it("keeps app-backed proposals visibly separate from working generated commands", async () => {
    const { turn, input, checks } = fixture("missing-capability");
    Object.assign(input.recommendations[0]!.choice, { proposal: { ...proposal, capabilityKind: "app-backed" } });
    const output = await turn.submit(input, checks);
    expect(output).toContain("Proposal only");
    expect(output).toContain("Next: plan application development. A prompt alone cannot provide this functionality.");
    for (const value of [...proposal.prerequisites, ...proposal.risks, ...proposal.verificationExpectations]) expect(output).toContain(value);
  });

  it.each(["prompt-only", "app-backed"] as const)("keeps %s command restrictions and a next action in the terminal summary", (capabilityKind) => {
    const { input } = fixture();
    const accepted = programmaticAssessmentResultV2Schema.parse({ ...input, recommendations: [{
      ...input.recommendations[0], choice: { kind: "reuse-command", availability: {
        status: "available", snapshot: { ...snapshot, capabilityKind, command: capabilityKind === "app-backed"
          ? { ...snapshot.command, source: "built-in", invocationKind: "workspace-action" } : snapshot.command },
      } },
    }] });
    const before = structuredClone(accepted);
    const output = renderAdvisoryResult(accepted);
    expect(output).toContain(`/project-check: ${capabilityKind === "app-backed" ? "workspace action" : "prompt"} available, not started. This does not guarantee the required tools or behavior.`);
    expect(output).toContain(capabilityKind === "app-backed"
      ? "Next: review the required application integration. This proposal cannot run it."
      : "Next: review the current command, prerequisites and scope before approving a run.");
    expect(accepted).toEqual(before);
  });

  it("renders honest unknowns and bounded next inspection steps", async () => {
    const { turn, input, checks } = fixture("manual");
    Object.assign(input.recommendations[0]!, {
      alternatives: [], evidence: { version: 1, items: [] },
      choice: { kind: "needs-more-evidence", missingEvidence: ["Local prerequisite support is unknown"], nextInspectionSteps: ["Read the selected package configuration"] },
    });
    input.recommendations[0]!.workflow.repeatability = { basis: "assumed", explanation: "Recurrence is unknown" };
    const output = await turn.submit(input, checks);
    expect(output).toContain("Missing evidence: Local prerequisite support is unknown");
    expect(output).toContain("Next: inspect without making changes — Read the selected package configuration");
    expect(turn.acceptedResult!.recommendations[0]!.workflow.repeatability).toEqual({ basis: "assumed", explanation: "Recurrence is unknown" });
    expect(output).not.toContain("Repeatability");
  });

  it.each([undefined, "unknown", "command-definition"] as const)("rejects positive advice with %s source-purpose provenance", async (purpose) => {
    const { evidence, turn, input, checks } = fixture("missing-capability");
    const receipt = evidence.list()[0]!;
    receipt.localSources = purpose ? [{ path: "package.json", purpose }] : undefined;
    await expect(turn.submit(input, checks)).rejects.toThrow("inspected local workflow evidence");
    expect(turn.acceptedResult).toBeUndefined();
  });

  it.each(["empty", "assumption", "metadata", "body", "external"])("refuses new automation supported only by %s evidence", async (support) => {
    const { evidence, turn, input, recommendation, checks } = fixture("missing-capability");
    recommendation.evidence.items = [];
    if (support === "assumption") recommendation.evidence.items.push({ basis: "assumed", source: "assumption", code: "need", severity: "info", message: "The workflow might recur" });
    if (support === "metadata" || support === "body") {
      const receipt = evidence.observe(process.cwd(), "command_information", { action: support === "body" ? "resolve" : "list" }, support, "Command information");
      recommendation.evidence.items.push({ basis: "inferred", source: receipt.id, code: "need", severity: "info", message: "Catalog information is not local workflow inspection" });
    }
    if (support === "external") {
      const receipt = evidence.observe(process.cwd(), "research_corpus", { action: "show", repo: "owner/repo", path: "check.ts" }, "external", "Example check");
      recommendation.evidence.items.push({ basis: "inferred", source: receipt.id, code: "need", severity: "info", message: "An external example does not establish this project's need" });
    }
    await expect(turn.submit(input, checks)).rejects.toThrow("inspected local workflow evidence");
    expect(turn.submitted).toBe(false);
    expect(turn.acceptedResult).toBeUndefined();
  });

  it("refuses an initially unavailable extension base", async () => {
    const { turn, input, checks } = fixture();
    Object.assign(input.recommendations[0]!.choice, { availability: { status: "unavailable", command: snapshot.command, reason: "Body unreadable" } });
    await expect(turn.submit(input, checks)).rejects.toThrow("Extension requires an inspected base");
    expect(checks.snapshot).not.toHaveBeenCalled();
    expect(turn.submitted).toBe(false);
  });

  it.each(["base", "alternative"])("requires the exact delivered %s snapshot", async (target) => {
    const { turn, input, recommendation, checks } = fixture(target === "base" ? "extend-command" : "missing-capability");
    if (target === "alternative") Object.assign(recommendation, { alternatives: [{ kind: "reuse-command", availability, reasonNotSelected: "The root-only command cannot compare selected packages" }] });
    await expect(turn.submit(input, checks)).rejects.toThrow("Resolve the exact candidate body");
    turn.observeCommand(JSON.stringify({ status: "prompt", snapshot: { ...snapshot, bodySha256: "c".repeat(64) } }));
    await expect(turn.submit(input, checks)).rejects.toThrow("Resolve the exact candidate body");
    expect(turn.submitted).toBe(false);
    deliver(turn);
    await turn.submit(input, checks);
    expect(checks.snapshot).toHaveBeenCalledExactlyOnceWith(snapshot);
    expect(turn.acceptedResult?.recommendations[0]?.choice.kind).toBe(target === "base" ? "extend-command" : "missing-capability");
  });

  it.each(["base", "reuse", "alternative"])("downgrades stale %s to unavailable and limited without discarding the proposal", async (target) => {
    const { turn, input, recommendation, checks } = fixture();
    if (target === "reuse") Object.assign(recommendation, { choice: { kind: "reuse-command", availability } });
    if (target === "alternative") Object.assign(recommendation, { choice: { kind: "missing-capability", proposal }, alternatives: [{ kind: "reuse-command", availability, reasonNotSelected: "The root-only command cannot compare selected packages" }] });
    deliver(turn);
    checks.snapshot.mockResolvedValue(false);
    await turn.submit(input, checks);
    const accepted = turn.acceptedResult!;
    const command = target !== "alternative" ? accepted.recommendations[0]!.choice : accepted.recommendations[0]!.alternatives[0];
    expect(command).toMatchObject({ availability: { status: "unavailable", command: snapshot.command, reason: expect.stringContaining("changed") } });
    expect(accepted.coverage).toMatchObject({ status: "limited", reason: expect.stringContaining("compared command changed") });
    expect(accepted.recommendations[0]!.choice.kind).toBe(target === "base" ? "extend-command" : target === "reuse" ? "reuse-command" : "missing-capability");
    const display = projectDiscovery(randomUUID(), accepted).projection.candidates[0]!;
    expect(target === "alternative" ? display.alternatives[0]!.availability : display.availability).toEqual({
      status: "unavailable", reason: "Command identity/body changed or cannot be safely resolved at submission.",
    });
    expect(display.nextStep.available).toBe(true);
    expect(JSON.stringify(display)).not.toContain("bodySha256");
  });

  it.each(["manual", "missing-capability"])("requires cited local prerequisites for command alternatives on %s", async (kind) => {
    const { turn, input, recommendation, checks } = fixture(kind);
    const local = recommendation.evidence.items;
    recommendation.evidence.items = [];
    Object.assign(recommendation, { alternatives: [{ kind: "reuse-command", availability, reasonNotSelected: "The command only checks the root and cannot compare packages" }] });
    deliver(turn);
    await expect(turn.submit(input, checks)).rejects.toThrow("inspected local prerequisite evidence");
    expect(turn.submitted).toBe(false);
    recommendation.evidence.items = local;
    await turn.submit(input, checks);
    expect(turn.acceptedResult?.recommendations[0]?.alternatives[0]).toMatchObject({ availability });
  });

  it.each(["forged", "authority", "v1"])("rejects %s submissions without consuming the result slot", async (mode) => {
    const { turn, input, recommendation, checks } = fixture("missing-capability");
    if (mode === "forged") recommendation.evidence.items[0]!.source = "receipt-invented";
    if (mode === "authority") Object.assign(recommendation, { executionApproved: true, toolGrants: ["write"] });
    if (mode === "v1") input.version = 1;
    await expect(turn.submit(input, checks)).rejects.toThrow(mode === "forged" ? "host receipt ID" : mode === "authority" ? "Unrecognized" : "2");
    expect(turn.submitted).toBe(false);
    expect(turn.acceptedResult).toBeUndefined();
  });
});

describe("advisory extension regression fixtures", () => {
  it("represents manual work without executable opportunity state", () => {
    const result = programmaticAssessmentResultV2Schema.parse(manualAssessment);
    expect(result.recommendations[0]!.choice.kind).toBe("manual");
    expect(result).not.toHaveProperty("opportunities");
    expect(result).not.toHaveProperty("configurationFingerprint");
    expect(
      programmaticAssessmentResultV2Schema.safeParse({ ...manualAssessment, lifecycle: [] })
        .success,
    ).toBe(false);
  });
  it.each(["review", "project-check", "Global.Check"])(
    "permits advice for %s outside the specialist runner",
    (name) => {
      const result = programmaticAssessmentResultV2Schema.parse({
        ...manualAssessment,
        recommendations: [
          {
            ...manualAssessment.recommendations[0],
            choice: {
              kind: "reuse-command",
              availability: {
                status: "unavailable",
                command: {
                  version: 1,
                  name,
                  source:
                    name === "review"
                      ? "built-in"
                      : name === "project-check"
                        ? "project-custom"
                        : "global-custom",
                  invocationKind: "prompt",
                },
                reason: "Resolve body and inspect prerequisites before asserting suitability",
              },
            },
          },
        ],
      });
      expect(result.recommendations[0]!.choice.kind).toBe("reuse-command");
    },
  );
  it.each(["prompt-only", "script-backed", "app-backed"])(
    "keeps missing %s functionality a proposal",
    (capabilityKind) => {
      const result = programmaticAssessmentResultV2Schema.parse({
        ...manualAssessment,
        recommendations: [
          {
            ...manualAssessment.recommendations[0],
            alternatives: [{ kind: "manual", reasonNotSelected: "Repeated status aggregation would require the same error-prone steps" }],
            choice: {
              kind: "missing-capability",
              proposal: {
                version: 1,
                capabilityKind,
                desiredOutcome: "Inspect deployment status",
                inputs: ["Selected project"],
                outputs: ["Status report"],
                prerequisites: ["Separate implementation approval"],
                risks: ["Capability does not exist"],
                verificationExpectations: ["Exercise the real implementation"],
              },
            },
          },
        ],
      });
      expect(result.recommendations[0]!.choice.kind).toBe("missing-capability");
    },
  );
  it("requires paging beyond the first hundred entries without truncating command identities", () => {
    const entries: CommandDiscovery["entries"] = Array.from({ length: 205 }, (_, index) => ({
      listing: {
        name: `custom-${index}`,
        aliases: [],
        description: "Project check",
        source: "custom",
        origin: "project-custom",
        invocationKind: "prompt",
        input: { text: "optional", references: "none", attachments: "none" },
      },
    }));
    const discovery: CommandDiscovery = {
      entries,
      resolve: (name) => entries.find((entry) => entry.listing.name === name),
    };
    const first = projectAdvisoryCommands(discovery);
    expect(first).toMatchObject({ nextOffset: 100, total: 205, limitedCoverage: true });
    const second = projectAdvisoryCommands(discovery, first.nextOffset!);
    const third = projectAdvisoryCommands(discovery, second.nextOffset!);
    expect(
      [...first.entries, ...second.entries, ...third.entries].map((entry) => entry.name),
    ).toEqual(entries.map((entry) => entry.listing.name));
    expect(third.nextOffset).toBeNull();
  });
});