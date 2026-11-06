# ADR 0005: Decisions between candidates use a vendored, pre-registered bench kit

**Status:** Accepted, 2026-10-20. Extends
[ADR 0004](0004-search-benchmark-harness.md); does not change it.

## Context

ADR 0004 gave the search tools a careful benchmark: pre-registered rule,
provenance guard, fresh worker per run, rotated order, hierarchical bootstrap
CIs. That harness is built for one question in one repo. We keep facing the
same kind of question elsewhere: which video engine, which library, which
CLI, which agent or prompt. Each time, the easy path is a one-off script that
times a few runs and reports averages.

Lessons from Ken's removed experiments (prompt-bench, ui-library-real-flow,
the baseline ledger) and from the open-source evals we reviewed point the same
way:

- A harness bug can make a result look real (the `toolcall_done` lesson).
  Gates and status must come from deterministic checks and terminal events.
- An errored sample scored as zero, or rerun until it passes, biases the
  result. Zero tests counted as success hides broken tasks.
- Without a same-vs-same check, ordinary noise reads as a win.
- Agent runs cost money. Spending needs caps approved by a person, and
  unknown usage must never be refunded against the cap.
- People need the verdict and every number explained in plain words, and a
  tie must never be worded as a win.

## Decision

- **One general kit, vendored per project.** A zero-dependency Node ESM kit
  (`packages/ggcoder/assets/bench-kit/`, `// @ts-check`) ships in the npm
  package. `/setup-bench` copies it into `bench/kit/` and writes a thin
  `/bench` router that loads one playbook per mode. A project's kit is pinned
  by its manifest hash in every protocol, so upgrades never change old
  results.
- **The CLI counts; the agent explains.** Every statistic, verdict and
  report line comes from `node bench/kit/cli.mjs`. The agent writes the
  study with the user, explains candidates, metrics and the rule before the
  run, and relays the CLI's plain sentences.
- **Pre-registration.** `study.json` holds the question, candidates,
  workload, gates, metrics and the decision rule (reference, primary metric
  with minimum ratio and CI bound, secondary must-not-regress limits,
  tie-break, A/A requirement). Freezing writes `protocol.json` with byte
  hashes of the study, workload, kit and candidate provenance. Any later
  edit is a new version, and results from different versions are never
  pooled.
- **Gates before metrics.** Gates return pass, fail or errored with a
  reason. A gate that cannot be checked is errored, never passed. Failing a
  disqualifying gate makes the candidate GATED-OUT before its metrics are
  compared. Gates are evaluated from the recorded samples at report time.
- **Honest statistics.** Seeded balanced rotation of candidate order, a
  fresh worker per sample, item-clustered paired bootstrap ratio CIs,
  Bonferroni-adjusted levels for multiple candidates, rank probability,
  Wilson intervals for rates, and an A/A noise floor. Errored samples are
  counted and never selectively rerun. Too many errors, a CI that is too
  wide or a failed A/A check give INCONCLUSIVE.
- **Five adapters.** `function`, `cli`, `http`, `agent` and `manual` cover
  in-process code, commands, services, headless coding agents and numbers
  measured elsewhere. Commands run without a shell. The `process` sandbox
  is the default; Docker is used only when configured and detected.
- **Agent lane.** Task bundles with hidden oracles, fail-to-pass and
  pass-to-pass grading (zero tests is an invalid task), scope, side-effect
  and negation-aware honesty gates, prices only from config, reported and
  estimated cost kept apart, and a spend broker that refuses paid runs
  without a human-approved cap.
- **Plain language.** `explain.mjs` produces deterministic sentences for
  every metric, comparison and verdict. `report` refuses to write when its
  wording audit fails (for example, a tie phrased as a win).

## Rejected alternatives

- **Extend `bench/search/` in place.** It is tied to one repo, one tool path
  and one rule. Generalising it inside the repo would risk the search
  results ADR 0004 protects. The kit ports its statistics and provenance
  logic instead, and the search benchmark stays as it is.
- **Adopt an existing eval framework.** The ones we reviewed (inspect_ai,
  Harbor, SWE-bench, lm-evaluation-harness, HELM) target one domain, need
  Python or containers, or bring dependencies. We need one method for
  engines, libraries and agents that runs wherever GG runs. We borrowed
  ideas, not code; see [references](../bench/references.md).
- **Generic micro-benchmark tools only** (hyperfine, mitata, tinybench,
  criterion). They time well but have no gates, no pre-registered decision
  rule, no versioned protocol and no agent lane. Projects can still use them
  through the `cli` or `manual` adapters.
- **LLM judge as a grader.** Non-deterministic, costly and easy to sway. The
  study validator rejects any gate that is a judge. A human may add a
  readability note after all gates pass, but it is labelled non-gating and
  the kit does not score it. Human judgement that matters goes through blind
  rating packs instead.
- **Install the kit globally and run it from there.** Results would depend on
  whatever kit version is installed today. Vendoring plus a manifest hash in
  the protocol keeps every study reproducible.
- **Default spend caps.** A default cap is a guess about someone's money. A
  missing cap refuses the run.

## Consequences

- New studies follow one documented method, and every verdict carries its
  protocol hash, provenance and CIs.
- The npm package grows by the size of the kit. Run the size gate with
  `--only dist:ggcoder` when the kit changes.
- Kit changes that alter behaviour bump `KIT_VERSION`. Old studies keep
  their vendored kit.
- Not covered yet: registering `setup-bench` in the programmatic specialist
  enum, app UI, and sidecar bundling.
