# Recoverable Roadmap phase deletion

Reviewed: **2026-09-21**. Scope: local Notes → active/archived phase → Delete → Undo or Deleted phases → Recover. This is feature documentation, not release approval or a Roadmap Done decision.

## Meaning and retention

| Action | What it does |
| --- | --- |
| Archive / archive Restore | Moves a present phase between active Roadmap and Archive. Existing behavior remains. |
| Delete phase | Hides a phase from active Roadmap and Archive after confirmation and host checks. Keeps its identity, content and history in Project Notes. |
| Cancel run | Separate execution action. Delete never cancels a run, takes over its lease or resolves advancement on your behalf. |
| Undo | Opens recovery confirmation for the exact deletion acknowledged by the host. Uses the durable Recover operation, not local rollback. No toast timeout. |
| Recover | Returns the same phase to its original active/archived placement, without restarting its old run. Available after ordinary restart. |

**Approved retention is indefinite, with no automatic expiry and no permanent purge.** Deleted content remains in the local Notes store and its backups. This is not erasure, an off-device backup, or a guarantee against disk loss or corrupt-store fallback. A future retention limit or purge requires separate approval.

Recovery keeps Done as historical status. Other phases return as not-started and require fresh binding/execution/plan approval. Old sessions, verification, overrides and reminders are retained as history, not restored as live authority. References, conversations and project files are not deleted.

## Using it

1. Open Notes → Roadmap → a phase → More → **Delete phase**, or use **Delete phase** on an archived row.
2. Pending Notes edits must finish saving. A save error keeps those edits and blocks confirmation.
3. Review the confirmation. **Cancel** or Escape before dispatch writes nothing; Cancel has initial focus.
4. During dispatch, **Deleting…** or **Recovering…** is shown and dismissal is disabled. Submitted writes cannot be cancelled by closing the dialog.
5. After durable acknowledgement, use **Undo**, or open **Archive → Deleted phases → Recover** later. Recovery explains the execution reset before dispatch.

If a response is lost, **Retry same request** retains the original operation identity. A stale revision refreshes authoritative data and requires renewed confirmation; it is never silently rebased. Offline operation never substitutes browser-local deletion. Closing an uncertain-result message does not mean the write failed.

A refusal explains the next action: finish/cancel the active run separately, resolve execution/store recovery, or resolve the outstanding next-phase decision. An unseen nonterminal legacy session binding must be opened and reconciled before deletion. Expiry alone does not prove a lease owner stopped.

**Approved implementation adjustment:** the checkout did not contain the plan's named topology guard or remaining-phase snapshots. The user approved the conservative replacement: **all Delete and Recover operations are refused while any advancement checkpoint remains unresolved**, even for an unrelated phase. No existing commitment is consumed or rewritten to allow deletion.

## Ownership and data flow (CODE)

