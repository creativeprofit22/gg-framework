# System-Prompt & Tool-Description Audit — 18 Aug 2026

> **POSTSCRIPT (same day): P1+P2 implemented and A/B-benched.** Changes shipped:
> 4 bullets in `renderWorkSection()` (question-vs-fix, git safety, reproduce-first,
> retry circuit-breaker), 1 paragraph in Code Quality (anti-fake-green, no
> file-variants, test-writing guidance), 3 lines in the bash tool description
> (git-only-when-asked, no `&`/`nohup`, PID-specific kills) + 2 in the cmd.exe
> fallback. Prompt grew 9843→10907 chars (~2460→~2730 tok, +11%). Size-budget
> tests raised deliberately; tool-catalog snapshot regenerated.
>
> **Bench** (`experiments/prompt-bench`, `full` vs new `preguard` variant,
> opus + gpt-5.5, n=5): zero regressions on all existing tasks (read-before-edit,
> match-neighbors, preserve-user-work, handles-bad-input — 100% both variants).
> New guardrail tasks: `no-surprise-commit` 100% both variants (trigger too weak
> in a non-git sandbox — cheap insurance, no signal); `green-honestly` — models
> fixed the source honestly even preguard, and reproduced-before-fix split by
> model (opus 0%/0%, gpt-5.5 100%/100%), i.e. the reproduce-first line showed no
> measurable delta on frontier models at n=5. `question-not-fix`: gpt-5.5
> 100%/100%; opus initially read 40% full vs 100% preguard — first traced to a
> check bug (penalized repro scripts the reproduce-first rule encourages), fixed;
> a clean n=8 rerun still showed 63% vs 100%, exposing a real interaction: the
> reproduce-first bullet ("For a bug… then fix") made opus treat questions about
> bugs as fix requests. Rescoped to "For a **requested** bug fix…" — n=8 rerun
> then read 88% vs 88%, parity with baseline. Net: additions cost ~270 tokens, cause no behavioral regressions,
> and function as insurance for weaker models / harder scenarios the micro-tasks
> can't trigger — consistent with the harness README's own caveat that
> untriggered guardrails read 100% regardless of wording.

Compared GG Coder's prompt stack against the field listed in `coding-agents.md`.
External material fetched live today (subagents, raw.githubusercontent.com): opencode,
OpenAI Codex, Claude Code (v2.0-era leak), gemini-cli, OpenHands (software-agent-sdk),
cline, kilocode, pi, oh-my-pi, oh-my-openagent, DeepSeek-Reasonix, mini-swe-agent,
aider, little-coder, learn-claude-code. All quotes below verbatim from those fetches.

**Verdict: our architecture is at or ahead of the field (tiering, lazy skills, edit
recovery, compaction, overflow). We are missing the cheap _behavioral guardrails_
every Tier-1 agent ships — git safety, verification integrity, bug-fix discipline —
~300 tokens total. One debloat candidate (`edit` schema) is bench-gated.**

---

## 1. Measured baseline (us, today)

| Surface                          |      Size | Notes                                                       |
| -------------------------------- | --------: | ----------------------------------------------------------- |
| Bare system prompt               | ~2.7k tok | `buildSystemPrompt('/tmp')`, no project context             |
| Live tool schemas                |   ~8k tok | `edit` alone ≈ 3.3k tok — fattest artifact in every request |
| With project context (this repo) | ~4.5k tok | mostly CLAUDE.md, user content                              |

Comparison points: pi ≈ 0.4k tok system prompt (no persona/plan/subagents);
Claude Code ≈ 2.1k; codex GPT-5 ≈ 1.6k (GPT-5.1 ≈ 6k); opencode ≈ 1.5k; OMO ≈ 5.5k.
We are mid-field, and ours carries deliberate persona + delegation + tiering that
the lean ones omit. Being 2.7k is not itself a problem; the sections must earn tokens.

## 2. Where we match or beat the field (do not churn)

Verified equivalents or better, several with our own benches behind them:

- **Tool tiering / deferred loading** (`tool-tiers.ts` + `tool_search`) — same as
  codex `defer_loading`, pi snippet tiering, Reasonix frozen tool surface. We have
  the bench (`bench/baseline/14-tool-tiering.mjs`); they have prose.
- **Lazy skills** (name+description only, `skill` tool loads body) — exactly pi's
  pattern, which Tensorlake measured as the core of its sub-1k win.
- **Edit reliability** — our dual-form edit (verbatim + hash-anchored span) with
  `findClosestSnippet` "Closest match in file" + bounded re-read hint is aider's
  proven failed-edit recovery pattern, already shipped. OMO's hashline edit is a
  cousin of our span anchors; theirs also lists harness-side autocorrects so the
  model isn't prompted to be careful about what code already fixes.
