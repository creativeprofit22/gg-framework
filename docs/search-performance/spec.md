# Search benchmark spec

**Spec version: 1** (frozen 2026-10-10, before any measurement). Source of truth
in code: `bench/search/spec.mjs` (`SPEC_VERSION = 1`).

Results from different spec versions are never compared directly. Any change
that alters what is measured (queries, tree, cells, load shapes, statistics,
keep/kill rule) bumps the version, and the current best version must be
re-run under the new version before any candidate is compared against it.

## What is measured

GG Coder's real `grep` and `find` tools, called in-process through their
`AgentTool.execute` interface (`createGrepTool(cwd, localOperations, options)`,
`createFindTool(cwd)`), imported from each target worktree's
`packages/ggcoder/dist/tools/`. No product code is patched.

## Frozen search tree

Built once at `E:/Projects/gg-search-bench/tree/` (same 7200 rpm HDD as the
repo) and verified by tree hash before every warm run. Cold sessions read only
`manifest.json` before measuring (hashing or stat-ing the tree would warm the
OS caches) and run the full content hash afterwards; the report excludes any
cold session without a passing post-run hash. It also excludes any session run
with a smoke/debug override that changes the measurement (`--only-cells`,
`--waves`, `--soak-ms`, `--open-step-ms`; recorded in `session.json`
`overrides`, or read from `argv` for older sessions). Excluded sessions are
listed as "excluded, no samples used" and never reach headlines or
`bench/baseline/search.json`. `--fast-verify` only shortens the up-front tree
check, so it is recorded but does not exclude a session. Tree layout:

- `repo/` — `git archive df1a3531b867f11393ce98ea9af1d4b6f1d66ceb` of this
  repository (real code and its real root `.gitignore`).
- `synthetic/many-small/` — 20 000 seeded files of 200–2 000 bytes in 100
  directories (crosses the 10 000 in-process candidate cap). Every 97th file
  contains the needle literal.
- `synthetic/large/large.txt` — one 9 MiB text file (under the 10 MB skip) of
  1 000-character word lines; every 1 000th line carries a marker literal.
- `manifest.json` — sorted path, size and SHA-256 per file plus the tree hash.

## Queries (tool cwd = tree root)

| ID  | Class                    | Tool | Arguments                                                                   |
| --- | ------------------------ | ---- | --------------------------------------------------------------------------- |
| Q1  | rare literal             | grep | `detectExternalScanner` in `repo`                                           |
| Q2  | common literal           | grep | `import` in `repo`                                                          |
| Q3  | regex                    | grep | `export\s+(async\s+)?function\s+\w+` in `repo`                              |
| Q4  | include filter           | grep | `createGrepTool` in `repo`, include `*.ts`                                  |
| Q5  | find glob                | find | `**/*.test.ts` in `repo`                                                    |
| Q6  | deadline-hitting         | grep | lookahead + quadratic `\w+\d+` tail over the whole tree (forces in-process) |
| Q7  | match-everything         | grep | `.` in `repo`                                                               |
| Q8  | match-nothing, walk-only | grep | a nonce literal absent from the tree, in `repo`                             |
| Q9  | one large file           | grep | marker literal in `synthetic/large/large.txt`                               |
| Q10 | many small files         | grep | needle literal in `synthetic/many-small`                                    |

The agent mix is Q1–Q5 round-robin. Each grep query runs as two engine cells:
`rg-enabled` (the default; rg used when on PATH) and `in-process`
(`useExternalScanner: () => false`). The engine that actually ran is recorded
per call from a spawn spy; rg absent ⇒ `rg-enabled` cells are labelled
`skipped-no-rg` for engine comparisons but still measure today's behaviour.

## Unique arguments per call

The harness calls `execute` directly, so the agent loop's duplicate
suppression is not in the path, but every call still has unique arguments:

- grep, cap does not bind (oracle total < cap): `max_results = cap + callSeq`.
- grep, cap binds: pattern `(?:<base>|<nonce>)` with a nonce the manifest
  proves absent; the same transformed pattern is given to the oracle.
- find: brace nonce `{<glob>,**/<nonce>}`.

An exploratory `fixed-args` cell measures the nonce overhead.

## Load modes

- **Closed waves**: concurrency ladder 1/4/16/32/64/100, at least 10 measured
  waves per level after 2 warm-up waves. A wave is N simultaneous calls; the
  wave is the independent unit (calls/s = N / wave wall time). Per-wave hard
  timeout 10 min.
