import { describe, it, expect } from "vitest";
import {
  AgentNotificationQueue,
  NOTIFICATION_DRAIN_MAX_CHARS,
  NOTIFICATION_MAX_CHARS,
} from "./agent-notifications.js";

describe("AgentNotificationQueue", () => {
  it("drains in insertion order and clears itself", () => {
    const q = new AgentNotificationQueue();
    q.enqueue("subagent", "a", "first");
    q.enqueue("subagent", "b", "second");

    expect(q.drain().map((n) => n.text)).toEqual(["first", "second"]);
    expect(q.size).toBe(0);
    expect(q.drain()).toEqual([]);
  });

  it("keeps only the latest entry per (kind, id)", () => {
    const q = new AgentNotificationQueue();
    q.enqueue("process", "p1", "10% done");
    q.enqueue("process", "p1", "90% done");

    const drained = q.drain();
    expect(drained).toHaveLength(1);
    expect(drained[0]!.text).toBe("90% done");
  });

  it("keys dedupe by kind as well as id", () => {
    const q = new AgentNotificationQueue();
    q.enqueue("process", "1", "process one");
    q.enqueue("subagent", "1", "child one");

    expect(q.drain()).toHaveLength(2);
  });

  it("preserves queue position when an entry is updated", () => {
    const q = new AgentNotificationQueue();
    q.enqueue("process", "p1", "old");
    q.enqueue("process", "p2", "other");
    q.enqueue("process", "p1", "new");

    expect(q.drain().map((n) => n.text)).toEqual(["new", "other"]);
  });

  it("lets a terminal entry supersede a pending progress entry", () => {
    const q = new AgentNotificationQueue();
    q.enqueue("process", "p1", "still building");
    expect(q.enqueue("process", "p1", "exited 0", { terminal: true })).toBe(true);

    const drained = q.drain();
    expect(drained).toHaveLength(1);
    expect(drained[0]).toMatchObject({ text: "exited 0", terminal: true });
  });

  it("refuses to overwrite a terminal entry with a late progress tick", () => {
    const q = new AgentNotificationQueue();
    q.enqueue("process", "p1", "exited 1", { terminal: true });
    expect(q.enqueue("process", "p1", "50% done")).toBe(false);

    expect(q.drain()[0]).toMatchObject({ text: "exited 1", terminal: true });
  });

  it("allows a terminal entry to replace an earlier terminal entry", () => {
    const q = new AgentNotificationQueue();
    q.enqueue("subagent", "a", "failed", { terminal: true });
    q.enqueue("subagent", "a", "done", { terminal: true });

    expect(q.drain()[0]!.text).toBe("done");
  });

  it("caps a single notification at NOTIFICATION_MAX_CHARS", () => {
    const q = new AgentNotificationQueue();
    q.enqueue("subagent", "a", "x".repeat(NOTIFICATION_MAX_CHARS * 3));

    const [entry] = q.drain();
    expect(entry!.text.length).toBe(NOTIFICATION_MAX_CHARS);
    expect(entry!.text.endsWith("\u2026")).toBe(true);
  });

  it("collapses whitespace so multi-line output cannot inflate a notification", () => {
    const q = new AgentNotificationQueue();
    q.enqueue("process", "p1", "  build\n\n  failed \t badly  ");

    expect(q.drain()[0]!.text).toBe("build failed badly");
  });

  it("caps one drain at NOTIFICATION_DRAIN_MAX_CHARS and requeues the rest", () => {
    const q = new AgentNotificationQueue();
    for (let i = 0; i < 6; i++) q.enqueue("subagent", `a${i}`, "y".repeat(NOTIFICATION_MAX_CHARS));

    const first = q.drain();
    const firstChars = first.reduce((sum, n) => sum + n.text.length, 0);
    expect(firstChars).toBeLessThanOrEqual(NOTIFICATION_DRAIN_MAX_CHARS);
    expect(first).toHaveLength(2);
    // Nothing is lost — the remainder waits for the next drain.
    expect(q.size).toBe(4);
  });

  it("never deadlocks on an oversized head entry", () => {
    const q = new AgentNotificationQueue();
    // Two max-size entries fill the drain budget exactly; add a third.
    q.enqueue("subagent", "a", "y".repeat(NOTIFICATION_MAX_CHARS));
    q.enqueue("subagent", "b", "y".repeat(NOTIFICATION_MAX_CHARS));
    q.enqueue("subagent", "c", "z".repeat(NOTIFICATION_MAX_CHARS));

    expect(q.drain()).toHaveLength(2);
    const rest = q.drain();
    expect(rest).toHaveLength(1);
    expect(q.size).toBe(0);
  });

  it("clears a single producer and everything", () => {
    const q = new AgentNotificationQueue();
    q.enqueue("process", "p1", "a");
    q.enqueue("process", "p2", "b");

    q.clear("process", "p1");
    expect(q.size).toBe(1);
    q.clearAll();
    expect(q.size).toBe(0);
  });
});
