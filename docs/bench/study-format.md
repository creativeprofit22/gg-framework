# Study format

Reference for the files of one study. Ideas are explained in [concepts.md](concepts.md).
Gate and metric options are in [gates-and-metrics.md](gates-and-metrics.md); adapter
options are in [adapters.md](adapters.md).

## On-disk layout

```text
bench/
  kit/                      vendored kit (cli.mjs, lib/, playbooks/, templates/)
  RESULTS.md                verdict ledger, one entry per study and protocol version
  glossary.json             project terms for `explain`
  studies/<id>/
    study.json              the study (this page)
    workload/               frozen inputs and expected outputs
    protocol.json           frozen fingerprint, one entry per version
    runs/<runId>/           run.json, environment.json, samples.jsonl, errors.jsonl
    ratings/                blind rating packs and imported scores
    report.md               written by `report`
    verdict.json            written by `report`
.gg/bench.config.json       optional: service URLs and prices
```

The folder name must equal the study `id`, or the kit refuses with `STUDY_ID_MISMATCH`.
Default run ids look like `full-2026-10-20T03-15-00-000Z` (kind plus timestamp); a custom
`--run-id` may use letters, digits, `.`, `_` and `-` (up to 80 characters).

## study.json

The file must be valid JSON with LF line endings. A CR byte is refused with `STUDY_CRLF`,
because the bytes are hashed. The validator reports every problem at once, each naming
its field (for example `candidates[1].adapter.type: ...`), under `STUDY_INVALID`.

Ids (study, candidate, item, metric, gate) are 1 to 64 characters: letters, digits, `.`,
`_` or `-`, starting with a letter or digit. Ids must be unique within their list.

### Top-level fields

| Field           | Type    | Required | Default  | Meaning                                                                                                                              |
| --------------- | ------- | -------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `schema`        | number  | yes      |          | Must be `1`.                                                                                                                         |
| `id`            | string  | yes      |          | Study id; matches the folder name.                                                                                                   |
| `title`         | string  | yes      |          | Non-empty short title.                                                                                                               |
| `question`      | string  | yes      |          | Non-empty question being decided.                                                                                                    |
| `kind`          | string  | no       |          | `code`, `library`, `engine`, `cli`, `service`, `agent` or `other`.                                                                   |
| `repeats`       | integer | yes      |          | Measured repeats per candidate and item; at least 2.                                                                                 |
| `warmupRepeats` | integer | no       | `0`      | Warm-up rounds, recorded but not measured; at least 0.                                                                               |
| `seed`          | integer | yes      |          | 0 to 4294967295; seeds ordering and resampling.                                                                                      |
| `timeoutMs`     | integer | no       | `600000` | Per-sample time limit; positive.                                                                                                     |
| `maxErrorRate`  | number  | no       | `0.1`    | 0 to 1; a candidate above it is INCONCLUSIVE.                                                                                        |
| `candidates`    | array   | yes      |          | At least 2.                                                                                                                          |
| `workload`      | object  | yes      |          | Inputs.                                                                                                                              |
| `metrics`       | array   | yes      |          | At least 1.                                                                                                                          |
| `gates`         | array   | no       | none     | Yes/no checks.                                                                                                                       |
| `decision`      | object  | yes      |          | The pre-registered rule.                                                                                                             |
| `sandbox`       | object  | no       |          | `{ "type": "process" }` or `{ "type": "docker", "image", "network"?, "memory"?, "pids"?, "cpus"? }`; see [adapters.md](adapters.md). |
| `budget`        | object  | if paid  |          | `perSampleWorstCase.usd` (number above 0) is required when any candidate has `paid: true`.                                           |
| `unmeasured`    | array   | no       |          | `{ what, how }` items; `what` must be a string, `how` a string if given.                                                             |

### candidates[]

| Field       | Type    | Required         | Meaning                                                                                           |
| ----------- | ------- | ---------------- | ------------------------------------------------------------------------------------------------- |
| `id`        | string  | yes              | Candidate id.                                                                                     |
| `label`     | string  | no               | Display name in reports.                                                                          |
| `adapter`   | object  | yes              | `type` is `function`, `cli`, `http`, `agent` or `manual`; other keys are checked by that adapter. |
| `paid`      | boolean | agent: yes       | Costs money per run; needs spend caps.                                                            |
| `synthetic` | boolean | no               | A stand-in; labelled in every report.                                                             |
| `source`    | object  | agent: `version` | Provenance, see below.                                                                            |

