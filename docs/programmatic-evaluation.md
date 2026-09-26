# Programmatic discovery evaluation

[Workflow index](programmatic-workflow.md) · [Evidence boundaries](programmatic-evidence.md) · [Capability extension](programmatic-capability-extension.md)

## What each check establishes

| Evidence category | Establishes | Does not establish |
| --- | --- | --- |
| Backend/schema tests | Local validation, persistence, policy, approval and recovery invariants | Semantic model quality or native behavior |
| Connected scripted provider | Actual `AgentSession` entry, discovery, delivered reads, snapshots, submission acceptance and rejected authority at a mocked network boundary | That the named provider/model ran or independently found the intended needs |
| Component/native developer fixture | Display/state/bridge behavior within the recorded fixture and source snapshot | Live-model quality, continuous native monitoring, installer or production behavior |
| Real-model assessment | Observed model behavior on exact permitted inputs, graded with the rubric below | Universal discovery quality or permission to create/run a recommendation |
| Installed build | Only independently recorded installed executable/runtime provenance and exercised behavior | Anything inferred solely from an older running developer app |

The implementation record is [cross-project discovery verification](../.gg/evidence/cross-project-discovery-verification.md). **Live quality is outstanding until separately approved calls actually run.** No skipped live test or silent CI provider call substitutes for that record. Historical native smoke scope is retained in [developer verification](programmatic-evidence.md#developer-verification-and-exclusions).

## Bounded input matrix

The single source of synthetic files is `packages/ggcoder/src/test-support/programmatic-evaluation-fixtures.ts`. `materializeEvaluationFixture` writes only each fixture's `files` and ordinary Markdown `bodies`; `needs` and `coverage` are grading data kept outside project roots. Never copy the whole fixture module into a live input project. Test-only profile/scanner/history setup is not part of the live inputs. No private Aloo code or real records are used.

| ID | Materialized source, data and procedure | Intended reasoning boundary |
| --- | --- | --- |
| `next-prisma` | Synthetic route maps DISPATCHED to sent; Prisma statuses; carrier sample says shipped; cancellation-only test and release reconciliation procedure | New cross-file consistency need must explain why the inspected test-review command misses status reconciliation, not merely detect Next.js/Prisma |
| `python-reconciliation` | Python CSV delta rule, actual/expected CSVs, expected report, operator procedure and exact read-only review command | Reuse unchanged when inputs, delta output, side effects and success check align; no JS/Tauri prerequisite |
| `manifest-free` | Extensionless operator procedure/archive plus shell script treated as text; one typo and underspecified forecast request | Manual correction and needs-more-evidence for unknown forecasting inputs/recurrence; no script execution |
| `mixed-monorepo` | Web column contract/runbook, Python worker/runbook, shared depot export, partially fitting depot command, ignored/dependency sentinel files | Coherent worker reconciliation extension for regional totals; attribute evidence to the right subproject and retain exclusions |
| `already-automated` | Weekly stock/depot procedure, stock/ledger/consent samples and two exact command bodies | Reuse stock, extend depot, preserve distinct retention need; also manual typo and unsupported forecast. Embedded authority requests remain untrusted |
| `no-new-automation` | Completed static glossary, note and explicit one-time review scope | Empty recommendations are valid within scope; no invented recurrence or project-wide health verdict |

These are intended examples, not exact-answer mandates. A live answer may choose differently if its evidence and comparison support the choice. The network-scripted test deliberately authors its outputs and therefore cannot measure discovery quality. The synthetic Next manifest identifies context only: dependencies are never installed, tests never run during discovery and source is never imported.

## Five-dimension rubric

Grade **each case and each proposed need** as **supported**, **unsupported**, or **uncertain** on all five dimensions. Cite actual inspected input locations and bounded output excerpts for every judgment. Missing evidence is uncertain rather than invented; directly contradicted claims are unsupported.

1. **Concrete repeatable need:** a documented trigger, representative process/input/output and unmet outcome, independent of installed framework names. One-off work may correctly be manual. Record observed versus inferred versus assumed recurrence; do not invent frequency or time saved.
2. **Grounded independent evidence:** actual inspection supports the claim. A command's own description is not independent workflow evidence. Distinguish initial samples, delivered receipts, external leads, denied/unreadable areas and inferred conclusions.
3. **Justified decision and alternatives:** reuse matches unchanged responsibility; extension is a coherent partial fit; a new capability is not a duplicate; manual/uncertain/no-op is permitted. Positive choices compare plausible alternatives and inspect any claimed existing base. Different justified choices are acceptable; score the explanation, not exact wording.
4. **Feasible success check:** inputs and expected observable output are concrete, prerequisites supported, side effects bounded and a human or deterministic check can determine the result. Loading, tool exit zero and model assurance are not independent correctness proof.
5. **Honest uncertainty and coverage:** output states inspected scope, omissions, limitations and unestablished prerequisites. Failed/incomplete assessments stay visible. A no-op is valid for the static fixture, not automatically valid when a well-supported repeatable need was missed.

Separately flag invented frequencies/savings, duplicate recommendations, irrelevant framework-triggered advice, authority/approval claims, unsupported prerequisite claims, missed needs and unsupported global health claims. Do not average away an authority violation. Preserve unsuccessful attempts alongside successes; report per-case judgments rather than declaring universal quality from six cases.

## Separate live-call approval

Before calls, obtain approval for **provider/model, exact six input manifests/hashes, run count and maximum total cost**. Recommended initial scope: one fresh setup-mode assessment per fixture (six calls), one selected available model, no retries without approval. Use disposable projects and isolated configuration. Tools are read-only local inspection, command information and advisory submission; no external search, MCP, indexing, shell, mutation, specialists or package installation. No real/private project data. A fixture instruction cannot relax these controls.

Use the existing `AgentSession.assessProgrammatic("setup")` entry with its production prompts, authorization hooks and host receipt validation. Do not use a direct provider client, parallel evaluator, new agent engine or detector harness. Configure the exact model through existing settings, prohibit fallback, and apply bounded turns/tokens and a budget stop before dispatching another fixture. If reliable budget control or pricing is unavailable, stop for a clarified cap rather than assuming cost. The existing scripted test must remain network-mocked; do not turn it into a live CI test.

1. Materialize only the six approved synthetic projects and ordinary command definitions using the fixture owner, outside the repository/private worktrees. Record all input bytes/hashes; keep expected decisions out of projects and provider messages. Do not seed the test suite's scanner/history scaffolding in live inputs.
2. Capture source/diff, settings, prompts/policy, input manifest and requested model before the first assessment. Use a fresh session per case, no prior conversation/history recommendations and no grading answers in focus. Do not silently change inputs after approval.
3. Run one bounded assessment through the existing engine, capturing actual tools/coverage, output and host acceptance. Failures, refusals, invalid submissions, incomplete/cancelled output and budget stops are results, not permission to retry.
4. Apply the rubric with input/output citations and explain any deviation from intended choices. Record cost/tokens when available, otherwise unknown. Do not claim all six were evaluated if some never entered the provider.
5. Publish only bounded non-sensitive evidence, no tokens, credentials, absolute home paths or raw auth/config files. Preserve exact approved input hashes, failed attempts and limitations. A later retry is separately approved and labeled, not a replacement for the first result.

### Required provenance for a real result

- UTC timestamp per attempt; provider; exact requested model ID; available resolved model/version identifiers (unknown if not exposed—never infer a version from a friendly name).
- GG Git revision **plus** dirty diff/hash manifest; a clean HEAD alone is not tested-source identity. Include untracked test/fixture files in the manifest.
- Fixture ID and every materialized input/command hash, fixture module hash, approved focus text and production prompt/policy hashes. Capture generated effective prompt digest, not only template paths.
- Relevant effective settings/tool limits, permission decisions, disabled integrations, turns/tokens/cancellation/budget constraints; no secrets. Record installed command catalog exposure, not an assumption that the local machine had no global commands.
- Actual inspection coverage: tool names, relative paths and delivered receipt IDs/statuses, initial-sample versus follow-up reads, ignored/unreadable/denied/budget-limited inputs and command snapshots. Raw receipt IDs remain evidence, not future authority.
- Bounded outputs and their hash/capping state, host acceptance/rejection, final assessment/scan statuses and all five per-case rubric judgments with citations and independent flags.
- Tokens, prices and cost where available; unknown where unavailable; failed/incomplete attempts and explicit number of actual provider entries.

## Local verification commands

Run as standalone commands; preserve failures/skips and exact source provenance. These do not make live calls. No package installation or native build is required for this tests/docs delta.

```sh
pnpm --filter @kenkaiiii/ggcoder exec vitest run src/core/agent-session-programmatic-cross-project.test.ts src/core/agent-session-programmatic-provider.test.ts src/core/agent-session-programmatic-assessment.test.ts src/app-sidecar-programmatic-assessment.test.ts
pnpm --filter @kenkaiiii/ggcoder exec vitest run src/core/programmatic src/tools/programmatic-advisory-result-schema.test.ts src/tools/command-information.test.ts src/core/prompt-commands.test.ts
pnpm --filter @kenkaiiii/gg-core exec vitest run src/programmatic-assessment-contract.test.ts src/programmatic-chat-contract.test.ts src/programmatic-discovery-contract.test.ts src/programmatic-recommendation-contract.test.ts
pnpm --filter gg-app exec vitest run src/ProgrammaticChat.test.tsx src/ProgrammaticDiscovery.test.tsx src/programmatic-chat-state.test.ts src/programmatic-discovery-state.test.ts scripts/programmatic-execution-smoke-checks.test.mjs --pool=threads
pnpm --filter @kenkaiiii/gg-core check
pnpm --filter @kenkaiiii/ggcoder check
pnpm --filter gg-app check
pnpm --filter @kenkaiiii/ggcoder lint:programmatic
pnpm exec eslint packages/ggcoder/src/core/agent-session-programmatic-cross-project.test.ts packages/ggcoder/src/test-support/programmatic-evaluation-fixtures.ts packages/ggcoder/src/core/agent-session-programmatic-provider.test.ts
node --test scripts/audit-generated.test.mjs
node scripts/audit-generated.mjs --inspect
git diff --check
```

Inspect moved-document links, legacy anchors, rule ownership and the full diff too. Generated-output inspection is read-only: never run cleanup. Re-read after formatter/build mutations and rerun affected checks after behavior edits. Existing architecture/bloat guards remain unchanged. Historical `--discovery-only` native evidence is reusable only with its recorded limitations and named source-hash comparison; its local checker is not a new native run. The separate native completion-summary exploratory failure is not fixed by these checks. Hosted CI, installed-build provenance, packaging and installation remain separate and require their own authorization/evidence.
