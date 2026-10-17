# Reviewing Tests

Coverage says a line ran, not that a test would notice it breaking. Review tests with a mutation-testing mindset: "if I broke this line, which test fails?"

## Checks

1. **Each behaviour change has a test that fails without it.** Mentally revert the production hunk and trace which assertion would fail. None → the test does not cover the change. (Do not stash or reset the author's work to check; if a run is needed, ask first.)
2. **Mutation spot-check on critical lines** (money, auth, data writes, parsing boundaries): flip a comparison, drop a condition, return early. If a test framework exists (e.g. StrykerJS, mutmut, PIT), suggest running it on the changed files only; do not install it unasked.
3. **Assertion quality.** Flag:
   - no assertion, or only `toBeDefined`/`toBeTruthy`/`not.toThrow` where a value is knowable;
   - asserting a mock was called, with no check of the outcome;
   - snapshot of a huge object where one field matters;
   - assertions on private internals that block refactoring.
4. **Real seams.** Mocks only at external boundaries (network, clock, filesystem, randomness). Mocking the unit under test, or the module next to it, proves nothing.
5. **Edge cases present:** empty, null/undefined, boundary values, error path, concurrency/ordering when relevant.
6. **Determinism.** No real time, randomness, network, or test-order dependence. Flaky = blocking.
7. **Test diffs in a "no behaviour change" PR** need a stated reason; otherwise treat as weakened tests (see `agent-diffs.md` table).

Report test findings under **[standards]** unless a required test the spec asked for is missing — that is **[spec]**.