`source` accepts only these keys:

| Key          | Type     | Meaning                                                    |
| ------------ | -------- | ---------------------------------------------------------- |
| `worktree`   | string   | Git worktree path, relative to the project root.           |
| `commit`     | string   | 7 to 40 hex characters; needs `worktree`.                  |
| `allowDirty` | boolean  | Allow uncommitted changes; needs `worktree`.               |
| `files`      | string[] | Relative paths (no `..`) whose hashes are recorded.        |
| `version`    | string   | Command whose output is recorded, e.g. `claude --version`. |

### workload

| Field                  | Type   | Required | Default    | Meaning                                                 |
| ---------------------- | ------ | -------- | ---------- | ------------------------------------------------------- |
| `dir`                  | string | no       | `workload` | Relative folder inside the study.                       |
| `items`                | array  | yes      |            | At least 1.                                             |
| `items[].id`           | string | yes      |            | Item id.                                                |
| `items[].input`        | string | no       |            | Relative path (file, or folder for agent task bundles). |
| `items[].expectedFile` | string | no       |            | Relative path to the expected output.                   |

Paths must be relative and must not contain `..`. At freeze time every named path must
exist, or the kit refuses with `WORKLOAD_MISSING`. Agent studies need `input` on every
item, pointing at a task bundle (`TASK_INVALID` otherwise).

### metrics[]

| Field                | Type   | Required | Meaning                                                                                     |
| -------------------- | ------ | -------- | ------------------------------------------------------------------------------------------- |
| `id`                 | string | yes      | Metric id.                                                                                  |
| `type`               | string | yes      | `wall-time`, `cpu-time`, `peak-memory`, `output-size`, `tokens-cost`, `custom` or `rating`. |
| `better`             | string | no       | `lower` or `higher`.                                                                        |
| `unit`, `label`, ... |        | no       | Further keys are checked by the metric type.                                                |

### gates[]

| Field       | Type     | Required | Default      | Meaning                                                                                                            |
| ----------- | -------- | -------- | ------------ | ------------------------------------------------------------------------------------------------------------------ |
| `id`        | string   | yes      |              | Gate id.                                                                                                           |
| `type`      | string   | yes      |              | `exit-code`, `equals`, `tolerance`, `schema`, `command`, `quality`, `tests`, `scope`, `side-effects` or `honesty`. |
| `scope`     | string   | no       | `sample`     | `sample` (each sample) or `candidate` (once per candidate).                                                        |
| `severity`  | string   | no       | `disqualify` | `disqualify` rules out on failure; `record` only records.                                                          |
| `appliesTo` | string[] | no       | all          | Candidate ids this gate covers.                                                                                    |
| `testsGate` | string   | no       |              | Names a `tests` gate listed earlier.                                                                               |
| `samples`   | string   | no       | `all`        | `all` or `first` (first sample per item); sample scope only.                                                       |
| `judge`     |          | never    |              | Any gate with `judge`, or a type containing "judge", is rejected.                                                  |

Command gates time out after 120000 ms unless their own `timeoutMs` says otherwise.

## The decision block

