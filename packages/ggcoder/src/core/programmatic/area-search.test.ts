import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProgrammaticAreaV1 } from "./area-map.js";
import { ADVISORY_LIMITATIONS, type AdvisoryReceipt } from "./advisory.js";
import {
  AREA_SEARCH_LIMITS,
  mergeAreaCandidates,
  runAreaPasses,
  selectAreaSearch,
  type AreaCandidateNeed,
  type AreaPassOutcome,
} from "./area-search.js";

function area(id: string, extra: Partial<ProgrammaticAreaV1> = {}): ProgrammaticAreaV1 {
  return {
    id,
    label: id,
    kind: "package",
    packageName: null,
    include: [`${id}/**`],
    exclude: [],
    fileCount: 100,
    sourceFileCount: 50,
    oversized: false,
    lowSignal: null,
    signals: {
      scripts: [],
      ciJobs: [],
      commandFiles: 0,
      taskRunners: [],
      itemFamilies: [],
      recentChanges: null,
    },
    omitted: { scripts: 0, ciJobs: 0, taskRunners: 0, itemFamilies: 0, exclude: 0, unsafeNames: 0 },
    ...extra,
  } as ProgrammaticAreaV1;
}
function receipt(id: string): AdvisoryReceipt {
  return { id, toolCallId: id, tool: "read", status: "retrieved", location: `${id}.ts` };
}
function need(text: string, sources: string[], path = "packages/api"): AreaCandidateNeed {
  return {
    need: text,
    workflow: {
      trigger: "t",
      representativeCase: "c",
      inputs: ["i"],
      currentProcess: ["p"],
      output: "o",
      successCheck: "s",
      affectedSubproject: { scope: "subproject", path },
      mutationBoundary: "m",
      repeatability: { basis: "observed", explanation: "e" },
    },
    evidence: {
      version: 1,
      items: sources.map((source) => ({ basis: "observed", source, message: `seen ${source}` })),
    },
    uncertainty: "u",
  } as AreaCandidateNeed;
}
const ok = (
  needs: AreaCandidateNeed[],
  receipts: AdvisoryReceipt[],
  extra: Partial<Extract<AreaPassOutcome, { status: "searched" | "partly" }>> = {},
): AreaPassOutcome => ({
  status: "searched",
  needs,
  receipts,
  sample: { listed: 3, excerpted: 1 },
  ...extra,
});
const map = (areas: ProgrammaticAreaV1[], fileCount = 500) =>
  ({ status: "ok", areaMap: { fileCount, areas }, omitted: {} }) as never;

afterEach(() => vi.useRealTimers());

describe("area search selection", () => {
  const base = { mode: "configured" as const, readAllowed: true, toolsDisabled: false };
  it("searches areas in map order, skipping low-signal ones and capping the count", () => {
    const areas = [
      area("cross-area", { kind: "cross-area" }),
      ...Array.from({ length: 7 }, (_, index) => area(`p${index}`)),
      area("quiet", { lowSignal: { reason: "isolated" } }),
    ];
    const decision = selectAreaSearch({ ...base, areaMap: map(areas) });
    expect(decision.mode).toBe("areas");
    if (decision.mode !== "areas") return;
    expect(decision.selected.map((item) => item.id)).toEqual([
      "cross-area",
      "p0",
      "p1",
      "p2",
      "p3",
      "p4",
    ]);
    expect(decision.skipped.map((item) => [item.area.id, item.reason])).toEqual([
      ["p5", "limit"],
      ["p6", "limit"],
      ["quiet", "low-signal"],
    ]);
  });
  it("falls back to the single pass for a focus, one area, a small map or no read access", () => {
    const two = [area("a"), area("b")];
    expect(selectAreaSearch({ ...base, focus: "api", areaMap: map(two) }).mode).toBe("single");
    expect(
      selectAreaSearch({
        ...base,
        areaMap: map([area("cross-area", { kind: "cross-area" }), area("a")]),
      }).mode,
    ).toBe("single");
    expect(selectAreaSearch({ ...base, areaMap: map(two, AREA_SEARCH_LIMITS.minFiles) }).mode).toBe(
      "single",
    );
    expect(selectAreaSearch({ ...base, readAllowed: false, areaMap: map(two) }).mode).toBe(
      "single",
    );
    expect(selectAreaSearch({ ...base, mode: "setup", areaMap: map(two) }).mode).toBe("single");
    expect(
      selectAreaSearch({ ...base, areaMap: { status: "unavailable", reason: "unreadable" } }).mode,
    ).toBe("single");
  });
});

