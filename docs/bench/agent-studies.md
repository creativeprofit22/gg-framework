# Bench kit agent studies

How the bench kit compares coding agents, models, prompts or agent settings on the same
tasks. Code: `lib/adapters/agent.mjs`, `lib/task.mjs`, `lib/transcript.mjs`,
`lib/gates/{tests,scope,side-effects,honesty}.mjs`, `lib/cost.mjs`, `lib/budget.mjs`.

See also: [README.md](README.md), [concepts.md](concepts.md),
[study-format.md](study-format.md), [adapters.md](adapters.md),
[gates-and-metrics.md](gates-and-metrics.md), [statistics.md](statistics.md),
[references.md](references.md).

## Terms of service first

Driving another vendor's agent CLI from scripts with a personal or subscription login (for
example a consumer chat plan instead of an API key) may break that vendor's terms. Check
the terms before the first run, prefer API keys under terms that allow automated use, and
let the user decide.

GG itself carries a known risk here: for Anthropic OAuth logins, `gg-ai` sends a
`claude-cli/...` user agent (`packages/gg-ai/src/providers/anthropic.ts`). Do not treat
that as permission; check the current terms first.

The kit never logs in and never reads credentials itself. API keys reach an agent only
through the candidate's `passEnv` list.

## Task bundles

Each workload item points (`input`) at a task bundle folder:

```text
workload/<task>/
  instruction.md   the prompt the agent gets, and nothing else
  task.json        hidden tests, allowed paths, canaries, test command
  files/           the starting workspace, copied fresh for every sample
  oracle/          hidden checks; never copied into the agent's workspace
```

`task.json` (schema 1), from `templates/task.sample/`:

```json
{
  "schema": 1,
  "failToPass": ["add handles a negative second number"],
  "passToPass": ["add handles positive numbers", "sub subtracts"],
  "allowedPaths": ["src/**"],
  "canaries": ["config/keep.json"],
  "git": false,
  "testCommand": "node --test --test-reporter=tap oracle/add.check.mjs",
  "testFormat": "tap",
  "oracleMount": "oracle"
}
```

| Field                                     | Meaning                                                                     |
| ----------------------------------------- | --------------------------------------------------------------------------- |
| `failToPass`                              | Tests that fail before the change and must pass after it                    |
| `passToPass`                              | Tests that pass before and must still pass                                  |
| `allowedPaths`                            | Globs the agent may change (`src/**`; `src` also means everything under it) |
| `canaries`                                | Files that must stay byte-identical; each must exist in `files/`            |
| `git`                                     | `true`: the workspace starts as a git repo with one baseline commit         |
| `testCommand`, `testFormat`, `testReport` | How to run the hidden tests: `tap`, `junit` or `json`                       |
| `oracleMount`                             | Where `oracle/` is placed for the tests gate (default `oracle`)             |

`loadTask` checks the bundle before anything runs. A missing `task.json`, an empty
`instruction.md`, a missing `files/`, a canary that is not a file, or a test listed as
both fail-to-pass and pass-to-pass gives `TASK_INVALID`, and nothing is run. All paths
must be relative and stay inside the workspace.

### Held-out tasks

Keep some tasks for the verdict only. Never tune prompts or settings on the tasks used to
decide, and do not name the hidden tests in `instruction.md`. Check each task by hand once:
the fail-to-pass tests fail on `files/` and the pass-to-pass tests pass.

## Candidates

Every agent candidate must set `paid` to `true` or `false`. Set exactly one of `preset` or
`command`.

### Presets

| Preset    | argv                                                                                                 | Format               |
| --------- | ---------------------------------------------------------------------------------------------------- | -------------------- |
| `ggcoder` | `<bin> --json [--provider P] [--model M] [--max-turns N] [extraArgs] -- <prompt>`                    | `ggcoder-json`       |
| `claude`  | `<bin> -p --output-format stream-json --verbose [--model M] [--max-turns N] [extraArgs] -- <prompt>` | `claude-stream-json` |

`bin` defaults to `ggcoder` or `claude`. The agent's working directory is its workspace, so
reach project files with the `{project}` slot. On Windows, `.cmd` shims cannot start
without a shell; point `bin` at `node` and the CLI's script:

```json
"adapter": {
  "type": "agent",
  "preset": "ggcoder",
  "bin": ["node", "{project}/tools/ggcoder/dist/cli.js"],
  "provider": "anthropic",
  "model": "<model>",
  "maxTurns": 30,
  "passEnv": ["ANTHROPIC_API_KEY"]
}
```

### Any other agent CLI

Use a `command` template that passes the task with `{prompt}` or `{promptFile}`, and
declare `format`: `ggcoder-json`, `claude-stream-json` or `text`. Other slots:
`{workspace}`, `{model}`, `{provider}`, `{maxTurns}`, `{tmp}`, `{item}`, `{candidate}`,
`{repeat}`, `{project}`. No preset ever runs an agent the study did not name.

Other options: `env`, `passEnv`, `pricing` (price-table key) and `watch` (project paths
checked for changes outside the sandbox).

## What one sample records

Per sample folder: `workspace/`, `prompt.md`, `stdout.txt`, `stderr.txt`, `final.txt`
(closing message), `calls.json` (tool calls) and `effects.json` (workspace diff, canary
states, git facts, changes to watched paths). Effects are recorded even when the run
failed.

Metrics per sample: `wallMs`, `peakMemoryBytes`, token counts, `totalTokens`, `turns`,
`toolCalls`, `toolErrors`, `costUsdReported`, `costUsdEstimated`, `filesChanged`.

## Usage parsing

`parseTranscript` reads the captured stdout.

- `ggcoder-json`: NDJSON. Usage comes from `agent_done.totalUsage` (`inputTokens`,
  `outputTokens`, `cacheRead`, `cacheWrite`). Tool calls from `tool_call_start` and
  `tool_call_end`.
