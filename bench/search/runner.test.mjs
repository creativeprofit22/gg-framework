import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  openLoopSchedule,
  runClosedWaves,
  runOpenLoopStep,
  uniqueArgs,
  withTimeout,
} from "./runner.mjs";
import { parseArgs } from "../search-bench.mjs";
import { nonce, TOOL_LIMITS } from "./spec.mjs";

/**
 * Fake clock: time only advances through sleepUntil or explicit advance().
 * `serviceAt(seq)` lets a test make a call finish at a chosen fake time.
 */
function fakeClock() {
  let t = 0;
  return {
    now: () => t,
    sleepUntil: async (target) => {
      if (target > t) t = target;
      await Promise.resolve();
    },
    advance: (ms) => {
      t += ms;
    },
    set: (ms) => {
      t = ms;
    },
  };
}

describe("open loop timing (coordinated omission)", () => {
  it("schedules intended starts at fixed intervals", () => {
    assert.deepEqual(openLoopSchedule(4, 1000), [0, 250, 500, 750]);
    assert.deepEqual(openLoopSchedule(2, 2000), [0, 500, 1000, 1500]);
  });

  it("charges a stall to every call that was scheduled during it", async () => {
    // 10 calls/s for 1 s. Call 0 stalls the (single-threaded) generator for
    // 500 ms: a closed-loop generator would just send later and report ~0 ms
    // latencies. Latency must be measured from the intended start.
    const clock = fakeClock();
    const makeCall = async ({ seq }) => {
      if (seq === 0) clock.advance(500); // synchronous stall blocks the generator
      return { seq };
    };
    const step = await runOpenLoopStep({ ratePerSecond: 10, durationMs: 1000, makeCall, clock });
    assert.equal(step.scheduled, 10);
    const byseq = step.records;
    // Calls 1..4 were intended at 100..400 ms but could start only at 500 ms.
    for (const i of [1, 2, 3, 4]) {
      const r = byseq[i];
      assert.equal(r.intendedStart, i * 100);
      assert.equal(r.actualStart, 500);
      assert.equal(r.startLagMs, 500 - i * 100);
      assert.equal(r.latencyMs, r.end - r.intendedStart);
      assert.ok(r.latencyMs >= 500 - i * 100, `call ${i} latency ${r.latencyMs}`);
      assert.equal(r.serviceMs, r.end - r.actualStart);
    }
    // Later calls start on time.
    assert.equal(byseq[7].startLagMs, 0);
  });

  it("counts calls over the outstanding cap as overflow instead of dropping them", async () => {
    const clock = fakeClock();
    const releases = [];
    const makeCall = () => new Promise((resolve) => releases.push(resolve));
    const running = runOpenLoopStep({
      ratePerSecond: 10,
      durationMs: 1000,
      makeCall,
      clock,
      maxOutstanding: 3,
    });
    // Let the generator reach the end of the schedule.
    for (let i = 0; i < 50 && releases.length < 3; i++) await Promise.resolve();
    await new Promise((r) => setImmediate(r));
    for (const release of releases) release({});
    const step = await running;
    assert.equal(step.scheduled, 10);
    assert.equal(step.overflow, 7);
    assert.equal(step.records.length, 10);
    assert.equal(step.records.filter((r) => r.overflow).length, 7);
  });
});

describe("closed waves", () => {
  it("treats each wave as one unit with calls/s = N / wave wall time", async () => {
    const clock = fakeClock();
    let seen = 0;
    const makeCall = async ({ seq }) => {
      seen++;
      return { seq };
    };
    const original = clock.now;
    let calls = 0;
    // Each wave takes 500 ms of fake time.
    clock.now = () => {
      calls++;
      return calls % 2 === 0 ? original() + 500 : original();
    };
    const waves = await runClosedWaves({
      concurrency: 4,
      waves: 3,
      warmupWaves: 1,
      makeCall,
      waveTimeoutMs: 10_000,
      clock,
    });
    assert.equal(waves.length, 4);
    assert.equal(seen, 16);
    assert.equal(waves[0].warmup, true);
    for (const w of waves) {
      assert.equal(w.wallMs, 500);
      assert.equal(w.callsPerSecond, 8);
      assert.equal(w.calls.length, 4);
    }
    // Sequence numbers are unique across waves.
    assert.equal(new Set(waves.flatMap((w) => w.calls.map((c) => c.seq))).size, 16);
  });

  it("stops and reports a wave that exceeds the harness timeout", async () => {
    const makeCall = () => new Promise(() => {});
    const waves = await runClosedWaves({ concurrency: 2, waves: 5, makeCall, waveTimeoutMs: 20 });
    assert.equal(waves.length, 1);
    assert.equal(waves[0].timedOut, true);
    assert.equal(waves[0].callsPerSecond, 0);
  });

  it("withTimeout reports the winner", async () => {
    assert.deepEqual(await withTimeout(Promise.resolve(3), 1000), { timedOut: false, value: 3 });
    assert.deepEqual(await withTimeout(new Promise(() => {}), 5), { timedOut: true });
  });
});

