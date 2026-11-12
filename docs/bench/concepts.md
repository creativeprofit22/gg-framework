# Bench concepts

This page explains the ideas behind the bench kit in plain words. For the exact file
format see [study-format.md](study-format.md). For the overview see [README.md](README.md).

The running example is the sample study that ships with the kit
(`templates/study.sample.json`): "Which of three video engines should the editor use for
decoding, seeking and export?"

## Study

A study is one question with a fixed way of answering it. It lives in
`bench/studies/<id>/` and is described by `study.json`. The question and the rule that
decides it are written down before anything is measured. That way the result cannot be
bent to fit what you hoped to see.

In the example the study id is `video-engine`, its `kind` is `engine`, and it runs each
candidate 10 times per input (`repeats: 10`) after 1 warm-up round (`warmupRepeats: 1`).

## Candidate

A candidate is one of the options being compared. A study needs at least two. Each
candidate has an `id`, an optional `label`, and an `adapter` that says how to run it:

| Adapter    | Use it when the candidates are                           |
| ---------- | -------------------------------------------------------- |
| `function` | JS functions or modules with the same interface          |
| `cli`      | commands, with `{input}` and `{out}` slots               |
| `http`     | running services                                         |
| `agent`    | coding agents (see [agent-studies.md](agent-studies.md)) |
| `manual`   | numbers measured elsewhere and imported                  |

The example has three `cli` candidates: `engine-a` (the current engine), `engine-b` and
`engine-c`. Each has a `prepare` command (clear the cache) and a `cleanup` command. See
[adapters.md](adapters.md).

One candidate is the **reference**: the one you keep unless another clearly beats it.
In the example that is `engine-a`.

## Workload

The workload is the set of inputs every candidate gets. The files sit in the study's
`workload/` folder and are listed in `workload.items`. The example has three items: a
1080p H.264 clip, a 4K HEVC clip and a mixed timeline. Each item also points at an
`expectedFile`, a reference render used by the quality gate.

The workload is frozen: its bytes are hashed into the protocol. Pick inputs before you see
any results, and cover the cases the decision depends on.

## Gate

A gate is a yes/no check. A candidate that fails a gate is ruled out, whatever its
numbers. A fast wrong answer is still wrong.

The example has five gates:

| Gate                | Type        | Scope       | Checks                                                        |
| ------------------- | ----------- | ----------- | ------------------------------------------------------------- |
| `exits-cleanly`     | `exit-code` | `sample`    | the command exits with 0                                      |
| `frame-exact-seek`  | `command`   | `sample`    | seeking lands on the exact frame (first sample per item only) |
| `vmaf-vs-reference` | `quality`   | `sample`    | VMAF against the reference is at least 93                     |
| `platform-support`  | `command`   | `candidate` | the engine runs on the needed platforms                       |
| `licence-fit`       | `command`   | `candidate` | the licence suits the project                                 |

Points worth knowing:

- A gate that cannot be checked (its command errors) makes the candidate INCONCLUSIVE,
  never passed.
- `"severity": "record"` keeps a gate as a recorded check that never rules anything out.
- An LLM judge can never be a gate. The validator rejects any gate with a `judge` field
  or a type containing "judge".

More in [gates-and-metrics.md](gates-and-metrics.md).

## Metric

A metric is a number measured for every sample. Each has a `type`, a `unit` and a
direction (`better`: `lower` or `higher`). The example measures:

| Metric           | Type          | Unit | Better |
| ---------------- | ------------- | ---- | ------ |
| `export_seconds` | `wall-time`   | s    | lower  |
| `decode_fps`     | `custom`      | fps  | higher |
| `seek_p95_ms`    | `custom`      | ms   | lower  |
| `peak_memory_mb` | `peak-memory` | MB   | lower  |

The two `custom` metrics are read from fields in the candidate's JSON on stdout.

Some things matter but are not measured by the run. They go in `unmeasured`, with how
they could be judged. The example lists picture quality as people see it, to be judged by
a blind human A/B rating with the `rate` command. Reports say "not measured" for these,
never 0.

