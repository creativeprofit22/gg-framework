# ADR 0004: Search changes are judged by a provenance-guarded, pre-registered benchmark

**Status:** Accepted, 2026-10-10.

## Context

GG Coder's `grep` and `find` tools feel slow on the reference machine (Windows,
12 threads, 24 GB, repo and Node on a 7200 rpm HDD, Defender real-time on). We
wanted to change them, but had no numbers, and several properties of the
current code make naive measurement misleading:

- The agent loop suppresses duplicate tool calls, so repeated identical calls
  can hide work.
- `deadlineMs: 0` scans nothing, so "deadline off" cannot mean 0.
- The engine (ripgrep or in-process) is invisible in the output, and an rg
  failure falls back silently. On this machine rg is not installed at all.
- `AbortSignal` is ignored. Only the 5 s deadline stops a search.
- Walk-heavy queries finish in about 1 s alone but hit the 5 s deadline at
  every concurrency from 16 up, so throughput rises only because calls are cut
  off. Averages without outcome classification would read this as a speed-up.
- Benchmark folklore applies: environment size biases timings by up to about
  8 % (Mytkowicz et al.), variance arises per process launch and per session
  (Kalibera & Jones), and closed-loop load hides queueing (coordinated
  omission, wrk2).

The baseline (experiments.md entry 1) confirmed the risks: launch-to-launch
CV is 5 % for throughput and 23 % for the in-process p50, and one single-session
A/A interval excluded 1.0.

## Decision

- One harness, `bench/search-bench.mjs` plus small single-owner modules in
  `bench/search/` (spec, tree, oracle, spawn spy, classify, provenance,
  runner, worker, sampler, stats, report), runs from the main worktree and
  targets each version's **separate clean git worktree**. It refuses to run
  when HEAD is not the stated commit, the worktree is dirty, `dist` is stale or
  the frozen tree hash differs.
- The real tools are called in-process through `AgentTool.execute`, imported
  from the target's `dist`. Arguments are unique per call. Deadline off means
  `1e9` ms. A spawn spy attributes the engine per call. Each call is
  classified as complete, partial (deadline, candidate cap, result cap) or
  error, and checked against an independent uncapped oracle.
- Load runs in closed waves (ladder 1–100, the wave is the unit) and open
  loop, timed from the intended start. Cancel, soak, a no-op calibration and a
  raw rg CLI ceiling are measured as well. Resources come from typeperf at 1 Hz
  plus `process.resourceUsage()`, with a USE note per run.
- Each run gets a fresh worker process with a rotated environment pad and
  rotated version order, across at least two sessions. Headlines H1–H4 and the
  keep/kill rule (≥ 1.30× with a 95 % bootstrap CI lower bound > 1.0,
  identical correctness, no worse error or deadline rate) are pre-registered in
  `docs/search-performance/spec.md` (versioned). Everything else is
  exploratory.
- Results: raw JSONL stays gitignored or is zipped into `.gg/verification/`.
  `docs/search-performance/` holds the living record and
  `bench/baseline/search.json` the current best headlines.

## Rejected alternatives

- **hyperfine on a CLI wrapper.** It measures process start-up and the
  wrapper, not the in-process tool path the agent uses, and has no concurrency
  or correctness checking.
- **Driving searches through the agent loop.** Duplicate suppression and model
  latency would dominate and hide the tool.
- **Switching branches in one checkout.** Easy to benchmark the wrong code. The
  main checkout also holds unrelated user work. Separate worktrees with a
  commit guard remove both risks.
- **Averages per call with t-tests.** Calls within a wave and waves within a
  launch are correlated (autocorrelation outside the band in most runs).
  Hierarchical bootstrap effect-size CIs at the launch level are honest about
  that.
- **Standby purge as "cold".** Windows keeps file system metadata cached, so a
  purge is only mostly cold. Reboot-cold sessions are a separate, declared
  method.
- **One big script.** It would be hard to extend to other repos, engines or
  queries. Each module has one owner and its own unit tests.
