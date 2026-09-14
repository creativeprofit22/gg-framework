# Review-flow decision report — 6 September 2026

## Implementation follow-up

The targeted control fixes below are implemented in source. These changes were made **after** the 72-trial study; its measurements are historical, not a benchmark of this follow-up.

- Verification re-arms once after edits invalidate a completed check. It does not repeatedly prompt on unchanged code. Exhausting the reminder budget does **not** clear the host's outstanding-verification state.
- The app blocks completion and Autopilot approval on missing, failed, stale, or running verification, independently of model claims. Foreground checks need an observed zero exit; background checks need a matching launch and observed process exit. A passing unrelated command cannot erase a failed check, including late failures from earlier revisions.
- The app displays **Unverified**, withholds completion rewards and plan finalization, and journals that outcome separately. Unresolved verification survives session reload and compaction. Resumed edited sessions require fresh evidence; successful-command cache entries intentionally are not restored.
- Ideal now reuses unchanged checks but requires affected checks and fresh reads after fixes; the old commit-time-only instruction is removed.
- Autopilot can return a strict structured `corpus_unverified` field. The cycle maps that field to fixed warning text, persists it using the existing marker reason field, and displays it on live and restored approvals. Arbitrary warnings, extra fields, malformed JSON, and failed-verification exceptions fail closed.
- Post-verification hook notices have a distinct recheck label. No new reviewer or always-on process was added; unchanged code within a live session reuses successful evidence.

Scope: revision tracking uses session mutation events and potentially mutating verification attempts, not filesystem watching of external writers. A zero exit is execution evidence, not proof that the suite has adequate assertions; the reviewer still assesses coverage. The runtime comparison below isolates host enforcement; it is not a full old-release or desktop benchmark.

## Runtime enforcement comparison (`RUNTIME`)

**48 live GLM-5.3 trials completed**, six fixtures × two reviewers × two arms × two rounds, low thinking, two trials concurrently, Apple M4 Pro / Node v26.0.0. Elapsed time was approximately **6.9 minutes**. Evidence: `artifacts/review-study-mv2seJ/{metadata,prompts,samples,summary}.json`.

The before/after variable is **host enforcement disabled → enabled**. Both arms use byte-identical current prompts, current verification bookkeeping, and sequential edit/check scheduling matching production. Both Ken arms run the production `driveAutopilotCycle`; Ideal's final completion boundary is reproduced in the harness. This isolates the new control, not every historical prompt/app change. Provider caches are uncontrolled; round order is counterbalanced. No production code was changed for the benchmark.

### Observed results

Tokens below mean reported input **including cache reads**, plus output, per trial—not dollars or uncached billing tokens. All observations, including blocked and capped trials, remain in these aggregate numbers.

| Metric | Enforcement off | Enforcement on | Change |
| --- | ---: | ---: | ---: |
| Ideal median trial time | 13.26 s | 11.90 s | −10.2% |
| Ken median trial time | 15.48 s | 16.22 s | +4.8% |
| Ideal mean total tokens | 15,463.5 | 15,440.9 | −0.15% |
| Ken mean total tokens | 19,025.1 | 18,083.2 | −4.95% |
| Ideal model calls | 12 | 12 | unchanged |
| Ken model calls | 24 | 22 | −8.3% |
| False code/check approvals | 0/24 | 0/24 | none observed in either arm |
| Independent code oracle passing | 24/24 | 24/24 | unchanged |
| Ideal turn-capped trials | 1/12 | 2/12 | one more cap |

The **directly attributable saving** is the known-failed-check Ken path: median **9.93 s → 0.105 s**, mean tokens **7,923.5 → 0**, model calls **2 → 0** across its two trials. The gate blocked before asking the reviewer. Ideal's two failed-check trials were also marked unverified, but still needed their initial review call. With enforcement off the model already refused these failures, so this run did **not** demonstrate a reduction in false approvals.

Do not turn blocked/capped runs into a successful-work speed claim. On **matched, approved, correctly checked completions**:

| Matched subset | Pairs | Median time off → on | Mean tokens off → on |
| --- | ---: | ---: | ---: |
| Ideal | 8 | 15.97 s → 12.72 s | 15,756.9 → 15,724.4 |
| Ken | 10 | 22.29 s → 20.50 s | 21,245.4 → 21,699.8 |

Ken's mean time across all trials fell **18.34 s → 15.43 s**, while its median rose: skipping two blocked reviews changes the distribution. Its successful-work token mean actually rose approximately **2.1%**. Ideal's latency direction reversed between rounds: round-one medians 15.45 s → 13.68 s; round-two medians 11.28 s → 11.80 s. These small, variable samples establish **no universal latency or token improvement**.

