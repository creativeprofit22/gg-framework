# Playbook: blind human ratings

For what numbers cannot capture (picture quality, readability of an answer). People rate
outputs without knowing which candidate made them.

## 1. Add a rating metric (before the full run, as part of the rule)

```json
{ "id": "looks_right", "type": "rating", "better": "higher", "label": "Looks right (1-5)" }
```

Adding it later changes study.json, so it makes a new protocol version.

## 2. Build a blind pack from a full run

```bash
node bench/kit/cli.mjs rate <id> create <pack> --scale 1-5 --prompt "How natural does the motion look?"
```

- The pack folder (`bench/studies/<id>/ratings/<pack>/`) holds the outputs under random
  labels and a `scores.csv` to fill in. The key that maps labels to candidates is stored
  OUTSIDE the pack folder. Only the pack folder goes to raters.
- Items where fewer than two candidates produced output are skipped (listed in `warnings`).

Tell the user: give raters the pack folder only (its README says what to do); each rater
puts their name in the rater column and a score on each row they rate, leaving rows empty
to skip them; do not tell raters which candidate is which; more raters and items make the
result firmer.

## 3. Import the scores

```bash
node bench/kit/cli.mjs rate <id> import <pack> <path-to-filled-scores.csv> [--metric looks_right]
```

The kit unblinds the scores with the key and stores them as the rating metric. Explain the
`summary` in plain words (number of raters, rows, skipped rows and why).

Next: `/bench report <id>` (the ratings now feed the report like any other metric).