describe("area pass scheduling", () => {
  it("never runs more than the concurrency cap at once", async () => {
    let running = 0;
    let peak = 0;
    const areas = Array.from({ length: 7 }, (_, index) => area(`a${index}`));
    const results = await runAreaPasses(
      areas,
      async () => {
        peak = Math.max(peak, ++running);
        await new Promise((resolve) => setTimeout(resolve, 5));
        running--;
        return ok([], []);
      },
      { signal: new AbortController().signal },
    );
    expect(peak).toBe(AREA_SEARCH_LIMITS.concurrency);
    expect(results.map((item) => item.area.id)).toEqual(areas.map((item) => item.id));
  });
  it("isolates a failing area and keeps the others", async () => {
    const results = await runAreaPasses(
      [area("a"), area("b"), area("c")],
      async (item) => {
        if (item.id === "b") throw new Error("provider exploded");
        return ok([], []);
      },
      { signal: new AbortController().signal },
    );
    expect(results.map((item) => [item.area.id, item.outcome.status])).toEqual([
      ["a", "searched"],
      ["b", "incomplete"],
      ["c", "searched"],
    ]);
    expect(results[1]?.outcome).toEqual({ status: "incomplete", reason: "failed" });
  });
  it("reports an area past its own deadline as timed out", async () => {
    vi.useFakeTimers();
    const pending = runAreaPasses(
      [area("slow"), area("fast")],
      (item, signal) =>
        item.id === "fast"
          ? Promise.resolve(ok([], []))
          : new Promise<AreaPassOutcome>((_, reject) =>
              signal.addEventListener("abort", () => reject(signal.reason)),
            ),
      { signal: new AbortController().signal, deadlineMs: 1_000 },
    );
    await vi.advanceTimersByTimeAsync(1_000);
    const results = await pending;
    expect(results.map((item) => item.outcome)).toEqual([
      { status: "incomplete", reason: "timed-out" },
      ok([], []),
    ]);
  });
  it("stops launching and rejects when the whole search is cancelled", async () => {
    const parent = new AbortController();
    const started: string[] = [];
    const pending = runAreaPasses(
      [area("a"), area("b"), area("c")],
      (item, signal) => {
        started.push(item.id);
        if (item.id === "a") parent.abort(new Error("stop"));
        return new Promise<AreaPassOutcome>((_, reject) =>
          signal.aborted
            ? reject(signal.reason)
            : signal.addEventListener("abort", () => reject(signal.reason)),
        );
      },
      { signal: parent.signal, concurrency: 1 },
    );
    await expect(pending).rejects.toThrow("stop");
    expect(started).toEqual(["a"]);
  });
  it("reports reading then settled per area, in launch order", async () => {
    const events: string[] = [];
    await runAreaPasses(
      [area("a"), area("b")],
      async (item) => {
        if (item.id === "b") throw new Error("boom");
        return ok([], []);
      },
      {
        signal: new AbortController().signal,
        concurrency: 1,
        onProgress: (item, progress) =>
          events.push(
            `${item.id}:${progress.status === "settled" ? progress.outcome.status : progress.status}`,
          ),
      },
    );
    expect(events).toEqual(["a:reading", "a:searched", "b:reading", "b:incomplete"]);
  });
  it("reports unstarted areas as stopped before rejecting on cancel", async () => {
    const parent = new AbortController();
    const events: string[] = [];
    const pending = runAreaPasses(
      [area("a"), area("b"), area("c")],
      (item, signal) => {
        if (item.id === "a") parent.abort(new Error("stop"));
        return new Promise<AreaPassOutcome>((_, reject) =>
          signal.aborted
            ? reject(signal.reason)
            : signal.addEventListener("abort", () => reject(signal.reason)),
        );
      },
      {
        signal: parent.signal,
        concurrency: 1,
        onProgress: (item, progress) =>
          events.push(
            `${item.id}:${progress.status === "settled" ? progress.outcome.status : progress.status}`,
          ),
      },
    );
    await expect(pending).rejects.toThrow("stop");
    expect(events).toEqual(["a:reading", "a:incomplete", "b:stopped", "c:stopped"]);
  });
  it("ignores a throwing progress callback", async () => {
    const results = await runAreaPasses([area("a")], async () => ok([], []), {
      signal: new AbortController().signal,
      onProgress: () => {
        throw new Error("render failed");
      },
    });
    expect(results.map((item) => item.outcome.status)).toEqual(["searched"]);
  });
});

