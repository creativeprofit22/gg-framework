# Playbook: run a study

Order: validate → freeze → spend approval (paid only) → A/A → pilot → full run.
The CLI does all the counting. Read its JSON; never compute anything yourself.

## 1. Validate and freeze

```bash
node bench/kit/cli.mjs validate <id>
node bench/kit/cli.mjs freeze <id>
```

- `freeze` checks provenance: each candidate's declared `source` (git worktree, commit,
  clean tree, file hashes, version command). A dirty or wrong commit refuses the run; fix
  the candidate, do not loosen `allowDirty` without asking.
- `status: "new-version"` means study.json, the workload, the kit or a candidate changed.
  Tell the user in one sentence what changed: older results stay but are never pooled with
  the new version.
- `KIT_UNSUPPORTED` / `TASK_INVALID` / `SANDBOX_UNAVAILABLE`: stop and explain; nothing ran.

## 2. Spend approval (only when a candidate is `paid: true`)

Run `node bench/kit/cli.mjs run <id>` once without caps. It refuses with `BUDGET_REQUIRED`
and states the worst case (`details.worstCaseUsd`, `details.samples`). Ask with `ask_user`:

```text
Question: Approve a spend cap of $<worst case, rounded up> for this run?
Detail:   <N> paid samples × up to $<per-sample worst case> each. Each sample reserves its
          worst case before it starts; unknown usage is never refunded; a sample that costs
          more than its worst case stops all paid work. A run cut short is not evidence.
Options:  approve $<amount> (recommended) | don't run paid candidates
```

Only with an explicit approval, pass it on every paid `aa`/`run` command:

```bash
node bench/kit/cli.mjs run <id> --cap-usd <amount> --approved-by "<user>" --approval-ref "<question and answer>"
```

`BUDGET_TOO_SMALL` means the cap does not cover the worst case: ask again or reduce repeats
(an edit to study.json, so a new version). Never lower `perSampleWorstCase` to make it fit.

## 3. A/A noise check

```bash
node bench/kit/cli.mjs aa <id>
```

The reference runs against a copy of itself. `aa.passed: true` gives the noise floor: the
smallest difference that is more than jitter. Explain it in one sentence. If it fails, the
machine is too noisy (background load, thermal throttling, power saving): say so, suggest a
fix, and rerun the whole A/A run. A required A/A that is missing or failed makes every
verdict INCONCLUSIVE.

## 4. Pilot (sizing, never evidence)

```bash
node bench/kit/cli.mjs run <id> --pilot --repeats 3
```

Use it to check every candidate works, see the error rate and estimate how long the full run
takes (`counts`, the run's `durationMs` per sample in samples.jsonl). Pilots are never part
of a verdict. If repeats must change, edit study.json and freeze again before the full run.

## 5. Full run

```bash
node bench/kit/cli.mjs run <id>
```

- Progress lines go to stderr; the final JSON gives `status` and `counts`.
- Errored samples are counted against their candidate and never rerun one by one. If the
  harness was broken (not the candidate), fix it and start a NEW full run; report only runs
  from the same protocol version.
- `status: "aborted"` (stopped by the user or by the spend broker) is not evidence on its own.
- Do not use the machine for other heavy work while it runs.

Explain the counts in plain words (for example "every candidate finished 30 of 30 samples;
engine-c errored on 2").

Next: `/bench report <id>`
