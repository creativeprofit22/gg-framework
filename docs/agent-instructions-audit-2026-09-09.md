# Agent instruction audit — before/after proposal

**Date:** 9 September 2026  
**Baseline:** `53f00ca0`; worktree was clean before this report.  
**Status:** extreme workflow-only profile applied after the response-controlled benchmark and user approval. Original proposal blocks below remain frozen for benchmark reproducibility.

## Applied scope and verification

- Replaced the main workflow/research/quality prose with the compact extreme contract, retaining explicit safety, authorization, precedence, and verification safeguards.
- Preserved both response-policy branches byte-for-byte against the pre-rollout source; regression tests pin their hashes. Review reminders, test-drift reminders, and bundled skill bodies were not changed.
- Active tool schemas own invocation details and the skill catalog. Deferred capabilities remain indexed only when the loader is available; hosts without the skill tool retain the catalog fallback.
- Aligned plan-mode and corpus-tool research guidance with unresolved questions, rather than mandatory research on every task. Kept skill scope/exclusion routing and before-action timing explicit.
- Verified 74 targeted production tests (including the deliberately regenerated prompt golden), nine benchmark-harness tests (including container checks), package typechecking, and lint on touched production/test files. No new paid model trials or full-suite run during rollout.
- Corrected the frozen control fingerprint against both saved prompts and preregistered protocols from all five runs; the recorded control text and measured results did not change.
- Representative assembled prompts: 5,801 characters normal; 7,223 plan mode; 9,102 with TypeScript project guidance. These are prompt-size measurements, not new latency or quality claims.

This applies the extreme workflow with production integration safeguards, not a byte-identical benchmark fixture. Project and language-dependent injection remains intact; the desktop language-detection gap identified below is not fixed by this rollout. Unrelated app edits remain untouched. The installed desktop bundle was not rebuilt or released.

## Historical recommendation (before benchmarking)

Restructure by **ownership and activation**, not by making every sentence shorter:

1. Keep one small, shared baseline for scope, safe changes, verification, and honest reporting.
2. Give each workflow rule one owner; tool schemas own parameters, skills own specialist methods.
3. Activate language guidance consistently across terminal, desktop, and implementation children.
4. Make runtime reminders describe the outstanding obligation, rather than introducing competing policy.
5. Measure behavior before accepting compression. Fewer lines alone is not success.

The immediate priorities are the disconnected desktop language injection, contradictory verification instructions, and an inflexible response budget. Wholesale replacement of the existing prompt is not recommended.

## Scope and measurement

This is a source review of the checked-in instruction system, not a claim to have exhaustively validated every possible assembled conversation. Local user overrides, external MCP descriptions, provider-injected text, and every page of bundled reference material are not exhaustively audited.

Three different quantities matter:

- **Source LOC:** physical lines in files, including comments, blank lines, and implementation code. These are inventory measurements, not model context size.
- **Instruction LOC:** physical lines in the exact before/after text blocks below, including blank lines. These measure the proposed wording only, not an applied TypeScript diff.
- **Words / UTF-8 bytes:** also measured because moving a paragraph onto one line can reduce LOC without saving any context.

Before blocks are exact current rendered wording, or explicitly identified current fragments. After blocks are concrete candidate replacements. Counts exclude code fences, labels, and terminal newlines. Conditional variants are counted separately, not added together as if every session receives them. Implementation and regression-test LOC for routing changes remain unestimated until the patch is designed; inventing a precise source-code saving now would be misleading.

### Current source inventory

| Surface | Files | Source LOC | Interpretation |
|---|---:|---:|---|
| Main system prompt builder | 1 | 586 | Text plus assembly, context loading, and limits |
| Tool hints and cross-tool steering | 1 | 164 | Not the full tool schemas |
| Skill discovery/catalog renderer | 1 | 193 | Loader and compact routing catalog |
| Bundled skill entrypoints | 10 | 933 | `assets/skills/*/SKILL.md`, including metadata |
| All bundled skill Markdown | 114 | 44,872 | Includes those 10 entrypoints; do not add both rows |
| Language pack implementation | 2 | 324 | Pack content and override loader |
| Bundled agent definitions | 1 | 278 | Specialist identities, methods, and tool lists |
| Ken prompt builder | 1 | 396 | Separate mentor role; not ordinary coding instructions |
| Chat-agent non-test TypeScript | 8 | 1,213 | Role-specific prompts plus implementation |
| Ideal-review module | 1 | 287 | Review text, scoring, and coverage tracking |
| Re-grounding module | 1 | 47 | Post-compaction reminder |
| Independent-review module | 1 | 114 | Reviewer task and result protocol |
| Async delegation policy | 1 | 33 | Model/thinking-dependent overlay |
| This repository's `AGENTS.md` | 1 | 22 | Project commands and CI constraints |
| This repository's `CLAUDE.md` | 1 | 47 | Architecture and workflow context |

