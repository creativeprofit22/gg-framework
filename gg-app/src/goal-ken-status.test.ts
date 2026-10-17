import { describe, expect, it } from "vitest";
import type { FloorAgent } from "./critter-floor";
import type { GoalRun } from "./goal-finish";
import { commandLabel, kenStatusOf, lastRunOf, type KenStatusInput } from "./goal-ken-status";
import type { LiveToolEntry } from "./LiveToolPanel";
import type { Item } from "./transcript-item";

const tool = (
  toolCallId: string,
  name: string,
  args: Record<string, unknown>,
  status: LiveToolEntry["status"] = "running",
): LiveToolEntry => ({ toolCallId, name, args, status });

const critter = (label: string, status: FloorAgent["status"] = "running"): FloorAgent => ({
  key: `k:${label}`,
  agentName: label,
  label,
  status,
  activity: undefined,
  tokens: null,
  durationMs: undefined,
  toolUseCount: 0,
});

const base: KenStatusInput = {
  running: true,
  paused: false,
  waitingOnUser: false,
  liveTools: [],
  workers: [],
  lastRun: null,
};

describe("kenStatusOf", () => {
  it("names the file he's reading, and its folder only when the pill opens", () => {
    const s = kenStatusOf({
      ...base,
      liveTools: [tool("1", "read", { file_path: "/repo/web-app/src/server/rag/search.ts" })],
    });
    expect(s).toMatchObject({
      key: "tool:1",
      tone: "work",
      icon: "read",
      headline: "Reading search.ts",
      detail: "In src/server/rag",
      mark: null,
    });
  });

  it("names a command by what it runs, not the setup before it, and keeps the rest for the detail", () => {
    const command =
      "cd /Users/me/app && export $(grep -v '^#' .env | xargs) && npx vitest run eval";
    const s = kenStatusOf({ ...base, liveTools: [tool("2", "bash", { command })] });
    expect(s.headline).toBe("Running npx vitest run eval");
    expect(s.icon).toBe("run");
    // The setup (a home folder, an .env export) is never shown.
    expect(s.detail).toBeNull();
    const long = kenStatusOf({
      ...base,
      liveTools: [
        tool("2b", "bash", {
          command: "cd /Users/me && pnpm vitest run src/server/rag/eval/harness.test.ts",
        }),
      ],
    });
    expect(long.detail).toBe("pnpm vitest run src/server/rag/eval/harness.test.ts");
    expect(long.detail).not.toContain("/Users/me");
  });

  it("is thinking between steps, saying what he just finished in plain words", () => {
    const s = kenStatusOf({
      ...base,
      liveTools: [tool("3", "bash", { command: "cd /x && pnpm test" }, "done")],
    });
    expect(s).toMatchObject({
      key: "think:3",
      icon: "think",
      headline: "Thinking",
      detail: "After running pnpm test",
      mark: "thinking",
      thinking: true,
    });
    // A new step is a new moment, so its timer starts again.
    const next = kenStatusOf({
      ...base,
      liveTools: [
        tool("3", "bash", { command: "pnpm test" }, "done"),
        tool("4", "read", { file_path: "a.ts" }, "done"),
      ],
    });
    expect(next.key).not.toBe(s.key);
  });

  it("calls the agents it brings in critters", () => {
    const s = kenStatusOf({
      ...base,
      liveTools: [tool("5", "wait_agent", {})],
      workers: [critter("researcher"), critter("builder")],
    });
    expect(s).toMatchObject({
      headline: "Waiting on critters",
      detail: "researcher and builder are working",
      mark: "waiting",
    });
    expect(JSON.stringify(s).toLowerCase()).not.toContain("helper");
  });

  it("names a question without repeating it, and a paused goal plainly", () => {
    const asking = kenStatusOf({ ...base, running: false, waitingOnUser: true });
    expect(asking).toMatchObject({
      tone: "ask",
      headline: "Waiting on you",
      detail: null,
      mark: "question",
    });
    expect(asking.opens).toBe(false);
    const paused = kenStatusOf({ ...base, running: false, paused: true });
    expect(paused).toMatchObject({ tone: "paused", headline: "Paused", mark: "asleep" });
  });

  it("opens by itself only when a run failed, with the error's headline", () => {
    const failed = kenStatusOf({
      ...base,
      running: false,
      lastRun: { outcome: "failed", reason: "The AI provider is overloaded." },
    });
    expect(failed).toMatchObject({
      tone: "error",
      headline: "Stopped",
      detail: "The AI provider is overloaded.",
      opens: true,
      mark: "problem",
    });
    const cancelled = kenStatusOf({
      ...base,
      running: false,
      lastRun: { outcome: "cancelled", reason: null },
    });
    expect(cancelled).toMatchObject({ tone: "idle", headline: "Stopped by you", opens: false });
    const done = kenStatusOf({
      ...base,
      running: false,
      lastRun: { outcome: "done", reason: null },
    });
    expect(done).toMatchObject({
      tone: "done",
      headline: "Done for now",
      detail: null,
      opens: false,
    });
  });

  it("waits on critters still out after his own run ends", () => {
    const s = kenStatusOf({ ...base, running: false, workers: [critter("tester")] });
    expect(s).toMatchObject({ headline: "Waiting on critters", detail: "tester is working" });
  });
});

describe("commandLabel", () => {
  it("skips folder changes and variables to the command itself", () => {
    expect(commandLabel("cd app && NODE_ENV=test pnpm vitest")).toBe("pnpm vitest");
    expect(commandLabel("docker compose up -d")).toBe("docker compose up -d");
    expect(commandLabel("cd app")).toBe("cd app");
  });
});

describe("lastRunOf", () => {
  const run = (outcome: GoalRun["outcome"], fromItemId = 10): GoalRun => ({
    goalId: "g",
    startedAt: 0,
    endedAt: 1,
    fromItemId,
    turns: 1,
    outputTokens: 0,
    outcome,
  });

  it("takes a failed run's reason from the error it left after it began", () => {
    const items = [
      { kind: "error", id: 4, headline: "An older problem" },
      { kind: "error", id: 12, headline: "Rate limit reached" },
    ] as unknown as Item[];
    expect(lastRunOf([run("failed")], "g", items)).toEqual({
      outcome: "failed",
      reason: "Rate limit reached",
    });
    expect(lastRunOf([run("failed", 20)], "g", items)).toEqual({ outcome: "failed", reason: null });
  });

  it("is null for another goal, or when no run was seen", () => {
    expect(lastRunOf([run("done")], "other", [])).toBeNull();
    expect(lastRunOf([], "g", [])).toBeNull();
  });
});
