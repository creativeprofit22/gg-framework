# Search performance experiments

Append-only. One entry per attempt, including failures and inconclusive runs.
Never edit a past entry's numbers; add a correction entry instead. Only compare
entries with the same spec version.

Entry template:

```
## N. <title> (<date>)
- Idea and expected gain:
- Commit / worktree:
- Spec version:
- Sessions / launches / cold method:
- Headline effects vs current best (ratio, 95% bootstrap CI): H1 … H2 … H3 … H4 …
- Correctness / errors / deadline-hit change:
- Verdict: kept | reverted | inconclusive — reason
- Raw results:
- Limits:
```

## 1. Baseline: unchanged tools (2026-10-10)

- **Idea and expected gain:** none. This records today's behaviour before any
  product change.
- **Commit / worktree:** `df1a3531b867f11393ce98ea9af1d4b6f1d66ceb` at
  `E:/Projects/gg-search-bench/worktrees/baseline` (clean, dist newer than src,
  `grep.js` sha256 prefix `d7e0f4f6425d`). Harness in the main worktree.
- **Spec version:** 1. Frozen tree hash `3cc2dcdda597…f285` (23 055 files).
- **Sessions:** `baseline-s1b-2026-10-10` (full profile, 6 launches) and
  `baseline-s2-2026-10-10` (quick profile, 4 launches); 10 launches in total
  for headline cells. Fresh worker process per run, environment pad rotated
  through 0 / 1 / 4 / 16 KiB. Pilot `pilot-2026-10-10c` set repetition counts
  and is excluded. **Both sessions ran in the same boot**: they are separate
  sessions, not a reboot.
- **Environment:** Node v22.20.0, High performance plan, AC power, SysMain
  stopped, Windows Search running, Defender real-time on, not admin (CPU
  temperature unreadable, WPR and Defender recording skipped), free RAM 8.8–11.5 GB,
  **ripgrep not on PATH**.

### Headlines (warm, 10 launches, 2 sessions)

| ID              | Value    | Launch CV | A/A ratio [95% CI]   |
| --------------- | -------- | --------- | -------------------- |
| H1 calls/s @100 | 19.10    | 0.054     | 1.033 [0.995, 1.099] |
| H2 p99 @16      | 5 016 ms | 0.001     | 1.001 [1.000, 1.002] |
| H3 Q2 p50 @1    | 55.7 ms  | 0.225     | 1.139 [0.941, 1.546] |
| H4 cold p50     | 82.9 ms  | –         | – (1 launch)         |

The A/A check splits launches by parity; every combined CI contains 1.0.
Session 1 alone gave H1 1.053 [1.002, 1.151], just excluding 1.0, a hint that
launch-to-launch drift is near the 5 % level. H3 is noisy (CV 0.23; the pilot
suggests about 30 launches to resolve a 5 % change), so H3 claims need more
launches than H1/H2.

### Main observations (exploratory)

- **Engine:** 0 rg children across both sessions. Every "rg enabled" cell
  measured the in-process scanner after the silent fallback, so the rg CLI
  ceiling is `skipped-no-rg`.
- **Walk-bound queries:** Q1 rare literal p50 1.03 s, Q8 match-nothing 0.99 s,
  Q10 many small files 0.76 s and Q4 include filter 0.51 s at concurrency 1.
  All four hit the 5 s deadline on 100 % of calls at concurrency 16, for a
  ceiling of about 3.2 calls/s.
- **Result-capped queries are fast:** Q2 `import` 56 ms, Q7 `.` 45 ms, Q3 regex
  90 ms, Q9 large file 29 ms and Q5 find 20 ms at concurrency 1.
- **Q6** (forced in-process lookahead) hits the deadline on 100 % of calls, as
  designed.
- **Agent mix ladder (deadline on, UV 4):** 14.2 / 3.4 / 3.2 / 6.4 / 12.6 /
  19.1 calls/s at 1 / 4 / 16 / 32 / 64 / 100. Deadline-hit rates were
  0 / 0 / 15 / 40 / 40 / 55 %. Throughput above 16 grows only because calls
  are cut off at 5 s.
- **Deadline off** at concurrency 16: p99 6.3 s, with 0 % partial results.
- **UV_THREADPOOL_SIZE 16** gave 19.3 calls/s at 100 vs 19.1, no material
  change, which points away from the libuv pool as the limit.
- **Open loop:** knee at 4 arrivals/s (p99). p99 reached 20.5 s and 67 % of
  calls hit the deadline over the rate ladder.
- **Cancel:** abort at 50 ms is ignored. Q6 returned 5.0–5.2 s after abort and
  Q2 about 105 ms. No rg child existed to leak.
