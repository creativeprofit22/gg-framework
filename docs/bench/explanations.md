# Bench kit explanations

The plain-language layer of the bench kit. The agent explains; the kit CLI produces the
numbers and the sentences about them. Sentences come from `lib/explain.mjs` and are built
only from the study's own numbers and the glossary, so they can be checked.

See also: [README.md](README.md), [concepts.md](concepts.md),
[study-format.md](study-format.md), [statistics.md](statistics.md),
[gates-and-metrics.md](gates-and-metrics.md).

## Before a run: explainer cards

The `new-study` playbook asks the agent to research each candidate and show one card per
candidate before anything is written:

```text
<Name> — <one-line plain description>
What it is:     <library / CLI / service / agent; who maintains it>
How it works:   <2-3 plain sentences; the part that matters for this decision>
Licence:        <licence, or "not verified">
Maturity:       <release cadence, last release, adoption; or "not verified">
Risks:          <what could go wrong for this project>
Sources:        <links you actually opened>
```

Anything that could not be confirmed is written as "not verified". A gap is never filled
with a guess.

## The rule is explained, then confirmed

After writing `study.json`, the agent runs:

```bash
node bench/kit/cli.mjs validate <id>
node bench/kit/cli.mjs explain <id>
```

`explain <id>` returns the decision rule as one sentence (`explainRule`), one sentence per
metric (`explainMetric`) and the candidates. The agent shows these, describes the gates in
plain words, and only then asks "Is this the rule you want to decide by?". The study is not
frozen until the user confirms. Changing the rule after results exist makes a new protocol
version; old results are never pooled with it.

An example rule sentence, as `explainRule` builds it:

```text
A candidate replaces Engine A (engine-a) only with at least 1.3× faster on export time,
with the whole range above 'no difference'. On a tie, keep Engine A (engine-a).
```

## Sentences the kit writes

| Function                | What it says                                             |
| ----------------------- | -------------------------------------------------------- |
| `explainMetric`         | What a metric measures, its unit and which way is better |
| `describeChange`        | "1.4× faster", "2 points higher (better)", "the same"    |
| `describeRange`         | "likely between 1.2× and 1.6× faster (95% confidence)"   |
| `explainClassification` | "clearly better, beyond run-to-run noise" and the like   |
| `explainRule`           | The rule and the tie-break                               |
| `explainCandidate`      | Headline and meaning per candidate                       |
| `explainVerdict`        | Headline, "what this means for you", details, next steps |
| `nextSteps`             | A concrete fix for each INCONCLUSIVE reason              |
| `explainUnmeasured`     | What was not measured, and why                           |

Numbers are formatted without the machine's locale: three significant figures, thousands
separators from 1,000, and percentages that never round a non-zero share to 0% or a
partial one to 100% ("under 1%", "over 99%").

When an interval was widened for several comparisons, the range says so, for example
"(98.3% confidence, widened from 95% because 3 comparisons were made)".

### What this means for you

Each verdict has a `meaning` line, shown in `report.md` as "What this means for you".

| Verdict      | Headline (shape)                                                | Meaning (shape)                                         |
| ------------ | --------------------------------------------------------------- | ------------------------------------------------------- |
| WIN          | "WIN: switch to X. It cleared the rule you set before the run." | The range against the reference, and the rule asked for |
| TIE          | "TIE: no candidate is meaningfully better than R on M."         | "This is a tie, not a win." plus the tie-break advice   |
| NO-WIN       | "NO-WIN: keep R."                                               | "No candidate cleared the rule: ..."                    |
| INCONCLUSIVE | "INCONCLUSIVE: do not decide from this run yet."                | The reasons and the next steps                          |

Per candidate, GATED-OUT reads "X is ruled out (GATED-OUT): <gate reasons>. Its
measurements do not count, however good they look". A candidate that measured ahead while
the study is INCONCLUSIVE reads "... It cannot be called a win yet."

