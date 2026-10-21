# Playbook: explain

`/bench explain <term | study | study:metric>` answers in plain words, from the study's own
numbers first and the glossary second.

```bash
node bench/kit/cli.mjs explain <query>
```

- `kind: "study"`: give the question, the decision rule (`rule`), one sentence per metric,
  the candidates and the verdict with its `meaning` (or "not reported yet").
- `kind: "metric"`: give `meaning`, then each line of `results` (this study's numbers).
  Mention `source` (verdict.json or the study definition).
- `kind: "term"`: give `plain`, then `example`. Relate it to the user's study when one is
  open in the conversation.

Keep it short: two to five sentences, no formulas unless the user asks.

## Unknown terms

`TERM_UNKNOWN` lists close matches. If one fits, use it. Otherwise explain the term yourself
in plain words, citing a source you opened, and add it for next time:

```bash
node bench/kit/cli.mjs explain "<term>" --plain "<one or two plain sentences>" --example "<short example>" --alias "<other name>"
```

The term goes to `bench/glossary.json` (project terms). Tell the user it was added.
`TERM_EXISTS` means the term or an alias is taken; use the existing one or `--replace` only
for the project's own entry.