### Reliability observations and scope

- Current Ideal hit two experimental turn caps, omitted the corpus disclosure once, and made rejected fixture-patch attempts in two trials. One rejected-attempt trial overlapped a cap. Restricted patch attempts are not evidence of a security failure: the harness intentionally accepts only a pre-authored repair.
- Off-arm Ken lost the corpus warning twice: once it returned `ALL_CLEAR` followed by the structured JSON, which the parser treats as plain `ALL_CLEAR`; once it returned only `ALL_CLEAR`. On-arm Ken returned the supported structured warning twice and the driver retained it. Both arms use the **same parser and prompt**, so do not attribute this stochastic formatting difference to the host gate. Current Ideal's missing disclosure is a genuine model-compliance miss, not a regex false positive.
- The live model never tried approving the known failed-check fixture. Deterministic production-control tests and the new offline benchmark assertion exercise that guard; this live run alone cannot establish adversarial reliability.
- Six fixture oracles remained immutable. **14 benchmark tests and the benchmark TypeScript check passed.** The added assertion exercises an actual failed subprocess and verifies zero model calls; no existing assertion was relaxed. A nested Node test-runner environment initially skipped child checks with exit zero; the harness now removes that inherited test context so the checks actually execute.
- Pilot `review-study-V4gOYy` was stopped and excluded because its tool scheduling and revision capture did not match production. All pilot data and its exclusion reason are retained; cancelled oracle results are not product failures. The final matrix was rerun in full without pooling pilot observations.
- Not measured: installed desktop/IPC, session-persistence I/O overhead, external file writers, real corpus discovery latency, Windows, other models, cold-cache behavior, or unconstrained multi-file tasks. No population-level confidence claim follows from two repetitions per fixture.

**Decision:** retain the host control for deterministic blocking and avoided reviewer calls on known failures. Do not market it as an across-the-board speedup or token reduction, and do not add another reviewer.

Reproduce (live calls consume quota):

```bash
pnpm exec tsx --test experiments/prompt-bench/review-bench.test.ts
pnpm exec tsc -p experiments/prompt-bench/tsconfig.json
pnpm exec tsx experiments/prompt-bench/review-bench.ts --runtime --live --rounds 2
```

## Historical prompt-study decision

**Do not call the new instructions an overall improvement. Keep the narrow tracking fix; refine verification and warning delivery; do not add another default reviewer.**

This pass compared the actual **old prompt sections against the current sections**, plus an experiment-only shorter candidate. It measured review, repair, checks, and rereview together—not just the first reviewer response.

| Decision | Reason | Concrete next change |
| --- | --- | --- |
| **Keep one reviewer by default** | Separate Ken needed a writer handoff and another review for repairs. Current Ken used about 29.8k input tokens per repair trial versus Ideal's 19.8k. Both repaired all six seeded-bug cases per arm. Some Ideal trials hit the study cap, so this is not proof Ideal is always preferable. | Preserve Ideal/Autopilot as alternatives, not stacked mandatory reviews. |
| **Keep per-file read invalidation** | A real regression previously proved that editing an already-read file retained stale review evidence. The shared tracker fix makes only that file require rereading. | Keep the tested fix; do not reread unchanged files merely to satisfy a repeated hook. |
| **Keep Steroids evidence reuse** | Old/current arms made no additional corpus calls with usable evidence already supplied. Nothing here supports deleting real-code comparison. | Avoid repeating research already available in context. |
| **Refine post-edit verification first** | The production one-shot verification budget can expire before later review edits. The deterministic test reproduces that gap. Live compliance is not a replacement for the control. | Invalidate checks by code revision; allow one bounded post-fix verification pass. Earlier passing checks cannot approve newer edits. |
| **Refine warning delivery separately from approval** | Every Ken corpus-declined trial lost the required disclosure through the existing contract. Adding text after `ALL_CLEAR` does not survive the parser. | Retain a separate evidence-limitation field through parsing and display. A failed check must remain distinct from a missing corpus comparison. |
| **Reject the combined shortened candidate** | It did not deliver a clear speed/token win. One shortened-Ken trial ended in `ALL_CLEAR` despite the known failed check, after an unnecessary repair/report cycle. Its warning was dropped by the parser. | Do not ship this candidate. Do not broadly weaken or replace Ken's evidence instructions to save tokens. |
| **Defer always-on watchers and another mandatory agent** | No measured benefit offsets the additional context, calls, and stale-snapshot handling. The earlier fast-first-response result did not include repairs. | Add neither by default. Overlap genuinely long checks with a frozen-snapshot review only as a separately measured change. |

