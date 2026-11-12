---
argument-hint: [new <question> | run <study> | report <study> | explain <term|study[:metric]> | rate <study> | list]
description: Compare candidates for a decision with a frozen, repeatable study and get a plain-language verdict you can defend.
allowed-tools: Bash, Read, Write, Edit, Grep, Glob, LS, ask_user, web_search, web_fetch, steroids
---

# Bench

Project: <project summary>
Kit: `bench/kit/` (version <kit version>). Config: `.gg/bench.config.json`. Studies: `bench/studies/<id>/`.
CLI: `node bench/kit/cli.mjs <command> [arguments] [--project .]` prints one JSON object.
Exit codes: 0 ok, 1 refused or failed (read `error.code` and `error.message`), 2 usage error, 3 kit bug.

## Rules for every mode

- The kit CLI does all counting and statistics. Never compute a median, ratio, interval or
  verdict yourself, never edit `runs/`, `protocol.json`, `verdict.json` or `RESULTS.md` by
  hand, and never rerun single samples. Errored samples stay errored.
- Plain words first. Every candidate, metric and decision rule is explained before anything
  runs; every result is followed by what it means for the user. Use the CLI's own `meaning`
  and `headline` sentences; do not reword them.
- Honesty: a TIE, NO-WIN or INCONCLUSIVE is never described as a win. Say "not measured" for
  anything unmeasured, never 0. Synthetic stand-ins keep their "[synthetic stand-in]" label.
- Nothing marked `paid` runs without spend caps the user approved through `ask_user` in this
  conversation. A missing cap means no run, never a default cap.
- No installs, downloads or network calls without the user's confirmation. `/bench` never
  edits product code; it only writes inside `bench/` and `.gg/bench.config.json`.
- Kit bug (exit 3), `REPORT_WORDING` or a failing selftest: stop, show the message, and
  suggest re-running `/setup-bench`.

## Step 0: Check the kit

Once per session run `node bench/kit/cli.mjs selftest`. If it fails or `bench/kit/` is
missing, stop and tell the user to run `/setup-bench`.

## Step 1: Pick the mode

Read the first word of `$ARGUMENTS` and load ONLY that playbook, then follow it exactly:

| First word | Playbook                           | Use it to                                  |
| ---------- | ---------------------------------- | ------------------------------------------ |
| `new`      | `bench/kit/playbooks/new-study.md` | turn a question into a confirmed study     |
| `run`      | `bench/kit/playbooks/run.md`       | freeze, A/A, pilot and the full run        |
| `report`   | `bench/kit/playbooks/report.md`    | verdict, report.md and the ledger entry    |
| `explain`  | `bench/kit/playbooks/explain.md`   | explain a term, a study or one metric      |
| `rate`     | `bench/kit/playbooks/rate.md`      | blind human ratings                        |
| `list`     | none                               | run `list`, summarise each study in a line |

Also load `bench/kit/playbooks/agent-studies.md` whenever the study's `kind` is `agent` or
any candidate uses the `agent` adapter.

No first word: run `node bench/kit/cli.mjs list`, summarise the studies in one line each,
then ask with `ask_user` whether to start a new study or continue one (recommend the most
recent unfinished study, else `new`).

Anything else: treat `$ARGUMENTS` as the question for a new study and use `new-study.md`.

## Step 2: Finish

End every reply with one `Next:` line naming the single command to run next, for example
`Next: /bench run engine-choice` or `Next: /bench report engine-choice`.
