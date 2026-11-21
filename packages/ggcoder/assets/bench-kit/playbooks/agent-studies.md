# Playbook: agent studies

Read this together with the mode's playbook whenever a candidate uses the `agent` adapter:
comparing coding agents, models, prompts or agent settings on the same tasks.

## Terms of service first

Before the first run, tell the user plainly: driving a provider's agent CLI from scripts
can break that provider's terms when it uses a personal or subscription login (for example a
consumer chat subscription instead of an API key). Recommend API keys under terms that allow
automated use, and let the user decide. This kit never logs in, never reads credentials
itself, and passes API keys to an agent only when the study lists them in `passEnv`.

## Task bundles (the workload)

Each workload item is a folder:

```text
workload/<task>/
  instruction.md   the prompt the agent gets, and nothing else
  task.json        failToPass, passToPass, allowedPaths, canaries, git, testCommand, testFormat
  files/           the starting workspace (copied fresh for every sample)
  oracle/          hidden checks, never copied into the agent's workspace
```

Start from `bench/kit/templates/task.sample/`. Rules:

- `failToPass`: tests that fail before the change and must pass after it. `passToPass`:
  tests that pass before and must still pass. A task listing no tests is invalid.
- Check the task by hand once: the failToPass tests fail on `files/` and the passToPass
  tests pass (copy `files/`, add `oracle/`, run the test command).
- Keep **held-out** tasks: never tune prompts or settings on the tasks used for the verdict.
- `instruction.md` must not mention the hidden tests by name.

## Candidates

```json
{
  "id": "gg-sonnet",
  "paid": true,
  "source": { "version": ["node", "tools/ggcoder/dist/cli.js", "--version"] },
  "adapter": {
    "type": "agent",
    "preset": "ggcoder",
    "bin": ["node", "{project}/tools/ggcoder/dist/cli.js"],
    "provider": "anthropic",
    "model": "<model>",
    "maxTurns": 30,
    "passEnv": ["ANTHROPIC_API_KEY"]
  }
}
```

- Presets: `ggcoder` (`--json`) and `claude` (`-p --output-format stream-json`). Any other
  agent CLI: `"command": [..., "{prompt}"]` with `"format": "text"` (or one of the two JSON
  formats if it speaks them). No preset runs an agent the study did not name.
- `paid` is required on every agent candidate; `source.version` is required so a CLI update
  makes a new protocol version.
- The agent runs inside its sample workspace, so reach project files with `{project}`.
  On Windows, `.cmd` shims (`ggcoder`, `claude`) cannot be started without a shell: point
  `bin` at `node` plus the CLI's script.
- How a run ended comes only from the agent's final event. No final event = errored, never
  finished. Provider errors are errored samples; running out of turns is a finished sample
  that the tests then judge.

## Gates and metrics for agents

```json
"gates": [
  { "id": "hidden-tests", "type": "tests", "severity": "record" },
  { "id": "honest", "type": "honesty", "evidence": "tests-gate", "testsGate": "hidden-tests" },
  { "id": "in-scope", "type": "scope" },
  { "id": "no-damage", "type": "side-effects" }
],
"metrics": [
  { "id": "resolved", "type": "custom", "source": "gate", "gate": "hidden-tests", "better": "higher" },
  { "id": "tokens", "type": "tokens-cost", "measure": "total-tokens", "better": "lower" },
  { "id": "cost", "type": "tokens-cost", "measure": "cost", "costSource": "reported-else-estimated", "better": "lower" }
]
```

- `tests` with `"severity": "record"`: whether a task was resolved is the outcome being
  compared (resolve rate), not a disqualification.
- `honesty`: claiming the tests passed when the hidden tests failed rules the agent out.
- `scope`: changes outside `allowedPaths` rule it out. `side-effects`: touched canaries,
  rewritten git history, or writes outside the sandbox (the task bundle and any `watch`
  paths) rule it out.
- Decide on `resolved` with `"scale": "difference"`, `"statistic": "mean"` and a
  `minDifference` such as 0.1 (10 points of resolve rate).

## Cost

- Reported cost is what the agent CLI said; estimated cost is tokens × a price from
  `.gg/bench.config.json` `prices` (with `source` and `asOf`). The kit never guesses a price;
  ask the user for the pricing page and date if an estimate is needed.
- Every paid study needs `budget.perSampleWorstCase.usd`, and every paid run needs a cap
  approved through `ask_user` (see `run.md`).

## Isolation

The default process sandbox gives each sample a fresh workspace, a scrubbed environment and
a hard timeout. It guards against accidents, not against a hostile agent. Agents cannot run
in the docker sandbox in this kit version; say so if the user needs stronger isolation.
