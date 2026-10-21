# Gates and metrics

Gates decide whether a candidate is allowed into the comparison. Metrics are
the numbers that are compared. Both are declared in `study.json` (`gates` and
`metrics`) and checked against completed, measured samples only. Warm-up and
errored samples are skipped.

See [concepts.md](concepts.md) for the overall flow,
[study-format.md](study-format.md) for the whole file,
[statistics.md](statistics.md) for how metric values are compared and
[explanations.md](explanations.md) for how verdicts are worded.

## Gates

### Results

Every gate check returns one of three statuses, with a reason:

| Status    | Meaning                                                    |
| --------- | ---------------------------------------------------------- |
| `pass`    | The condition was checked and holds.                       |
| `fail`    | The condition was checked and does not hold.               |
| `errored` | The condition could not be checked. Never counted as pass. |

A gate that crashes, times out, or whose type is not in this kit version is
`errored`. Per candidate, any failure makes the summary `fail` (GATED-OUT).
Errors with no failures make it `errored` (INCONCLUSIVE). If a sample-scope
gate had no completed samples, it is listed under `notRun`; when nothing at
all was checked the summary is `not-run`.

### Shared fields

| Field                  | Meaning                                                                        |
| ---------------------- | ------------------------------------------------------------------------------ |
| `id`                   | Unique id: letters, digits, `.`, `_`, `-`, up to 64.                           |
| `type`                 | One of the types below.                                                        |
| `scope`                | `sample` (default) or `candidate`.                                             |
| `severity`             | `disqualify` (default) or `record`.                                            |
| `appliesTo`            | Candidate ids this gate applies to. Default: all.                              |
| `samples`              | `all` (default) or `first`: only the first sample per item. Sample scope only. |
| `label`, `description` | Free text.                                                                     |

Unknown fields are rejected, because a typo would silently weaken a gate.

**Scope.** A `sample` gate runs once per completed measured sample. A
`candidate` gate runs once per candidate, with no sample output (for example
a licence or platform check). Use `"samples": "first"` for expensive checks
such as VMAF; the report says so.

**Severity.** A `disqualify` gate rules the candidate out when it fails. A
`record` gate is checked and kept, and its value can feed a metric, but it
never rules a candidate out. Whether an agent resolved a task is the outcome
being measured, so `tests` is usually `record`.

### Command slots

Gates that run a command (`command`, `quality`) use these slots. Commands run
without a shell, with a scrubbed environment, from the project root, with a
default timeout of 120000 ms.

| Scope  | Slots                                                                                       |
| ------ | ------------------------------------------------------------------------------------------- |
| both   | `{candidate}` `{project}` `{study}` `{workload}` `{report}`                                 |
| sample | also `{out}` `{outDir}` `{input}` `{expected}` `{item}` `{repeat}` `{sampleDir}` `{stdout}` |

`{report}` is a fresh file path the tool may write its result to. `{input}`
and `{expected}` point at the frozen workload, not the sample copy.

### Gate catalogue

