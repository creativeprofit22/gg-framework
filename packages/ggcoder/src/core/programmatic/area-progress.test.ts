import { describe, expect, it } from "vitest";
import { isProgrammaticAssessment } from "@kenkaiiii/gg-core/programmatic-assessment-contract";
import type { ProgrammaticAreaV1 } from "./area-map.js";
import { assessmentAreas, clipText, createAreaProgress, withoutFinds } from "./area-progress.js";
import type { AreaCandidateNeed } from "./area-search.js";

const area = (id: string, label = id) => ({ id, label }) as ProgrammaticAreaV1;
const need = (text: string, path?: string) =>
  ({
    need: text,
    uncertainty: "Owner unclear",
    workflow: {
      affectedSubproject: path ? { scope: "subproject", path } : { scope: "repository-wide" },
    },
  }) as unknown as AreaCandidateNeed;
const ok = (needs: AreaCandidateNeed[], status: "searched" | "partly" = "searched") => ({
  status,
  needs,
  receipts: [],
  sample: { listed: 1, excerpted: 0 },
});

describe("area progress snapshots", () => {
  it("moves rows waiting → reading → found with at most three bounded finds", () => {
    const progress = createAreaProgress([area("a", "Core"), area("b")]);
    expect(progress.snapshot().map((row) => row.status)).toEqual(["waiting", "waiting"]);
    progress.update(area("a", "Core"), { status: "reading" });
    expect(progress.snapshot()[0]).toEqual({ id: "a", label: "Core", status: "reading" });
    progress.update(area("a", "Core"), {
      status: "settled",
      outcome: ok([need("x".repeat(400), "pkg/a"), need("two"), need("three"), need("four")]),
    });
    const [row] = progress.snapshot();
    expect(row?.status).toBe("found");
    expect(row?.finds).toHaveLength(3);
    expect(row?.finds?.[0]?.need).toHaveLength(280);
    expect(row?.finds?.[0]?.where).toBe("pkg/a");
    expect(row?.finds?.[1]?.where).toBe("Core");
    expect(withoutFinds(progress.snapshot())[0]).not.toHaveProperty("finds");
  });
  it("maps partly, failed and cancelled outcomes and ignores unknown areas", () => {
    const progress = createAreaProgress([area("a"), area("b"), area("c")]);
    progress.update(area("a"), { status: "settled", outcome: ok([], "partly") });
    progress.update(area("b"), {
      status: "settled",
      outcome: { status: "incomplete", reason: "timed-out" },
    });
    progress.update(area("c"), {
      status: "settled",
      outcome: { status: "incomplete", reason: "cancelled" },
    });
    expect(progress.update(area("z"), { status: "reading" })).toBe(false);
    expect(progress.snapshot()).toEqual([
      { id: "a", label: "a", status: "partly" },
      { id: "b", label: "b", status: "failed" },
      { id: "c", label: "c", status: "stopped" },
    ]);
  });
  it("marks only failed, timed-out and no-result areas retryable", () => {
    const areas = assessmentAreas([
      { id: "a", label: "a", status: "searched" },
      { id: "b", label: "b", status: "partly", reason: "sample-limit" },
      { id: "c", label: "c", status: "not-searched", reason: "timed-out" },
      { id: "d", label: "d", status: "not-searched", reason: "no-result" },
      { id: "e", label: "e", status: "not-searched", reason: "failed" },
      { id: "f", label: "f", status: "not-searched", reason: "cancelled" },
      { id: "g", label: "g", status: "not-searched", reason: "low-signal" },
    ]);
    expect(areas.map((item) => item.retryable)).toEqual([
      false,
      false,
      true,
      true,
      true,
      false,
      false,
    ]);
    const assessment = {
      version: 1,
      mode: "configured",
      status: "completed",
      summary: "Scoped",
      limitations: [],
      coverage: [],
      observations: [],
      deterministic: { status: "succeeded", enabledCount: 0, applicableCount: 0 },
      areas,
    };
    expect(isProgrammaticAssessment(assessment)).toBe(true);
  });
  it("clips by UTF-16 length without splitting a code point", () => {
    expect(clipText("short", 10)).toBe("short");
    const clipped = clipText("😀".repeat(10), 7);
    expect(clipped.length).toBeLessThanOrEqual(7);
    expect(clipped).toBe("😀😀😀…");
  });
});
