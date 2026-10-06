---
name: refactoring
description: Use for behavior-preserving restructuring: extract, move, split, deduplicate, plan a refactor, or migrate an implementation behind an unchanged contract. Baseline tests, small steps, revert-on-red. Do NOT use for requested behavior or API-contract changes (including new return/error semantics), even when called a "refactor"; use the normal implementation workflow with regression tests and update affected callers together. Also exclude bug fixes (root-cause when stubborn), performance work (lean), data migrations (durable), styling/copy, TDD's refactor step (tdd), and rewrites.
license: Behavior-preservation methodology synthesized from public sources (Fowler's Refactoring catalog, Tidy First?, and community agent skills by bienhoang, wondelai, mattpocock, jeffallan, vasilyu1983), audited 2026-09-12.
---

# Refactoring

**Scope gate:** Decide from the requested behavior, not the word "refactor". A requested change to return values, error handling, or an API contract is implementation work, not a behavior-preserving cleanup. Use the normal implementation workflow: inspect the affected callers, make the requested contract and caller changes together, add regression coverage, and run the checks. Do not manufacture a separate pure-rename stage merely to enter this skill. Existing authorization and safety controls still apply. For a genuine behavior-preserving refactor, use the gated loop below unchanged.

**Route first:**

| Situation                                                        | Mode                | Next                                   |
| ---------------------------------------------------------------- | ------------------- | -------------------------------------- |
| Tidy a module/function you are already touching, suite green     | **1. In-the-small** | Execute loop, inline                   |
| User wants a plan, architectural change, or competing approaches | **2. Plan-first**   | Modes → 2                              |
| No/red/unrunnable tests, or migration bigger than one session    | **3. Legacy**       | `references/legacy.md` before any edit |
| Same mechanical change across >~10 files or >~500 lines          | **Codemod**         | `references/legacy.md` → Codemods      |

Change the structure of code without changing what it does. Every observable behavior that exists before the refactoring — including the bugs — must exist after it. This skill exists because agents drift: without hard gates, "refactoring" silently becomes rewriting, and rewriting untested code is how behavior is lost.

**Without tests, you're not refactoring — you're editing.**

## Governing rules

1. **Two hats.** You are either adding function or restructuring, never both in the same change. Mixing them makes each unprovable. If new behavior is genuinely required, finish the structural change first, prove it, then change behavior in a separate step.
2. **The baseline is a gate, not advice.** Before the first edit: the test suite runs green on unmodified code, or you build a safety net first (see mode 3). Record what you ran and its result. A suite that was already red tells you nothing — fix or quarantine the noise before counting on it.
3. **One named transformation per step.** Each step applies exactly one refactoring (Extract Method, Move Function, Introduce Parameter…) and has a name you can state. If you cannot name it, it is not a refactoring — it is a rewrite wearing a costume.
4. **Red means revert, not debug.** After each step, run the smallest relevant suite. Green ⇒ commit (when per-step commits were agreed — see the loop's checkpoint), message names the transformation. Red ⇒ revert the step immediately (`git restore`/`git checkout` the touched files). A red intermediate means the step was too big or wrong; debugging a broken step costs more than re-slicing it.
5. **Never touch tests to get green.** In a pure refactor, modifying, loosening, or deleting an assertion is the cardinal sin — it destroys the only proof you have. If a test blocks legitimate structural change (asserts private internals), convert it to assert observable behavior _before_ the transformation, as its own commit. Any unexplained test change in a refactor diff is a red flag.
6. **Smallest suite per step, full suite per finish.** Iterate fast on the touched area, but before declaring done: full test suite + typecheck + lint, on the same commands CI runs.
7. **Prove it, don't vibe it.** The closing question is not "is this good code" but "can I prove nothing observable changed?" Answer with evidence: suites run, before/after outputs, mutation spot-checks when the boundary is critical. Say plainly what you could not verify.
8. **Make the change easy, then make the easy change** (Beck). Preparatory refactoring — small structural setup that makes the coming feature trivial — is the highest-ROI kind. Do it, then stop.
9. **Public API surface is observable behavior.** Renaming or reshaping an exported symbol, endpoint, or file layout preserves runtime behavior but breaks consumers. Inside the module: refactor freely. Across a published boundary: deprecate-and-alias, never hard-break, unless the user chose the break.
10. **Edit sources, not generated output.** `dist/`, vendored, or generated files are regenerated by their toolchain — hand-editing them is a change that the next build erases. Change the generator or the source, then regenerate.

## Modes

**1. In-the-small** — tidy a module, extract a function, kill duplication while working. The execute loop below, inline, without ceremony. Keep litter-pickup bounded to files you are already touching; a boy-scout sweep across the repo is scope creep.

**2. Plan-first** — the user asks for a refactor plan, the change is architectural, or multiple approaches compete. Interview the problem, explore the repo to verify claims, fix scope as in/out lists, check test coverage (thin coverage is a question to the user, not an assumption), then break the work into a plan of tiny commits — each commit leaves the codebase working. File it where the user wants (issue, doc, or just the reply). Do NOT embed file paths or code snippets in the plan — they go stale before the work starts.

**3. Legacy / untested** — no tests, unrunnable suite, or a migration too large for one session. Do not proceed with the normal loop. Go to `references/legacy.md`: characterization tests capturing _actual_ current behavior (bugs included — log them, don't silently fix them), seams, branch-by-abstraction, parallel change (expand–migrate–contract), strangler fig.

## Execute loop

1. **Baseline.** Run the suite on unmodified code; record green. If red or absent → mode 3. If the project has no VCS, say so and stop for direction. If the working tree is dirty with unrelated changes, see _Dirty tree_ below — a dirty baseline destroys the revert safety.
2. **Commit checkpoint.** Refactoring is safest with per-step commits on a dedicated branch — ask the user once, up front: "I'll commit each verified step on a branch — good?" If they decline, keep steps small and separable and report the step list for review at the end. Never commit without authorization.
3. **Pick one target.** If you were started from a `Fix /sweep:` task, that task's finding and named transformation are the target — still re-read the cited lines, since code may have moved since the sweep. Otherwise, ranked by risk-adjusted value, not by how interesting it is: security → correctness → structure → duplication → naming. Hotspots first — files where churn (recent edit frequency) meets complexity. Smell catalog and metrics thresholds: `references/smells.md`.
4. **Apply one named transformation.** Full mechanics per transformation live in `references/smells.md`. Prefer language-aware tooling (`code_nav` / IDE rename, AST codemods) over regex edits; at scale (>~10 files or >~500 lines), a codemod (ast-grep, jscodeshift, OpenRewrite) is the safe path and regex is the wrong one — workflow in `references/legacy.md`.
5. **Verify.** Smallest relevant suite → green ⇒ commit (message = transformation name) → next target. Red ⇒ rule 4 of the governing rules: revert, take a smaller step.
6. **Close.** Full suite + typecheck + lint, on the same commands CI runs — including every package that imports the code you touched, not just the one you edited (monorepos: respect build order). Report: transformations applied (named), before/after state, smells left and why, anything deferred. Agent-specific drift modes to check before closing: `references/agent-pitfalls.md`.

### Dirty tree

Unrelated uncommitted changes make "revert the step" unsafe. Ask once, with `ask_user`: **commit them first** (recommended) or **stop**. Choosing commit is the authorization: follow the project's `/commit` workflow (project `.gg/commands/commit.md`, else the user's global one) — review and group all uncommitted changes into logical changesets and create one atomic commit per group, using its checks, review gate and push behavior. Then re-check the tree is clean and take the baseline. Never stash, discard, or fold unrelated changes into a refactor commit.

## Risk levels set the safety net

| Risk   | Touching                                   | Minimum net before editing                             |
| ------ | ------------------------------------------ | ------------------------------------------------------ |
| Low    | Pure internals, no I/O                     | Unit tests + types                                     |
| Medium | Module boundary, parsing, state            | + contract tests at the seam                           |
| High   | Money, auth, concurrency, migrations, data | + integration tests, a rollback plan, and small phases |

When unsure whether behavior could change: **do not apply — ask.**

## When NOT to refactor

- No failing demand: nothing to add, nothing hurting. Refactoring without a driver is gold-plating.
- The code is about to be deleted or replaced. Deleting is cheaper.
- You cannot run or construct any safety net and the risk is medium+. Report and stop.
- The rewrite instinct hits ("this is all wrong, let me start fresh"). That is a different conversation with the user, not a refactor — and big-bang rewrites lose the one thing refactoring keeps: working software at every step.

## Scaling: one agent or several

| Situation                                                       | Do                                                                                                                                                                                                                                                                      |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| In-the-small, or one package you can fully read                 | Main thread only. Never spawn.                                                                                                                                                                                                                                          |
| Large codebase: changed symbol has many callers across packages | Impact map first: ONE `spawn_agent` call, ≤ 6 read-only `owl` children, one per package/directory. Brief: the symbol(s) and their definition file:line, the slice's paths, output = every caller/import/dynamic reference as file:line + `checked`/`not checked` lists. |
| Dated claim needed (framework migration, deprecated API)        | One `researcher` child; label result SNAPSHOT with source URL.                                                                                                                                                                                                          |
| Executing transformations                                       | **Serialized in the main thread**, one named step at a time, revert-on-red. Never parallel edits on a shared tree.                                                                                                                                                      |
| Truly independent modules (no shared files, no import edges)    | Optionally one `worker` per module on its own branch; each runs the full loop and its own baseline. Merge one branch at a time, full suite after each.                                                                                                                  |

Merge rule: a child that fails or omits a slice → that slice is `not checked`; treat its callers as unknown and do not change the public signature. Re-open each reported caller before relying on it.

## References

- `references/smells.md` — smell catalog, metrics thresholds, prioritization, transformation mechanics
- `references/legacy.md` — characterization tests, seams, branch-by-abstraction, parallel change, strangler fig, per-phase checkpoints
- `references/agent-pitfalls.md` — how LLM agents specifically break "behavior-preserving", and the layered proof that catches it