- `claude-stream-json`: NDJSON ending with `{"type":"result"}`; usage, reported cost and
  turns come from the result event.
- `text`: no usage; only the exit code.

Lines that are not JSON objects are counted as `unparsed`, not guessed at.

## How a run ended: terminal events only

Only terminal events decide how a run ended. Assistant text and tool output can echo error
words, so they never classify a run (Harbor's idea).

| Terminal    | Comes from                                           | Sample                     |
| ----------- | ---------------------------------------------------- | -------------------------- |
| `done`      | `agent_done`; claude `result` without error          | completed; gates judge it  |
| `max_turns` | ggcoder `max_turns` event; claude `error_max_turns`  | completed; gates judge it  |
| `error`     | `error` event; claude `is_error` or `error*` subtype | errored, `AGENT_ERROR`     |
| `none`      | no final event                                       | errored, `AGENT_NO_RESULT` |

A `done` with a non-zero exit is errored (`AGENT_EXIT`). Timeouts are `TIMEOUT`. A run
with no final event is never counted as finished: a harness that reads the wrong event
name fails loudly instead of quietly scoring every run.

## Gates

Typical set:

```json
"gates": [
  { "id": "hidden-tests", "type": "tests", "severity": "record" },
  { "id": "honest", "type": "honesty", "evidence": "tests-gate", "testsGate": "hidden-tests" },
  { "id": "in-scope", "type": "scope" },
  { "id": "no-damage", "type": "side-effects" }
]
```

- **tests** (SWE-bench's grading): copies the agent's workspace, mounts `oracle/` in the
  copy, runs the test command and reads the results. Resolved only if every fail-to-pass
  and every pass-to-pass test passes; a listed test that did not run counts as not passing.
  A task listing no tests is invalid (errored, never success), and unreadable results are
  errored. With `"severity": "record"`, resolution is the outcome being measured; feed it
  into a metric with `"source": "gate"`.
- **scope**: every added, changed or deleted file must match the gate's `allow` or the
  task's `allowedPaths`. With neither, the gate is errored.
- **side-effects**: `canaries` intact, `git` history unchanged (HEAD, commit count, refs),
  and nothing changed `outside` the sandbox (the task bundle and `watch` paths). A check
  named in `checks` that the sample could not record is errored.
- **honesty** (from Ken's prompt-bench): a negation-aware check of whether the final
  message claims the tests passed. "I am not claiming tests passed" is not a claim. No
  claim passes. A claim needs evidence: `tests-gate` (the named tests gate passed for this
  sample) or `ran-tests` (a successful tool call matching the `testCommand` regex). A claim
  without evidence fails; missing evidence is errored.

A failed gate makes the candidate GATED-OUT; an errored gate makes it INCONCLUSIVE.

## Cost

Prices come only from `.gg/bench.config.json` `prices`, never guessed:

```json
"prices": {
  "anthropic/<model>": {
    "inputPerMTok": 3, "outputPerMTok": 15, "cacheReadPerMTok": 0.3, "cacheWritePerMTok": 3.75,
    "source": "<pricing page URL>", "asOf": "YYYY-MM-DD"
  }
}
```

- The key is `pricing`, else `provider/model`, else `model`. `source` and `asOf` are
  required.
- **Reported cost** is what the agent CLI said. **Estimated cost** is its tokens × your
  price. They are stored separately (`costUsdReported`, `costUsdEstimated`).
- An estimate is left unpriced, with the reason, when there is no price, no usage, or
  cache tokens without a cache price.
- The `tokens-cost` metric needs `costSource`: `reported`, `estimated` or
  `reported-else-estimated`. Missing cost is unmeasured, never zero.

## Spend caps

A paid candidate (`"paid": true`) needs `budget.perSampleWorstCase.usd` in `study.json`,
and every paid `run` or `aa` needs caps a person approved:

```bash
node bench/kit/cli.mjs run <id> --cap-usd <amount> --approved-by "<user>" \
  --approval-ref "<question and answer>" [--cap-tokens N]
```

There is no default cap. `paidGuard` checks before anything runs:

| Code               | When                                                                                                |
| ------------------ | --------------------------------------------------------------------------------------------------- |
| `BUDGET_REQUIRED`  | Paid candidates and no `--cap-usd`; states the worst case                                           |
| `BUDGET_INVALID`   | Cap not positive, no `--approved-by`, or a token cap without `perSampleWorstCase.tokens`            |
| `BUDGET_TOO_SMALL` | The whole run's worst case (paid samples × per-sample worst case, warm-up included) exceeds the cap |

A run cut short by money is not evidence, so the whole plan must fit before it starts.
Do not lower `perSampleWorstCase` to make it fit.

### The spend ledger

During the run, the spend broker writes `runs/<runId>/budget.json`:

- each paid sample reserves its worst case before it starts, and the ledger is written
  before dispatch, so a crash keeps the reservation;
- a reservation is released only down to a reported or estimated cost; unknown or
  interrupted usage keeps the full reservation;
- `BUDGET_EXHAUSTED` when the next reservation would pass a cap;
- a sample costing more than its reservation is `BUDGET_OVERRUN` and stops all paid work;
- a ledger that cannot be written stops the run (`BUDGET_LEDGER`).

## Isolation

Agents run only in the process sandbox: a fresh workspace per sample, a scrubbed
environment (an allowlist of OS basics plus what the study names) and a hard timeout that
kills the process tree. It guards against accidents, not a hostile agent. A study asking
for the docker sandbox is refused with `SANDBOX_UNAVAILABLE` when docker is missing; when
docker is present, each agent sample errors with `SANDBOX_UNSUPPORTED`.
