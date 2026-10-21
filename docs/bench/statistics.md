# Bench kit statistics

How the bench kit turns samples into a verdict. Everything here is done by the kit CLI
(`packages/ggcoder/assets/bench-kit/`), never by the agent. Every number below is the
code's own default; a study can change only the ones marked as study options.

See also: [README.md](README.md), [concepts.md](concepts.md),
[study-format.md](study-format.md), [gates-and-metrics.md](gates-and-metrics.md),
[references.md](references.md).

## Where the ideas come from

The core methods are ported from this repo's `bench/search/stats.mjs`: the seeded random
number generator, percentiles, the hierarchical bootstrap and the Wilson interval. Other
ideas were taken from published tools as ideas only; no code was copied.

| Idea                                                           | Source                   |
| -------------------------------------------------------------- | ------------------------ |
| mulberry32 RNG, hierarchical bootstrap, Wilson                 | `bench/search/stats.mjs` |
| Classify an interval against a noise band; Tukey               | criterion.rs             |
| MAD modified z-scores                                          | hyperfine                |
| Stop at minimum samples AND minimum time; gc first; heap delta | mitata                   |
| One fresh worker process per sample                            | pyperf                   |
| pass@k, clustered standard error                               | inspect_ai               |
| Seeded balanced schedule                                       | Ken's prompt-bench       |

## Seeded randomness (`lib/rng.mjs`)

- `makeRng(seed)` is mulberry32: a small, fast generator that gives the same sequence for
  the same seed. Every random choice in the kit uses it, so a study can be replayed.
- `seedFrom(text)` hashes a string (32-bit FNV-1a) into a sub-seed, for example
  `"<seed>:<candidate>:<metric>"`. Each comparison gets its own stream, so adding a metric
  does not change another metric's numbers.
- `shuffle` is a Fisher–Yates shuffle into a new array.

The default seed is `0x0b0075ed`. A study's integer `seed` replaces it.

## Run order (`lib/schedule.mjs`)

`buildSchedule` decides the order of every sample before the run starts.

1. The candidates are shuffled once, from `seedFrom("<seed>:order")`.
2. For each repeat (warm-up repeats first), the workload items are shuffled again from
   `seedFrom("<seed>:items:<repeat>")`.
3. For each item, every candidate runs once. The starting position rotates by
   `(repeat + itemIndex) mod candidates`, so each candidate takes each position in turn.

Why: warm caches, thermal drift and background load then hit every candidate equally.
`positionCounts` reports how often each candidate ran in each position, as a balance check.
Warm-up slots are marked `phase: "warmup"` and are dropped before any statistic.

## Running samples (`lib/runner.mjs`, `lib/measure.mjs`)

