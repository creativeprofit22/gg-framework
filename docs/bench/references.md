# References

Every source that informed the bench kit, how deeply it was read, its licence
status, and how it was used.

Use labels:

- **ported**: logic carried over from this repository and adapted. Covered
  by this repository's MIT licence.
- **pattern**: an in-repo convention the kit follows (file layout, installer
  shape, test style). No code copied.
- **idea only**: the method was read and the kit implements it in its own
  code. No source was copied.
- **not used**: reviewed and rejected, or kept only for traceability.

Licence status: external licences were **not verified** for any source
below. That is why every external source is "idea only". Upstream
`KenKaiii/gg-framework` is this project's upstream and is MIT at the fork's
HEAD. Its licence at the older commits cited below was not separately
checked.

Depth: **read** means the cited lines were read and relied on. **Skimmed**
means a research helper reviewed it during the design session but it did not
shape the design.

## This repository (fork HEAD `ab50288c`)

| Source                                                                                   | Depth | Use     | What it gave                                                                   |
| ---------------------------------------------------------------------------------------- | ----- | ------- | ------------------------------------------------------------------------------ |
| `bench/search/stats.mjs:7-16,74-132,230-253`                                             | read  | ported  | mulberry32 RNG, percentiles, hierarchical bootstrap, Wilson, verdict shape     |
| `bench/search/spec.mjs:245-262`                                                          | read  | ported  | Keep/kill rule shape (≥ 1.30×, CI lower bound > 1.0) and statistics constants  |
| `bench/search/provenance.mjs:121-180`                                                    | read  | ported  | Commit and clean-worktree guard, generalised (no `packages/ggcoder` hard-code) |
| `docs/adr/0004-search-benchmark-harness.md`                                              | read  | pattern | Pre-registration, fresh workers, rotated order, rejected alternatives          |
| `packages/ggcoder/scripts/install-setup-sweep-command.mjs:1-51` and `.test.mjs:1-206`    | read  | pattern | Atomic installer and command-text contract tests                               |
| `packages/ggcoder/assets/commands/setup-sweep.md:1-30,161-260,532-563`                   | read  | pattern | Setup command structure: non-negotiables, detection, re-read, `Next:` line     |
| `packages/ggcoder/scripts/audit-command-family.test.mjs:1-106`                           | read  | pattern | Command-asset test conventions                                                 |
| `packages/ggcoder/src/cli.ts:297-298`, `src/modes/json-mode.ts:145-146`                  | read  | pattern | How `ggcoder --json` runs headless and what it emits                           |
| `packages/gg-ai/src/types.ts:296-305`                                                    | read  | pattern | Usage fields parsed from agent output                                          |
| `packages/ggcoder/package.json:92-105`, root `package.json:14,21,34`, `.gitignore:60-75` | read  | pattern | `assets` ships in `files`; test chain; ignore conventions                      |
| `gg-app/scripts/bundle-sidecar.mjs:36-39,302-305`                                        | read  | pattern | Sidecar bundles only skills and motion; test-file name tokens to avoid         |

## Ken's removed history (upstream `KenKaiii/gg-framework`)

