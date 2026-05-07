import { describe, it, expect } from "vitest";
import { decideStuckEvent, parseReportedStatus, reportedToTaskStatus } from "./orchestrator.js";
import type { WorkerActivity } from "./worker.js";

function activity(overrides: Partial<WorkerActivity> = {}): WorkerActivity {
  return {
    status: "working",
    startedAt: new Date().toISOString(),
    lastEventAt: new Date().toISOString(),
    workingSeconds: 30,
    silentSeconds: 5,
    activeTools: [],
    completedTools: [],
    textTail: "",
    lastEventAtMs: Date.now(),
    ...overrides,
  };
}

describe("parseReportedStatus", () => {
  it("matches a clean trailer", () => {
    const text = "Did the thing.\nChanged: x.ts\nVerified: pnpm test passes\nStatus: DONE";
    expect(parseReportedStatus(text)).toBe("DONE");
  });

  it("matches every grade", () => {
    for (const grade of ["DONE", "UNVERIFIED", "PARTIAL", "BLOCKED", "INFO"] as const) {
      expect(parseReportedStatus(`x\nStatus: ${grade}`)).toBe(grade);
    }
  });

  it("accepts trailing content on the same line", () => {
    expect(parseReportedStatus("x\nStatus: INFO — answered the question")).toBe("INFO");
  });

  it("picks the LAST occurrence (workers sometimes mention statuses mid-text)", () => {
    const text = "First Status: BLOCKED was wrong\nFinal answer below.\nStatus: DONE";
    expect(parseReportedStatus(text)).toBe("DONE");
  });

  it("returns null when no trailer is present", () => {
    expect(parseReportedStatus("just some text without a status line")).toBeNull();
  });

  it("returns null for unrecognised grade", () => {
    expect(parseReportedStatus("Status: COOL")).toBeNull();
  });
});