The details also say which differences count as noise ("Differences under 1% are treated
as run-to-run noise") and give rank probability as "ranked best on M in 87% of resamples
(a ranking, not a verdict)".

## `/bench explain`

```bash
node bench/kit/cli.mjs explain <term | study | study:metric>
```

The answer comes from the study's own numbers first and the glossary second.

| Query              | Returns (`kind`) | Content                                                                                 |
| ------------------ | ---------------- | --------------------------------------------------------------------------------------- |
| `<study>`          | `study`          | Question, rule, metric sentences, candidates, verdict and meaning (or "No verdict yet") |
| `<study>:<metric>` | `metric`         | The metric sentence, then each candidate's range from `verdict.json`                    |
| anything else      | `term`           | The glossary entry: `plain`, then `example`                                             |

A query is treated as a study only when it looks like a study id and
`bench/studies/<id>/study.json` exists; otherwise it is looked up as a term. For a metric,
`source` says whether the numbers came from "this study's verdict.json" or only from the
study definition. The playbook keeps answers to two to five sentences, with no formulas
unless asked.

## The glossary

The kit ships `glossary.json` (schema 1). Terms include: a/a check, bootstrap, bonferroni
correction, confidence interval, decision rule, errored sample, gated-out, hidden tests,
noise floor, rank probability, reported cost, estimated cost, spend cap, terminal event,
tie, win, worst-case reservation and more. Each entry has `plain`, and optionally
`example` and `aliases`.

Lookups (`explainTerm`) match the term or an alias after lower-casing and collapsing
spaces. A miss returns `TERM_UNKNOWN` with up to five close matches.

### Adding project terms

```bash
node bench/kit/cli.mjs explain "<term>" --plain "<one or two plain sentences>" \
  --example "<short example>" --alias "<other name>"
```

- The term is written to `bench/glossary.json` (project terms), sorted, LF only.
- Project terms are merged over the kit's terms and may reword them.
- `TERM_EXISTS`: the term or one of its aliases is already used. `--replace` replaces only
  the project's own entry; an alias can never shadow a kit term.
- `GLOSSARY_INVALID`: keys must be lower-case and trimmed, `plain` must be non-empty.

When a term is unknown, the playbook asks the agent to explain it in plain words from a
source it opened, add it, and tell the user it was added.

## Honesty rules

These are enforced in code, not only in the playbooks.

- **A tie is never worded as a win.** TIE meanings say "This is a tie, not a win". The tie
  advice is the declared tie-break, otherwise "keep the reference".
- **Unmeasured is labelled.** A missing value is reported as "not measured ... shown as
  unmeasured, not as zero", with the reason. It is never filled with zero.
- **Synthetic stand-ins are labelled.** `candidateName` appends `[synthetic stand-in]` to
  any candidate with `"synthetic": true`, everywhere it is named. The verdict adds "not the
  real thing; confirm on the real candidate before deciding".
- **Sampled readings say so.** Peak memory is described as read every few milliseconds, so
  short spikes can be missed.

### The wording audit

`auditWording` scans the generated text for win words (win, winner, beat, outperforms,
superior, cleared the rule and so on) when the verdict is not WIN. Verdict tokens such as
NO-WIN and negated or conditional phrases ("not a win", "unless another candidate clears
the rule") are allowed. It also flags any line that names a synthetic candidate without
saying "synthetic".

`auditDecision` runs it over the verdict and every candidate. `buildReport` returns the
problems, and `report` refuses to write anything when there are any:

```text
REPORT_WORDING: the generated wording broke the honesty rules, so nothing was written: ...
```

No `report.md`, `verdict.json` or `RESULTS.md` entry is written. The report playbook treats
this as a kit bug: stop and show the message.

## What `report` writes

- `bench/studies/<id>/report.md`: verdict, "What this means for you", next steps, "The rule,
  written down before the run", candidate tables, and a "Not measured" section listing each
  `study.unmeasured` item with how it could be judged.
- `bench/studies/<id>/verdict.json`: the machine-readable verdict, including `headline` and
  `meaning`, plus `unmeasured` (the study's `{ what, how }` items) when the study lists any.
- `bench/RESULTS.md`: one entry per study and protocol version, between
  `<!-- bench:start <id> v<n> -->` and `<!-- bench:end -->` markers. A re-report replaces
  its own entry and never touches other text. A file with CRLF line endings is refused
  (`LEDGER_CRLF`).

The agent presents the CLI's sentences as written. It may add context but never changes
the claim, and never calls a TIE, NO-WIN or INCONCLUSIVE a win, a "slight edge" or
"promising".

## Blind human rating packs

For things a number cannot capture, people rate outputs without knowing which candidate
made them (`lib/rating.mjs`).

```bash
node bench/kit/cli.mjs rate <id> create <pack> --scale 1-5 --prompt "How natural does it look?"
node bench/kit/cli.mjs rate <id> import <pack> <filled-scores.csv> [--metric looks_right]
```

- The rating metric (`"type": "rating"`) must be in the study before the full run; adding
  it later is a new protocol version.
- `create` copies each item's outputs under letters (A, B, C...) in an order shuffled per
  item from `seedFrom("<seed>:<pack>:<item>")`. Items where fewer than two candidates
  produced output are skipped and listed in `warnings`.
- The pack folder `bench/studies/<id>/ratings/<pack>/` holds the outputs, a README and
  `scores.csv` with columns `rater,item,label,score,notes`.
- The key that maps letters to candidates is `ratings/<pack>.key.json`, beside the pack and
  never inside it. Only the pack folder goes to raters.
- `import` unblinds the scores with the key into `ratings/<pack>.scores.json`. It refuses a
  missing key (`RATING_KEY_MISSING`), unknown options and a rater scoring the same option
  twice. The scores then feed the report like any other metric.
