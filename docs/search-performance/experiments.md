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

## 2. Bundled ripgrep with `--json` parsing (2026-10-12)

- **Idea and expected gain:** ship a pinned ripgrep 15.2.0 (bundled → PATH →
  in-process), read its `--json` events, report complete/partial status and
  kill the child on cancel or deadline. Expected: walk-bound queries (Q1, Q4,
  Q8, Q10) stop pinning the 5 s deadline, so H2 and H1 improve; H3 measures
  the in-process engine and should not move.
- **Commit / worktree:** `89ccdd188b92c4ad51777281de3269ceef07e989` (local
  branch `search/ripgrep-json`, not pushed) at
  `E:/Projects/gg-search-bench/worktrees/rg-json`: clean, dist newer than src,
  `grep.js` sha256 prefix `ffe3b85f8d8c`, vendored `rg.exe` 15.2.0
  `x86_64-pc-windows-msvc` sha256 `14231169855e…6680` (matches its staging
  manifest). Baseline `df1a353` as in entry 1, re-measured in the same
  sessions.
- **Spec version:** 1. Frozen tree hash `3cc2dcdda597…`.
- **Harness changes (adapter only):** the worker unwraps the new
  `{ content, details }` result and classifies only the text, by the same
  notice rules as before; it records the tool's own engine/status next to the
  spy's attribution and flags any status/notice disagreement. Provenance now
  refuses a version whose bundled-rg lookup has nothing staged, or whose
  staged binary no longer matches its manifest hash. The baseline still
  returns text, so its measurements are unaffected.
- **Sessions / launches / cold method:** `rgjson-quick-1` (quick, 4 launches),
  `rgjson-quick-2` (quick, 4 launches, target order reversed) and
  `rgjson-full-1` (full, 2 launches): 12 launches per version for headline
  cells, 2 for exploratory cells. All warm, same boot. Node v22.20.0, High
  performance, AC, SysMain stopped, Windows Search running, Defender
  real-time on, not admin, free RAM 11.6–14.4 GB, rg not on PATH (the
  candidate used only its bundled copy).

### Headlines (warm, 12 launches, 3 sessions)

| ID              | Baseline | rg-json  | Ratio (higher = better) [95% CI] | Rule outcome |
| --------------- | -------- | -------- | -------------------------------- | ------------ |
| H1 calls/s @100 | 19.68    | 16.60    | **0.844** [0.824, 0.865]         | worse        |
| H2 p99 @16      | 5 011 ms | 1 573 ms | **3.186** [3.040, 3.554]         | ≥ 1.30, CI>1 |
| H3 Q2 p50 @1    | 45.7 ms  | 47.6 ms  | 0.960 [0.914, 1.005]             | no change    |
| H4 cold p50     | –        | –        | no data                          | not measured |

A/A checks (launch parity split) contain 1.0 for every headline of both
versions.

- **Correctness:** 60 730 checked candidate outputs, 0 failures; 18 924
  complete calls matched the uncapped oracle exactly (baseline: 2 682, because
  most of its walk-bound calls were cut off). Tool status agreed with the
  output notices on every call.
- **Errors:** 20 candidate errors in 74 790 calls, all `This operation was
aborted` from the cancel cell, where the candidate now throws on abort
  instead of returning a partial answer (intended). 0 errors in every other
  cell. Baseline: 0 in 67 956.
- **Deadline hits:** overall 22.0 % (candidate) vs 34.0 % (baseline). At 16
  concurrent agent-mix calls 0.00 % vs 6.41 %; at 100, **42.6 % vs 40.0 %**.

### Verdict

- **Reverted** by the pre-registered rule. H2 alone clears the 1.30 bar, but
  H1 regresses (0.84×, CI entirely below 1.0) and the reliability gate fails:
  the rule compares the candidate's overall error rate (0.027 %) with the
  baseline's 95 % CI, whose upper bound with 0 errors is about 0.005 %. All 20
  errors are deliberate cancellations; the rule as written counts them, and
  it is applied as written. H4 was not measured (no cold session), so it
  cannot rescue or sink the result.
- Consequence for this record: "Current best" and `bench/baseline/search.json`
  stay on `df1a353`.
- **Final (2026-10-12): no rerun.** The deadline-overrun fix below came after
  this benchmark (candidate `89ccdd18` vs baseline `df1a353`). It targets Q7,
  which is not in H1's agent mix (Q1–Q5), so it cannot rescue H1. The verdict
  stays **reverted**.
