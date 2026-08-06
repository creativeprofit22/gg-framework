# Notes and Roadmap Maintenance

Audit baseline: 2026-07-30 at commit `0811a66a`.

This is the remaining maintenance queue from the scoped Phases 00–26 sweep. Execute it in the order below; do not combine cleanup with behavior changes.

## Status

- [x] **P0 — Fix `evidence-only` contract drift.** Commit `0811a66a` added the missing `NotesRoadmapStatusOutcome` member and runtime allow-list entry in `gg-app/src/notes-types.ts`. `gg-app/src/agent-pane-client.test.ts` now proves a valid backend-style final-review snapshot crosses `PaneAgentClient.getNotes()` without rejection.
- [x] **P1 — Consolidate the shared Notes schema and validators.** Canonical contracts now live in `@kenkaiiii/gg-core`; backend and app compatibility surfaces re-export them.
- [ ] **P2 — Split oversized implementation files, sequentially.**
- [ ] **P3 — Remove obsolete Phase 20/25 packaged-smoke code.**

P0 and P1 are complete. P2 remains the active maintenance priority; P3 is pending.

## Required order

1. P2a repository persistence and mutations split.
2. P2b `useProjectNotes` split.
3. P2c `NotesRoadmap` phase-detail split.
4. P3 obsolete smoke cleanup.

Each step must be green before the next starts. Keep public behavior and serialized data unchanged throughout P2.

## P1 — Shared Notes contract

### Current files

- `packages/gg-core/src/project-notes.ts` owns the canonical Notes schema, limits, migrations, and document validator.
- `packages/gg-core/src/roadmap-workflow.ts` owns shared Roadmap draft and workflow contracts.
- `packages/ggcoder/src/project-notes-repository.ts` re-exports shared contracts while retaining backend persistence, recovery, and mutations.
- `gg-app/src/notes-types.ts` re-exports shared contracts while retaining app IPC outcome guards; `gg-app/src/notes-storage.ts` retains browser fallback storage and diagnostics.
- `fixtures/project-notes-v3.json` remains the cross-boundary canonical document fixture, updated for the explicit blocker-action field; compatibility coverage spans gg-core, ggcoder, and gg-app.

### Boundary

The shared contract consolidation is complete: both backend persistence and app parsing consume the UI-free `@kenkaiiii/gg-core` source of truth.

Keep these concerns outside the shared contract:

- backend file paths, locking, backup recovery, revisions, and mutation authority;
- app IPC response-envelope guards;
- browser fallback storage and diagnostics;
- React state and presentation.

Preserve existing public import surfaces with re-exports where needed. Apart from the Roadmap workflow's explicit `requiredExternalAction` addition, P1 preserved the v3 wire shape, migration acceptance, exact-key validation, append-only rules, and authority checks.

### Verification gate

- The canonical `fixtures/project-notes-v3.json` passes both backend persistence and app parse/load boundaries.
- Invalid nested roadmap, reminder, reference, and final-review shapes retain their current error paths and messages.
- Run:
  - `pnpm --filter @kenkaiiii/ggcoder exec vitest run src/project-notes-repository.test.ts`
  - `pnpm --filter gg-app exec vitest run src/notes-storage.test.ts src/agent-pane-client.test.ts`
  - `pnpm --filter @kenkaiiii/ggcoder check`
  - `pnpm --filter gg-app check`

## P2 — Sequential file splits

These are behavior-preserving extractions. Do not run them in parallel.

### P2a — Repository persistence, then mutations

**Current files:** `packages/ggcoder/src/project-notes-repository.ts` and `packages/ggcoder/src/project-notes-repository.test.ts`.

First extract storage mechanics: canonical keys and paths, envelope serialization, primary/backup reads, corruption reporting, locking, atomic writes, migration persistence, and revision conflicts. Keep `ProjectNotesRepository` as the stable facade.

Then extract mutation logic: reminder delivery, roadmap status/final review, implementation checkpoints, completion review, phase launch/link/lifecycle transitions, and their authority/append-only guards. Mutation code must use the persistence boundary rather than duplicate file I/O.

**Boundary:** no schema redesign, outcome-shape changes, lock-scope changes, revision changes, timestamp changes, or reordered writes. Keep filesystem injection and failure-path coverage intact.

**Verification gate:**

- `pnpm --filter @kenkaiiii/ggcoder exec vitest run src/project-notes-repository.test.ts src/app-sidecar-phase.test.ts`
- `pnpm --filter @kenkaiiii/ggcoder check`
- Recovery, corruption, atomic-write failure, conflict, final-review, and restart tests remain green.