describe("decideStuckEvent", () => {
  const SILENT = 90;
  const WORKING = 600;
  const base = { silentThresholdSec: SILENT, workingThresholdSec: WORKING };

  it("idle worker with no debounce → skip", () => {
    const d = decideStuckEvent({
      ...base,
      status: "idle",
      activity: null,
      lastPushedAt: undefined,
    });
    expect(d.kind).toBe("skip");
  });

  it("idle worker with leftover debounce → clear_debounce", () => {
    const d = decideStuckEvent({
      ...base,
      status: "idle",
      activity: null,
      lastPushedAt: 12345,
    });
    expect(d.kind).toBe("clear_debounce");
  });

  it("errored worker with leftover debounce → clear_debounce", () => {
    const d = decideStuckEvent({
      ...base,
      status: "error",
      activity: null,
      lastPushedAt: 12345,
    });
    expect(d.kind).toBe("clear_debounce");
  });

  it("working but under both thresholds → skip", () => {
    const d = decideStuckEvent({
      ...base,
      status: "working",
      activity: activity({ workingSeconds: 30, silentSeconds: 5 }),
      lastPushedAt: undefined,
    });
    expect(d.kind).toBe("skip");
  });

  it("silent past threshold → push with reason=silent", () => {
    const d = decideStuckEvent({
      ...base,
      status: "working",
      activity: activity({ workingSeconds: 120, silentSeconds: 95, activeTools: ["bash"] }),
      lastPushedAt: undefined,
    });
    expect(d.kind).toBe("push");
    if (d.kind === "push") {
      expect(d.reason).toBe("silent");
      expect(d.snapshot.activeTools).toEqual(["bash"]);
      expect(d.snapshot.silentSeconds).toBe(95);
    }
  });

  it("long-running but recent events → push with reason=long_running", () => {
    const d = decideStuckEvent({
      ...base,
      status: "working",
      activity: activity({ workingSeconds: 700, silentSeconds: 10 }),
      lastPushedAt: undefined,
    });
    expect(d.kind).toBe("push");
    if (d.kind === "push") expect(d.reason).toBe("long_running");
  });

  it("silent threshold takes precedence over long-running when both apply", () => {
    const d = decideStuckEvent({
      ...base,
      status: "working",
      activity: activity({ workingSeconds: 700, silentSeconds: 95 }),
      lastPushedAt: undefined,
    });
    expect(d.kind).toBe("push");
    if (d.kind === "push") expect(d.reason).toBe("silent");
  });

  it("silentSeconds high but lastEventAtMs is null → fall through to long_running check", () => {
    // Edge case: worker just started, has never emitted an event. silentSeconds
    // is computed against lastEventAtMs which is null, so we shouldn't classify
    // it as "silent" — only "long_running" if it's been working long enough.
    const d = decideStuckEvent({
      ...base,
      status: "working",
      activity: activity({
        workingSeconds: 100,
        silentSeconds: 100,
        lastEventAtMs: null,
        lastEventAt: null,
      }),
      lastPushedAt: undefined,
    });
    expect(d.kind).toBe("skip"); // not yet at long_running threshold either
  });

  it("never-emitted worker past long-running threshold → push long_running with null lastEventAtMs", () => {
    const d = decideStuckEvent({
      ...base,
      status: "working",
      activity: activity({
        workingSeconds: 700,
        silentSeconds: 700,
        lastEventAtMs: null,
        lastEventAt: null,
      }),
      lastPushedAt: undefined,
    });
    expect(d.kind).toBe("push");
    if (d.kind === "push") {
      expect(d.reason).toBe("long_running");
      expect(d.lastEventAtMs).toBeNull();
    }
  });

  it("already debounced and no new activity → skip (no spam)", () => {
    const pushedAt = 1_000_000;
    const d = decideStuckEvent({
      ...base,
      status: "working",
      activity: activity({ workingSeconds: 200, silentSeconds: 150, lastEventAtMs: pushedAt }),
      lastPushedAt: pushedAt,
    });
    expect(d.kind).toBe("skip");
  });

  it("already debounced but worker emitted new activity → re-evaluate (and re-push if stalled)", () => {
    const oldPush = 1_000_000;
    const newerEvent = oldPush + 30_000;
    const d = decideStuckEvent({
      ...base,
      status: "working",
      activity: activity({
        workingSeconds: 300,
        silentSeconds: 95,
        lastEventAtMs: newerEvent,
      }),
      lastPushedAt: oldPush,
    });
    expect(d.kind).toBe("push");
    if (d.kind === "push") {
      expect(d.reason).toBe("silent");
      expect(d.lastEventAtMs).toBe(newerEvent);
    }
  });

  it("already debounced, new activity, but back under threshold → skip", () => {
    const oldPush = 1_000_000;
    const newerEvent = oldPush + 30_000;
    const d = decideStuckEvent({
      ...base,
      status: "working",
      activity: activity({
        workingSeconds: 200,
        silentSeconds: 10, // recovered, well under threshold
        lastEventAtMs: newerEvent,
      }),
      lastPushedAt: oldPush,
    });
    expect(d.kind).toBe("skip");
  });

  it("thresholds at exact boundary → push (>=, not >)", () => {
    const d = decideStuckEvent({
      ...base,
      status: "working",
      activity: activity({ workingSeconds: 100, silentSeconds: SILENT }),
      lastPushedAt: undefined,
    });
    expect(d.kind).toBe("push");
  });
});

describe("reportedToTaskStatus", () => {
  it("DONE → done", () => {
    expect(reportedToTaskStatus("DONE", false)).toBe("done");
  });

  it("INFO → done (question answered, no work needed)", () => {
    expect(reportedToTaskStatus("INFO", false)).toBe("done");
  });

  it("BLOCKED → blocked", () => {
    expect(reportedToTaskStatus("BLOCKED", false)).toBe("blocked");
  });

  it("UNVERIFIED → in_progress (boss should re-prompt)", () => {
    expect(reportedToTaskStatus("UNVERIFIED", false)).toBe("in_progress");
  });

  it("PARTIAL → in_progress (boss should re-prompt for the rest)", () => {
    expect(reportedToTaskStatus("PARTIAL", false)).toBe("in_progress");
  });

  it("missing trailer + clean tools → done", () => {
    expect(reportedToTaskStatus(null, false)).toBe("done");
  });

  it("missing trailer + any tool failure → blocked", () => {
    expect(reportedToTaskStatus(null, true)).toBe("blocked");
  });

  it("DONE outranks tool failure (worker self-report wins)", () => {
    // Worker says DONE but had an incidental bash non-zero (grep no-match).
    // We trust the trailer over the heuristic — that was the whole point.
    expect(reportedToTaskStatus("DONE", true)).toBe("done");
  });
});