| Source                                                                                                                                                                                                                                                                          | Depth | Use       | What it gave                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | --------- | ------------------------------------------------------------------------------ |
| [prompt-bench/comparison-bench.ts](https://github.com/KenKaiii/gg-framework/blob/31ca46936d6e50eae606debbc62b04da112cc73a/experiments/prompt-bench/comparison-bench.ts)                                                                                                         | read  | idea only | Five pass/fail checks, sandbox, seeded schedule, frozen protocol               |
| [prompt-bench/comparison-analyze.py](https://github.com/KenKaiii/gg-framework/blob/31ca46936d6e50eae606debbc62b04da112cc73a/experiments/prompt-bench/comparison-analyze.py)                                                                                                     | read  | idea only | Wilson interval, task-clustered bootstrap, refusing to analyse incomplete runs |
| [prompt-bench/comparison-adjudicate.py](https://github.com/KenKaiii/gg-framework/blob/31ca46936d6e50eae606debbc62b04da112cc73a/experiments/prompt-bench/comparison-adjudicate.py)                                                                                               | read  | idea only | Negation-aware "claimed tests passed" check; grader fixes kept separate        |
| [ui-library-real-flow/budget.mjs](https://github.com/KenKaiii/gg-framework/blob/31ca46936d6e50eae606debbc62b04da112cc73a/bench/ui-library-real-flow/budget.mjs)                                                                                                                 | read  | idea only | Spend broker: approved caps, worst-case reservation                            |
| [bench/RESULTS.md](https://github.com/KenKaiii/gg-framework/blob/20dd2f3b2ee08c867ef3464b903667e520f932c6/bench/RESULTS.md) and [bench/baseline/BASELINE.md](https://github.com/KenKaiii/gg-framework/blob/20dd2f3b2ee08c867ef3464b903667e520f932c6/bench/baseline/BASELINE.md) | read  | idea only | Verdict vocabulary and the adoption ledger                                     |
| [bench/lib.mjs](https://github.com/KenKaiii/gg-framework/blob/20dd2f3b2ee08c867ef3464b903667e520f932c6/bench/lib.mjs)                                                                                                                                                           | read  | idea only | The harness-bug lesson (`toolcall_done`): status from terminal events          |
| [prompt-bench/review-bench.md](https://github.com/KenKaiii/gg-framework/blob/583d10eb813e3e01264b41b5e2b52813470c3c02/experiments/prompt-bench/review-bench.md)                                                                                                                 | read  | idea only | Matched-subset reporting, pilot exclusion, honest scope limits                 |

## Open-source evals and benchmark tools (relied on)

All idea only, licence not verified, depth read.

| Project                 | Link                                                                                                                                                                  | What it gave                                                         |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Harbor                  | [claude_code.py#L596](https://github.com/harbor-framework/harbor/blob/96ff9c6db90cc015f0fc0987d896670c9c5f1fad/src/harbor/agents/installed/claude_code.py#L596)       | Error classification from terminal events only                       |
| Harbor                  | [claude_code.py#L2189](https://github.com/harbor-framework/harbor/blob/96ff9c6db90cc015f0fc0987d896670c9c5f1fad/src/harbor/agents/installed/claude_code.py#L2189)     | Headless agent run                                                   |
| Harbor                  | [claude_code.py#L1205](https://github.com/harbor-framework/harbor/blob/96ff9c6db90cc015f0fc0987d896670c9c5f1fad/src/harbor/agents/installed/claude_code.py#L1205)     | Reported vs estimated cost kept apart                                |
| Harbor                  | [docker.py#L208](https://github.com/harbor-framework/harbor/blob/96ff9c6db90cc015f0fc0987d896670c9c5f1fad/src/harbor/environments/docker/docker.py#L208)              | Container network policy                                             |
| SWE-bench               | [grading.py#L237](https://github.com/SWE-bench/SWE-bench/blob/02e7a74ffd0b707aab73d203fe87bdc7c76afc8e/swebench/harness/grading.py#L237)                              | Fail-to-pass / pass-to-pass grading                                  |
| SWE-bench               | [grading.py#L292](https://github.com/SWE-bench/SWE-bench/blob/02e7a74ffd0b707aab73d203fe87bdc7c76afc8e/swebench/harness/grading.py#L292)                              | Zero tests counted as success (the kit treats it as an invalid task) |
| SWE-bench               | [grading.py#L309](https://github.com/SWE-bench/SWE-bench/blob/02e7a74ffd0b707aab73d203fe87bdc7c76afc8e/swebench/harness/grading.py#L309)                              | Resolution status                                                    |
| SWE-bench Pro           | [swe_bench_pro_eval.py#L96](https://github.com/scaleapi/SWE-bench_Pro-os/blob/66f92766bba642462d4bbe5479e83f91f9211862/swe_bench_pro_eval.py#L96)                     | Grading entry script                                                 |
| terminal-bench          | [test.sh#L6](https://github.com/harbor-framework/terminal-bench/blob/5a3f5dadcfa704f1741127ba64131d0b6217472b/scripts/rubric-regression/templates/test.sh#L6)         | Reward contract                                                      |
| Repo2RLEnv              | [bundle.py#L137](https://github.com/huggingface/Repo2RLEnv/blob/27d04ee8203cd5b2f20c3997d13836e5f5b64238/src/repo2rlenv/emitter/bundle.py#L137)                       | Task bundle identity hash                                            |
| Repo2RLEnv              | [bundle.py#L179](https://github.com/huggingface/Repo2RLEnv/blob/27d04ee8203cd5b2f20c3997d13836e5f5b64238/src/repo2rlenv/emitter/bundle.py#L179)                       | Task bundle layout                                                   |
| Repo2RLEnv              | [validation.py#L173](https://github.com/huggingface/Repo2RLEnv/blob/27d04ee8203cd5b2f20c3997d13836e5f5b64238/src/repo2rlenv/validation.py#L173)                       | Task layout validation                                               |
| Repo2RLEnv              | [jest_parser.py#L183](https://github.com/huggingface/Repo2RLEnv/blob/27d04ee8203cd5b2f20c3997d13836e5f5b64238/src/repo2rlenv/log_parsers/jest_parser.py#L183)         | vitest/jest result parsing                                           |
| Repo2RLEnv              | [log_parsers/\_\_init\_\_.py#L78](https://github.com/huggingface/Repo2RLEnv/blob/27d04ee8203cd5b2f20c3997d13836e5f5b64238/src/repo2rlenv/log_parsers/__init__.py#L78) | Test runner detection                                                |
| inspect_ai              | [reducer.py#L164](https://github.com/UKGovernmentBEIS/inspect_ai/blob/e3310b753cd270e2d2b84f2be4924575d454da70/src/inspect_ai/scorer/_reducer/reducer.py#L164)        | pass@k                                                               |
| inspect_ai              | [std.py#L109](https://github.com/UKGovernmentBEIS/inspect_ai/blob/e3310b753cd270e2d2b84f2be4924575d454da70/src/inspect_ai/scorer/_metrics/std.py#L109)                | Clustered standard error                                             |
| inspect_evals           | [scorers.py#L177](https://github.com/UKGovernmentBEIS/inspect_evals/blob/ab32a85be8340e63f0f33f4e96fe29c46ce50dc0/src/inspect_evals/swe_bench/scorers.py#L177)        | Errored rather than zero                                             |
| AppWorld                | [environment.py#L1120](https://github.com/StonyBrookNLP/appworld/blob/42b5bcf3cd334fee33f0c37c02070a9f5807add5/src/appworld/environment.py#L1120)                     | State-based evaluation and side-effect log                           |
| criterion.rs            | [html/mod.rs#L812](https://github.com/bheisler/criterion.rs/blob/3dbc6c618acb48885066422d81d50729aa17b2b7/src/html/mod.rs#L812)                                       | CI-vs-noise classification                                           |
| criterion.rs            | [tukey.rs#L253](https://github.com/bheisler/criterion.rs/blob/3dbc6c618acb48885066422d81d50729aa17b2b7/src/stats/univariate/outliers/tukey.rs#L253)                   | Tukey fences                                                         |
| mitata                  | [lib.mjs#L134](https://github.com/evanwashere/mitata/blob/8a956d3facd42dbb32c9820852451f34d1c40b44/src/lib.mjs#L134)                                                  | Stop when min samples and min time are met                           |
| mitata                  | [lib.mjs#L210](https://github.com/evanwashere/mitata/blob/8a956d3facd42dbb32c9820852451f34d1c40b44/src/lib.mjs#L210)                                                  | gc before the loop                                                   |
| mitata                  | [lib.mjs#L275](https://github.com/evanwashere/mitata/blob/8a956d3facd42dbb32c9820852451f34d1c40b44/src/lib.mjs#L275)                                                  | Heap delta                                                           |
| pyperf                  | [\_manager.py#L50](https://github.com/psf/pyperf/blob/00556e18777c36cfd96c91fdf1cd6bf70dd8c276/pyperf/_manager.py#L50)                                                | Worker processes                                                     |
| pyperf                  | [\_cli.py#L452](https://github.com/psf/pyperf/blob/00556e18777c36cfd96c91fdf1cd6bf70dd8c276/pyperf/_cli.py#L452)                                                      | Stability warnings                                                   |
| hyperfine               | [benchmark/mod.rs#L128](https://github.com/sharkdp/hyperfine/blob/c5161524980522320c7d3425e714cc0965a869a5/src/benchmark/mod.rs#L128)                                 | Prepare hook                                                         |
| hyperfine               | [statistics.rs#L130](https://github.com/sharkdp/hyperfine/blob/c5161524980522320c7d3425e714cc0965a869a5/src/quantity/statistics.rs#L130)                              | MAD z-score                                                          |
| hyperfine               | [cli.rs#L219](https://github.com/sharkdp/hyperfine/blob/c5161524980522320c7d3425e714cc0965a869a5/src/cli.rs#L219)                                                     | Parameter scan                                                       |
| hyperfine               | [cli.rs#L347](https://github.com/sharkdp/hyperfine/blob/c5161524980522320c7d3425e714cc0965a869a5/src/cli.rs#L347)                                                     | JSON export                                                          |
| tinybench               | [statistics.ts#L216](https://github.com/tinylibs/tinybench/blob/1289362bc4fe1577e055e3592aca3155da536be3/src/statistics.ts#L216)                                      | Result statistics shape                                              |
| moltar benchmarks       | [register.ts#L35](https://github.com/moltar/typescript-runtime-type-benchmarks/blob/499f3fb88a402e1f8fdbfab2385d82af3d7f5e19/benchmarks/helpers/register.ts#L35)      | One interface for all candidates                                     |
| moltar benchmarks       | [assertLoose.ts#L52](https://github.com/moltar/typescript-runtime-type-benchmarks/blob/499f3fb88a402e1f8fdbfab2385d82af3d7f5e19/benchmarks/assertLoose.ts#L52)        | Correctness checks before timing                                     |
| github-action-benchmark | [write.ts#L302](https://github.com/benchmark-action/github-action-benchmark/blob/84ec6ea748925b6580796c05ce7a1c8fd0d15f3b/src/write.ts#L302)                          | Alert vs fail tiers                                                  |
| bencher                 | [limits/mod.rs#L56](https://github.com/bencherdev/bencher/blob/e2c5af8bc599561e0fb49e933971d3daca3d1230/lib/bencher_boundary/src/limits/mod.rs#L56)                   | Threshold models                                                     |
| lm-evaluation-harness   | [task.py#L74](https://github.com/EleutherAI/lm-evaluation-harness/blob/d6de81643928d653435c431bae19945d41d32520/lm_eval/api/task.py#L74)                              | Task versioning                                                      |
| HELM                    | [statistic.py#L33](https://github.com/stanford-crfm/helm/blob/63754d05db6f874e41a395880fb573890a13e791/src/helm/benchmark/metrics/statistic.py#L33)                   | Named multi-metric statistics                                        |
| openai/evals            | [registry.py#L216](https://github.com/openai/evals/blob/8eac7a7de5215c907fbddc30efdaf316913eccdd/evals/registry.py#L216)                                              | Glob selection                                                       |
| Netflix VMAF            | [output.c#L117](https://github.com/Netflix/vmaf/blob/272c5967701017b90a0ebcff24205e59dbba6421/libvmaf/src/output.c#L117)                                              | VMAF JSON output, the quality-gate example                           |
| deepeval                | [g_eval.py#L53](https://github.com/confident-ai/deepeval/blob/727203702cddf68e4f01a6ef95b23d9cb9036654/deepeval/metrics/g_eval/g_eval.py#L53)                         | **Not used**: LLM-judge metric, rejected as a gate                   |

## Reviewed but not relied on

All skimmed, licence not verified, not used. Kept for traceability.

- Harbor: [Claude Code flag table](https://github.com/harbor-framework/harbor/blob/96ff9c6db90cc015f0fc0987d896670c9c5f1fad/src/harbor/agents/installed/claude_code.py#L61), [trajectory token fill](https://github.com/harbor-framework/harbor/blob/96ff9c6db90cc015f0fc0987d896670c9c5f1fad/src/harbor/agents/installed/claude_code.py#L1806), [pinned-CLI judge backend](https://github.com/harbor-framework/harbor/blob/96ff9c6db90cc015f0fc0987d896670c9c5f1fad/packages/rewardkit/src/rewardkit/agents.py#L876)
- terminal-bench: [legacy layout](https://github.com/harbor-framework/terminal-bench/blob/5a3f5dadcfa704f1741127ba64131d0b6217472b/legacy/cancel-async-tasks/solution/solve.sh#L14)
- inspect_ai: [at_least reducer](https://github.com/UKGovernmentBEIS/inspect_ai/blob/e3310b753cd270e2d2b84f2be4924575d454da70/src/inspect_ai/scorer/_reducer/reducer.py#L130), [reducer protocol](https://github.com/UKGovernmentBEIS/inspect_ai/blob/e3310b753cd270e2d2b84f2be4924575d454da70/src/inspect_ai/scorer/_reducer/types.py#L7), [CI method](https://github.com/UKGovernmentBEIS/inspect_ai/blob/e3310b753cd270e2d2b84f2be4924575d454da70/src/inspect_ai/scorer/_metrics/std.py#L166)
- AppWorld: [CLI evaluate](https://github.com/StonyBrookNLP/appworld/blob/42b5bcf3cd334fee33f0c37c02070a9f5807add5/src/appworld/cli.py#L1971)
- criterion.rs: [saved config](https://github.com/bheisler/criterion.rs/blob/3dbc6c618acb48885066422d81d50729aa17b2b7/src/connection.rs#L352), [noise default](https://github.com/bheisler/criterion.rs/blob/3dbc6c618acb48885066422d81d50729aa17b2b7/src/lib.rs#L582), [comparison groups](https://github.com/bheisler/criterion.rs/blob/3dbc6c618acb48885066422d81d50729aa17b2b7/benches/benchmarks/compare_functions.rs#L27), [outlier labels](https://github.com/bheisler/criterion.rs/blob/3dbc6c618acb48885066422d81d50729aa17b2b7/src/stats/univariate/outliers/tukey.rs#L189)
- tinybench: [warm-up defaults](https://github.com/tinylibs/tinybench/blob/1289362bc4fe1577e055e3592aca3155da536be3/src/bench.ts#L215)
- pyperf: [calibration](https://github.com/psf/pyperf/blob/00556e18777c36cfd96c91fdf1cd6bf70dd8c276/pyperf/_manager.py#L86)
- bencher: [Student-t limits](https://github.com/bencherdev/bencher/blob/e2c5af8bc599561e0fb49e933971d3daca3d1230/lib/bencher_boundary/src/limits/mod.rs#L111)
- moltar benchmarks: [addCase](https://github.com/moltar/typescript-runtime-type-benchmarks/blob/499f3fb88a402e1f8fdbfab2385d82af3d7f5e19/benchmarks/helpers/register.ts#L76), [parseSafe fixtures](https://github.com/moltar/typescript-runtime-type-benchmarks/blob/499f3fb88a402e1f8fdbfab2385d82af3d7f5e19/benchmarks/parseSafe.ts#L4)
- lm-evaluation-harness: [metadata version override](https://github.com/EleutherAI/lm-evaluation-harness/blob/d6de81643928d653435c431bae19945d41d32520/lm_eval/api/task.py#L647)
- HELM: [metric names](https://github.com/stanford-crfm/helm/blob/63754d05db6f874e41a395880fb573890a13e791/src/helm/benchmark/metrics/metric_name.py#L9)