### P2b — `useProjectNotes`

**Current files:** `gg-app/src/useProjectNotes.ts`, `gg-app/src/useProjectNotes.test.tsx`, and the fallback repository in `gg-app/src/notes-storage.ts`.

Extract authority/opening and snapshot adoption first, mutation queue/replay and conflict handling second, then domain mutation builders for tasks, phases, references, roadmap decisions, reminders, and handoff. Keep `useProjectNotes()` and `UseProjectNotesResult` as the stable component-facing API.

**Boundary:** preserve epoch/stale-response protection, sidecar-first authority, browser fallback behavior, optimistic replay order, mutation settlement, timestamps, diagnostics, and callback results. Do not move UI into the hook or persistence into React components.

**Verification gate:**

- `pnpm --filter gg-app exec vitest run src/useProjectNotes.test.tsx src/notes-storage.test.ts`
- `pnpm --filter gg-app check`
- Authority switching, concurrent conflicts, replay, fallback, references, roadmap overrides, and reminder guards remain green.

### P2c — `NotesRoadmap` phase detail

**Current files:** `gg-app/src/NotesRoadmap.tsx`, integration coverage in `gg-app/src/ProjectNotes.test.tsx`, and styling in `gg-app/src/App.css`.

Extract the current private `PhaseDetail` and only its detail-specific helpers/subcomponents. Leave roadmap list selection, create flow, selected-phase ownership, focus restoration, and live announcements in `NotesRoadmap`.

**Boundary:** preserve props and callback timing, pending-state ownership, activity ordering, completion-gate recovery text, reference/reminder actions, keyboard focus return, ARIA semantics, and responsive layout. This split must not redesign the UI or change CSS selectors.

**Verification gate:**

- `pnpm --filter gg-app exec vitest run src/ProjectNotes.test.tsx`
- `pnpm --filter gg-app check`
- Manually verify phase open/close focus, pending action disabling, live announcements, and the detail layout at representative and narrow widths.

## P3 — Obsolete Phase 20/25 packaged-smoke cleanup

### Current files and dependencies

Phase 20 packaged-smoke remnants:

- `gg-app/scripts/smoke-packaged-windows.mjs`
- `gg-app/scripts/smoke-packaged-windows.test.mjs`
- `gg-app/scripts/phase-20-native-smoke.mjs`
- `gg-app/scripts/phase-20-sidecar-fixture.mjs`

`gg-app/scripts/phase-21-native-smoke.mjs` still imports `connectToPackagedWebview` and `clickExpression` from the Phase 20 runner, and `gg-app/scripts/phase-26-macos-dev-fixture.mjs` depends on the Phase 21 fixture. Move only those live generic helpers to a neutral smoke helper before deleting the obsolete Phase 20 scenario and fixture.

Phase 25 packaged-smoke remnants:

- `gg-app/scripts/phase-25-native-smoke.mjs` is a disabled packaged-runner stub.
- `gg-app/scripts/phase-25-native-smoke.test.mjs` mixes retirement assertions with still-useful dev-fixture/helper coverage.

Keep the active isolated-development path:

- `gg-app/scripts/phase-25-dev-fixture.mjs`
- `gg-app/scripts/phase-25-dev-fixture.test.mjs`
- `gg-app/scripts/phase-25-dev-evidence.mjs`
- `gg-app/scripts/phase-25-sidecar-fixture.mjs`
- `gg-app/scripts/phase-25-windows-smoke-helpers.mjs`

Move any still-required pure-helper, permission-route, isolation, and arm-gated fixture assertions out of `phase-25-native-smoke.test.mjs` before removing the obsolete runner/test. Remove obsolete test entries from `gg-app/vitest.config.ts`; `gg-app/package.json` already has no packaged-smoke commands.

### Boundary

Do not weaken release safety, re-enable packaged automation, remove active Phase 21/25-dev/26 fixtures, or touch production reminder behavior. Cleanup is complete only when no live file imports an obsolete Phase 20/25 packaged runner.

### Verification gate

- `pnpm --filter gg-app exec vitest run scripts/phase-21-native-smoke.test.mjs scripts/phase-25-dev-fixture.test.mjs scripts/phase-26-macos-dev-fixture.test.mjs`
- `pnpm --filter gg-app test:parallel`
- `pnpm --filter gg-app check`
- Confirm `gg-app/vitest.config.ts` references only retained tests and repository search finds no obsolete runner imports.

## Final gate for every phase

Run `pnpm check`, `pnpm lint`, `pnpm format:check`, and `git diff --check`. Review the diff for scope creep before starting the next ordered item.
