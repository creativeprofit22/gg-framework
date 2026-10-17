import { describe, expect, test } from "vitest";
import {
  buildProcessCompletionFollowUp,
  buildProcessCompletionGateMessage,
  isUnresolvedProcess,
  MAX_PROCESS_GATE_INJECTIONS,
  selectUnresolvedProcesses,
  type GateableProcess,
} from "./process-gate.js";

const RUN_START = 1_000;

function proc(overrides: Partial<GateableProcess> = {}): GateableProcess {
  return {
    id: "aaaa1111",
    command: "pnpm test",
    startedAt: RUN_START + 10,
    exitCode: null,
    lastReadOffset: 0,
    logSize: 0,
    ...overrides,
  };
}

describe("isUnresolvedProcess", () => {
  test("gates a running process from this run whose output was never read", () => {
    expect(isUnresolvedProcess(proc(), RUN_START)).toBe(true);
  });

  test("exempts a process started before the run (long-lived dev server)", () => {
    expect(isUnresolvedProcess(proc({ startedAt: RUN_START - 1 }), RUN_START)).toBe(false);
  });

  test("exempts a running process whose output was already read", () => {
    expect(isUnresolvedProcess(proc({ lastReadOffset: 42, logSize: 42 }), RUN_START)).toBe(false);
  });

  test("exempts a clean exit", () => {
    expect(isUnresolvedProcess(proc({ exitCode: 0, logSize: 900 }), RUN_START)).toBe(false);
  });

  test("gates a non-zero exit with unread bytes", () => {
    expect(
      isUnresolvedProcess(proc({ exitCode: 1, logSize: 900, lastReadOffset: 100 }), RUN_START),
    ).toBe(true);
  });

  test("exempts a non-zero exit whose log was fully read", () => {
    expect(
      isUnresolvedProcess(proc({ exitCode: 1, logSize: 900, lastReadOffset: 900 }), RUN_START),
    ).toBe(false);
  });

  test("treats a process started exactly at run start as in-run", () => {
    expect(isUnresolvedProcess(proc({ startedAt: RUN_START }), RUN_START)).toBe(true);
  });
});

describe("selectUnresolvedProcesses", () => {
  test("orders by start time then id", () => {
    const selected = selectUnresolvedProcesses(
      [
        proc({ id: "cccc", startedAt: RUN_START + 30 }),
        proc({ id: "bbbb", startedAt: RUN_START + 10 }),
        proc({ id: "aaaa", startedAt: RUN_START + 10 }),
        proc({ id: "dddd", startedAt: RUN_START - 5 }),
      ],
      RUN_START,
    );
    expect(selected.map((p) => p.id)).toEqual(["aaaa", "bbbb", "cccc"]);
  });
});

describe("buildProcessCompletionGateMessage", () => {
  test("returns undefined when nothing is unresolved", () => {
    expect(buildProcessCompletionGateMessage([], RUN_START)).toBeUndefined();
    expect(
      buildProcessCompletionGateMessage([proc({ exitCode: 0, logSize: 10 })], RUN_START),
    ).toBeUndefined();
  });

  test("names running and failed processes separately and instructs task_output", () => {
    const message = buildProcessCompletionGateMessage(
      [
        proc({ id: "run1", command: "pnpm dev" }),
        proc({ id: "fail1", command: "pnpm build", exitCode: 2, logSize: 500 }),
      ],
      RUN_START,
    );
    expect(message).toContain("run1 (pnpm dev)");
    expect(message).toContain("fail1 (pnpm build)");
    expect(message).toContain("exited with code 2");
    expect(message).toContain("task_output");
    expect(message).toContain("task_stop");
  });

  test("omits the failed section when everything is still running", () => {
    const message = buildProcessCompletionGateMessage([proc()], RUN_START)!;
    expect(message).toContain("Still running");
    expect(message).not.toContain("Exited non-zero");
  });
});

describe("buildProcessCompletionFollowUp", () => {
  test("wraps the gate text in a user message", () => {
    const followUp = buildProcessCompletionFollowUp([proc()], RUN_START, 0);
    expect(followUp).toHaveLength(1);
    expect(followUp?.[0]?.role).toBe("user");
    expect(followUp?.[0]?.content).toContain("aaaa1111");
  });

  test("returns null once the per-run injection cap is reached", () => {
    expect(
      buildProcessCompletionFollowUp([proc()], RUN_START, MAX_PROCESS_GATE_INJECTIONS - 1),
    ).not.toBeNull();
    expect(
      buildProcessCompletionFollowUp([proc()], RUN_START, MAX_PROCESS_GATE_INJECTIONS),
    ).toBeNull();
    expect(
      buildProcessCompletionFollowUp([proc()], RUN_START, MAX_PROCESS_GATE_INJECTIONS + 1),
    ).toBeNull();
  });

  test("returns null when no process blocks completion", () => {
    expect(buildProcessCompletionFollowUp([], RUN_START, 0)).toBeNull();
  });
});
