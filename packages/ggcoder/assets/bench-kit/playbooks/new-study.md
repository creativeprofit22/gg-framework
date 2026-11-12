# Playbook: new study

Turn a question into a study the user has understood and confirmed. Nothing is measured in
this playbook. The result is `bench/studies/<id>/study.json` plus a frozen `workload/`.

Worked example used below: "Which of three video engines should the editor use?"

## 1. Interview (one `ask_user` call, at most 5 questions)

Find out, in the user's words:

1. The decision: what will change depending on the answer, and what is in use today
   (that becomes the **reference**, the candidate that stays unless another clearly wins).
2. The candidates (2 or more) and where each one comes from.
3. What "better" means: the one number that decides (export time, resolve rate...) and the
   numbers that must not get worse (seek p95, memory...).
4. Hard requirements that rule a candidate out regardless of speed (correct output,
   platform support, licence, no damage). These become **gates**.
5. Whether any candidate costs money per run (paid APIs, agent CLIs). Those are `paid: true`.

Skip questions the user already answered. Recommend an answer for each.

## 2. Explainer card per candidate (before anything else is written)

Research each candidate (local code first; then `web_search`/`web_fetch` for official docs;
`steroids` for real source when behaviour is unclear). Show one card per candidate:

```text
<Name> — <one-line plain description>
What it is:     <library / CLI / service / agent; who maintains it>
How it works:   <2-3 plain sentences; the part that matters for this decision>
Licence:        <licence, or "not verified">
Maturity:       <release cadence, last release, adoption; or "not verified">
Risks:          <what could go wrong for this project>
Sources:        <links you actually opened>
```

Say "not verified" for anything you could not confirm. Never fill a gap with a guess.

## 3. Choose how each candidate runs

| Adapter    | When                                                               |
| ---------- | ------------------------------------------------------------------ |
| `function` | candidates are JS functions/modules with the same interface        |
| `cli`      | candidates are commands (`{input}`/`{out}` slots, prepare/cleanup) |
| `http`     | candidates are running services (base URLs in the config)          |
| `agent`    | candidates are coding agents (read `agent-studies.md` now)         |
| `manual`   | numbers measured elsewhere, imported with their stated source      |

Every candidate gets the same interface and the same inputs. If a candidate cannot run here
(missing tool, other OS), say so and mark it, or leave it out. Never invent its numbers.
Use `"synthetic": true` for stand-ins; they are labelled in every report.

## 4. Freeze the workload

Put the inputs in `bench/studies/<id>/workload/` (text files with LF line endings). They should be
realistic and cover the cases the decision depends on (small and large, easy and nasty).
Never pick inputs after seeing results. Expected outputs go next to them (`expectedFile`).

## 5. Gates, then metrics

Gates come first: a fast wrong answer is still wrong. Pick from `exit-code`, `equals`,
`tolerance`, `schema`, `command`, `quality` (e.g. VMAF), and for agents `tests`, `scope`,
`side-effects`, `honesty`. LLM judges are never gates. A gate that cannot be checked makes
the candidate INCONCLUSIVE, never passed.

Metrics: `wall-time`, `cpu-time`, `peak-memory` (always "sampled"), `output-size`,
`tokens-cost`, `custom` (numbers the candidate or a tool reports), `rating` (blind human
scores). Give each a unit and `better` (lower or higher). Anything that matters but cannot
be measured goes in `unmeasured` with how it could be judged.

## 6. The decision rule, in plain words

Write `decision`: `reference`, `primary` (`metric`, `better`, `minRatio` such as 1.3 =
"at least 30% better", `ciLowerAbove`), optional `secondary` (`mustNotRegressBeyond`),
`tieBreak`, and `"noise": { "requireAA": true }` (recommended). Keep `repeats` at 10 or more
unless a pilot says otherwise; pick any fixed `seed`.

Write `study.json` (LF only), then run:

```bash
node bench/kit/cli.mjs validate <id>
node bench/kit/cli.mjs explain <id>
```

Fix every validation problem. Show the user the `rule` sentence from `explain`, one
sentence per metric (`metrics`), and the gates in plain words. Then ask with `ask_user`:
"Is this the rule you want to decide by?" (options: confirm, change the threshold, change
the metric). Do not freeze until the user confirms. Changing the rule after results exist is
not allowed; it makes a new protocol version and the old results are never pooled.

## 7. Freeze

```bash
node bench/kit/cli.mjs freeze <id>
```

Report the protocol version and what was frozen.

Next: `/bench run <id>`