**Do not interpret 44,872 lines as an always-loaded prompt.** Skills use discovery descriptions and on-demand bodies; reference documents are a separate layer. Deleting reference material to improve initial prompt size would target the wrong cost.

### Measured rendered baselines

Existing tests ran against this checkout:

| Test fixture | Characters | Instruction LOC | Sections |
|---|---:|---:|---:|
| Normal prompt | 9,114 | 81 | 6 |
| Plan-mode prompt | 10,796 | 95 | 7 |
| TypeScript + project context + tools + skill fixture | 13,524 | 127 | 10 |
| Separate prompt-audit fixture | 13,203 | 127 | 10 |

These are **test fixtures**, not the exact prompt received by this desktop session. Dynamic paths, dates, settings, tool availability, and project content affect the real total.

## Spec findings: instruction delivery

### F1 — Language injection is not consistently connected

**Location:** `packages/ggcoder/src/ui/App.tsx:773-823`; `packages/ggcoder/src/core/agent-session.ts:3437-3475`; `packages/ggcoder/src/system-prompt.ts:564-570`.

**Before:** the terminal detects repository languages, refreshes them at turn boundaries, and passes the active language set to the prompt builder. The shared desktop session passes `undefined` for that argument. Consequently the normal desktop path omits both Language Style Packs and the language-dependent verification section.

**After:** move language activation into the shared session lifecycle and give each client the same result. Refresh at task boundaries after filesystem changes; preserve project overrides and avoid rescanning on every token or tool response. Test existing projects, empty projects, newly created files, and multiple languages.

**Why:** this is missing behavior, not excess wording. Shortening a pack will not repair a path that never loads it.

**Important distinction:** this mechanism detects **languages from project files**, not product categories such as “SaaS,” “mobile app,” or “e-commerce.” Request-based skill matching is a separate model-driven mechanism. In an empty directory, file detection cannot guide the first file. For an explicitly selected new stack, a future task-scoped activation should use that declared stack, then reconcile with actual files. Do not guess a stack from vague product labels.

**LOC impact:** runtime/test changes required; no defensible exact code delta yet. Desktop prompt size would increase when previously omitted packs begin loading. That increase buys intended behavior.

### F2 — The skill catalog is duplicated, but removing it blindly would break children

**Location:** `packages/ggcoder/src/core/skills.ts:183-190`; `packages/ggcoder/src/tools/skill.ts:49-61`; `packages/ggcoder/src/system-prompt.ts:479-505,573-575`.

**Before:** the normal prompt contains skill routing and the catalog; the `skill` tool schema independently embeds routing and the same catalog. Named child prompts do not call the system catalog renderer, so their schema can be their only discovery source.

**After:** emit routing and discovery exactly once per effective request. Prefer the tool schema as the catalog owner while it is active, since children already receive that surface; retain an appropriate discovery fallback for deferred tools. Keep skill bodies on demand. Put the revised routing rule in that owner, rather than leaving the old numeric cap in a second copy.

**Why:** this is a confirmed duplication across message and tool-schema payloads, not the false claim that the short checked-in `AGENTS.md` contains the catalog. Merely replacing the tool description with “see Skills above” would break recipients without that section.

**LOC impact:** one dynamic catalog plus its repeated routing can disappear from normal effective requests. The saving depends on installed skills and descriptions; the fixed wording ledger does not invent a total for it. Shared generation and capability tests may add source lines even while request size falls.

### F3 — Specialist prompts need explicit boundaries, not the entire parent personality

**Location:** `packages/ggcoder/src/system-prompt.ts:455-459,479-505`; `packages/ggcoder/src/core/bundled-agents.ts:69-113`.