| Layer | Source and responsibility |
| --- | --- |
| Shared domain | [`roadmap-phase-deletion.ts`](../packages/gg-core/src/roadmap-phase-deletion.ts): exact request/outcome schemas, additive deletion history, generation, canonical replay identity and pure transitions. Re-exported by [`project-notes.ts`](../packages/gg-core/src/project-notes.ts), which validates the full Notes document and retained history. |
| Daemon policy | [`app-sidecar-phase-deletion.ts`](../packages/ggcoder/src/app-sidecar-phase-deletion.ts): derives project scope from the authenticated session; coordinates reconciliation, session startup and lease guards. No model-callable deletion tool. |
| Storage | [`project-notes-repository.ts`](../packages/ggcoder/src/project-notes-repository.ts): revision-CAS, fresh in-lock checks, dedicated mutation, append-only preservation, primary/backup atomic writes and replay. Generic saves cannot remove any persisted phase, create/edit deletion metadata, change deleted content or revive recovered runtime authority. Normal order reindexing remains permitted. |
| Lease admission | [`roadmap-phase-lease-repository.ts`](../packages/ggcoder/src/roadmap-phase-lease-repository.ts) and [`app-sidecar-phase-binding.ts`](../packages/ggcoder/src/app-sidecar-phase-binding.ts): lease-before-Notes ordering; fresh Notes context inside acquisition, including stale replay rejection across deletion generations. Unknown/corrupt lease state refuses deletion. |
| HTTP/native | [`app-sidecar-notes.ts`](../packages/ggcoder/src/app-sidecar-notes.ts) and composition in `app-sidecar.ts`; [`agent/notes.rs`](../gg-app/src-tauri/src/agent/notes.rs), registered in `lib.rs`. Rust retains native credential and logical-session routing; no direct webview HTTP or frontend policy duplication. |
| Client/state | [`agent.ts`](../gg-app/src/agent.ts) validates shared outcomes. [`useProjectNotes.ts`](../gg-app/src/useProjectNotes.ts) provides the save-settlement and authoritative-snapshot bridge with project epochs. [`usePhaseDeletion.ts`](../gg-app/src/notes-roadmap/usePhaseDeletion.ts) owns confirmation, exact retry identity, conflicts, feedback and focus intent. |
| Presentation | `ProjectNotes.tsx` → `NotesModal.tsx` (the actual existing Notes shell in this checkout), `NotesRoadmap.tsx`, `NotesPhaseDetailState.tsx`, `NotesPhaseMoreView.tsx`, [`NotesPhaseDeletionDialog.tsx`](../gg-app/src/notes-roadmap/NotesPhaseDeletionDialog.tsx) and [`NotesDeletedPhases.tsx`](../gg-app/src/notes-roadmap/NotesDeletedPhases.tsx). Existing Modal/Notes controls and CSS tokens are reused. No navigation redesign. |

Execution admission, cancellation, advancement discovery, model-facing projections, active phase context, reminder reservation/final claims and repository mutations reject deleted phases. Recovered phases reject stale revisions/sessions, retired implementation receipts and sessionless legacy lifecycle callbacks. Activity/history arrays remain intact; retired evidence is not presented as current verification in a new run.

Existing completion, user-override and advancement authority rules remain in the [shared Notes contract](../packages/gg-core/src/project-notes.ts) and its compatibility tests. Deletion does not replace or relax those rules. [Maintenance ownership map](notes-roadmap-maintenance.md) is historical context, not an active task inventory.

## Store compatibility and uncertainty (CODE + RUNTIME tests)

- A phase stays in the contiguous Notes array with a stable ID. Optional, versioned deletion metadata holds the current deletion and an append-only delete/recover sequence. Runtime fields are retired into that record; the whole phase is not duplicated into a second store.
- Public Notes remains version 3. The **storage envelope upgrades from v1 to v2 on the first deletion**. Both the prior-snapshot backup and new primary use v2. All later writes stay v2, including after recovery. Reads do not migrate files.
- An interruption after the upgraded backup but before the primary leaves an uncommitted old snapshot. New readers preserve that upgrade on later writes. A completed deletion has a v2 primary and backup; frozen old v1 readers refuse the newer envelope before trying a pre-deletion fallback.
- Unknown newer primary **or backup** formats are protected from overwrite, even when the other file is readable. Existing documents without metadata remain accepted.
- Exact replay returns historical completion plus the **current** snapshot, including when an old Delete is retried after Recover. Reusing an operation ID for different input fails. A new deletion needs a new confirmation and request identity.
- Sync/rename failures can leave an uncertain acknowledgement. The UI does not interpret an exception as proof that nothing persisted. Replay settles the retained request against the current primary.
- If only a backup is readable, deletion/recovery refuses to finalize until storage recovery is resolved. Fallback can expose an older snapshot: **zero data loss is not promised**. No general repair or purge facility is added.

## Verification record

All new tests and drills used synthetic projects or temporary data roots. No real Notes, paid provider prompts, installation or packaging were used. Implementation is uncommitted and unreleased.

