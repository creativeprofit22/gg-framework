import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createWebFetchTool } from "../../tools/web-fetch.js";
import { executeAdvisoryTool } from "./advisory-tools.js";

import { AdvisoryEvidence, ProgrammaticAdvisoryTurn, ADVISORY_LIMITS } from "./advisory.js";
import { programmaticAssessmentResultV1Schema } from "./contracts.js";
import { projectAdvisoryCommands, type CommandDiscovery } from "../command-discovery.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// Contract fixtures, not model-quality evaluation. Scanner equivalence is exercised
// separately by agent-session-programmatic-provider.test.ts through the real loop.
export const manualAssessment = {
  version: 1,
  kind: "advisory",
  coverage: {
    status: "limited",
    scope: "Manifest and catalog",
    reason: "Source prerequisites not inspected",
  },
  recommendations: [
    {
      version: 1,
      kind: "advisory",
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

// Validation fixtures explicitly establish a host-completed scan, not model-supplied state.
function scannedTurn(evidence: AdvisoryEvidence): ProgrammaticAdvisoryTurn {
  const turn = new ProgrammaticAdvisoryTurn(evidence);
  turn.claim("programmatic_scan", {});
  turn.settleScan("succeeded");
  return turn;
}

it("does not credit successful execution before post-cap preparation", async () => {
  const turn = scannedTurn(new AdvisoryEvidence());
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
  await expect(turn.submit(assessment, checks)).resolves.toContain("Claimed inspection");
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
      expect(await turn.submit(citation(actual), checks)).toContain("Inspected source");
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
    } else
      expect(
        await scannedTurn(evidence).submit(citation("https://example.com/file.pdf"), checks),
      ).toContain("Inspected source");
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
          expect(output).toContain("Coverage: limited");
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
    expect(output).toContain("Coverage: limited");
    expect(output).toContain("Not all current catalog pages");
    expect(output).toContain("Manual alternative");
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
    expect(await turn.submit(input(3), checks)).toContain("Inspected line");
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
    expect(await turn.submit(input(local.id), checks)).toContain("A model claim");
    expect(await scannedTurn(evidence).submit(input(local.id), checks)).toContain(local.id);
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
    expect(await turn.submit(input(citation), checks)).toContain("Model inference");
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

  it("renders supplied local locations without filling in omitted receipt ranges", async () => {
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
    const output = await scannedTurn(evidence).submit({
      ...manualAssessment,
      recommendations: [{ ...manualAssessment.recommendations[0], evidence: { version: 1, items } }],
    }, checks);
    expect(output.split("\n").filter((line) => line.startsWith("Evidence ("))).toEqual([
      `Evidence (observed, ${items[0]!.source}, path: src/first.ts, lines: 3-5): Local claim 0`,
      `Evidence (inferred, ${items[1]!.source}, path: src/second.ts, line: 8): Local claim 1`,
      `Evidence (observed, ${items[2]!.source}, path: src/path-only.ts): Local claim 2`,
      `Evidence (observed, ${items[3]!.source}): Local claim 3`,
    ]);
    expect(output).not.toContain("src/omitted.ts");
    expect(output).not.toContain("\u001b");
    expect(output.length).toBeLessThanOrEqual(ADVISORY_LIMITS.resultChars);
  });

  it("distinguishes corpus files and renders only supplied revisions and locations", async () => {
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
    const output = await scannedTurn(evidence).submit({
      ...manualAssessment,
      recommendations: [{
        ...manualAssessment.recommendations[0],
        evidence: { version: 1, items: [
          { ...citation, location: { path: "src/first.ts" }, revision: "abc123" },
          { ...citation, location: { path: "src/second.ts" } },
          citation,
        ] },
      }],
    }, checks);
    expect(output.split("\n").filter((line) => line.startsWith("External evidence ("))).toEqual([
      `External evidence (inferred, https://github.com/owner/repo, path: src/first.ts, revision: abc123): ${citation.claim}`,
      `External evidence (inferred, https://github.com/owner/repo, path: src/second.ts): ${citation.claim}`,
      `External evidence (inferred, https://github.com/owner/repo): ${citation.claim}`,
    ]);
    expect(output).toContain("Retrieval provenance does not verify claims; external URLs are source attribution, not proof of live URL fetching.");
    expect(output).not.toMatch(/\/blob\/|line:|lines:|revision: (?:HEAD|main|unknown)/);
  });

  it("names each unavailable command while retaining its reason", async () => {
    const output = await scannedTurn(new AdvisoryEvidence()).submit({
      ...manualAssessment,
      recommendations: ["project-check", "Global.Check"].map((name) => ({
        ...manualAssessment.recommendations[0],
        choice: { kind: "reuse-command", availability: {
          status: "unavailable",
          command: { version: 1, name, source: "project-custom", invocationKind: "prompt" },
          reason: "Body unavailable",
        } },
      })),
    }, checks);
    expect(output.split("\n").filter((line) => line.startsWith("Command unavailable"))).toEqual([
      "Command unavailable /project-check: Body unavailable",
      "Command unavailable /Global.Check: Body unavailable",
    ]);
    expect(output).toContain("Advice only: availability and suitability do not authorize execution.");
  });
});

describe("advisory extension regression fixtures", () => {
  it("represents manual work without executable opportunity state", () => {
    const result = programmaticAssessmentResultV1Schema.parse(manualAssessment);
    expect(result.recommendations[0]!.choice.kind).toBe("manual");
    expect(result).not.toHaveProperty("opportunities");
    expect(result).not.toHaveProperty("configurationFingerprint");
    expect(
      programmaticAssessmentResultV1Schema.safeParse({ ...manualAssessment, lifecycle: [] })
        .success,
    ).toBe(false);
  });
  it.each(["review", "project-check", "Global.Check"])(
    "permits advice for %s outside the specialist runner",
    (name) => {
      const result = programmaticAssessmentResultV1Schema.parse({
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
      const result = programmaticAssessmentResultV1Schema.parse({
        ...manualAssessment,
        recommendations: [
          {
            ...manualAssessment.recommendations[0],
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