| Field                              | Type     | Required         | Default                         | Meaning                                                                               |
| ---------------------------------- | -------- | ---------------- | ------------------------------- | ------------------------------------------------------------------------------------- |
| `reference`                        | string   | yes              |                                 | A candidate id; kept unless another wins.                                             |
| `level`                            | number   | no               | `0.95`                          | Confidence level, above 0.5 and below 1. Bonferroni-adjusted for several comparisons. |
| `primary.metric`                   | string   | yes              |                                 | A metric id.                                                                          |
| `primary.better`                   | string   | no               | metric's `better`, else `lower` | `lower` or `higher`.                                                                  |
| `primary.scale`                    | string   | no               | `ratio`                         | `ratio` or `difference`.                                                              |
| `primary.statistic`                | string   | no               | `median`                        | `median`, `mean`, `min`, `max`, `p90`, `p95` or `p99`.                                |
| `primary.minRatio`                 | number   | ratio scale      |                                 | At least 1; `1.3` means 30% better.                                                   |
| `primary.minDifference`            | number   | difference scale |                                 | At least 0.                                                                           |
| `primary.ciLowerAbove`             | number   | no               | 1 (ratio), 0 (difference)       | Lower interval end must exceed this.                                                  |
| `secondary[].metric`               | string   | yes per entry    |                                 | A metric id.                                                                          |
| `secondary[].mustNotRegressBeyond` | number   | no               |                                 | At least 1; `1.1` allows 10% worse.                                                   |
| `secondary[].better`, `.statistic` | string   | no               | metric's / `median`             | `lower`/`higher`; same statistics as `primary.statistic`.                             |
| `tieBreak`                         | string[] | no               | `[]`                            | Plain-language tie-breakers, in order.                                                |
| `noise.requireAA`                  | boolean  | no               |                                 | A missing or failed A/A run makes the verdict INCONCLUSIVE.                           |
| `resamples`                        | number   | no               | `10000`                         | Bootstrap resamples; a whole number from 1000 to 1000000.                             |

Secondary metrics are always compared on the ratio scale.

## protocol.json

`freeze` writes `protocol.json` (written atomically):

```json
{
  "schema": 1,
  "studyId": "video-engine",
  "current": 1,
  "versions": [{ "version": 1, "digest": "...", "frozenAt": "...", "...": "..." }]
}
```

Each version holds a fingerprint plus `version`, `digest`, `frozenAt` and `environment`.

| Fingerprint field | What it is                                                              |
| ----------------- | ----------------------------------------------------------------------- |
| `studyId`         | The study id.                                                           |
| `studyHash`       | SHA-256 of the raw `study.json` bytes.                                  |
| `workloadHash`    | SHA-256 over the sorted `path<TAB>sha256` lines of every workload file. |
| `workloadFiles`   | Number of workload files.                                               |
| `kitHash`         | Same tree hash over `bench/kit/`, skipping `node_modules` and `*.log`.  |
| `seed`            | The study seed.                                                         |
| `candidates`      | Provenance facts per candidate id (or `null`).                          |

`digest` is the SHA-256 of the fingerprint as canonical JSON (keys sorted). The
`environment` (Node version, OS, CPU, memory) is recorded but not part of the digest.

Text files in the workload and kit (`.json`, `.md`, `.txt`, `.csv`, `.js`, `.mjs`, `.py`,
`.sh`, `.srt` and similar) must use LF. Any CR byte stops the freeze with `HASH_CRLF`.
Binary files are hashed as they are.

## Versioning

- First `freeze` writes version 1 (`status: "created"`).
- `freeze` with nothing changed returns the current version (`status: "unchanged"`).
- Any change to `study.json`, the workload, the kit, the seed or candidate provenance
  appends a new version (`status: "new-version"`) and lists what changed in `changed`.
- `run`, `aa` and `report` re-check the fingerprint first. Drift is refused with
  `PROTOCOL_DRIFT`; with no protocol yet, `PROTOCOL_NOT_FROZEN`.
- Results are never pooled across versions. `report` uses only full runs whose digest
  matches the current version. Older runs give `NO_RUNS` or `PROTOCOL_STALE`, and mixed
  runs give `POOL_MIXED`.
- Pilot and A/A runs are never evidence for a verdict (`RUN_KIND`).
- So editing the decision rule after results exist starts a new version; old results stay
  on disk but do not count.

## Git: tracked and ignored

| Path                                           | Git    |
| ---------------------------------------------- | ------ |
| `bench/kit/`                                   | track  |
| `bench/studies/<id>/study.json`                | track  |
| `bench/studies/<id>/workload/`                 | track  |
| `bench/studies/<id>/protocol.json`             | track  |
| `bench/studies/<id>/report.md`, `verdict.json` | track  |
| `bench/RESULTS.md`                             | track  |
| `bench/studies/<id>/runs/`                     | ignore |

`RESULTS.md` entries sit between `<!-- bench:start <id> v<version> -->` and
`<!-- bench:end -->` markers. A re-report replaces only its own entry; your notes outside
the markers are kept. A CRLF `RESULTS.md` is refused with `LEDGER_CRLF`.
