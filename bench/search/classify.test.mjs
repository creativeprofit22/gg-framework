import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyError, classifyOutcome } from "./classify.mjs";
import { attributeEngine } from "./spawn-spy.mjs";

describe("classifyOutcome", () => {
  const cases = [
    ["grep complete", { tool: "grep", output: "a.ts:1:x" }, "complete", []],
    ["grep no matches", { tool: "grep", output: "No matches found." }, "complete", []],
    [
      "grep result cap",
      { tool: "grep", output: "a.ts:1:x\n\n[Truncated at 50 matches]" },
      "partial",
      ["result-cap"],
    ],
    [
      "grep candidate cap",
      { tool: "grep", output: "a.ts:1:x\n\n[Stopped after scanning 10000 candidate files]" },
      "partial",
      ["candidate-cap"],
    ],
    [
      "grep deadline",
      { tool: "grep", output: "a.ts:1:x\n\n[Stopped after 5s — narrow the path]" },
      "partial",
      ["deadline"],
    ],
    [
      "grep deadline + result cap",
      {
        tool: "grep",
        output: "a.ts:1:x\n\n[Truncated at 50 matches]\n[Stopped after 5.0s — narrow]",
      },
      "partial",
      ["deadline", "result-cap"],
    ],
    ["find complete", { tool: "find", output: "a.ts\nb.ts" }, "complete", []],
    [
      "find cap",
      { tool: "find", output: "a.ts\n\n[Truncated: showing 100 of 412 matches]" },
      "partial",
      ["find-cap"],
    ],
    [
      "find ignores grep notices",
      { tool: "find", output: "[Truncated at 50 matches]" },
      "complete",
      [],
    ],
    ["noop", { tool: "noop", output: "ok" }, "complete", []],
  ];
  for (const [name, input, outcome, partial] of cases) {
    it(name, () => {
      const r = classifyOutcome(input);
      assert.equal(r.outcome, outcome);
      assert.deepEqual(r.partial, partial);
      assert.equal(r.error, null);
    });
  }

  it("non-string output is an error", () => {
    assert.deepEqual(classifyOutcome({ tool: "grep", output: undefined }), {
      outcome: "error",
      partial: [],
      error: "other",
    });
  });
});

describe("classifyError", () => {
  const err = (props) => Object.assign(new Error(props.message ?? "boom"), props);
  it("EMFILE family", () => {
    for (const code of ["EMFILE", "ENFILE", "EAGAIN"])
      assert.equal(classifyError(err({ code })), "emfile");
    assert.equal(classifyError(err({ cause: { code: "EMFILE" } })), "emfile");
  });
  it("spawn ENOENT", () => {
    assert.equal(classifyError(err({ code: "ENOENT", syscall: "spawn rg" })), "spawn");
    assert.equal(classifyError(err({ code: "ENOENT", message: "no such file" })), "other");
  });
  it("invalid pattern", () => {
    assert.equal(classifyError(err({ message: "Invalid regex pattern: (" })), "invalid-pattern");
  });
  it("harness timeout wins", () => {
    assert.equal(classifyError(undefined, { harnessTimeout: true }), "harness-timeout");
    assert.deepEqual(classifyOutcome({ tool: "grep", harnessTimeout: true }), {
      outcome: "error",
      partial: [],
      error: "harness-timeout",
    });
  });
});

describe("attributeEngine", () => {
  it("no rg child means in-process", () => {
    assert.equal(attributeEngine([]).engine, "in-process");
  });
  it("rg exit 0/1 means rg", () => {
    assert.equal(attributeEngine([{ exitCode: 0 }]).engine, "rg");
    assert.equal(attributeEngine([{ exitCode: 1 }]).engine, "rg");
  });
  it("rg failures fall back in-process and are flagged", () => {
    assert.deepEqual(attributeEngine([{ spawnError: "ENOENT" }]), {
      engine: "in-process",
      fallback: "rg-fallback:spawn:ENOENT",
    });
    assert.deepEqual(attributeEngine([{ exitCode: 2 }]), {
      engine: "in-process",
      fallback: "rg-fallback:exit:2",
    });
    assert.equal(
      attributeEngine([{ killedAt: 1, stdoutBytes: 9 * 1024 * 1024 }]).fallback,
      "rg-fallback:overflow",
    );
  });
  it("deadline kill keeps rg output", () => {
    const r = attributeEngine([{ killedAt: 5000, stdoutBytes: 10 }]);
    assert.equal(r.engine, "rg");
    assert.equal(r.rgKilledByDeadline, true);
  });
});