**Order of work:** authoritative verification → retained warning field → remove redundant unchanged-code checks/context → reassess efficiency. Not more prompt paragraphs or more reviewers first.

## Old versus current versus candidate (`RUNTIME`)

**72 bounded trials**, six tasks, two rounds, three instruction variants, two review modes. **356 model turns / 110 agent phases**. GLM-5.3, thinking **low**, macOS arm64 / Apple M4 Pro / Node v26.0.0. Two isolated trials at a time; model/variant order rotates. Approximately **11.4 minutes** elapsed.

Old prompt sections were reconstructed as static data from commit `073aa149d7466ed8f1e4505327c4f07d34132eab`. Exact-match guards fail if extraction is ambiguous. Current production prompt builders supplied the unchanged sections. Rendered prompts and SHA-256 hashes are saved with the run. No branch checkout or production rollback was performed.

The candidate changes both wording and a small prototype policy: compact evidence guidance, one post-edit verification nudge for Ideal, and a proposed appended `ALL_CLEAR` warning for Ken. It is a **bundle experiment**, not evidence attributing an effect to any single change. None of it was installed in production.

| Instructions / reviewer | Median trial time | Mean input, including cache reads | Mean output | Normal completions |
| --- | ---: | ---: | ---: | ---: |
| Old / Ideal | 10.45 s | 13,965 | 220 | 11/12 |
| Current / Ideal | 13.15 s | 14,187 | 185 | 10/12 |
| Candidate / Ideal | 14.50 s | 13,967 | 242 | 10/12 |
| Old / Ken | 14.53 s | 17,975 | 249 | 12/12 |
| Current / Ken | 16.59 s | 18,560 | 253 | 12/12 |
| Candidate / Ken | 18.06 s | 18,283 | 271 | 12/12 |

The table includes the resource cost of capped trials; a cap is **not** a successful completion. Five Ideal trials reached the six-turn-per-phase study limit without emitting final text. All Ken repair cycles had separate reviewer/writer/reviewer budgets, so their extra calls also provided more total headroom. This prevents interpreting the completion counts as a general reliability ranking.

On this task mix, current tracked input + output tokens increased **1.31% for Ideal** and **3.23% for Ken** versus old instructions. Ideal's output alone decreased, but its input increased. The shorter candidate's modest input reduction did not yield lower output or a reliable latency improvement. **Token counts are not billing estimates:** cache and output pricing differ.

Medians across mixed tasks are descriptive, not causal. For example, current Ideal's median *repair* attempt was 16.97 s versus old Ideal's 19.87 s, while its overall median increased. Provider variability, cache warmth, tiny sample sizes, task weighting, and turn caps matter. The defensible result is **no clear overall efficiency win**, not “the new wording is definitely slower.”

Tracked usage across the study: **94,876 input + 1,068,352 cache-read + 17,030 output = 1,180,258 tokens**.

## Reliability results (`RUNTIME` plus manual inspection)

Tasks:

1. Partial final page incorrectly rounded down.
2. Explicit zero timeout incorrectly replaced by the default.
3. Sorting incorrectly mutates the caller's array.
4. Already-correct implementation; no unnecessary edits expected.
5. Known failing check; do not turn it into a successful verdict.
6. Empty corpus with indexing already declined; disclose the limitation without repeated setup.

Every fixture has executable smoke assertions and a separately authored requirement oracle. The three buggy implementations pass the incomplete initial smoke check and fail the oracle. Repairs must satisfy the oracle. The oracle is not counted as a model-requested verification when the harness runs it for scoring.

- **36/36 seeded-defect outputs passed the final code oracle.** These are three distinct simple defects repeated across variants/rounds, not 36 independent defect classes.
- All six repair trials per arm ended with correct code. Current/candidate Ideal and all Ken arms had current passing checks for all six. Old Ideal had one capped, unreverified repair; rejected fixture patches consumed its budget. The whitelist is narrower than general JavaScript, so do not generalize that incident into an old-model reliability defect.
- No arm made an unnecessary implementation edit on either clean-control trial. Current Ideal nevertheless reran checks in both; current Ken reran none. Avoiding redundant verification is a concrete efficiency target, provided the existing result covers the actual requirements and unchanged revision.
- Old/current Ideal and old/current Ken honestly reported the failed-check case in both rounds. The initial text-screening regex misread `Verification **failed**` as approval in one old-Ideal response; manual inspection rejected that flag.
- Candidate Ken took an unnecessary repair/report/rereview route in one failed-check trial and ended with `ALL_CLEAR` plus “verification remains unproven.” The production parser keeps only the approval. **That candidate is not acceptable.** The other candidate-Ken round stopped correctly.
- Old/current Ken returned bare `ALL_CLEAR` in all four corpus-declined trials. Candidate Ken produced a warning in both, but the actual production parser discards it. **None delivers the required disclosure through the current app contract.**