- **Overflow recovery** (`overflow.ts` → `~/.gg/tool-output/`) = pi's
  truncated-output-to-temp-file-with-pointer.
- **Compaction** — structured sections ordered by load-bearing-ness, prompt-injection
  guard, "conversation wins over prior summary" merge (opencode/omp carry the same).
- **Project context** — AGENTS.md nearest-wins hierarchy + budget = codex's
  AGENTS.md spec, root-first rendering for recency bias.
- **Prefix-cache discipline** — uncached date marker, append-only tool array,
  env-baked bash description (cmd.exe fallback) = Reasonix's cache-stable rules,
  cline's shell-adaptive description.
- **Code-quality minimization ladder** — no other agent ships an ordered
  stop-at-first-rung reuse ladder. Closest is prose ("respect existing
  conventions"). We're ahead, with A/B numbers.
- **Parallel batching steering + "no re-read after edit" economics** — covered
  (`Batch independent read-only calls…`; our re-read rule scopes to external
  mutators only, matching codex's "do not re-read after apply_patch").

## 3. Gaps — what the field uniformly ships and we don't

### P1 — guardrail blocks (all Tier-1 agents have these; we have none)

1. **Git safety protocol.** We have _zero_ git rules in prompt or bash description
   (verified by grep). Every reference agent ships one because unwanted
   commits/amends/force-ops are the most user-visible agent mistakes.
   Field wording (Codex): "NEVER use destructive commands like `git reset --hard` or
   `git checkout --` unless specifically requested"; "Do not amend a commit unless
   explicitly requested"; Claude Code: "NEVER update the git config", "NEVER run
   force push to main/master", "If the commit fails due to pre-commit hook changes,
   retry ONCE"; Codex dirty-worktree: "You may be in a dirty git worktree. NEVER
   revert existing changes you did not make… If you notice unexpected changes that
   you didn't make, STOP IMMEDIATELY and ask."
   → Add ~5 lines to `renderWorkSection()` + 1 line in bash description. ~80 tok.

2. **Verification integrity (anti-fake-green).** We say "never claim unrun checks
   passed" but nothing forbids _making the check pass by weakening it_ — the #1
   bad-code failure mode (deleted tests, `as any`, `eslint-disable`, skipping
   failing cases). Gemini: "NEVER use hacks like disabling or suppressing warnings,
   bypassing the type system"; Claude Code TodoWrite: "Never mark a task as
   completed when: Tests are failing…".
   → Add to Code Quality after the safety paragraph: never silence a failing check
   (delete/skip tests, type assertions, lint suppressions) to make it pass — fix
   the code or surface the conflict. ~40 tok.

3. **Bug-fix discipline.** Gemini: "For bug fixes, you must empirically reproduce
   the failure with a new test case or reproduction script before applying the fix."
   We run targeted checks after edits but never demand reproduction before the fix.
   → One line in How to Work or Code Quality, pairs with the Verify section. ~30 tok.

4. **Escalation circuit-breaker.** Gemini: "If you have attempted to fix a failing
   implementation more than 3 times without success… Propose a different
   architectural approach." Prevents the doom-loop every agent eventually enters.
   → One line. ~25 tok.

### P2 — one-liners (cheap, each from ≥2 agents in the field)

5. **Question vs fix** (OpenHands): "If the user asks a question, like 'why is X
   happening', don't try to fix the problem. Just give an answer." Our "default to
   action" pushes the wrong way on pure questions. ~20 tok.
6. **No shell backgrounding** — Gemini bans `&`; ours owns `run_in_background` +
   `wake` but never says "never append `&`/`nohup`". One line in bash description.
7. **PID-specific kills** (OpenHands): "Do NOT use general keywords with commands
   like `pkill -f server`… find the exact process ID (PID) first." We carry this
   only as a project CLAUDE.md rule. One line in bash description.
8. **No file variants** (OpenHands): "NEVER create multiple versions of the same
   file with different suffixes (e.g., file_test.py, file_fix.py, file_simple.py)."
   One line in Code Quality.
9. **Test-writing guidance** (Codex + OpenHands): start narrow ("as specific as
   possible to the code you changed"), "do not add tests to codebases with no
   tests", "Do not use mocks in tests unless strictly necessary… test real code
   paths, NOT mocks". ~40 tok in Code Quality or Verify section.

P1+P2 total ≈ 250–350 tokens (+~10% bare prompt) — the exact mistake classes all
eight studied Tier-1/2 agents decided are worth tokens.

### P3 — structural (bigger; bench-gated or strategic)

10. **`edit` schema diet (3.3k tok).** Largest recurring cost in every request.
    Codex ships apply_patch as a FREEFORM (non-JSON) grammar-constrained tool to
    dodge JSON-escaping overhead; OMO lists harness autocorrects so the prompt
    doesn't teach care where code already repairs. Options: trim worked examples
    into the error path (show format help only on failure), or slim the SPAN-form
    docs. Must be gated on `experiments/prompt-bench` edit-failure rate — this
    schema is why our edits apply cleanly; a regression here costs more than the
    tokens save.
11. **Cache-miss diagnostics** (Reasonix `cache_shape.go`): hash system+tool
    schemas per turn, log _why_ the prefix changed (system/tools/compaction).
    Cheap dev telemetry; would have caught the tool-reorder cache-bust class of
    bug automatically. We only normalize cache keys today (`prompt-cache-key.ts`).
12. **Per-model prompt variants** (opencode per-model `.txt`, codex per-model
    `.md`, OMO 8 model variants of one persona): GLM/GPT/Claude respond differently
    to mandates vs prose. Strategic follow-up, not now.
13. **Untrusted-content tagging** (Gemini `<untrusted_context>`, OpenHands
    `<UNTRUSTED_CONTENT>` + risk tiers): wrap tool/MCP output at the harness level.
    We cover this behaviorally (Code Quality "treat external input as hostile" +
    compaction guard + bulletproof skill); the wrappers are stronger injection
    hardening. Candidate for gg-agent/ggcoder work, sized separately.

## 4. Debloat findings — what NOT to add, and what could shrink

- **Do not chase pi's 350 tokens.** Its documented rationale ("frontier models
  don't need extensive behavioral content") holds only because it drops persona,
  plan mode, and subagents. We carry those deliberately; our 2.7k with tiering +
  lazy skills is mid-field and mostly bench-justified.
- **Do not grow mandate stacks Gemini-style** — theirs is the largest prompt
  studied and the direction the minimalists explicitly rebel against.
- **How to Talk (~450 tok) is user persona** — stays, by definition.
- Only real diet target is `edit`'s schema (P3 #10), bench-gated.

## 5. Recommended next step

Implement P1 (git block, anti-fake-green, reproduce-first, circuit-breaker) and the
P2 one-liners in `system-prompt.ts` + `tools/bash.ts`, then A/B through
`experiments/prompt-bench` exactly like the code-quality ladder was — correctness
must not move, and the mistake classes above should show up in failure taxonomy.

## Source-index (fetched 2026-08-18)

- opencode `anomalyco/opencode@dev`: `packages/opencode/src/session/prompt/*.txt`, `tool/*.txt`, `shell.ts`; `core/src/session/compaction.ts`
- codex `openai/codex@main`: `codex-rs/core/gpt_5_codex_prompt.md`, `gpt_5_1_prompt.md`, `tools/handlers/{shell_spec,apply_patch_spec,plan_spec,tool_search_spec}.rs`
- Claude Code v2.0.0 leak (2025-09; treat as era-snapshot): `x1xhlol/system-prompts-and-models-of-ai-tools`
- gemini-cli `google-gemini/gemini-cli@main`: `packages/core/src/prompts/{snippets,promptProvider}.ts`
- OpenHands `OpenHands/software-agent-sdk@main`: `openhands/sdk/context/prompts/sections/{static,dynamic,planning}.py`
- cline `cline/cline@main`: `sdk/packages/shared/src/prompt/{system,cline}.ts`; kilocode `Kilo-Org/kilocode`: `packages/opencode/src/session/prompt/default.txt`
- pi `earendil-works/pi`: `packages/coding-agent/src/core/{system-prompt.ts,tools/edit.ts}`, `packages/agent/src/harness/{system-prompt.ts,tools/bash.ts}`, `docs/compaction.md`; + Tensorlake token measurements
- oh-my-pi `can1357/oh-my-pi`: `src/prompts/{system/personalities,tools}/{default,replace,bash}.md`
- oh-my-openagent `code-yeongyu/oh-my-openagent@dev`: `tools/hashline-edit/tool-description.ts`, `prompts-core`
- DeepSeek-Reasonix `esengine/DeepSeek-Reasonix@main-v2`: `REASONIX.md`, `docs/TOOL_CONTRACT.md`, `internal/agent/cache_shape.go`
- mini-swe-agent v2: `src/minisweagent/config/default.yaml`; aider: `aider/coders/{editblock,wholefile,udiff}_prompts.py`, `base_coder.py`, `base_prompts.py`
- little-coder: `.pi/extensions/{write-guard,read-guard,output-parser,finalize-warn}`; learn-claude-code: `agents/s01_agent_loop.py`, `s_full.py`
