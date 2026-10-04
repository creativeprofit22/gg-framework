# Legacy and Untested Code

For codebases or areas where the baseline gate cannot be met: no tests, an unrunnable suite, or a migration too large to land as small commits. The prime directive still holds — observable behavior preserved, bugs included (log them; fixing them is separate work the user must choose).

## Sequence

**1. Make the system runnable and observable.** Get it to start locally with realistic data. If you cannot execute it, say so and stop — static-only refactoring of critical legacy paths is a coin flip.

**2. Build characterization tests (golden master).** Tests that assert what the code _actually does_, not what it should do:

- Call the boundary (public API, CLI, event handler, exported function) with real inputs.
- Capture the full observable output — return values, written files, emitted events, HTTP responses, log lines.
- Assert the captured behavior, including wrong-looking output. If output looks like a bug, record the bug and pin the bug.
- Sufficient coverage: the paths your refactor will touch and their immediate callers. 80% project coverage is not the bar; coverage of the change surface is.

Approval (snapshot) testing is the cheap way to do this for complex outputs: serialize the output, approve it once as the golden file, and any later diff fails the test (ApprovalTests exists for many languages; Jest/Vitest `toMatchSnapshot` works too). Scrub nondeterministic fields (timestamps, IDs) before comparing, or the net is flaky.

Gate: the characterization suite is **green against the unmodified system** before any refactoring. A red baseline proves nothing later.

**3. Create seams before structure.** A seam is a place where behavior can be intercepted without editing the logic:

- Extract an interface over the dependency, implement it twice (old, new).
- Dependency injection for clocks, RNGs, IDs, filesystem, network — anything that makes behavior nondeterministic.
- Adapter wrapping the legacy module so new code consumes the adapter, not the legacy internals.

**4. Migrate by one of the incremental strategies below** — never big-bang.

**5. Delete last.** The legacy path is removed only after the new path has provably carried the full behavior (characterization suite green against the new path). Before deleting anything old, check why it exists — `git blame` / changelog; code that looks pointless sometimes guards an incident (Chesterton's Fence).

## Incremental migration strategies

### Branch by Abstraction

For replacing an internal implementation that many callers use. Create an abstraction over the old implementation → migrate callers to it one by one (each a working commit) → implement the new behind the abstraction → flip the default → delete the old. Hybrid states are acceptable and working at every commit.

### Parallel Change (expand–migrate–contract)

For changing a live contract (API, storage schema, queue message) where old and new consumers coexist:

1. **Expand** — support both old and new forms side by side; write the new form.
2. **Migrate** — move every consumer to the new form, one by one.
3. **Contract** — after all readers are migrated and nothing reads the old form, remove it.

Never skip the migration phase because tests pass — external consumers may exist that tests don't model.

### Strangler Fig

For replacing a subsystem wholesale. Put a facade in front of the legacy system → route traffic through the facade → intercept one route/slice at a time, implementing it fresh behind the facade (guarded by a feature flag when the slice is risky) → when all slices are intercepted, the legacy core is unused; delete it. Each interception must keep the characterization suite green.

## Codemods (large mechanical changes)

For one transformation applied across many files (rename, API migration, import moves). Tools: **ast-grep** (polyglot structural search/rewrite), **jscodeshift** (JS/TS transforms), **OpenRewrite** (recipes for large-scale refactoring, Java-first, also JS/TS). Use what is already installed; installing one needs the user's OK.

1. **Search before rewrite.** Run the pattern read-only; count matches; spot-check ~5 by hand, including the weird ones (comments, strings, dynamic access, re-exports).
2. **Dry run on one directory**, review the diff, run that package's tests.
3. **Apply repo-wide as its own commit** — the codemod commit contains only codemod output. Hand fixes for leftovers go in a separate commit, so reviewers can trust the mechanical one.
4. **Grep for survivors** the pattern missed (dynamic calls, string references, docs); list them, do not silently hand-edit beyond the plan.
5. Full suite + typecheck + lint across every consuming package.

An agent hand-editing 50 files is a rewrite with 50 chances of drift; a codemod is one reviewable rule.

## Per-phase discipline (all strategies)

Every phase ends with a **validation checkpoint**: characterization + full suite green, and a stated **rollback trigger** — the condition under which this phase is reverted (a commit, a flag flip, never a re-merge). Keep commits bisectable: one phase-step per commit, `git bisect` must stay usable for finding which step changed behavior.

Feature flags guard risky slices, but flags are debt: each one gets a removal issue at creation, and is retired as soon as the new path is proven.

## Sources (SNAPSHOT, accessed 3 October 2026)

- Parallel Change — https://martinfowler.com/bliki/ParallelChange.html
- Strangler Fig — https://martinfowler.com/bliki/StranglerFigApplication.html
- ApprovalTests — https://approvaltests.com/
- ast-grep — https://ast-grep.github.io/ ; jscodeshift — https://jscodeshift.com/ ; OpenRewrite — https://docs.openrewrite.org/