- **Soak** (16 concurrent, 10 min): RSS +3.35 MB/min, handles −0.20/min.
- **Reliability:** 0 errors (no EMFILE or spawn failures) in more than 60 000
  calls. 0 timed-out waves.
- **Correctness:** 61 709 checked outputs, 0 failures. 2 732 complete calls
  had exact set equality with the uncapped oracle. Partial calls averaged
  43 % recall. Repeated complete calls were byte-identical per query.
- **USE:** the worker main-thread CPU proxy was saturated in most search runs,
  and event-loop delay led for match-everything (Q7). Short runs (under about
  3 s) have no typeperf rows and are labelled `counters unavailable`.
- **Harness overhead:** no-op tool p50 0.1 ms at concurrency 1 and 1.0 ms at
  100, negligible against search latencies.
- **Unique-args overhead:** fixed-args cell 3.24 vs unique 3.23 calls/s at 16,
  no visible nonce cost.

### Verdict and limits

- **Verdict:** kept as the current best (reference point, no comparison).
- **Raw results:** `.gg/verification/search-bench-baseline-2026-10-10.zip`
  (sha256 `c7ffd969924adb2120ae520fa0d57d55f8f7a96f4738b188616a4482b5aa3443`),
  containing both sessions, the pilot and the combined report
  (`report.md`, `report.json`, run-sequence/ACF SVGs).
- **Skipped:** standby-purge cold and reboot-cold runs (both need the user:
  RAMMap as admin and a reboot window). H4 has no baseline yet; run
  `--cold standby-purge` and `--cold reboot` sessions before comparing H4.
- **Independence:** lag-1…10 autocorrelation is outside the band in most
  closed-wave runs. Waves within a run are not independent (warming cache,
  deadline pacing), which is why CIs resample at the launch level.
- **Product-source check scope:** this phase changed no files under
  `packages/`, `gg-app/` or `Matey/`. The check excludes two pre-existing,
  unrelated, uncommitted user edits in the main worktree: `gg-app/src/App.css`
  (+49/−26, Notes roadmap card styling) and `gg-app/src/appearance.css` (+2,
  `--shadow-raised` token). Both were last modified 2026-10-10 01:06–01:17
  (−06:00), 12 h before this plan was approved (13:30). Benchmark sessions
  never wrote either file, and they were left as found. They cannot affect
  results: the measured code is the clean `df1a353` worktree, not the main
  checkout.
- Not admin: no CPU temperature, MsMpEng counters possibly incomplete, no WPR or
  Defender performance recording.

### Void cold attempt (2026-10-11)

- Session `baseline-cold-reboot-2026-10-11` started 6 min after a reboot
  (uptime check passed) and reported H4 p50 68.39 ms. **Void, not a cold
  result:** the harness full-hashed every tree file (~4 min) before the cold
  call, loading the tree into the OS cache. The reading sits close to warm H3
  (55.7 ms), as expected for a warm cache.
- Fix: cold sessions now read only the manifest before measuring, skip the
  per-run stat check, and hash the full content afterwards. The report excludes
  cold sessions that lack a passing post-run hash; this session is listed as
  excluded. Regression tests in `bench/search/provenance.test.mjs`.
- Standby-purge was not attempted: RAMMap is not installed.

### Reboot-cold H4 (2026-10-11)

- Session `baseline-cold-reboot-2026-10-11b`, fixed harness, started 9.5 min
  after a second reboot (`uptimeS` 569). This boot differs from the warm
  sessions' boot and from the void attempt's boot. The tree was read only via
  the manifest before measuring; the post-run full content hash passed.
- **H4 cold p50: 82.9 ms** from 1 launch, 5 calls: the first grep (5 030 ms,
  deadline hit, partial), 55 ms, 83 ms, 2 901 ms (complete) and one find
  (22 ms, partial). Engines: in-process 4, find 1; 0 rg children (rg not on
  PATH). Error rate 0 %; deadline-hit 1/5.
- **Limits:** a single launch gives no CI and no A/A check, and the p50 of 5
  mixed queries is dominated by the query mix. The USE note marks Defender
  (MsMpEng) as saturated during the run, which is expected just after boot.
  Comparing a candidate on H4 needs several reboot-cold launches per version
  (one reboot each), alternating versions.
- Combined report: `baseline-combined-2026-10-11` (the warm sessions plus both
  cold sessions; the void one is listed as excluded). H1–H3 are unchanged.
- **Raw results:** `.gg/verification/search-bench-baseline-cold-2026-10-11.zip`
  (sha256 `70891722d2f3a005eb46618d6dc42dfef38281cbd7324fc82ea54abafb01c271`),
  containing both cold sessions and the combined report.
