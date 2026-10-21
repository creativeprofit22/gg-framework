# Bench kit: compare candidates and get a verdict you can defend

The bench kit compares 2 or more candidates for any decision. A candidate can
be a code approach, a library, an engine, a CLI tool, a service, or a coding
agent with its prompt. The answer is a verdict worded in plain language:
**WIN**, **TIE**, **NO-WIN** or **INCONCLUSIVE**, and **GATED-OUT** for each
candidate that fails a must-have check.

The method:

1. Write the question and the decision rule down before measuring.
2. Freeze the workload (inputs are hashed, and any later edit is a new version).
3. Gates come before metrics. A candidate that fails a must-have check is
   ruled out before any of its numbers are compared, so a wrong candidate
   never wins on speed. (Gates are evaluated at `report` time from the
   recorded samples; this kit version does not skip measuring a candidate
   that will later fail a gate.)
4. Repeat runs, measure a same-vs-same (A/A) noise floor, and compute
   confidence intervals.
5. Grade with deterministic checks. An LLM judge is never a gate.
6. Record the verdict in a ledger (`bench/RESULTS.md`).

The agent orchestrates and explains. The kit's CLI does all counting and
statistics, so no number in a report is worked out by hand.

## Getting started

1. Install the global command and kit once:
   `pnpm commands:install:setup-bench`. This writes
   `~/.gg/commands/setup-bench.md` and a versioned kit under
   `~/.gg/bench-kit/`, with `current.json` pointing at it.
2. In a project, run `/setup-bench`. It vendors the kit into `bench/kit/`,
   writes `.gg/bench.config.json` and the project's `/bench` command, asks
   before touching `.gitignore`, and runs `node bench/kit/cli.mjs selftest`.
3. Run `/bench new <your question>` and follow the prompts.

The `/bench` modes are `new`, `run`, `report`, `explain`, `rate` and `list`.
Each mode loads one playbook from `bench/kit/playbooks/`.

## Docs

| Doc                                          | What it covers                                                    |
| -------------------------------------------- | ----------------------------------------------------------------- |
| [concepts.md](concepts.md)                   | Study, candidate, workload, gate, metric, verdict, in plain words |
| [study-format.md](study-format.md)           | `study.json`, `protocol.json`, folder layout, versioning          |
| [adapters.md](adapters.md)                   | The five adapter types, sandboxes, adding an adapter              |
| [gates-and-metrics.md](gates-and-metrics.md) | Gate and metric catalogue, adding your own                        |
| [statistics.md](statistics.md)               | The methods, why each was chosen, and where the ideas came from   |
| [explanations.md](explanations.md)           | Plain-language rules, glossary, honesty rules, blind rating       |
| [agent-studies.md](agent-studies.md)         | Comparing coding agents: task bundles, spend caps, terms          |
| [references.md](references.md)               | Every source used, its licence status and how it was used         |

The decision record is
[ADR 0005](../adr/0005-agnostic-benchmark-studies.md).

## Where the code lives

| Path                                                       | Role                                                     |
| ---------------------------------------------------------- | -------------------------------------------------------- |
| `packages/ggcoder/assets/bench-kit/`                       | The kit (ships in the npm package, vendored per project) |
| `packages/ggcoder/assets/commands/setup-bench.md`          | The global `/setup-bench` command                        |
| `packages/ggcoder/scripts/install-setup-bench-command.mjs` | Installer for the command and the kit                    |
| `packages/ggcoder/scripts/bench-kit/*.test.mjs`            | Kit unit and scenario tests (not shipped)                |

The kit is plain ESM with `// @ts-check` and no dependencies. Its version is
`KIT_VERSION` in `lib/version.mjs`; bump it when the study format, the CLI or
a statistic changes behaviour.

## Status and what was verified

Status: new, kit version 1.0.0.

Checks:

- `pnpm test:bench-kit` runs the kit's unit and scenario tests.
- `pnpm test:setup-bench-command` checks the command text, the router and
  playbooks, that every CLI command written in them parses, the kit manifest,
  and a temp-folder install.
- `node packages/ggcoder/assets/bench-kit/cli.mjs selftest` checks the kit
  in place. In a source checkout the `manifest` check warns, because only an
  installed kit has `manifest.json`.

The scenario tests are synthetic and use no network:

1. 3 function candidates, one about 2× faster: WIN.
2. Same vs same: TIE or INCONCLUSIVE, never WIN.
3. A candidate failing a gate: GATED-OUT with the reason.
4. A CLI candidate with prepare/cleanup hooks and errored samples, counted
   correctly.
5. A fake agent CLI emitting NDJSON and stream-json: usage parsed, terminal
   error classified, and the scope, canary and honesty gates enforced.
6. A paid candidate with no approved cap: refused.
7. Editing `study.json` after freezing: a new version, never pooled.
8. `explain` wording: a tie is never phrased as a win, and unmeasured values
   are labelled.
9. Blind rating pack: labels randomised, key kept apart, scores imported.

Not verified: real engines, real paid agent runs, Docker on the development
machine (Windows), and macOS or Linux. Peak memory on Windows is polled, and
reports label it "sampled".

## Relation to the search benchmark

`bench/search/` (see [ADR 0004](../adr/0004-search-benchmark-harness.md)) is
unchanged. The kit ports its statistics and provenance logic and generalises
them. Moving the search benchmark onto the kit is a separate, later decision.