describe("area candidate merge", () => {
  it("merges duplicate needs across areas once, with both area IDs and both receipts", () => {
    const merged = mergeAreaCandidates(
      [
        { area: area("a"), outcome: ok([need("Release notes by hand", ["r1"])], [receipt("r1")]) },
        {
          area: area("b"),
          outcome: ok(
            [need("  release NOTES, by hand!", ["r2"])],
            [receipt("r2"), receipt("unused")],
          ),
        },
        { area: area("c"), outcome: { status: "incomplete", reason: "timed-out" } },
      ],
      [{ area: area("d"), reason: "limit" }],
    );
    expect(merged.candidates).toHaveLength(1);
    expect(merged.candidates[0]?.areas).toEqual(["a", "b"]);
    expect(
      merged.candidates[0]?.evidence.items.map((item) => "source" in item && item.source),
    ).toEqual(["r1", "r2"]);
    expect(merged.receipts.map((item) => item.id)).toEqual(["r1", "r2"]);
    expect(merged.coverage.map((row) => row.status)).toEqual([
      "inspected",
      "inspected",
      "uninspected",
      "uninspected",
    ]);
    expect(merged.coverage[2]?.summary).toBe(
      "c: not searched, because searching it took too long.",
    );
    expect(merged.limitations).toHaveLength(2);
    expect(merged.sample).toEqual({ listed: 6, excerpted: 2 });
  });
  it("keeps needs for different subprojects apart", () => {
    const merged = mergeAreaCandidates(
      [
        { area: area("a"), outcome: ok([need("Same need", ["r1"], "x")], [receipt("r1")]) },
        { area: area("b"), outcome: ok([need("Same need", ["r2"], "y")], [receipt("r2")]) },
      ],
      [],
    );
    expect(merged.candidates).toHaveLength(2);
  });
  it("drops needs past the receipt cap and marks their area partly searched", () => {
    const merged = mergeAreaCandidates(
      [
        {
          area: area("a"),
          outcome: ok(
            [need("First", ["r1", "r2"]), need("Second", ["r3"])],
            [receipt("r1"), receipt("r2"), receipt("r3")],
          ),
        },
      ],
      [],
      2,
    );
    expect(merged.candidates.map((item) => item.need)).toEqual(["First"]);
    expect(merged.receipts).toHaveLength(2);
    expect(merged.statuses[0]).toMatchObject({ status: "partly", reason: "receipt-limit" });
    expect(merged.coverage[0]?.status).toBe("budget-limited");
  });
  it("merges a pass whose sample hit a limit as partly searched", () => {
    const merged = mergeAreaCandidates(
      [
        {
          area: area("a"),
          outcome: ok([need("First", ["r1"])], [receipt("r1")], {
            diagnostics: [{ code: "path-limit", count: 1 }],
          }),
        },
        {
          area: area("b"),
          outcome: ok([need("Second", ["r2"])], [receipt("r2")], {
            diagnostics: [{ code: "non-text", count: 3 }],
          }),
        },
      ],
      [],
    );
    expect(merged.statuses[0]).toMatchObject({ status: "partly", reason: "sample-limit" });
    expect(merged.coverage.map((row) => row.status)).toEqual(["budget-limited", "inspected"]);
    expect(merged.coverage[0]?.summary).toBe(
      "a: searched partly, so something there may have been missed.",
    );
    expect(merged.limitations).toEqual([]);
  });
  it("reports a permission-denied area and adds a limitation", () => {
    const merged = mergeAreaCandidates(
      [
        {
          area: area("a"),
          outcome: ok([need("First", ["r1"])], [receipt("r1")], {
            status: "partly",
            diagnostics: [
              { code: "excerpt-limit", count: 2 },
              { code: "permission-denied", count: 1 },
            ],
          }),
        },
      ],
      [],
    );
    expect(merged.statuses[0]).toMatchObject({ status: "partly", reason: "permission-denied" });
    expect(merged.coverage[0]).toEqual({
      scope: "project",
      status: "budget-limited",
      summary: "a: searched partly, because permission to read some of it was denied.",
    });
    expect(merged.limitations).toEqual([ADVISORY_LIMITATIONS.areasPermissionDenied]);
  });
});
