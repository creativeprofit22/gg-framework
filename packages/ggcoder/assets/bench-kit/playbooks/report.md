# Playbook: report a study

```bash
node bench/kit/cli.mjs report <id>
```

Optional: `--runs A,B` to choose full runs of the current version, `--aa ID` to choose the
A/A run. Without them the kit uses every full run and the latest A/A run of the current
protocol version. Full runs left out by `--runs` are named in the report and verdict
("Left out by choice"); tell the user why they were left out.

## What the CLI writes

- `bench/studies/<id>/report.md`: tables plus a "what this means for you" line per result.
- `bench/studies/<id>/verdict.json`: the machine-readable verdict.
- `bench/RESULTS.md`: one ledger entry per study (updated, never duplicated).

If it refuses with `REPORT_WORDING`, the generated wording broke the honesty rules: nothing
was written. That is a kit bug: stop and show the message.

## Presenting the verdict

Use the CLI's sentences as written (`headline`, `meaning`, `nextSteps`, and per candidate
`candidates.<id>.headline` / `meaning`). Add context, never change the claim.

```text
Verdict: <WIN | TIE | NO-WIN | INCONCLUSIVE> — <headline>
What this means for you: <meaning>
Per candidate:
- <name>: <verdict> — <meaning>
Not measured: <items from study.unmeasured and any unmeasured metric, with the reason>
```

Verdicts in plain words:

- **WIN**: the candidate cleared the pre-registered rule against the reference.
- **TIE**: no meaningful difference; choose by the declared tie-break (default: keep the reference).
- **NO-WIN**: the reference stays.
- **INCONCLUSIVE**: the evidence cannot decide (interval too wide, too many errored
  samples, A/A missing or failed, gates that could not be checked). Say which, and what
  would fix it (more repeats, a quieter machine, fixing the harness).
- **GATED-OUT** (per candidate): it failed a hard requirement; give the gate and reason.

Never call a TIE, NO-WIN or INCONCLUSIVE a win, a "slight edge" or "promising". Never
present a synthetic stand-in as the real thing.

## Follow-up

Offer `/bench explain <id>:<metric>` for any number the user asks about. If the study has
a `rating` metric with no imported scores, the report says so; suggest `/bench rate <id>`.

Next: the single most useful follow-up, for example `Next: adopt engine-b` (only after a
WIN) or `Next: /bench run <id>` (to add evidence after INCONCLUSIVE).
