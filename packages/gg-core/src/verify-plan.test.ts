import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  VERIFY_PLAN_DESCRIPTOR_MAX_BYTES,
  VERIFY_PLAN_HEURISTICS_REASONS,
  VERIFY_PLAN_LIMITS,
  VERIFY_PLAN_MAX_BYTES,
  adaptSupaPlanV1,
  decideVerifyPlanSource,
  interpretVerifyPlanOutput,
  parseVerifyPlan,
  parseVerifyPlanDescriptor,
  parseVerifyPlanJson,
} from "./verify-plan.js";

const fixture = (name: string): string =>
  readFileSync(new URL(`./__fixtures__/verify-plan/${name}`, import.meta.url), "utf8");

const gate = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "unit",
  argv: ["pnpm", "test"],
  ...overrides,
});

const plan = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  version: 1,
  mode: "changed",
  gates: [gate()],
  ...overrides,
});

const reasonOf = (value: unknown): string => {
  const result = parseVerifyPlan(value);
  expect(result.ok).toBe(false);
  return result.ok ? "" : result.reason;
};

const descriptor = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    version: 1,
    command: { argv: ["node", "scripts/verify-plan.mjs"], cwd: "." },
    format: "gg-verify-plan-v1",
    ...overrides,
  });

describe("verify-plan fixtures", () => {
  it("accepts a minimal non-JS harness plan with defaults filled in", () => {
    expect(parseVerifyPlanJson(fixture("cargo-only.json"))).toEqual({
      ok: true,
      plan: {
        version: 1,
        mode: "full",
        gates: [
          {
            id: "cargo-test",
            argv: ["cargo", "test"],
            cwd: ".",
            covers: ["src/**/*.rs"],
            fingerprint: null,
            quietBudgetSeconds: null,
            protectedPaths: [],
          },
        ],
        advice: [],
      },
    });
  });

  it("adapts a supa plan and keeps reused passes as advice only", () => {
    const result = adaptSupaPlanV1(JSON.parse(fixture("supa-plan-v1.json")));
    if (!result.ok) throw new Error(result.reason);
    expect(result.plan.mode).toBe("changed");
    expect(result.plan.gates.map((entry) => [entry.id, entry.cwd, entry.covers])).toEqual([
      ["typecheck", ".", ["src/**/*.ts", "tsconfig.json"]],
      ["unit", "packages/api", ["packages/api/src/**/*.{ts,tsx}"]],
    ]);
    expect(result.plan.gates[0]?.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(result.plan.advice).toEqual([
      {
        gateId: "lint",
        kind: "reused-pass",
        reason: "inputs unchanged since last pass",
        lastRun: "2026-10-29T18:04:11Z",
      },
    ]);
    expect(result.plan.gates.some((entry) => entry.id === "lint")).toBe(false);
  });

  it("rejects a supa plan of another version", () => {
    const supa = JSON.parse(fixture("supa-plan-v1.json")) as Record<string, unknown>;
    expect(adaptSupaPlanV1({ ...supa, version: 2 })).toEqual({
      ok: false,
      reason: "unsupported supa plan version 2; expected 1",
    });
  });
});

describe("parseVerifyPlan rejections", () => {
  it("rejects malformed and oversize JSON text", () => {
    expect(parseVerifyPlanJson("{ not json")).toEqual({
      ok: false,
      reason: "plan is not valid JSON",
    });
    const oversize = `{"pad":"${"x".repeat(VERIFY_PLAN_MAX_BYTES)}"}`;
    expect(parseVerifyPlanJson(oversize)).toEqual({
      ok: false,
      reason: `plan is larger than ${VERIFY_PLAN_MAX_BYTES} bytes`,
    });
  });

  it.each([
    ["missing", undefined, "unsupported verify-plan version missing; expected 1"],
    ["older", 0, "unsupported verify-plan version 0; expected 1"],
    ["newer", 2, "unsupported verify-plan version 2; expected 1"],
  ])("rejects a %s version", (_label, version, reason) => {
    expect(reasonOf(plan({ version }))).toBe(reason);
  });

  it("rejects unknown keys at plan and gate level", () => {
    expect(reasonOf(plan({ extra: true }))).toBe('unknown key "extra"');
    expect(reasonOf(plan({ gates: [gate({ shell: true })] }))).toBe(
      'gates[0]: unknown key "shell"',
    );
  });

  it("rejects shell strings and shell programs", () => {
    expect(reasonOf(plan({ gates: [gate({ argv: "pnpm test" })] }))).toBe(
      "gates[0].argv: argv must be an array, shell strings are not accepted",
    );
    for (const program of ["bash", "/bin/sh", "C:/Windows/System32/cmd.exe", "pwsh"]) {
      expect(reasonOf(plan({ gates: [gate({ argv: [program, "-c", "pnpm test"] })] }))).toBe(
        "gates[0].argv[0]: shells are not accepted as the program",
      );
    }
    expect(reasonOf(plan({ gates: [gate({ argv: [] })] }))).toBe(
      "gates[0].argv: argv must be a non-empty array",
    );
    expect(reasonOf(plan({ gates: [gate({ argv: ["node", "a\nb"] })] }))).toBe(
      "gates[0].argv[1]: contains NUL or a newline",
    );
  });

  it("rejects traversal and absolute paths", () => {
    expect(reasonOf(plan({ gates: [gate({ covers: ["src/../../etc/passwd"] })] }))).toBe(
      'gates[0].covers[0]: ".." segments are not allowed',
    );
    expect(reasonOf(plan({ gates: [gate({ cwd: ".." })] }))).toBe(
      'gates[0].cwd: ".." segments are not allowed',
    );
    for (const absolute of ["/x", "C:/x"]) {
      expect(reasonOf(plan({ gates: [gate({ cwd: absolute })] }))).toBe(
        "gates[0].cwd: must be repo-relative, not absolute",
      );
    }
    expect(reasonOf(plan({ gates: [gate({ protectedPaths: ["\\\\srv\\share"] })] }))).toBe(
      'gates[0].protectedPaths[0]: use "/" separators, not "\\"',
    );
  });

  it("limits globs to the supported subset", () => {
    expect(parseVerifyPlan(plan({ gates: [gate({ covers: ["a/**/b?.{ts,tsx}"] })] })).ok).toBe(
      true,
    );
    expect(reasonOf(plan({ gates: [gate({ covers: ["src/[ab].ts"] })] }))).toBe(
      "gates[0].covers[0]: only **, *, ? and {a,b} globs are supported",
    );
    expect(reasonOf(plan({ gates: [gate({ cwd: "src/*" })] }))).toBe(
      "gates[0].cwd: globs are not allowed here",
    );
  });

  it("rejects duplicate ids, too many gates and bad optional fields", () => {
    expect(reasonOf(plan({ gates: [gate(), gate()] }))).toBe('gates: duplicate id "unit"');
    const many = Array.from({ length: VERIFY_PLAN_LIMITS.gates + 1 }, (_, index) =>
      gate({ id: `g${index}` }),
    );
    expect(reasonOf(plan({ gates: many }))).toBe(
      `gates: more than ${VERIFY_PLAN_LIMITS.gates} entries`,
    );
    expect(reasonOf(plan({ gates: [gate({ id: "Bad Id" })] }))).toContain("gates[0].id");
    expect(reasonOf(plan({ gates: [gate({ fingerprint: "abc" })] }))).toContain(
      "gates[0].fingerprint",
    );
    expect(reasonOf(plan({ gates: [gate({ quietBudgetSeconds: 3601 })] }))).toContain(
      "gates[0].quietBudgetSeconds",
    );
    expect(reasonOf(plan({ mode: "all" }))).toBe('mode: must be "changed" or "full"');
  });
});

describe("plan source rules", () => {
  it("parses a descriptor and applies the same argv/cwd rules", () => {
    expect(parseVerifyPlanDescriptor(descriptor())).toEqual({
      ok: true,
      descriptor: {
        version: 1,
        command: { argv: ["node", "scripts/verify-plan.mjs"], cwd: "." },
        format: "gg-verify-plan-v1",
      },
    });
    expect(
      parseVerifyPlanDescriptor(descriptor({ command: { argv: ["bash", "-c", "x"] } })),
    ).toEqual({ ok: false, reason: "command.argv[0]: shells are not accepted as the program" });
    expect(
      parseVerifyPlanDescriptor(descriptor({ command: { argv: ["node"], cwd: "../x" } })),
    ).toEqual({ ok: false, reason: 'command.cwd: ".." segments are not allowed' });
    expect(parseVerifyPlanDescriptor(descriptor({ format: "other" })).ok).toBe(false);
    expect(parseVerifyPlanDescriptor(" ".repeat(VERIFY_PLAN_DESCRIPTOR_MAX_BYTES + 1))).toEqual({
      ok: false,
      reason: `descriptor is larger than ${VERIFY_PLAN_DESCRIPTOR_MAX_BYTES} bytes`,
    });
  });

  it("falls back to heuristics with fixed reasons", () => {
    expect(decideVerifyPlanSource({ trusted: false, descriptor: descriptor() })).toEqual({
      kind: "heuristics",
      reason: VERIFY_PLAN_HEURISTICS_REASONS.untrusted,
    });
    expect(decideVerifyPlanSource({ trusted: true, descriptor: null })).toEqual({
      kind: "heuristics",
      reason: VERIFY_PLAN_HEURISTICS_REASONS.noDescriptor,
    });
    expect(decideVerifyPlanSource({ trusted: true, descriptor: "[]" })).toEqual({
      kind: "heuristics",
      reason: `${VERIFY_PLAN_HEURISTICS_REASONS.badDescriptor}: descriptor must be a JSON object`,
    });
    expect(decideVerifyPlanSource({ trusted: true, descriptor: descriptor() }).kind).toBe("run");
  });

  it("interprets plan command output as untrusted data", () => {
    const cargo = fixture("cargo-only.json");
    const supa = fixture("supa-plan-v1.json");
    expect(interpretVerifyPlanOutput("gg-verify-plan-v1", cargo, 0, false).kind).toBe("plan");
    const adapted = interpretVerifyPlanOutput("supa-plan-v1", supa, 0, false);
    expect(adapted.kind === "plan" ? adapted.plan.advice.length : -1).toBe(1);
    expect(interpretVerifyPlanOutput("gg-verify-plan-v1", cargo, 0, true)).toEqual({
      kind: "heuristics",
      reason: VERIFY_PLAN_HEURISTICS_REASONS.timedOut,
    });
    expect(interpretVerifyPlanOutput("gg-verify-plan-v1", cargo, 1, false)).toEqual({
      kind: "heuristics",
      reason: `${VERIFY_PLAN_HEURISTICS_REASONS.nonZeroExit} (exit 1)`,
    });
    const oversize = "x".repeat(VERIFY_PLAN_MAX_BYTES + 1);
    expect(interpretVerifyPlanOutput("gg-verify-plan-v1", oversize, 0, false)).toEqual({
      kind: "heuristics",
      reason: VERIFY_PLAN_HEURISTICS_REASONS.oversize,
    });
    expect(interpretVerifyPlanOutput("gg-verify-plan-v1", supa, 0, false)).toEqual({
      kind: "heuristics",
      reason: `${VERIFY_PLAN_HEURISTICS_REASONS.badPlan}: unknown key "run"`,
    });
  });
});
