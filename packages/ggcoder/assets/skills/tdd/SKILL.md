---
name: tdd
description: Use when asked for test-first development. Do NOT use for post-build tests.
---

# TDD

Red → green, one vertical slice at a time. Before the first test: agree seams (below). Then loop.

## Seams — agree before writing

A **seam** is a public boundary where behaviour is observable: exported function, HTTP route, CLI invocation. Tests live at seams, never in internals. List the seams under test and confirm them with the user (one `ask_user` call, recommended set marked). No test at an unagreed seam.

## The loop

1. **Red.** One failing test at an agreed seam for the next smallest real behaviour. Run it; confirm it fails for the right reason (assertion, not import/syntax error).
2. **Green.** Least code that passes. Run the test and the touched suite.
3. **Repeat.** The next test follows from what the last cycle taught. Never write all tests first, then all code.
4. **Refactor** only on green, as a separate step; rerun tests after.

## Test integrity (agent guard)

- **Tests are frozen during green.** Never edit, delete, skip, loosen, or `.only` a test to make it pass. If a test is wrong, stop, say why, and get agreement before changing it.
- Never special-case test inputs in production code (hard-coded returns for the test's literal).
- Before claiming done, `git diff` the test files; explain any change made during a green step.

## Test quality

- **Expected values from an outside source of truth** — a known literal, worked example, or the spec. Never recompute the expected value the way the code does.
- **Behaviour, not structure.** A test that breaks under a behaviour-preserving refactor is coupled to internals; rewrite it at the seam.
- **Mock only external boundaries** (network, clock, filesystem), and only when slow or stateful.
- **Name like a spec**: "user can check out with an empty cart".
- **Property tests for rules over many inputs** (parsers, round-trips, invariants) when the project already has a property library (fast-check, Hypothesis, proptest); otherwise a table of examples.
- **Optional strength check:** if a mutation tool is already installed (Stryker, mutmut, cargo-mutants), run it on the changed module; surviving mutants point to missing assertions. Do not install one unasked. Manual alternative: break one line of the new code, confirm a test goes red, revert.

Never claim a cycle green that you did not run.

## Scaling: one agent or several

Main thread only — the loop is sequential by design. Never parallelise red/green steps or let a child edit tests.

Sources (accessed 3 October 2026): https://code.claude.com/docs/en/best-practices (failing test before the fix); https://stryker-mutator.io/docs/ (killed vs surviving mutants); https://hypothesis.readthedocs.io/