| Type           | Scope             | Fields                                                                                                                                 | Passes when                                                                                                                                                                |
| -------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `exit-code`    | sample            | `expect` (integer or array, default `0`)                                                                                               | The exit code is expected. Killed by a signal: fail. Adapter reports no exit code: errored.                                                                                |
| `equals`       | sample            | `source` (`output`\|`stdout`, default `output`), `mode` (`text`\|`bytes`\|`json`, default `text`), `expected`, `trim` (default `true`) | Output equals the inline `expected` or the item's `expectedFile`. Text mode unifies line endings. JSON mode compares canonical JSON. Neither expected value: errored.      |
| `tolerance`    | sample            | `source` (`metric`\|`stdout-json`\|`output-json`), `field`, `target`, `expectedField`, `abs`, `rel`                                    | Each number is within `abs` or within `rel` × target. Target comes from `target`, else the `expectedFile` JSON. At least one of `abs`, `rel` is required.                  |
| `schema`       | sample            | `source`, exactly one of `schema` (inline) or `schemaFile` (inside the study folder)                                                   | JSON output matches the schema. Only a documented subset of JSON Schema keywords is accepted; others are refused at validation time.                                       |
| `command`      | sample, candidate | `command`, `timeoutMs`, `passEnv`                                                                                                      | The script prints `{"pass": true\|false, "value"?, "reason"?}` (last JSON line counts) and exits 0. No JSON, or pass with a non-zero exit: errored.                        |
| `quality`      | sample, candidate | `command`, `format`, `field`, `pattern`, `min`, `max`, `timeoutMs`, `passEnv`                                                          | A tool's score clears `min` and/or `max`. Non-zero exit or unreadable score: errored.                                                                                      |
| `tests`        | sample            | `command`, `format`, `reportFile`, `timeoutMs`, `passEnv`                                                                              | Agent only. Every fail-to-pass and pass-to-pass test in the task passes. Runs on a copy of the workspace with `oracle/` added. Slots `{workspace}` `{oracle}` `{project}`. |
| `scope`        | sample            | `allow` (globs, else task `allowedPaths`)                                                                                              | Agent only. Every changed file is inside the allowed paths. No allowed paths: errored.                                                                                     |
| `side-effects` | sample            | `checks` (`canaries`, `git`, `outside`; default all recorded)                                                                          | Agent only. Canaries intact, git history unchanged, nothing watched outside the sandbox changed. A named check with no data: errored.                                      |
| `honesty`      | sample            | `evidence` (`tests-gate`\|`ran-tests`), `testsGate`, `testCommand`                                                                     | Agent only. No claim that tests passed, or a claim backed by the evidence. `testsGate` must name a `tests` gate listed earlier.                                            |

The schema subset: `$schema`, `title`, `description`, `type`, `enum`,
`const`, `required`, `properties`, `additionalProperties`, `items`,
`minItems`, `maxItems`, `minLength`, `maxLength`, `pattern`, `minimum`,
`maximum`, `exclusiveMinimum`, `exclusiveMaximum`.

The agent gates are covered in more depth in
[agent-studies.md](agent-studies.md).

### Quality output formats

The `quality` gate never guesses how to read a tool. `format` is required. If
the tool wrote `{report}`, that file is parsed; otherwise its stdout.

| `format`     | Reads                                                                      |
| ------------ | -------------------------------------------------------------------------- |
| `vmaf-json`  | libvmaf JSON: `pooled_metrics.vmaf.mean`, or older `aggregate.VMAF_score`. |
| `json-field` | The number at dotted path `field`, for example `score.mean`.               |
| `number`     | The last output line that is a plain number.                               |
| `regex`      | The first capture group of `pattern`.                                      |

```json
{
  "id": "vmaf-vs-reference",
  "type": "quality",
  "scope": "sample",
  "samples": "first",
  "command": "node scripts/vmaf.mjs --reference {expected} --distorted {out}",
  "format": "vmaf-json",
  "min": 93
}
```

The score is kept as the check's value, so a `custom` metric with
`"source": "gate"` can report it.

### Why there is no LLM-judge gate

A gate must give the same answer for the same output and must be able to say
"could not check". An LLM judge does neither reliably. The study validator
rejects any gate with a `judge` field or a type containing "judge", with the
message that LLM judges cannot gate a study. For subjective quality, use blind
human ratings (the `rating` metric) instead.

## Metrics

### Shared fields

| Field                             | Meaning                                         |
| --------------------------------- | ----------------------------------------------- |
| `id`                              | Unique id, same rules as gates.                 |
| `type`                            | One of the types below.                         |
| `unit`                            | Display and conversion unit. Defaults per type. |
| `better`                          | `lower` or `higher`.                            |
| `label`, `description`, `explain` | Free text.                                      |

Units: time `ns`, `us`, `ms`, `s`, `min`. Bytes `B`, `KB`, `MB`, `GB`
(decimal) and `KiB`, `MiB`, `GiB` (binary).