## Decision rule

The decision rule says what counts as a win. It is written before any run. The example
rule in words:

> Keep `engine-a` unless another engine's median export time is at least 1.3 times
> better (30% faster), the lower end of its 95% interval is above 1.0, and its seek p95
> is no more than 1.1 times worse. If it is a tie, decide by simpler integration, then
> licence fit.

In `study.json` this is the `decision` block: `reference`, `level`, `primary`,
`secondary`, `tieBreak` and `noise`. Each non-reference candidate is compared with the
reference. With more than one such comparison the confidence level is tightened
(Bonferroni), so three engines (two comparisons at 0.95) are judged at 0.975 each. See
[statistics.md](statistics.md).

## A/A noise floor

An A/A run compares the reference with a copy of itself. Any "difference" it finds is
pure noise from the machine: background load, caches, heat. The kit compares the copy
with the original using the primary metric and statistic.

- The A/A check **passes** when its interval contains "no difference".
- The **noise floor** is how far that interval reaches either way. A candidate must beat
  the reference by more than the noise floor to win.
- With no A/A run, the kit assumes a 1% noise floor.
- With `"noise": { "requireAA": true }`, a missing or failed A/A run makes the verdict
  INCONCLUSIVE.

## Verdicts

The study gets one verdict. Each candidate also gets its own.

| Verdict      | Meaning                                                                                                                                                                            |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WIN          | A candidate cleared the pre-written rule against the reference, beyond the noise. If several did, the one ranked best most often wins.                                             |
| TIE          | The interval sits inside the tie band (the bar or the noise floor, whichever is wider). Choose by the tie-break, otherwise keep the reference. A tie is not a win.                 |
| NO-WIN       | No candidate cleared the rule. The reference stays. A WIN whose secondary metric regressed too far also becomes NO-WIN.                                                            |
| INCONCLUSIVE | The data cannot settle it yet: interval too wide, too many errored samples (over `maxErrorRate`, default 10%), a gate could not be checked, or the A/A check is missing or failed. |
| GATED-OUT    | Per candidate only: it failed a gate and was ruled out.                                                                                                                            |

The reference itself is shown as REFERENCE. If the reference is gated out or blocked,
the study verdict is INCONCLUSIVE. Plain-language wording is covered in
[explanations.md](explanations.md).

## End-to-end flow

Every command prints one JSON object. Exit codes: 0 ok, 1 refused or failed, 2 usage
error, 3 kit bug.

```bash
node bench/kit/cli.mjs selftest            # check the kit works here
# new: write bench/studies/video-engine/study.json and workload/ (via /bench new)
node bench/kit/cli.mjs validate video-engine
node bench/kit/cli.mjs explain video-engine  # read the rule back in plain words
node bench/kit/cli.mjs freeze video-engine
node bench/kit/cli.mjs aa video-engine
node bench/kit/cli.mjs run video-engine --pilot --repeats 3   # sizing only
node bench/kit/cli.mjs run video-engine
node bench/kit/cli.mjs report video-engine
```

1. **new**: there is no `new` CLI command. The `/bench new` playbook interviews you and
   writes `study.json` and the workload.
2. **validate**: checks every field and lists all problems at once.
3. **freeze**: writes `protocol.json`. Any later change makes a new version.
4. **aa**: measures the noise floor.
5. **run**: the full run with the frozen repeats. A `--pilot` run may use fewer repeats
   but is never evidence.
6. **report**: evaluates gates, then the rule, and writes `report.md`, `verdict.json` and
   an entry in `bench/RESULTS.md`.

Other commands: `explain <term | study | study:metric>`, `rate <study> create|import ...`
for blind human ratings, and `list` for every study and its latest verdict. Options that
apply everywhere: `--project DIR` and `--quiet`. Paid candidates also need `--cap-usd`
(and optionally `--cap-tokens`, `--approved-by`, `--approval-ref`) on `aa` and `run`.
Background reading is in [references.md](references.md).