- **Open loop**: arrival rates 1, 2, 4, 8, 16, 32, 64/s, 30 s each. Each call
  records intended start (`t0 + i/rate`), actual start and end. Latency =
  end − intended start (coordinated-omission corrected); service time =
  end − actual start. Knee = first rate whose p99 exceeds 2× the 1/s p99 or
  whose completion rate falls below 0.95× the arrival rate. At most 1 000
  calls outstanding; overflow is counted, never dropped silently.
- **Cancel**: Q6 and Q2 started with an `AbortController`, aborted at 50 ms;
  records time to return and whether an rg child is alive 100 ms after abort
  and after return.
- **Soak**: concurrency 16 for 10 min; RSS and handle-count slope per minute.
- **Calibration**: a no-op tool through the same runner path; raw rg CLI
  ceiling with the tool's exact argument list per query.

Deadline on (5 000 ms) for all cells; deadline off (1e9 ms, never 0) at
concurrency 1 and 16 only. `UV_THREADPOOL_SIZE` 4 for all cells and 16 for
the ladder and deadline-off cells.

## Cold runs

Recorded per launch as `cold`:

- `none` — warm.
- `standby-purge` — mostly-cold: RAMMap "Empty Standby List" (admin, run by
  the operator) immediately before the launch. Windows keeps file-system
  metadata cached, so this is not fully cold.
- `reboot` — reboot-cold: first session after a reboot; the harness refuses
  unless `os.uptime()` < 15 min.

A cold sample is the first call per query in a fresh worker after the
declared purge or reboot: one sample per query per purge. Cold cells that
were not performed are reported as skipped, never estimated.

## Controls

Each launch is a fresh `node` process. Version order rotates per round
(Latin square). A dummy environment variable of 0 / 1 KiB / 4 KiB / 16 KiB is
rotated across launches and recorded. Provenance (commit, worktree, dirty
flag, tool-file hashes, rg path/version, engine settings, threadpool size,
Node version, power plan, AC state, free RAM, SysMain/Search/Defender state,
CPU temperature where readable) is recorded per launch; the harness refuses
on a commit mismatch, a dirty target tree, stale or missing `dist` tool files,
or a tree-hash mismatch.

## Outcome classification

`complete` | `partial` with one or more of `deadline`, `candidate-cap`,
`result-cap`, `find-cap` | `error` with one of `spawn`, `emfile`,
`invalid-pattern`, `harness-timeout`, `other`.

## Correctness

An independent uncapped oracle (own directory walk, same documented
ignore/binary/size rules) produces the full `path:line:text-hash` set.
Complete ⇒ set equality; result-capped ⇒ equals the oracle's first N in
path/line order; partial by deadline or candidate cap ⇒ recall reported.
Repeated complete calls must be byte-identical (output hash).

Q6 and Q8 can only match lines containing a literal token that the tree
manifest proves absent, so their oracle match set is empty by proof; the
oracle still walks the candidates (matching that literal) to count files and
bytes, instead of running Q6's quadratic regex over the whole tree.

## Statistics

Percentiles by linear interpolation (type 7): p50/p90/p99/max. Effect sizes
are ratios of medians (latency) or of mean wave throughput, with a
hierarchical bootstrap 95% CI (sessions → launches → waves/calls; 10 000
resamples, fixed seed). Independence is checked per launch with a
run-sequence plot and lag 1–10 autocorrelation. A pilot (excluded from
results) sizes launches per cell: n = ceil((1.96·CV/0.05)²) at the launch
level, clamped to [3, 30]. An A/A comparison of the baseline against itself
must give a CI containing 1.0.

## Headline comparisons (pre-registered)

- **H1** warm closed-wave calls/s at concurrency 100, agent mix, rg enabled,
  deadline on, UV 4 (higher is better).
- **H2** warm p99 latency at concurrency 16, same cell (lower is better).
- **H3** warm p50 latency of Q2 in-process at concurrency 1 (lower).
- **H4** cold p50 latency of the agent mix at concurrency 1 (lower).

All other comparisons are exploratory and labelled as such.

## Keep/kill rule

A candidate is **kept** only if the headline speedup point estimate is at
least 1.30 with a 95% CI lower bound above 1.0, every complete call is
identical to the oracle, and error and deadline-hit rates do not rise above
the baseline's 95% CI. Otherwise it is **reverted**, or **inconclusive** when
the CI straddles the threshold.