| Evidence | Observed result / boundary |
| --- | --- |
| Shared contract suites | 150 tests passed: legacy compatibility, malformed input, retained runtime validation, repeated cycles and pure transitions. |
| Daemon/repository regression selection | 395 tests across 16 suites passed. Covers CAS, two-window replay, lease/bind/start races, pending advancement, fault-injected writes, generic-save bypasses, authenticated HTTP and reminder paths. A final legacy lifecycle regression was first reproduced failing, then fixed; the affected 259-test selection passed afterward. |
| Frontend selection | 278 tests passed, followed by the final 15-test dialog/controller selection after the nested-unmount fix (8 Modal + 7 deletion). Includes save-queue failure preservation, project switching, pending dispatch, conflict confirmation, retry identity, recovery and focus. Mocked client tests are not daemon persistence evidence. |
| Build/type/native checks | gg-core, ggcoder and gg-app checks passed; core/daemon developer builds and frontend build passed. Rust proxy test, `cargo check --offline` and developer `cargo build --offline` passed. Existing Rust dead-code/linker and Vite compatibility/chunk warnings remain; no blanket clean-warning claim. |
| Durable repository drills | Delete → new repository instance → Recover exercised draft, archived, Done and history-bearing phases. Latest timed isolated cycles: 87–95 ms. These are local synthetic timings, not a recovery SLA. |
| Real developer-native drill | Current Tauri command → native session routing → current daemon → temporary filesystem: Delete committed, app and daemon restarted with new process IDs, Recover committed, old Delete replay remained historical, unrelated content survived and runtime authority stayed cleared. The final drill was repeated after the legacy lifecycle fix: approximately 27.2 seconds between Delete and Recover observations, including orchestration (the earlier drill took 42.4 seconds). Both native/daemon process generations were confirmed stopped. The isolated debug manifest used its default app identifier with explicitly temporary profile/data roots; this is not an installed Local Fork/package identity or release check. |
| Rendered journey | Fresh 1280×800 and 390×844 light-theme images plus a dark sample inspected. Actual Notes components/state with an explicitly synthetic in-memory client exercised Cancel, uncertain acknowledgement, exact retry, success, Undo and archived recovery. Initial fixture mistakes were corrected, not treated as product failures or passing evidence. |
| Keyboard/cascade/reflow | Cancel-first focus; Escape closes only confirmation; next surviving phase receives focus; all three dialog controls show 2px keyboard outlines. Delete/Cancel measured 32px high, reused Close 26px square. No hover required. Forced colors/reduced motion exercised. A 640×400 viewport proved 200%-equivalent reflow without horizontal overflow; this is not a native browser zoom claim. |

Local evidence: `.gg/eyes/out/phase-deletion-baseline/` and `.gg/eyes/out/phase-deletion-final/` (`report.json`, `control-metrics.json`, desktop/narrow/dark images, `native-delete.json`, `native-recover.json`, and final-source `native-delete-final.json` / `native-recover-final.json`). These are local verification artifacts, not a guarantee they are present in another checkout.

### Probe interpretation and remaining limits

Canonical visual/density/affordance/a11y/states/liveness probes were run with `UIMAXXXING_EYES_NO_INSTALL=1`. The initial unmocked shell capture had no interactive Notes surface and is **not** deletion coverage. The scoped adapter subsequently rendered the actual synthetic confirmation for affordance/a11y/liveness:

- a11y inspected 164 contrast candidates with no reported low contrast, no ARIA gaps and no positive tab indices. Its out-of-DOM-order flag is the intentional modal focus cycle beginning at Cancel, not an untrapped keyboard path.
- Affordance reports include inert background controls and the existing 26px Close control against its 32px heuristic. Its programmatic-focus scan does not reproduce keyboard modality; direct Tab measurements and screenshots confirmed visible keyboard outlines. Findings were retained, not relabeled as a clean probe pass.
- The state scanner recognized the alert but missed empty/pending states because its lexical patterns do not recognize this copy or `pending`/`preparing`. Runtime/component tests cover those states; the scanner is not a completeness proof.
- Density-card metrics remain **unavailable** because the adopted project deliberately has no card configuration. No cards were invented to force a pass.
- Assistive-technology walkthrough, actual native browser zoom, installed-app behavior, cross-platform native behavior and performance under very large indefinitely retained histories were **not verified**. No WCAG/ADA conformance, zero-loss backup, or release certification is claimed.

Historical Mindwtr and W3C references from the approved plan informed distinct deletion/recovery and least-destructive focus. Their dated inspections are not new runtime evidence, copied lifecycle authority or permission to purge. Fresh local source/tests own the implementation and limits above.