- `forkExecutor` starts one fresh worker process per sample (pyperf's idea), with
  `--expose-gc` by default. A sample that runs past `timeoutMs` plus 5 s of grace is killed
  and recorded as `TIMEOUT`. The study's `timeoutMs` defaults to 600,000 ms.
- Function candidates are timed in the worker by `measureFunction`. It runs 2 warm-up
  calls, forces garbage collection when it can, then measures until BOTH 10 samples and
  300 ms are reached (mitata's rule), capped at 100,000 samples or 30,000 ms. It reports
  the heap change across the loop and the CPU time used.
- Every slot is appended to `samples.jsonl` as it finishes; errored ones also go to
  `errors.jsonl`.

## Summaries (`lib/stats.mjs`)

| Function                   | What it gives                                                       |
| -------------------------- | ------------------------------------------------------------------- |
| `percentile`               | Linear interpolation between sorted values (Hyndman–Fan type 7)     |
| `median`, `mean`, `stddev` | The usual; `stddev` divides by n − 1                                |
| `geomean`                  | Geometric mean; undefined if any value is not positive              |
| `summarize`                | n, min, p50, p90, p95, p99, max, mean, sd, coefficient of variation |

A study's decision rule may use one of these named statistics: `median` (default), `mean`,
`min`, `max`, `p90`, `p95`, `p99`. Non-numbers and non-finite values are dropped first.

## The paired, item-clustered bootstrap

`pairedBootstrap(reference, candidate, options)` is the main comparison.

In plain words: the kit pretends to rerun the study 10,000 times by drawing from the data
it already has, and looks at how much the answer moves.

- Data is grouped by workload item: one list of values per item, one value per repeat.
- Each resample draws items with replacement, using the SAME draw for both sides. Both
  candidates ran the same inputs, so they are compared item by item (paired).
- Inside each chosen item, the repeats are resampled separately for each side.
- The per-item effect is either a ratio (`scale: "ratio"`, the default) or a difference
  (`scale: "difference"`).
- Ratios are combined by geometric mean, so a 10 s input and a 100 s input weigh the same.
  Differences are combined by mean.
- The result is oriented so that above 1 (ratio) or above 0 (difference) always means the
  candidate is better, whichever way `better` points.
- The interval is the 2.5th to 97.5th percentile of the resampled effects at the default
  95 % level. `validResamples` says how many resamples gave a usable number.

Only items with numbers on both sides are used. With none, the interval is undefined.

The older `bootstrapRatio` and `hierarchicalResample` (Kalibera and Jones: resample at
every level of a nested array) are kept as ported, but the decision rule uses
`pairedBootstrap`.

Why: repeats of one input are not independent, and inputs differ in size. Resampling whole
items keeps that structure and avoids pretending to have more evidence than there is.

## Several candidates: Bonferroni

With one reference and m other candidates, the kit makes m comparisons. Each extra
comparison is another chance of a lucky result, so `bonferroniLevel(level, m)` widens each
interval to `1 - (1 - level) / m`. With three challengers at 95 %, each interval is
98.3 %. The report says the interval was widened and why (`describeRange`).

## Rank probability

`rankProbability` answers "how often was each candidate the best?". It draws items and
repeats like the bootstrap, scales each item by the mean across candidates (so large and
small items count the same), adds up the scores, and counts the best candidate in each
resample. Ties share the credit. It uses at most 2,000 resamples.

The report words it as, for example, "ranked best on export time in 87% of resamples (a
ranking, not a verdict)". Rank probability only picks between several candidates that
already cleared the rule; it never creates a win.

## The decision rule (`lib/compare.mjs`, `decide`)

The rule is written in `study.json` before the run and frozen in the protocol.

| Setting                      | Meaning                                        | Default       |
| ---------------------------- | ---------------------------------------------- | ------------- |
| `minRatio` / `minDifference` | the bar the point estimate must reach          | 1 / 0         |
| `ciLowerAbove`               | the whole interval must be above this          | 1 (ratio) / 0 |
| `level`                      | confidence level before Bonferroni             | 0.95          |
| `maxErrorRate`               | share of errored samples allowed per candidate | 0.1           |
| noise                        | from the A/A check, else `DEFAULT_NOISE`       | 0.01 (1 %)    |

Per candidate, in order:

1. A failed gate gives **GATED-OUT**. A gate that could not be checked gives
   **INCONCLUSIVE**. An error rate above `maxErrorRate` gives **INCONCLUSIVE**.
2. **WIN** when the point estimate reaches the bar, the interval's lower end is above
   `ciLowerAbove`, and the point is beyond the noise (above `1 + noise` for ratios).
3. **TIE** when the whole interval sits inside the tie band: from `1 / t` to `t`, where
   `t = max(bar, 1 + noise)` (for differences, `-t` to `t` with `t = max(bar, noise)`).
4. **NO-WIN** when the upper end is below the bar or below "no difference".
5. Otherwise **INCONCLUSIVE**: the interval is too wide to tell.

Secondary metrics (`mustNotRegressBeyond`) are compared the same way on a ratio scale. A
regression past the limit turns a WIN into NO-WIN; a secondary with no numbers turns a WIN
into INCONCLUSIVE.

Study verdict: INCONCLUSIVE if any study-level reason exists (A/A missing when required,
A/A failed, a run not finished, the reference blocked). Otherwise WIN if any candidate won
(the one ranked best most often is named), else INCONCLUSIVE if any candidate is, else TIE
if any is tied, else NO-WIN.

`classifyChange` adds a criterion.rs-style label to each interval: `better`, `worse`,
`no-change` (the interval includes "no difference"), `within-noise`, or `unknown`.

## The A/A noise check

`aaStudy` makes a copy of the reference (id `<ref>~aa`) and runs the reference against
itself. Any difference it finds is noise.

`noiseCheck` compares the two with the primary rule's statistic and scale.
`noiseFromAA` passes when the interval contains "no difference"; the noise floor is how far
the interval reaches either way. The check also fails when more than `maxErrorRate` of
either side errored, or the A/A run did not finish.

With `"noise": { "requireAA": true }`, a missing A/A run makes the verdict INCONCLUSIVE. A
failed A/A run always does.

## How INCONCLUSIVE arises

| Cause                                      | Where                        |
| ------------------------------------------ | ---------------------------- |
| Interval too wide to clear or miss the bar | `decide`, step 5             |
| Errored samples above `maxErrorRate`       | `decide`, step 1             |
| A gate could not be checked                | `decide`, step 1             |
| No comparable measurements                 | `decide`                     |
| A/A required but not run, or failed        | `decide`, study reasons      |
| A run aborted or still running             | `collectRuns` (`incomplete`) |
| The reference itself was blocked           | `decide`                     |

The report turns each reason into a next step (`nextSteps` in `explain.mjs`), such as "Add
repeats or reduce noise, then run again."

## No selective reruns

Nothing is ever retried. An errored sample stays errored and counts against its candidate.
Rerunning only the failures would give some candidates a second chance and bias the result.

- `runStudy` refuses an existing run id (`RUN_EXISTS`): runs are never overwritten or
  topped up.
- `collectRuns` refuses a run whose plan gave candidates different sample counts
  (`RUN_UNBALANCED`) and a run given twice (`RUN_DUPLICATE`).
- Full runs use the frozen `repeats`. Only a pilot may use fewer (`REPEATS_LOCKED`).
- If the harness was broken, fix it and start a new full run.
- `report` uses every full run of the current version by default. `--runs A,B` may
  choose a subset, but never silently: each full run left out is named in `report.md`
  ("Left out by choice"), in `verdict.json` (`excludedRuns`) and in the CLI output.

## Never pooling across protocol versions

Freezing a study records a protocol version and digest. Any change to `study.json`, the
workload, the kit or a candidate makes a new version. `collectRuns` calls `assertPoolable`,
and `report` only uses full runs whose digest matches the current version. Runs from older
versions stay on disk but are never mixed in; the A/A run must match too. Pilot runs are
excluded from evidence.

## Other helpers in `stats.mjs`

These are implemented and tested. In this kit version they are not called by the
run/report pipeline (only `wilson` is used, by the self-test).

| Function                    | What it does                                             | Idea from    |
| --------------------------- | -------------------------------------------------------- | ------------ |
| `wilson`                    | Interval for a pass rate; sensible at 0 and n            | ported       |
| `passAtK(n, c, k)`          | Chance at least one of k tries passes (Chen et al. 2021) | inspect_ai   |
| `clusteredStandardError`    | Standard error when repeats of one task are correlated   | inspect_ai   |
| `tukey`                     | Outlier labels: mild beyond 1.5 IQR, severe beyond 3 IQR | criterion.rs |
| `madZScores`, `madOutliers` | Modified z-scores; outliers above 3.5                    | hyperfine    |
| `pilotRepetitions`          | Repeats needed: `ceil((z·CV / e)²)`, clamped to 3–30     | ported       |
