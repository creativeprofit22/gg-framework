import { describe, expect, it } from "vitest";
import {
  buildSemanticLoopJudgePrompt,
  buildSemanticLoopMessage,
  MAX_SEMANTIC_LOOP_CHECKS,
  parseSemanticLoopVerdict,
  shouldRunSemanticLoopCheck,
  SEMANTIC_LOOP_COOLDOWN_TURNS,
  type SemanticCallDigest,
} from "./semantic-loop-check.js";

const calls: SemanticCallDigest[] = [
  {
    tool: "bash",
    args: '{"command":"npm test"}',
    ok: false,
    result: "Exit code: 1\n3 tests failed",
  },
  { tool: "edit", args: '{"file_path":"src/a.ts","old_text":"x"}', ok: true, result: "ok" },
  {
    tool: "bash",
    args: '{"command":"npm test"}',
    ok: false,
    result: "Exit code: 1\n3 tests failed",
  },
];

describe("shouldRunSemanticLoopCheck", () => {
  const base = {
    consecutiveFailures: 2,
    totalFailures: 3,
    turns: 10,
    lastCheckTurn: 0,
    checksUsed: 0,
    checkPending: false,
    deterministicBreak: false,
  };

  it("runs on a suspicious-but-syntactically-quiet burst", () => {
    expect(shouldRunSemanticLoopCheck(base)).toBe(true);
  });

  it("stays quiet while the deterministic breaker owns the correction", () => {
    expect(shouldRunSemanticLoopCheck({ ...base, deterministicBreak: true })).toBe(false);
  });

  it("requires at least two consecutive failures", () => {
    expect(shouldRunSemanticLoopCheck({ ...base, consecutiveFailures: 1 })).toBe(false);
  });

  it("respects the turn cooldown", () => {
    expect(
      shouldRunSemanticLoopCheck({
        ...base,
        turns: base.lastCheckTurn + SEMANTIC_LOOP_COOLDOWN_TURNS - 1,
      }),
    ).toBe(false);
    expect(
      shouldRunSemanticLoopCheck({
        ...base,
        turns: base.lastCheckTurn + SEMANTIC_LOOP_COOLDOWN_TURNS,
      }),
    ).toBe(true);
  });

  it("never runs concurrently with itself or past the per-run budget", () => {
    expect(shouldRunSemanticLoopCheck({ ...base, checkPending: true })).toBe(false);
    expect(shouldRunSemanticLoopCheck({ ...base, checksUsed: MAX_SEMANTIC_LOOP_CHECKS })).toBe(
      false,
    );
  });
});

describe("buildSemanticLoopJudgePrompt", () => {
  it("contains the task, the calls with outcomes, and the JSON contract", () => {
    const prompt = buildSemanticLoopJudgePrompt(calls, "Fix the failing tests in src/a.ts");
    expect(prompt).toContain("Fix the failing tests in src/a.ts");
    expect(prompt).toContain('bash({"command":"npm test"}) → FAILED');
    expect(prompt).toContain("edit(");
    expect(prompt).toContain('"loop": boolean');
  });
});

describe("parseSemanticLoopVerdict", () => {
  it("parses a plain JSON verdict", () => {
    const verdict = parseSemanticLoopVerdict(
      '{"loop": true, "reason": "same test failure three times", "advice": "read the failing assertion"}',
    );
    expect(verdict).toEqual({
      loop: true,
      reason: "same test failure three times",
      advice: "read the failing assertion",
    });
  });

  it("parses JSON wrapped in prose or fences", () => {
    const verdict = parseSemanticLoopVerdict(
      'Here is my judgment.\n```json\n{"loop": false, "reason": "", "advice": ""}\n```',
    );
    expect(verdict?.loop).toBe(false);
  });

  it("fails closed to null on garbage, missing loop flag, or invalid JSON", () => {
    expect(parseSemanticLoopVerdict("no verdict here")).toBeNull();
    expect(parseSemanticLoopVerdict('{"reason": "no loop field"}')).toBeNull();
    expect(parseSemanticLoopVerdict('{"loop": "yes"}')).toBeNull();
    expect(parseSemanticLoopVerdict('{"loop": true, ')).toBeNull();
  });
});

describe("buildSemanticLoopMessage", () => {
  it("frames the verdict as a steering correction with reason and advice", () => {
    const message = buildSemanticLoopMessage({
      loop: true,
      reason: "retrying npm test after unrelated edits",
      advice: "Read the failing assertion before the next edit",
    });
    expect(message.role).toBe("user");
    expect(message.provenance).toMatchObject({ source: "runtime", visibility: "hidden" });
    expect(String(message.content)).toContain("unproductive pattern");
    expect(String(message.content)).toContain("retrying npm test after unrelated edits");
    expect(String(message.content)).toContain("Read the failing assertion");
    expect(String(message.content)).toContain("report honestly");
  });
});