describe("unique arguments", () => {
  const grep = { id: "Q2", tool: "grep", args: { pattern: "import", path: "repo" } };
  const find = { id: "Q5", tool: "find", args: { pattern: "**/*.test.ts" } };
  it("raises max_results when the cap never binds", () => {
    const r = uniqueArgs(grep, 7, { capBinds: false });
    assert.equal(r.uniqueness, "max-results");
    assert.equal(r.args.max_results, TOOL_LIMITS.grepDefaultMaxResults + 7);
    assert.equal(r.args.pattern, "import");
  });
  it("adds an absent nonce alternative when the cap binds", () => {
    const r = uniqueArgs(grep, 7, { capBinds: true });
    assert.equal(r.args.pattern, `(?:import|${nonce(7)})`);
    assert.equal(r.args.max_results, undefined);
  });
  it("uses a brace nonce for find and leaves fixed-args untouched", () => {
    assert.equal(
      uniqueArgs(find, 3, { capBinds: false }).args.pattern,
      `{**/*.test.ts,**/${nonce(3)}}`,
    );
    assert.deepEqual(
      uniqueArgs(grep, 3, { capBinds: true, uniqueness: "fixed-args" }).args,
      grep.args,
    );
  });
  it("never repeats arguments across calls", () => {
    const keys = new Set();
    for (let seq = 0; seq < 200; seq++)
      for (const capBinds of [false, true])
        keys.add(JSON.stringify([capBinds, uniqueArgs(grep, seq, { capBinds }).args]));
    assert.equal(keys.size, 400);
  });
});

describe("search-bench parseArgs", () => {
  it("rejects unknown and misspelled flags", () => {
    for (const argv of [
      ["--launch", "4"],
      ["--only-cell", "x"],
      ["--sesion", "name"],
      ["--cold-method", "reboot"],
      ["--dryrun"],
    ]) {
      assert.throws(() => parseArgs(argv), {
        message: `Unknown flag "${argv[0]}" (see --help)`,
      });
    }
  });

  it("parses every documented flag", () => {
    const opts = parseArgs([
      "--target",
      "baseline=wt@abc",
      "--report",
      "dir1",
      "--tree",
      "t",
      "--profile",
      "full",
      "--launches",
      "4",
      "--cold",
      "reboot",
      "--session",
      "s1",
      "--waves",
      "2",
      "--soak-ms",
      "100",
      "--open-step-ms",
      "50",
      "--only-cells",
      "Q1",
      "--out",
      "o",
      "--baseline-label",
      "base",
      "--candidate-label",
      "cand",
      "--build-tree",
      "--force",
      "--dry-run",
      "--update",
      "--wpr",
      "--mp-recording",
      "--fast-verify",
      "--help",
    ]);
    assert.deepEqual(opts, {
      target: ["baseline=wt@abc"],
      report: ["dir1"],
      tree: "t",
      profile: "full",
      launches: "4",
      cold: "reboot",
      session: "s1",
      waves: "2",
      "soak-ms": "100",
      "open-step-ms": "50",
      "only-cells": "Q1",
      out: "o",
      "baseline-label": "base",
      "candidate-label": "cand",
      "build-tree": true,
      force: true,
      "dry-run": true,
      update: true,
      wpr: true,
      "mp-recording": true,
      "fast-verify": true,
      help: true,
    });
  });

  it("accumulates repeatable flags", () => {
    const opts = parseArgs([
      "--target",
      "a=x@1",
      "--target",
      "b=y@2",
      "--report",
      "r1",
      "--report",
      "r2",
    ]);
    assert.deepEqual(opts.target, ["a=x@1", "b=y@2"]);
    assert.deepEqual(opts.report, ["r1", "r2"]);
  });
});
