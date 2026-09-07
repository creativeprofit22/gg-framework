# Completion compatibility fixtures

`project-notes-pre-simplification-validator.ts` is a verbatim copy of
`packages/gg-core/src/project-notes.ts` from the working tree on 2026-09-07,
before implementation of step 2 of approved plan
`e404a232-7a3b-4cf1-a0f0-3a345579f6c0`. Keep it frozen: compatibility tests must
exercise the old validator, not a mock or an alias to the evolving validator.
This pins the inspected pre-change source, not every shipped app version.

The JSON fixture in `fixtures/project-notes-v3-completion-compatibility.json`
is a disposable derivative of the canonical V3 fixture. It retains its
relationships, overrides, completed/archived phase and metadata, and adds
synthetic historical V1/V2 evidence, partial plan steps and pending intent.
The helper adds an unbound phase with no execution/checkpoint history and
models the proposed legacy-compatible Done wire encoding. It does not write
Notes or confer completion authority.

Repository tests use only temporary directories. The writer round-trip exercises
the current repository against old-validator-compatible bytes; it is not an
old-binary writer test. Shipped old writers and concurrent cross-version writers
remain unverified. Direct Done is asserted immediately after the transaction,
without fabricated checkpoints or run-end settlement.

## Additional observed writer check (2026-09-07)

A one-off, copy-only Node check exercised the existing pre-change compiled
`ggcoder/dist/project-notes-repository.js` (its `settlePhaseCompletion` API was
still present), SHA-256
`1aa7d32d91a7eb92d7d1e806406e05f78334bdf17440bfb090642932eef03688`.
It loaded the compatible Done fixture without rewriting primary bytes, saved an
unrelated `currentFocus` update, and preserved every phase subtree including old
pending intent. The result passed the frozen validator at revision 2.
Execution evidence: `499d5a9a-956b-48ab-a738-001cb586a2e1`.

This verifies that particular writer with the local shared dependencies, not a
complete historical installer or concurrent mixed-version daemons. The compiled
artifact is not a checked-in test dependency and may change on the next build.