Raw `approved` / `failures` fields are screening aids, not the final reliability verdict. The initial regex also misclassified a Markdown failure report from candidate Ideal and treated empty capped responses as approvals. The helper now handles these cases, with tests. Original samples remain untouched; `assessment.json` records corrections and the parser-level findings. Rejected fixture patches are not counted as security failures: valid alternative JavaScript can fall outside the deliberately restricted executable targets.

## What was actually exercised

- Current `Agent`, system prompt builders, Ken context builder, verdict parser, review coverage tracker, and verification gate.
- Real fixture reads, restricted expression edits, subprocess checks, and one Ken repair/rereview cycle.
- A replayed Steroids tool with preloaded public evidence and a declined-indexing path. No actual indexing, arbitrary shell execution, or model-written arbitrary JavaScript is permitted.
- The normal pre-review verification budget is deliberately already consumed. Writer handoffs get a fresh budget, matching a new GG prompt.
- The already-fixed coverage tracker is held constant across instruction variants. This is an instruction/workflow comparison, **not** a full old app binary versus new app binary test.

## Deterministic checks

**212 checks passed in this pass:**

- **108 existing agent-engine tests:** follow-up ordering, timeouts, output ceilings, and related loop behavior.
- **91 existing ggcoder flow/context tests:** verification/review order, coverage, Autopilot verdict/cycle handling, and evidence packaging. This includes the earlier added tracking regressions.
- **13 new benchmark tests:** static baseline extraction without code execution, exact replacement guards, medians, Markdown/empty-result assessment, warning loss in the production parser, safe patch containment, six executable fixture oracles, and subprocess cancellation.

No existing assertions were weakened, skipped, or deleted. The earlier tracking regression failed before the production fix. The one-shot verification and warning-loss tests characterize known gaps; a green characterization test does not certify the behavior as safe. Benchmark TypeScript checking also passed.

## Limits and conclusions we are NOT making

- Small controlled fixtures, seeded authorship history, preloaded evidence, one model at low thinking, and warm caches. Not a genuine model-authored multi-file build, broad defect-detection evaluation, or proof about self-justification bias.
- No actual corpus lookup/indexing latency, no fresh discovery comparison, no desktop rendering benchmark, no persistent-watcher benchmark, no cold-versus-warm full app study, and no production concurrency change.
- The six-turn budget is an experimental cost bound, not the app's normal limit. Do not advertise capped runs as fast successful work.
- Safe patch targets deliberately constrain valid syntax. The experiment measures this bounded repair workflow, not unconstrained code-writing ability.
- These results do **not** justify removing Steroids from substantial implementation work or broadly shortening safety instructions. They justify rejecting the tested candidate and prioritizing concrete control/transport fixes.

## Earlier reviewer-only experiment

The initial 18-review experiment measured no repair cycle: Ideal 10.57 s, separate Ken 8.98 s, parallel Ken 7.75 s median. Its fixture checks took only 0.137 s; that overlap could not explain most of the apparent difference. Steroids was unavailable as a tool in that profile. Those measurements are retained as preliminary evidence, **not** the basis for declaring Ken faster end-to-end.

Local bookkeeping was approximately 0.011 ms median over 1,000 small gate lifecycles, with filesystem existence stubbed. Preparing two prompts took approximately 5 ms excluding imports. An actual package typecheck separately took 3.171 s. None supports spending effort on hook-label rendering for speed; phase labels are a clarity improvement.

## Reproduce

```bash
# No LLM calls: render and validate baseline/current/candidate prompts.
pnpm exec tsx experiments/prompt-bench/review-bench.ts

# The 13 deterministic benchmark checks; no LLM calls.
pnpm exec tsx --test experiments/prompt-bench/review-bench.test.ts

# Explicit quota-consuming opt-in: 72 trials, two at a time.
pnpm exec tsx experiments/prompt-bench/review-bench.ts --live --rounds 2
```

Bounds: 1,800 output tokens/turn; six turns/agent phase; one Ken repair/rereview cycle; 180 seconds/trial; 25 minutes overall. Existing GG authentication is loaded by the existing helper, never placed in model context or artifacts. Temporary workspaces are cleaned up. No production prompts, scheduling, parser behavior, or app UI were changed by this study.

Current live evidence: `artifacts/review-study-5IybnE/{metadata,prompts,samples,summary,assessment}.json`. Preliminary evidence: `artifacts/review-bench-Tbxqdu/`. These are ignored local artifacts. The experiment runner evolved; the commands above reproduce the new comparison, not the preliminary profile.
