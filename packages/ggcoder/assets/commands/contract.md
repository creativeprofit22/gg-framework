---
argument-hint: [interface, module, or scope — optional]
description: Audit interfaces, types, abstract classes, CLI flags, and documented APIs against their implementations. Find accepted-but-ignored options, half-implemented abstractions, promised-but-missing features — then create one prioritised task per gap.
allowed-tools: tasks, Bash, Read, Write, Edit, Grep, Glob, steroids, ask_user
---

# Contract

Find where the promise doesn't match the reality. When a type says `proxy?: string` but the function never reads it, that's a broken contract. When a base class defines 5 abstract methods but a subclass implements 3, that's a broken contract. Create one actionable task per gap. Do not edit any files.

## Step 1: Determine what to audit

If `$ARGUMENTS` is provided, use it as the interface, module, or boundary to audit.

If `$ARGUMENTS` is empty, infer scope from context — in this order:

- **Git diff** — `git diff --name-only HEAD~1 HEAD` and `git status --short` for recently changed type/interface/CLI/API files
- **Active plan** — most recently modified file in `.gg/plans/`
- **Session context** — what was just discussed or implemented

From that, extract:

- The contract surface in scope (which interfaces, which abstract classes, which CLI surface, which documented API)
- The implementation files that should fulfill those contracts

If nothing can be inferred, ask the user what to audit. Do not proceed blind.

## Step 2: Identify contract boundaries

Find every place a **contract** is defined — a promise of what something accepts, returns, implements, or does:

| Contract                           | Where it lives                                     | What it promises                    | Where to verify                            |
| ---------------------------------- | -------------------------------------------------- | ----------------------------------- | ------------------------------------------ |
| **Type / Interface → function**    | `types/`, `interfaces/`, inline TS types           | "Function accepts these options"    | The function that destructures the options |
| **Abstract class → subclass**      | Base class with abstract methods                   | "Subclasses implement these"        | Every concrete subclass                    |
| **Public exports → consumers**     | `index.ts` barrels, package public API             | "These are available"               | Whether anything actually imports them     |
| **CLI flags → handler**            | Commander/yargs `.option()` calls, `--help` output | "This flag does something"          | The action handler                         |
| **Event system → emitters**        | Event type defs, documented hooks                  | "These events fire"                 | Code that calls `emit`/`dispatch`          |
| **Config schema → consumer**       | Config types, env definitions, JSON/YAML schemas   | "These config values are supported" | Code that reads them                       |
| **API docs → handler**             | OpenAPI, JSDoc, README endpoints                   | "Endpoint returns shape X"          | Actual response construction               |
| **Plugin / hook interface → host** | Plugin base type, registered hooks                 | "Plugins can hook here"             | Whether host code fires every hook point   |
| **Error types → throw sites**      | Custom error classes, error enums                  | "These errors can occur"            | Whether they're ever thrown                |
| **Module interface → modules**     | Shared `ModuleInterface` shape                     | "Every module has these methods"    | Each module's implementation               |

## Step 3: Trace each contract

For each contract in scope, list every field / method / event / flag it promises. Then for each one, find where it's read, called, or used in the implementation. Follow real imports — do not guess.

**Trace deeper before calling anything ignored.** A field that looks unused might be:

- Spread into a sub-call: `doThing(options)` passes everything through
- Destructured later: `const { persona } = options` in a helper
- Used conditionally: only read when another flag is set
- Passed to a base class constructor: `super(options)` propagates it

Confirm it's truly never consumed before flagging. Local declarations, consumers, tests, and runtime evidence are authoritative for whether this project keeps its contract.

**Ground unfamiliar APIs with Steroids before classifying.** If a contract involves a third-party library, framework hook, decorator, or external API you're not certain about, use Steroids to look up canonical usage in real public repos _before_ deciding the implementation is broken. Two reasons:

1. **Avoid false positives.** What looks like an IGNORED field may be consumed through a standard pattern (decorator metadata, framework lifecycle, magic prop) the trace missed. Confirm against real-world usage.
2. **Pre-bake the fix recipe.** Once you've seen how the API is normally wired, you can write a concrete WIRE recipe into the task in Step 7 — actual call signature, import path, surrounding pattern — instead of leaving the fix agent to re-investigate from a cold chat.

External examples cannot prove local deadness, reachability, correctness, or business intent.

Search for the literal symbol (import line, function name, decorator) with `steroids` using `action: "search"` and inspect 2–3 real examples using `action: "show"`. Steroids results: prefer repos active in 2026. Skip stale ones. If Steroids reports a real corpus gap, call `discover` with a short topic query, present suitable repositories, and use `ask_user` for approval before `add`; never call `add` or `discover` with `add: true` before approval. After approval, add only the selected repositories, then repeat `search` and `show`. Skip this whole step for purely project-internal contracts where the local pattern is obvious.