**Before:** named children replace the parent's identity/talk/work sections, intentionally. Worker instructions unconditionally say to commit, push, and open a PR, while the main prompt restricts publishing to explicit user requests. Specialist output templates coexist with a generic return contract that tells oversized reports to use a file, even for read-only agents.

**After:** share a small capability-appropriate contract for authorized scope, preservation of user work, truthful verification, and reporting. Keep specialist methods separate. Worker tasks must carry the user's explicit authorization for commit/push/PR actions; without it, report the completed local work and do not publish. A caller's internal delegation must not create user permission. Make report formatting compatible with the child's actual tools (P8).

**Why:** role specialization is useful; accidentally losing a shared constraint is not. This is a prompt-level inconsistency, not evidence that an unauthorized push has occurred. Do not claim branch isolation is guaranteed merely by wording; filesystem/worktree behavior needs its own implementation review.

**LOC impact:** a small shared baseline adds text to some children. Remove duplicate specialist rules only after the shared contract covers them; exact source/test changes are not yet specified.

### F4 — Attachment requests can lose their pinned post-compaction instructions

**Location:** `packages/ggcoder/src/core/agent-session.ts:1350-1356,1766-1769,2258-2262`; `packages/ggcoder/src/core/regrounding.ts:22-32`.

**Before:** attachment-bearing user messages can contain an array of text/media parts. Request pinning retains the content only when it is a string; otherwise it stores an empty string. After compaction, the re-grounding reminder can therefore identify the original request as `(empty)` instead of restating the user's textual instructions.

**After:** retain the textual request from content blocks plus bounded attachment references for re-grounding. Do not dump media payloads into the prompt or infer unseen attachment content. Test plain text and mixed text/image requests through compaction.

**Why:** optimizing instruction wording cannot help if the user's original instruction is dropped before a later reminder is assembled. This is a source-traced delivery gap, not a claim that the entire conversation or attachment is deleted.

**LOC impact:** implementation/test changes required; no precise source delta claimed. The recovered text adds context that was previously missing.

## Standards findings: concrete wording proposals

### P1 — Replace competing output restrictions with a concise default

**Location:** `packages/ggcoder/src/system-prompt.ts:58-82`.

**Problem:** a hard whole-reply budget, per-item word limits, limits on naming evidence, and random jokes compete with substantive reviews and technical explanations. The user can explicitly request a detailed comparison, yet the default says nothing is exempt. This is a policy-design issue, not proof that every response fails.

**Before — full current section when `ask_user` is active:**

```before-P1
## How to Talk

Write for severe ADHD: fast scanning, low working memory, easy action.

**Budget: ~120 words, whole reply.** Prose, lists, headers, the ask — everything counts, nothing is exempt. Over budget means cut content, not compress wording.

**First line = actionable state.** Done: the outcome. Blocked or handing off: the ONE next action, plus what already works so finished work is never buried.

**One line per item, ≤15 words, max 5 items.** Needs a second line? That's two ideas — cut one. **Bold** the word that matters.

**Cut what they can't act on.** Reasoning, findings, and history earn a clause only when they change the next move: conclusion, not investigation; never re-explain yourself.

**Plain words by default.** Name a file, symbol, or command only when the user must act on it — then give its stake in the same breath (≤8 words). Otherwise say what it does, not what it's called.

**Default to action.** Take every safe, reversible step the goal implies — never ask permission, merely suggest it, or leave it for the user. When something in How to Work genuinely stops you, ask for the ONE action that unblocks you.

**Every ask is an `ask_user` call — never a sentence.** No question? Just end; never invent one. Any question you'd end on — a blocker OR a soft "want me to also…?" — is a tool call, never prose: no asking line, no blockquote, no options restated as text. Offering optional follow-up work counts as a question. Several: one call, each with your pick marked `recommended`.

Give ONE recommended approach — default to X, switch to Y only when [condition] — not a menu, unless a command's flow defines its own options. Between tool calls, speak only when the plan changes: a decision, tradeoff, surprise finding, or the ask. No preamble, no recap, no hedging, no output dumps. Surface tradeoffs and unverified claims plainly. Rarely and at random (~1 in 6 replies), drop ONE short, absurd, cringey interjection with an emoji — a fart confession (“Woops I just farted!”), a weird craving, a pigeon fact; invent fresh ones, never repeat, never force, never explain.
```