- rg-json is not merged into `custom/local-customizations`. Branch
  `search/ripgrep-json` stays local and is not pushed.

### Main observations (exploratory)

- **Per-query @16 (rg vs baseline p50):** Q1 rare literal 1.20 s vs 5.03 s
  (deadline 100 % → 0 %), Q4 include filter 0.69 s vs 5.04 s, Q8
  match-nothing 1.15 s vs 5.03 s. Q10 many small files still hits the
  deadline (98 %). Common-literal Q2 is **slower** with rg (2.83 s vs 0.62 s),
  Q3 1.52 s vs 0.96 s: these used to stop early at the result cap, while exact
  path-ordered top-N via rg must read every match.
- **Q7 match-everything is pathological via rg:** p50 4.7 s at concurrency 1
  vs 36 ms in-process, and p99 **26.6 s at 16 — far past the 5 s deadline.**
  Profiling found the cause in this commit's runner, not in rg: (1) each match
  event's `submatches` array holds one object per matched character, so `.`
  over minified lines produces multi-megabyte JSON lines; (2) readline
  re-scans a pending line on every chunk, which is quadratic for such lines;
  together they blocked the event loop for 5–18 s, deadline timer included.
  See "Post-benchmark fix" below.
- **Concurrency ladder (agent mix, deadline on, UV 4), calls/s at
  1 / 4 / 16 / 32 / 64 / 100:** rg 13.9 / 12.3 / 12.3 / 11.7 / 12.1 / 16.6;
  baseline 17.5 / 3.8 / 3.4 / 6.4 / 12.6 / 19.7. rg holds ~12 calls/s with 0 %
  deadline hits up to 32; past 64 it saturates the 12-thread CPU (each rg uses
  all cores) and p99 overshoots the deadline (6.7 s at 100).
- **UV 16** made no material difference for rg (deadline-on @100: 17.0 vs
  16.6 calls/s). **Deadline off** @16: rg p99 1.33 s vs baseline 5.65 s.
- **Open loop:** knee moved from 4 to **16 arrivals/s**, but above the knee rg
  latencies grew without bound (p99 28 s at the knee step, 48 s max), worse
  than the baseline's deadline-capped tail.
- **Cancel (abort at ~50 ms):** settle time after abort, from call latency
  minus abort time: Q6 67–103 ms (baseline 4.96–5.24 s), Q2 via rg 3–5 ms.
  0 rg processes alive 100 ms after abort and 1 s after return in every run.
  The harness's own `returnAfterAbortMs` waits 100 ms before awaiting the
  call, so it has a 100 ms floor and is not used here.
- **Soak** (16 concurrent, 10 min, 2 launches): 0 deadline hits (baseline
  39.9 %), p99 4.1 s vs 5.1 s, RSS +1.3 and +7.0 MB/min (baseline +3.5 and
  +3.7), handles flat. 0 rg left after any run.
- **rg CLI ceiling:** not available. The cell runs `rg` from PATH, which this
  machine lacks; it does not use the bundled copy.

### Post-benchmark fix (not measured by the rule)

Found by this run and fixed in the working tree after `89ccdd18`: the runner
now splits rg output with a linear byte-level splitter that drops each match
event's `submatches` bytes as they stream in, skips formatting for matches
that cannot make the top-N, and stops parsing once the search is stopped.
Regression tests in `packages/ggcoder/src/tools/grep.test.ts`. An ad-hoc probe
on the frozen tree (not a harness session, exploratory only), Q7 `.` with the
5 s deadline: 1 call 7.7 s → 1.6 s; 16 concurrent calls 18.1 s → 5.6 s, with
the longest event-loop block 18.0 s → 1.6 s. This change is not committed and
has no harness measurement. It is not rerun (see Verdict), so no verdict
covers it.

### Limits

- No cold sessions: H4 has no data for either version this time (needs a
  reboot window or RAMMap as admin). Recorded as not measured, not estimated.
- Exploratory cells have 2 launches each; their CIs are wide.
- macOS (Apple Silicon) packaging is unverified here; only the Windows bundle
  was built and smoke-tested.
- **Raw results:** `.gg/verification/search-bench-rg-json-2026-10-12.zip`
  (sha256 `3880d1bfd2883cfef4b7657ba089c492eeceab40311d9da43cfcd78e830cbc3e`),
  containing the three sessions and `rgjson-combined` (`report.md`,
  `report.json`, SVGs).