## Step 4: Classify gaps

For every promise that isn't fully kept:

| Gap type            | Meaning                                                                                      |
| ------------------- | -------------------------------------------------------------------------------------------- |
| **IGNORED**         | Field/option accepted by the contract but never read by any implementation                   |
| **PARTIAL**         | Read in some code paths but not others (e.g. wired in path A, ignored in path B)             |
| **STUB**            | Method exists but is empty, throws "not implemented", or returns a hardcoded value           |
| **DOCUMENTED-ONLY** | Mentioned in docs / `--help` / README but no code implements it                              |
| **PHANTOM**         | Implementation reads or returns a field the contract doesn't define (undocumented behaviour) |
| **FACADE**          | Whole module/subclass implements the shape but every method is a stub or throws              |

For each gap, record:

- **WHERE**: `file:line` for the contract definition AND `file:line` for the implementation
- **WHAT**: which promise isn't kept
- **WHY IT MATTERS**: what actually fails or silently degrades

Do NOT track:

- Optional fields with intentional defaults / fallbacks (verify the default is real before skipping)
- Deprecated fields with documented migration paths
- Private internals — only public boundaries (exported types, CLI surface, documented APIs, abstract methods)
- Style, naming, code quality
- Theoretical mismatches that can't actually be triggered

**Note on PARTIAL fulfillment:** A feature that works in 3 of 5 cases is more dangerous than one that doesn't exist at all — users assume it works everywhere. Treat PARTIAL gaps as High severity by default.

## Step 5: Decide wire vs trim vs document

Every gap has one of three correct fixes. Pick the right one **per gap** before writing the task:

- **WIRE** — the feature should work; connect the contract to the implementation. Use when the field/method represents real intended behaviour that just isn't hooked up.
- **TRIM** — the contract was speculative or premature; remove the field/method from the type/interface/docs. Use when nothing real depends on it and writing an implementation would be dead code. **This is often the right answer.**
- **DOCUMENT** — phantom behaviour that's actually useful; add it to the contract instead of removing the behaviour. Use when consumers benefit from the undocumented field.

If you can't tell whether a gap should be wired or trimmed, mark the task as needing a wire/trim decision and explain both options concretely.

## Step 6: Classify by severity

- **Critical** — public API is broken, data is lost, or the contract is a flat lie (FACADE module that's depended on)
- **High** — silent degradation, PARTIAL fulfillment in a real code path, IGNORED option that users actually pass
- **Medium** — STUB that returns plausible-looking wrong data, DOCUMENTED-ONLY feature, PHANTOM field consumers can't type-safely access
- **Low** — speculative IGNORED field nobody uses, latent drift, dead export

## Step 7: Create tasks

For every gap, add one task to the task pane using the `tasks` tool (action: `add`).

Each task must be self-contained — a fix agent in a separate chat must execute it with no extra context. Include:

- Severity label (Critical / High / Medium / Low)
- Gap type (IGNORED / PARTIAL / STUB / DOCUMENTED-ONLY / PHANTOM / FACADE)
- Decision (WIRE / TRIM / DOCUMENT) — or "needs decision" with both options spelled out
- Exact `file:line` for both contract and implementation
- A plain-english description of the gap
- A concrete fix at the code level — actual field names, function names, import paths, where the new wiring goes (not pseudocode). If you grounded the contract against Steroids in Step 3, bake the canonical pattern you saw directly into the task (call signature, import path, surrounding usage). The fix agent should be able to execute, not re-investigate.
- Any related files the fix agent should read first
- **Fallback grounding clause**: if your Step 3 recipe is ambiguous or you couldn't verify the pattern (rare API, no public examples), tell the fix agent to search Steroids for the specific literal symbol and inspect matches with `show` _before_ writing code. Otherwise omit — don't pad every task with redundant lookup instructions.

Order: Critical → High → Medium → Low.

If a gap is too ambiguous to write a concrete fix for, mark it Skipped with a reason — do not silently drop it and do not create vague tasks.

## Step 8: Report

Reply inline with:

```
Audited: <contracts in scope>
Contracts checked: <N>
Gaps found: <N> (<N> Critical, <N> High, <N> Medium, <N> Low)
Tasks created: <N> (<N> wire, <N> trim, <N> document, <N> needs-decision)
Skipped: <N>
```

Then one line per task:

```
[Critical] [WIRE]    file:line — one sentence description
[High]     [TRIM]    file:line — one sentence description
[Medium]   [DECIDE]  file:line — one sentence description
...
```

Then any skipped gaps:

```
Skipped: file:line — reason a concrete fix couldn't be written
```

Keep the report tight. The detail lives in the tasks.