**After:**

```after-P1
## Communication

- Lead with the outcome, or the blocker and the next action.
- Default to about 120 words; expand when the requested explanation, evidence, or deliverable needs it.
- Use short paragraphs or bullets, plain words, and descriptive headings. Include technical names when they clarify the answer.
- Keep findings, tradeoffs, and verification limits that affect the user's decision; omit narration and unsolicited jokes.
- Continue authorized, reversible work. Use the stopping conditions in How to Work; do not invent follow-up questions.
- Ask through `ask_user`, including optional follow-ups; batch related decisions, recommend one choice, and do not repeat the question in prose.
- Between tool calls, speak only when a decision, blocker, or material discovery changes the plan.
```

**Expected improvement:** more usable detailed deliverables without losing short, scannable everyday replies. One communication policy replaces several overlapping restrictions.

**Tradeoff / verification:** replies can be longer when warranted. Retain the current capability-specific fallback for hosts without `ask_user`; do not advertise unavailable tools. Test both branches and a detailed-review request. This changes policy and would require updating tests that intentionally lock the existing wording—not deleting those tests to hide failures.

### P2 — Make research proportional and keep one research policy

**Location:** `packages/ggcoder/src/system-prompt.ts:159-160`; repeated workflows in `:106-107` and `packages/ggcoder/src/core/ideal-review.ts:158-175`.

**Problem:** all nontrivial work takes an unconditional corpus detour even when the repository already demonstrates the exact solution. The corpus is described as the source of truth, while project conventions outrank it elsewhere. The same search/discover/approval procedure is repeated in planning and review.

**Before — current corpus-present fragment, excluding its joining space:**

```before-P2
`steroids` (local corpus of real, current repos) is the source of truth for HOW to build. HARD RULE for nontrivial work: before your first `edit`/`write`, and without being asked, `search` literal tokens, then `show` matching code. Build from real samples, not assumptions. Benchmark comparable implementations: architecture, simplicity, completeness, edge cases, error handling, security, and performance. During Ideal review, reuse samples to compare finished code; research gaps. Fix request-relevant gaps, not taste. Samples guide; they do not replace tests or prove correctness. No hits is NOT permission to write from memory: `discover`, propose the found repos via `ask_user`, `add` on approval, then search/show. If none fit or user declines: use `source_path`/official docs and say the approach is unverified against real usage.
```

**After:**

```after-P2
Reuse verified project patterns first. Check installed source or official documentation when an API or behavior is uncertain.
Use `steroids` search/show for unfamiliar architecture or implementation choices; inspect matching code before adopting it.
Treat examples as evidence, not authority over project requirements or substitutes for tests.
If the corpus lacks needed evidence, discover suitable repositories and request approval before adding them; otherwise use installed source or official docs and disclose material uncertainty.
Reuse established evidence during planning and review; repeat research only when a new question or changed implementation requires it.
```

**Expected improvement:** fewer unnecessary tool calls, less permission friction, and less repeated research. This is a hypothesis to benchmark, not a measured latency saving.

**Tradeoff:** this deliberately relaxes mandatory external comparison. Preserve current dependency verification and approval before indexing. The request to optimize instructions does not itself approve activating this policy change.

### P3 — Make the Ideal reminder a focused check, not a second policy manual

**Location:** `packages/ggcoder/src/core/ideal-review.ts:158-175`.

**Problem:** the runtime reminder repeats the research workflow and can reintroduce policy after the task appeared complete. It should reference a shared policy only where that policy is actually present; named children currently need separate treatment.

**Before — full rendered constant:**

```before-P3
Ideal? Review the actual work against the user's request before the final response. Is it simple, focused, correct, and aligned? Did you over-edit, leave TODOs, miss an obvious case the request called for, or introduce risk? For substantial implementations, use Steroids when available to compare the finished work against comparable real-world code for architecture, simplicity, completeness, edge cases, error handling, security, and performance. Reuse samples already examined; search and read further where evidence is missing. Fix concrete gaps relevant to the user's request and project constraints, not differences in taste. Examples inform judgment; they do not replace tests or prove correctness. Empty corpus or no hits: discover suitable repos, propose them via ask_user, add only on approval, then search and read again. If Steroids is unavailable, discovery finds nothing suitable, or the user declines, use installed source and official docs and state that the work was not cross-checked against real-world implementations. Judge this by reading the code you changed — reuse completed checks while code is unchanged. If anything is wrong, fix it now; rerun the affected checks and reread those changes before finishing; earlier results do not verify later edits. Do not claim coverage without corresponding assertions. If everything is good, respond with the final answer only; do not mention this ideal review unless it changed the work or a required cross-check could not be completed.
```

