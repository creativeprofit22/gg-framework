# Search performance

Living record for GG Coder's `grep` and `find` tools on the reference machine
(Windows, i7-8700 12 threads, 24 GB, repo and Node on a 7200 rpm HDD, Defender
real-time on). Read with:

- [`spec.md`](spec.md) — what is measured and how (current: **spec v1**).
- [`experiments.md`](experiments.md) — append-only log of every attempt.
- [ADR 0004](../adr/0004-search-benchmark-harness.md) — why the harness looks
  like this.

## Current best

**`baseline`** = `df1a3531b867f11393ce98ea9af1d4b6f1d66ceb` (unchanged tools),
spec v1, recorded 2026-10-10 (warm) and 2026-10-11 (reboot-cold). Machine-readable copy:
`bench/baseline/search.json`.

| ID  | Pre-registered headline                                                 | Baseline                                           | Target to keep a candidate                                         |
| --- | ----------------------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------ |
| H1  | warm calls/s, concurrency 100, agent mix, rg enabled, deadline on, UV 4 | **19.10 calls/s**                                  | ≥ 24.8 (×1.30) and CI lower bound > 1.0                            |
| H2  | warm p99 latency, concurrency 16, same cell                             | **5 016 ms**                                       | ≤ 3 858 ms                                                         |
| H3  | warm p50 latency, Q2 (`import`) in-process, concurrency 1               | **55.7 ms**                                        | ≤ 42.9 ms                                                          |
| H4  | cold p50 latency, agent mix, concurrency 1                              | **82.9 ms** (1 reboot-cold launch, 5 calls; no CI) | ≤ 63.8 ms; needs several reboot-cold launches per version for a CI |

Every candidate must also match the oracle on all complete calls and must not
raise the error or deadline-hit rate beyond the baseline CI (full rule in
`spec.md`).

What the baseline shows (details in `experiments.md` entry 1):

- **ripgrep is not installed on this machine**, so every "rg enabled" call ran
  the in-process scanner (0 rg children spawned). Installing `rg` is itself a
  candidate experiment.
- Walk-heavy queries (rare literal, include filter, match-nothing, many small
  files) take 0.5–1.2 s alone but hit the 5 s deadline on **100 %** of calls
  at concurrency 16. H2 is therefore pinned at the deadline.
- Open-loop knee: tail latency breaks at **4 arrivals/s**.
- Abort is ignored: a deadline-hitting search returns about 5 s after abort.
- 0 errors (no EMFILE or spawn failures) in more than 60 000 calls. The oracle
  matched all 2 732 complete calls that could be fully checked.

## How to run

Prerequisites: a clean git worktree for each version with built framework
packages (`pnpm install`, then build gg-ai → gg-agent → gg-core → ggcoder), and
the frozen tree.

```bash
# once: build the frozen tree (E:/Projects/gg-search-bench/tree, hash 3cc2dcdd…)
node bench/search-bench.mjs --build-tree

# a version's worktree, outside the main checkout
git worktree add E:/Projects/gg-search-bench/worktrees/<label> <sha>

# measure (prints a runtime estimate first; --dry-run to only print the plan)
pnpm bench:search --target baseline=E:/Projects/gg-search-bench/worktrees/baseline@df1a353 \
  --target cand=E:/Projects/gg-search-bench/worktrees/cand@<sha> \
  --profile quick --launches 4 --session <name>

# combine sessions into one report (add --update only to promote the baseline)
pnpm bench:search --report bench/search-results/<s1> --report bench/search-results/<s2> \
  --out bench/search-results/<combined> --candidate-label cand

# harness unit tests
pnpm test:search-bench
```

Profiles: `pilot` (noise sizing, excluded from results), `quick` (headline
cells, about 15–20 min) and `full` (all exploratory cells, about 2.6 h for 6 launches
on this HDD). Cold runs: empty the standby list with RAMMap (admin) and pass
`--cold standby-purge`, or start within 15 minutes of a reboot and pass
`--cold reboot`. The harness checks both claims and never fakes a cold run.

Smoke/debug flags (`--only-cells`, `--waves`, `--soak-ms`, `--open-step-ms`)
are for checking the harness only. The report lists such sessions as excluded
and uses none of their samples, so they can never become headline or baseline
evidence. `--fast-verify` is for warm sessions only: it does a size/mtime tree
check instead of the full content hash before the run. Cold sessions ignore it
(they read only the manifest first and full-hash afterwards). It does not change
measurements and is not excluded.

The harness refuses to run when a target's HEAD is not the stated commit, the
worktree is dirty, `dist` is missing or older than `src`, or the tree hash
differs. Raw per-call JSONL goes to `bench/search-results/` (gitignored). Zip
raw results into `.gg/verification/` and only commit summaries.

## Comparing a candidate

1. Make the change in a separate worktree, build it and commit it (provenance
   needs a commit).
2. Run baseline and candidate together in rotated order across at least two
   sessions.
3. Apply the keep/kill rule in `spec.md` to the report's H1–H4 effect sizes and
   CIs, then append an entry to `experiments.md`, including failures.
4. Only a kept result updates "Current best" here and `bench/baseline/search.json`
   (`--update --baseline-label <label>`).