**Unmeasured is not zero.** When a sample has no value, the metric records it
as unmeasured with a reason (for example "this adapter does not measure CPU
time"). The report lists the count and reasons per candidate.

**Labels.** Each value can carry a label saying how it was measured. Peak
memory from polling is labelled "sampled, 50 ms resolution, direct process
only": a spike between polls can be missed and child processes are not
watched. The `function` adapter's peak is labelled as an exact peak of the
worker, including the Node runtime. On Windows the poller takes a moment to
start, so very short processes may come back unmeasured.

### Metric catalogue

| Type          | Fields                                                       | Default unit     | Value                                                                                                                                                      |
| ------------- | ------------------------------------------------------------ | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `wall-time`   | `field` (`wallMs`\|`wallMsMean`\|`ttfbMs`, default `wallMs`) | `ms`             | Elapsed time as the adapter measured it: spawn to exit, request to last byte, or median per call.                                                          |
| `cpu-time`    | none                                                         | `ms`             | User + system CPU per call. Only the `function` adapter measures it.                                                                                       |
| `peak-memory` | none                                                         | `B`              | Highest memory seen, with the adapter's label.                                                                                                             |
| `output-size` | none                                                         | `B`              | Total bytes written to the output file or folder.                                                                                                          |
| `tokens-cost` | `measure`, `costSource`                                      | `tokens` / `USD` | Token counts the agent reported, or cost. Units `tokens`, `ktok`, `Mtok`, or `USD`, `cents`.                                                               |
| `custom`      | `source`, `field`, `pattern`, `gate`, `scale`                | none             | A number from `metric` (a raw adapter metric), `stdout-json`, `output-json`, `stdout-regex`, or `gate` (a gate's value). Multiplied by `scale` (non-zero). |
| `rating`      | `packs` (rating pack ids)                                    | none             | Blind human scores loaded by `rate import`. Always unmeasured per sample.                                                                                  |

`tokens-cost` `measure` is one of `input-tokens`, `output-tokens`,
`cache-read-tokens`, `cache-write-tokens`, `total-tokens` or `cost`. For
`cost`, `costSource` is required: `reported` (the agent CLI's figure),
`estimated` (tokens × a price from `.gg/bench.config.json` `prices`) or
`reported-else-estimated`. The two sources are never mixed silently.

```json
"metrics": [
  { "id": "export_seconds", "type": "wall-time", "unit": "s", "better": "lower" },
  { "id": "decode_fps", "type": "custom", "unit": "fps", "better": "higher",
    "source": "stdout-json", "field": "decodeFps" },
  { "id": "peak_memory_mb", "type": "peak-memory", "unit": "MB", "better": "lower" }
]
```

## How to add a gate

1. Write `lib/gates/<name>.mjs` exporting:
   - `validate(g) -> string[]`. Start with `unknownKeys(g, [own fields])`
     from `common.mjs`. Reject a scope the gate cannot honour.
   - `async check(ctx) -> GateResult`. `ctx` is the `GateContext` typedef in
     `common.mjs`: `gate`, `candidate`, `sample` (sample scope), `item`,
     `studyDir`, `projectDir`, `workloadDir`, `workDir`, `env`, `signal`, and
     `earlier` (this candidate's previous checks).
2. Return `pass(reason)`, `failed(reason)` or `errored(reason)`, optionally
   with `withValue(result, number)`. If anything needed is missing, return
   `errored`, never `pass`.
3. To run a tool, use `runGateCommand` (no shell, scrubbed env, timeout) and
   `validateGateCommand` for its slots.
4. Register it in `GATES` in `lib/gates/index.mjs` and add the type to
   `GATE_TYPES` in `lib/study.mjs`.
5. Add tests to `packages/ggcoder/scripts/bench-kit/gates.test.mjs`: each
   status, and the validation messages.

## How to add a metric

1. Write `lib/metrics/<name>.mjs` exporting:
   - `validate(m) -> string[]`, starting with `unknownKeys(m, [own fields])`
     and `validateUnit` if it has units.
   - `async extract(sample, m, ctx) -> Extracted`. `ctx` holds `studyDir` and
     `gateValues` (gate values per sample, keyed by `gateValueKey`).
2. Return `measured(value, label?)` or `unmeasured(reason)`. Use `fromRaw`
   to read and convert a raw adapter metric. Never return `0` for a missing
   value.
3. Register it in `METRICS` in `lib/metrics/index.mjs` (and `DEFAULT_UNITS`
   if it has a default unit), and add the type to `METRIC_TYPES` in
   `lib/study.mjs`.
4. Add tests to `packages/ggcoder/scripts/bench-kit/metrics.test.mjs`.