**After:**

```after-P3
Before finalizing, compare the actual changes with the user's request: completeness, correctness, scope, simplicity, edge cases, and risk.
Read the changed files required by the attached coverage checklist; reuse existing research under the shared research policy.
Fix concrete, in-scope gaps. After further edits, reread those changes and rerun affected checks; unchanged code can reuse completed checks.
Do not claim coverage without assertions or verification without observed results. Report material gaps you could not verify.
Give the final answer without narrating this internal review.
```

**Expected improvement:** less repeated instruction text per review and fewer competing workflows.

**Keep:** review triggers, real read coverage, bounded retries, check freshness, and honest disclosure. Do not remove harness controls in the name of prompt compression. Only use the shared-policy reference after recipients receive that policy; retain an explicit fallback for custom prompts otherwise.

### P4 — Align the main verification rule with the runtime gate

**Location:** `packages/ggcoder/src/system-prompt.ts:98`; `packages/ggcoder/src/core/agent-session.ts:2090-2111`; `packages/ggcoder/src/core/verification-gate.ts:407-435`.

**Problem:** “skip checks after simple edits” is ambiguous about code changes. The runtime can still demand verification after those edits. The agent is told to skip something the harness then requires.

**Before:**

```before-P4
- Skip checks after simple edits. At coherent checkpoints or after risky/non-obvious changes, run one targeted check; fix failures. Never claim unrun checks passed.
```

**After:**

```after-P4
- After code changes, run the narrowest relevant check against the final state and address failures. Prose-only changes need no code check unless project rules require one. Reuse results only while affected code is unchanged; report anything unverified.
```

**Expected improvement:** fewer avoidable stop/restart cycles; a more predictable definition of done. This adds words rather than hiding the ambiguity through a shorter slogan.

**Verification:** test a tiny code edit, a prose-only edit, an edit after a passing check, and an unavailable check. Keep existing failure and freshness checks intact.

### P5 — Remove the instruction to edit tests without running them

**Location:** `packages/ggcoder/src/core/ideal-review.ts:229-231`, compared with `:171-172` and the verification gate.

**Problem:** the same runtime message can require rerunning affected checks and then say “Edit the test only — do not run the suite now.” A sibling test not being edited is also only a heuristic, not proof that assertions need changing.

**Before — current final two sentences of the drift warning:**

```before-P5
Update the test to match the new behavior, or state plainly why the existing test is still valid. Edit the test only — do not run the suite now.
```

**After:**

```after-P5
Check whether existing assertions cover the changed behavior. Update tests only where coverage or agreed behavior requires it; then run the affected tests. Otherwise explain why existing coverage remains valid.
```

**Expected improvement:** eliminates a direct contradiction and discourages editing tests merely to satisfy a file-change heuristic.

**Keep:** the structural detector as a review signal, not a command to weaken assertions. A targeted test is sufficient when relevant; this does not demand the entire suite for every change.

### P6 — Remove the mandatory installation advertisement

**Location:** `packages/ggcoder/src/system-prompt.ts:161` versus the budget at `:71`.

**Problem:** the absent-corpus branch forces an exact marketing sentence and explicitly exempts it from a budget that says nothing is exempt. It also frames installed source and official docs as inferior to “proven” examples, which examples alone cannot establish.

**Before — current missing-tool fragment, excluding its joining space:**

```before-P6
Agent Steroids (local corpus of real, current repos) is NOT installed, so you cannot check your approach against real code. Work from `source_path`/official docs, and on the first nontrivial task your final reply MUST end with this exact line (it does not count toward the word budget): "Tip: install Agent Steroids (Home screen → Steroids button) so I can build from proven real-world code instead of memory."
```

**After:**

