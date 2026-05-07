import { describe, it, expect } from "vitest";
import { EventQueue } from "./event-queue.js";
import type { BossEvent, WorkerStuckSnapshot, WorkerTurnSummary } from "./types.js";

const ts = (): string => new Date().toISOString();

function stuck(project: string): BossEvent {
  const snapshot: WorkerStuckSnapshot = {
    workingSeconds: 100,
    silentSeconds: 95,
    activeTools: [],
    completedTools: [],
    textTail: "",
  };
  return { kind: "worker_stuck", project, reason: "silent", snapshot, timestamp: ts() };
}

function complete(project: string): BossEvent {
  const summary: WorkerTurnSummary = {
    project,
    cwd: "/tmp",
    status: "idle",
    finalText: "done",
    toolsUsed: [],
    turnIndex: 1,
    timestamp: ts(),
  };
  return { kind: "worker_turn_complete", summary };
}

function err(project: string, message = "boom"): BossEvent {
  return { kind: "worker_error", project, message, timestamp: ts() };
}

function user(text: string): BossEvent {
  return { kind: "user_message", text, timestamp: ts() };
}

async function drain(q: EventQueue): Promise<BossEvent[]> {
  const out: BossEvent[] = [];
  while (q.size() > 0) out.push(await q.next());
  return out;
}

describe("EventQueue", () => {
  it("delivers worker events FIFO", async () => {
    const q = new EventQueue();
    q.push(complete("a"));
    q.push(complete("b"));
    q.push(complete("c"));
    const order = (await drain(q)).map((e) =>
      e.kind === "worker_turn_complete" ? e.summary.project : "?",
    );
    expect(order).toEqual(["a", "b", "c"]);
  });

  it("user messages preempt worker events but stay FIFO among themselves", async () => {
    const q = new EventQueue();
    q.push(complete("a"));
    q.push(user("hi"));
    q.push(complete("b"));
    q.push(user("there"));
    const out = await drain(q);
    expect(out.map((e) => e.kind)).toEqual([
      "user_message",
      "user_message",
      "worker_turn_complete",
      "worker_turn_complete",
    ]);
    expect((out[0] as Extract<BossEvent, { kind: "user_message" }>).text).toBe("hi");
    expect((out[1] as Extract<BossEvent, { kind: "user_message" }>).text).toBe("there");
  });

  it("a pending next() resolves as soon as an event is pushed", async () => {
    const q = new EventQueue();
    const got = q.next();
    q.push(complete("a"));
    const e = await got;
    expect(e.kind).toBe("worker_turn_complete");
  });
});

describe("EventQueue.removeStuckFor", () => {
  it("drops queued stuck events for the named project", () => {
    const q = new EventQueue();
    q.push(stuck("a"));
    q.push(stuck("a"));
    q.push(stuck("b"));
    expect(q.size()).toBe(3);
    const dropped = q.removeStuckFor("a");
    expect(dropped).toBe(2);
    expect(q.size()).toBe(1);
  });

  it("only drops worker_stuck — leaves completion/error events alone", async () => {
    const q = new EventQueue();
    q.push(stuck("a"));
    q.push(complete("a"));
    q.push(err("a"));
    q.removeStuckFor("a");
    const out = await drain(q);
    expect(out.map((e) => e.kind)).toEqual(["worker_turn_complete", "worker_error"]);
  });

  it("does not affect other projects' stuck events", async () => {
    const q = new EventQueue();
    q.push(stuck("a"));
    q.push(stuck("b"));
    q.removeStuckFor("a");
    const out = await drain(q);
    expect(out).toHaveLength(1);
    expect(out[0]!.kind).toBe("worker_stuck");
    if (out[0]!.kind === "worker_stuck") expect(out[0]!.project).toBe("b");
  });

  it("returns 0 when nothing matches", () => {
    const q = new EventQueue();
    q.push(complete("a"));
    expect(q.removeStuckFor("a")).toBe(0);
    expect(q.removeStuckFor("nonexistent")).toBe(0);
  });

  it("preserves FIFO order of remaining events", async () => {
    const q = new EventQueue();
    q.push(complete("a"));
    q.push(stuck("b")); // gets dropped
    q.push(complete("c"));
    q.push(stuck("d"));
    q.removeStuckFor("b");
    const out = await drain(q);
    expect(out.map((e) => e.kind)).toEqual([
      "worker_turn_complete",
      "worker_turn_complete",
      "worker_stuck",
    ]);
  });
});
