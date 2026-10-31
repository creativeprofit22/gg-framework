import { describe, expect, it } from "vitest";
import { overloadHint, redirectHint, sharedLogWarning } from "./check-hints.js";

const LOG = "/home/u/.gg/foreground/run-1.log";

describe("redirectHint", () => {
  it("names the standalone check when redirected output was refused", () => {
    expect(redirectHint("pnpm test > out.txt", LOG, true)).toBe(
      "[Not counted as a check: output went to a file. Run `pnpm test` on its own; " +
        `this run's full output is kept at ${LOG}.]\n`,
    );
  });

  it.each([
    ["a redirect the host snapshot can count", "pnpm test > /tmp/fmt.log 2>&1", true],
    ["an accepted check", "pnpm test 2>&1", true],
    ["a non-check", "echo hi > out.txt", true],
  ])("stays quiet for %s", (_label, command, posix) => {
    expect(redirectHint(command, LOG, posix)).toBe("");
  });

  it("explains the refusal on cmd.exe, where the /tmp redirect is not counted", () => {
    expect(redirectHint("pnpm test > /tmp/fmt.log 2>&1", LOG, false)).toContain(
      "Run `pnpm test` on its own",
    );
  });
});

describe("sharedLogWarning", () => {
  it.each(["pnpm test > /tmp/fmt.log 2>&1", "pnpm test > build/test.log"])(
    "warns about the fixed log path in %j",
    (command) => {
      const warning = sharedLogWarning(command, LOG, true);
      expect(warning).toMatch(/^\[Warning: \S+ is reused across runs/);
      expect(warning).toContain(`read this run's log at ${LOG} instead.]`);
    },
  );

  it.each([
    "pnpm test > /dev/null",
    'pnpm test > "$LOG"',
    "echo hi > /tmp/notes.log",
    "pnpm test 2>&1",
  ])("does not warn for %j", (command) => {
    expect(sharedLogWarning(command, LOG, true)).toBe("");
  });
});

describe("overloadHint", () => {
  const vitestTimeouts = [
    " FAIL  src/a.test.ts > a > waits",
    "Error: Test timed out in 5000ms.",
    " FAIL  src/b.test.ts > b > waits",
    "Error: Test timed out in 5000ms.",
    " FAIL  src/c.test.ts > c > waits",
    "Error: Test timed out in 5000ms.",
    "      Tests  3 failed | 40 passed (43)",
  ].join("\n");

  it("points to the machine-profile defaults when every failure is a timeout", () => {
    const hint = overloadHint(vitestTimeouts);
    expect(hint).toContain("the machine may have been overloaded");
    expect(hint).toContain("machine-profile defaults in docs/harness-checks.md");
    expect(hint.endsWith("]\n")).toBe(true);
  });

  it("counts jest and node:test timeout lines too", () => {
    const output = [
      "thrown: Exceeded timeout of 5000 ms for a test.",
      "thrown: Exceeded timeout of 5000 ms for a test.",
      "error: 'test timed out after 30000ms'",
      "# fail 3",
    ].join("\n");
    expect(overloadHint(output)).not.toBe("");
  });

  it("counts cargo tests that ran long and then failed", () => {
    const output = ["a", "b", "c"]
      .flatMap((name) => [
        `test ${name} has been running for over 60 seconds`,
        `test ${name} ... FAILED`,
      ])
      .join("\n");
    expect(overloadHint(output)).not.toBe("");
  });

  it.each([
    ["fewer than three timeouts", "Error: Test timed out in 5000ms.\nTests  1 failed"],
    [
      "an assertion failure among the timeouts",
      `${vitestTimeouts}\nAssertionError: expected 1 to be 2`,
    ],
    ["more failures than timeouts", vitestTimeouts.replace("3 failed", "5 failed")],
    ["a cargo slow test that passed", "test a has been running for over 60 seconds\ntest a ... ok"],
  ])("stays quiet with %s", (_label, output) => {
    expect(overloadHint(output)).toBe("");
  });
});