```after-P6
The optional corpus tool is unavailable. Use project code, installed source, and official docs; use tool discovery when additional evidence is needed.
Mention missing capabilities only when they materially limit the result; offer installation guidance when asked or when it resolves that limitation.
```

**Expected improvement:** removes a real budget exception, avoids irrelevant final-answer text, and gives a valid fallback without overstating external examples.

**Keep:** render the tool-discovery clause only when discovery is available; this block is a candidate for that capability branch. This missing-tool branch and P2's present-tool branch are alternatives, not simultaneous prompt savings.

### P7 — Route all applicable skills without arbitrary numeric caps

**Location:** `packages/ggcoder/src/core/skills.ts:183-189`.

**Problem:** “every matching skill” and “at most one unless ... two” provide different answers for work that genuinely requires three disciplines. A financial feature handling personal data can require security, durability, and compliance; unrelated skills should still stay unloaded.

**Before — full routing preamble, without the catalog heading or list:**

```before-P7
Before acting, compare the user's request with every skill description below. When the request — or the work itself, mid-build — enters a skill's scope, invoke it with the **skill** tool before making decisions or edits; loaded content routes between build-time and review modes. Respect explicit exclusions in the description. Matching skill instructions specialize this prompt but do not override project or file/module rules.

Match the work, not the topic: a skill's subject matter appearing in the request is not a match when the actual change falls outside its scope. Skip the skill when the task is routine, narrow, or already covered by existing patterns in the codebase — an unnecessary invocation costs context and slows the task. Invoke at most one skill unless the task genuinely spans two, and do not re-invoke a skill whose instructions are already in this conversation.
```

**After:**

```after-P7
Load only skills whose scope matches the actual work, before making decisions or edits in that scope; respect their exclusions.
Load each necessary skill once per conversation. Combine skills when the task genuinely requires them; do not apply an arbitrary numeric cap.
Skill guidance specializes the shared workflow without overriding project or file-level requirements. Skip unrelated or explicitly excluded routine work.
```

**Expected improvement:** consistent handling of cross-disciplinary tasks without loading everything because a keyword appears.

**Tradeoff:** some tasks load more than two skill bodies. That is necessary coverage, not automatically waste. Test a narrow excluded edit and a task with three independently applicable scopes.

### P8 — Make child report instructions compatible with read-only agents

**Location:** `packages/ggcoder/src/system-prompt.ts:442-449`; read-only tool lists in `packages/ggcoder/src/core/bundled-agents.ts`.

**Before — current return-contract bullet:**

```before-P8
- Stay under ~400 words. If the finding is genuinely larger, write it to a file and return the path.
```

**After:**

```after-P8
- Aim for 400 words; include the evidence the caller needs. Write a longer report only when file output is authorized and available; otherwise return it directly, clearly structured.
```

**Expected improvement:** a child is no longer instructed to use an unavailable write tool or omit essential evidence to meet the cap. Preserve answer-first, file:line citations, actual checks, blockers, and assumptions in the other contract bullets.

**Tradeoff:** some child results grow. Prefer focused task briefs rather than a hard cap that makes larger investigations impossible to report.

### P9 — Stop forcing a TDD confirmation when the requested behavior already fixes the scope

**Location:** `packages/ggcoder/assets/skills/tdd/SKILL.md:10-18`.

**Problem:** the skill requires user agreement before every first test, even where the public boundary follows directly from the request. This conflicts with the shared instruction to investigate facts and reserve questions for actual decisions.

**Before:**

```before-P9
## Seams — agree before writing

A **seam** is the public boundary where behavior is observable: an exported function, an HTTP route, a CLI invocation. Tests live at seams; they never reach into internals.

Before the first test, write down the seams under test and confirm them with the user — which boundaries get tests and which stay untested is a decision, and settling it up front is what keeps effort on critical paths instead of every edge case. No test at an unagreed seam.

## The loop

1. **Red.** One failing test at an agreed seam, for the next smallest real behavior. Run it; watch it fail for the right reason.
```

**After:**

```after-P9
## Seams — choose from the request

A **seam** is a public boundary where behavior is observable: an exported function, HTTP route, or CLI invocation. Test behavior there, not private implementation details.

Infer test boundaries from the requested behavior and existing interfaces. Ask only when materially different scopes remain; otherwise state the selected boundary and proceed.

## The loop

1. **Red.** One failing test at the selected seam, for the next smallest real behavior. Run it; watch it fail for the right reason.
```

