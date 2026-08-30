import { describe, expect, it } from "vitest";
import { AppSidecarCompletionIntentTracker } from "./app-sidecar-completion-intent.js";
import type { AppSidecarCompletionIntent } from "./app-sidecar-roadmap-tool-host.js";

const intent = (statusUpdateId: string): AppSidecarCompletionIntent => ({
  phaseId: "phase-1",
  statusUpdateId,
  revision: 3,
  session: { sessionId: "session-1", sessionPath: "/sessions/one.jsonl" },
});

describe("AppSidecarCompletionIntentTracker", () => {
  it("returns an intent only to its exact owning run", () => {
    const tracker = new AppSidecarCompletionIntentTracker();
    const run = tracker.beginRun();
    const completion = intent("status-1");

    tracker.record(completion);

    expect(tracker.take(run)).toBe(completion);
  });

  it("does not expose an earlier intent to a later run", () => {
    const tracker = new AppSidecarCompletionIntentTracker();
    tracker.beginRun();
    tracker.record(intent("status-1"));

    const laterRun = tracker.beginRun();

    expect(tracker.take(laterRun)).toBeNull();
  });

  it("clears a taken intent before a second take", () => {
    const tracker = new AppSidecarCompletionIntentTracker();
    const run = tracker.beginRun();
    tracker.record(intent("status-1"));

    expect(tracker.take(run)?.statusUpdateId).toBe("status-1");
    expect(tracker.take(run)).toBeNull();
  });

  it("replaces stale run state when a new run begins", () => {
    const tracker = new AppSidecarCompletionIntentTracker();
    tracker.beginRun();
    tracker.record(intent("status-1"));

    const laterRun = tracker.beginRun();
    tracker.record(intent("status-2"));

    expect(tracker.take(laterRun)?.statusUpdateId).toBe("status-2");
  });

  it("does not let a stale finalizer consume or clear a newer intent", () => {
    const tracker = new AppSidecarCompletionIntentTracker();
    const staleRun = tracker.beginRun();
    const currentRun = tracker.beginRun();
    tracker.record(intent("status-2"));

    expect(tracker.take(staleRun)).toBeNull();
    expect(tracker.take(currentRun)?.statusUpdateId).toBe("status-2");
  });
});