**Expected improvement:** avoids routine permission round-trips while preserving red-first execution and scope decisions that matter.

**Tradeoff:** an underspecified request can still require a question. Preserve that escape rather than replacing a hard stop with “always guess.” Update the source skill; distribute the packaged copy through the normal build, not a competing manual rewrite.

### P10 — Distinguish new-project defaults from existing-project tooling

**Location:** `packages/ggcoder/src/core/style-packs/packs.ts:21`.

**Problem:** “always” enabling compiler flags is broader than a new-project default and can prompt unnecessary config changes. The existing precedence rule already lets project conventions win, so this is ambiguity to remove—not proof that the pack necessarily overrides them.

**Before:**

```before-P10
- **Tooling.** `tsc --strict` always. Enable `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`. **Biome** (single Rust binary — format + lint) as the default for new projects; fall back to Prettier + `@typescript-eslint/strict-type-checked` only when Biome's rule coverage is insufficient. Don't run both in one project.
```

**After:**

```after-P10
- **Existing projects.** Preserve the configured compiler, formatter, linter, and package scripts; change them only when required by the task.
- **New projects.** Default to strict TypeScript with `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, and `noImplicitOverride`; use Biome, or Prettier plus type-aware ESLint when needed. Choose one formatting/linting setup and verify current compatibility.
```

**Expected improvement:** less unsolicited modernization and clearer first-project guidance. Follow the same scoping principle for framework-required defaults/exports and other language defaults in a subsequent pack-by-pack pass.

**Tradeoff:** this does not settle every tooling preference or certify all language packs. Existing project constraints remain authoritative; no dependency installation is authorized merely by a style recommendation.

## Proposed instruction LOC ledger

These numbers were computed from the paired text blocks, not estimated. All ten before blocks were checked against current source/rendered text. “Delta” means after minus before.

| Proposal | Instruction LOC before → after | LOC delta | Words before → after | UTF-8 bytes before → after |
|---|---:|---:|---:|---:|
| P1 Communication | 19 → 9 | −10 | 358 → 121 | 2,136 → 796 |
| P2 Corpus-present research | 1 → 5 | +4 | 120 → 91 | 837 → 670 |
| P3 Ideal reminder | 1 → 5 | +4 | 227 → 83 | 1,503 → 593 |
| P4 Verification | 1 → 1 | 0 | 24 → 38 | 164 → 253 |
| P5 Test-drift warning | 1 → 1 | 0 | 29 → 30 | 146 → 210 |
| P6 Corpus-absent fallback | 1 → 2 | +1 | 67 → 43 | 412 → 299 |
| P7 Skill routing | 3 → 3 | 0 | 142 → 61 | 890 → 423 |
| P8 Child reporting | 1 → 1 | 0 | 20 → 29 | 100 → 182 |
| P9 TDD seam selection | 9 → 9 | 0 | 112 → 83 | 628 → 532 |
| P10 TypeScript tooling | 1 → 2 | +1 | 42 → 49 | 351 → 409 |
| **All ten paired artifacts, not a single prompt** | **38 → 38** | **0** | **1,141 → 628** | **7,167 → 4,367** |

Across those ten candidate replacements: **45.0% fewer words and 39.1% fewer bytes, despite unchanged total physical lines.** Some lines deliberately grow to repair ambiguity. These are wording savings, not measured provider-token or performance gains.

For comparable selected portions of a parent prompt with skills and the clickable question tool:

| Selected portions only | Instruction LOC | Words | Bytes |
|---|---:|---:|---:|
| Common wording, P1 + P4 + P7 | 23 → 13 (−10) | 524 → 220 (−58.0%) | 3,190 → 1,472 (−53.9%) |
| With corpus, add P2 | 24 → 18 (−6) | 644 → 311 (−51.7%) | 4,027 → 2,142 (−46.8%) |
| Without corpus, add P6 instead | 24 → 15 (−9) | 591 → 263 (−55.5%) | 3,602 → 1,771 (−50.8%) |

**These are not whole-prompt before/after totals.** P3/P5 are runtime follow-ups, P8 is a child contract, P9 is an on-demand skill, and P10 is conditional language guidance. Additional savings from deduplicating catalogs and removing repeated plan/review procedures are not counted. Added language delivery and shared child contracts can offset reductions, correctly.

No runtime source-code LOC reduction is claimed by this wording-only proposal. The source inventory is measured; implementation/test deltas for F1–F4 require an actual patch. This deliberately avoids advertising source-code savings by counting rewrapped English as deleted implementation.

## Keep, rather than compress blindly

- **The ordered minimization ladder.** `system-prompt.ts:182-201` records a small prior experiment where the longer ladder reduced generated code and output tokens. That is limited historical evidence, not a fresh result, but enough not to delete it merely because it is long.
- **Tool capability gating and deferred discovery.** Loaded schemas and deferred hints serve different purposes; removing both makes tools undiscoverable.
- **Project override precedence and context budgets.** Preserve nearest-project conventions and bounded input sizes.
- **On-demand skill bodies.** Discovery metadata is not the same as duplicating the entire skill body.
- **Verification freshness and read coverage.** An attractive final answer is not proof that work was checked.
- **Distinct mentor/chat roles.** Ken and chat specialists are not simply duplicate coding prompts. Share genuinely universal contracts, not coding behavior that conflicts with their jobs.

## Corrections and limits

My earlier statement that the checked-in project instructions duplicate the generated skill catalog was too broad. The actual `AGENTS.md` here is 22 lines and contains no Skills section. The expanded session context showed catalog material adjacent to project context; adjacency is not proof that the repository file contains it. The confirmed issue above is duplicated or conflicting policy across generated instructions and runtime messages, not a blanket finding against `AGENTS.md`.

The bundled skill reference library was inventoried, not read line-by-line in its entirety. No claim is made that every reference page is redundant or correct. User-home overrides were not exhaustively inspected, so the installed application's exact effective instruction stack can differ from this checkout.

## Validation and acceptance criteria

**Already run:**

```text
pnpm --filter @kenkaiiii/ggcoder exec vitest run src/system-prompt.test.ts src/core/language-detector.test.ts src/core/ideal-review.test.ts src/core/skills-routing.test.ts
4 files passed; 83 tests passed.
```

The existing prompt “audit” is largely an obsolete-phrase denylist plus exact duplicate-sentence detection (`system-prompt.test.ts:49-79`). It does not prove semantic consistency between prompt sections, tool schemas, and runtime follow-ups. Its zero flags do not refute the contradictions above.

**Before implementation is accepted:**

1. Render a matrix of desktop, terminal, named child, custom prompt, plan mode, tool availability, and language combinations. Assert expected policy presence and absence at those real seams.
2. Add regression cases for verification/test-drift agreement, detailed-answer requests, and multiple applicable skills.
3. Preserve meaningful behavioral assertions while replacing literal old-wording assertions with checks for the agreed new contract. Do not weaken tests to make a rewrite pass.
4. Reuse the existing `experiments/prompt-bench` harness for one-section-at-a-time comparisons. Include safe edits, ambiguous requirements, code reuse, tool discovery, and final verification scenarios.
5. Compare tool-call count, retries, task success, verification accuracy, and actual provider token usage—not LOC alone. Test relevant active models; do not infer general gains from one small run.

No paid model benchmark was run. The expected improvements in this report are prospective; only source counts, rendered fixture sizes, and the listed test results are measured.

## External implementation comparison

Read from the local corpus before drafting:

- [nanobot](https://github.com/HKUDS/nanobot), corpus file `nanobot/agent/context.py:105-167`: separates identity, bootstrap context, tool contract, memory, active skills, and a discovery summary; excludes active skills from that summary. This supports clear ownership and selective loading, not copying its full architecture.
- [aider](https://github.com/Aider-AI/aider), corpus file `aider/coders/base_coder.py:1174-1240`: selects guidance based on actual model and shell-command capabilities. This supports mutually exclusive capability branches rather than appending conflicting generic advice.

These comparisons establish real usage patterns, not proof that the proposed GG wording improves behavior. GG already has valuable selective loading and harness checks; the proposal retains those rather than introducing a new prompt framework.

**Verdict: works with gaps.** The language-dependent feature exists, but delivery is uneven; several instruction contracts conflict. The safe next implementation order is delivery correctness → verification consistency → communication/research simplification → measured specialist cleanup.
