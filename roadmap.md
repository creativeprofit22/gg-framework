# GG Coder Workspace + Notes Roadmap

## Outcome

Build a VS Code-style workspace inside one `gg-app` window while preserving the current project-scoped Notes experience, agent/session isolation, multi-window workflow, and restart recovery.

The sequence is deliberate:

1. Stabilize Notes persistence without changing its current UI contract.
2. Ship Notes as a useful command-center vertical slice.
3. Add the single-window workspace model and explicit pane/session routing.
4. Add recursive panes, resizing, focus, and durable layout restoration.
5. Add embedded terminals and finish accessibility, notifications, performance, and escape hatches.

## Verified current boundaries

These paths and behaviors were verified before this roadmap was written:

- `gg-app/src/App.tsx`
  - Owns `notes: string` and `showNotes` state.
  - Reads and writes the raw string at `localStorage["gg-notes:<cwd>"]`.
  - Opens Notes from the title-bar `Notes` button.
  - Separately owns the agent-backed project task list and `TasksModal`; Notes must not silently replace or merge with that system.
  - Restores each native window's project/session through `restoreTarget()`.
- `gg-app/src/NotesModal.tsx`
  - Current compatibility contract is intentionally small: `value: string`, `onChange(value)`, and `onClose()`.
  - Current UI is one focused, scrollable textarea titled **Your notes**.
- `gg-app/src/App.css`
  - Owns `.notes-input`, `.notes-modal`, and existing window-layout styles.
- `gg-app/src/WindowLayoutButton.tsx`
  - Creates/arranges 2, 4, or 6 native project windows and offers **Auto-arrange all**.
- `gg-app/src/agent.ts`
  - Is the webview's only typed Tauri IPC bridge.
  - Exposes project selection, `restoreTarget()`, native window creation/arrangement, and per-window agent calls.
- `gg-app/src-tauri/src/lib.rs`
  - Runs one shared Node daemon but currently maps exactly one daemon `session_id` to each native webview window.
  - Routes agent commands by deriving the session from `webview.label()` and adding `x-gg-session`.
  - Persists native-window project/session/geometry state in `~/.gg/gg-app-workspace.json` and restores it on launch.
  - Already tests workspace JSON compatibility and missing/minimal snapshots.
- `packages/ggcoder/src/app-sidecar.ts`
  - Already supports multiple in-process `SessionContext` instances through `POST /session`, `DELETE /session/:id`, `x-gg-session`, and `?session=` for SSE.
  - This is the reusable agent spine; workspace work should expose it to panes rather than fork agent logic.
- `packages/ggcoder/src/tools/bash.ts` and `packages/ggcoder/src/core/persistent-shell.ts`
  - Provide agent-tool shell persistence for `persist: true`.
  - They are not an interactive user terminal API and must not be coupled to terminal panes.
- `gg-app/package.json`
  - Has React/Vitest/Testing Library but no resizable-pane or terminal-emulator dependency today.
  - Relevant verification commands are `pnpm --filter gg-app test`, `check`, `lint`, `format:check`, and `build`.

## Research sources and transferable patterns

Use these as patterns, not as code to copy blindly; licenses and current dependency APIs must be checked again at implementation time.

1. [zdenham/anvil — `plans/multi-pane.md`](https://github.com/zdenham/anvil/blob/4ed2af35ddb0d02c326cb2a1b471f5c99b1702b8/plans/multi-pane.md)
   - Model the layout as a recursive `SplitNode | LeafNode` tree.
   - Store a stable `paneId` in each leaf; keep pane content/session data separate from geometry.
   - Implement in order: model/store, recursive renderer, focus and keyboard routing, per-pane navigation/session lifecycle, drag/rearrange, then persistence/hydration.
2. [MaxQian888/cognia-next — `hooks/ui/use-resizable-layout.ts`](https://github.com/MaxQian888/cognia-next/blob/43abbe2cf1efddb9973489b8fb6aad33a110fc12/hooks/ui/use-resizable-layout.ts)
   - Bridge the current resizable-panel layout callback to a versioned storage record.
   - Validate stored layouts and fall back cleanly when storage is missing, malformed, or stale.
   - Do not rely on deprecated `autoSaveId` behavior.
3. [MaxQian888/cognia-next — `hooks/ui/use-resizable-layout.test.ts`](https://github.com/MaxQian888/cognia-next/blob/43abbe2cf1efddb9973489b8fb6aad33a110fc12/hooks/ui/use-resizable-layout.test.ts)
   - Test first load, valid restoration, malformed storage, changed pane counts, and persistence callbacks independently from the visual pane tree.
4. [MaxQian888/cognia-next — `components/terminal/terminal-pane-group.tsx`](https://github.com/MaxQian888/cognia-next/blob/43abbe2cf1efddb9973489b8fb6aad33a110fc12/components/terminal/terminal-pane-group.tsx)
   - Keep terminal pane grouping separate from terminal process state.
   - Compose terminal panes from the same resizable primitives rather than inventing terminal-only layout behavior.
5. [gnoviawan/termul — `src/renderer/components/ui/resizable.tsx`](https://github.com/gnoviawan/termul/blob/9cba9ff708d4a9e42a87bfe3063aa9a844adb0ca/src/renderer/components/ui/resizable.tsx)
   - Wrap third-party resizable primitives behind app-owned components.
   - Normalize horizontal/vertical flex behavior and provide visible, keyboard-reachable resize handles.
6. [dust-tt/dust — `useProjectTasksPanelState.ts`](https://github.com/dust-tt/dust/blob/a928a6c25c02e4ec8e65d0c5602f48b2801807aa/front/components/assistant/conversation/space/conversations/project_tasks/useProjectTasksPanelState.ts)
   - Keep task-panel state transitions in a dedicated hook/controller instead of distributing mutations through the view.
   - Make completion reversible; preserve ordering while toggling pending/done state.
7. [dust-tt/dust — `PodTasksPanelContext.tsx`](https://github.com/dust-tt/dust/blob/a928a6c25c02e4ec8e65d0c5602f48b2801807aa/front/components/pod/tasks/PodTasksPanelContext.tsx)
   - Expose command-center state through a narrowly scoped provider/hook so pane and header consumers do not receive the entire app state.
8. [spencerkit/coder-studio — workspace memory system plan](https://github.com/spencerkit/coder-studio/blob/0efb2806f69b9237b29480299e593016f9472549/docs/superpowers/plans/2026-06-12-workspace-memory-system.md)
   - Define and validate the domain shape before repository/UI work.
   - Scope records to a workspace/project, normalize entries, retain timestamps, support filtering, and prefer soft-delete/archive over destructive deletion.
   - Test repository persistence, validation, search/filter behavior, and soft deletion separately.
9. [Mooshieblob1/MooshieUI — `notifications.svelte.ts`](https://github.com/Mooshieblob1/MooshieUI/blob/84d0e456528a33505d261e16acd2fc625f322e52/src/lib/stores/notifications.svelte.ts)
   - Derive `unreadCount` from notification state and keep it separate from whether the panel is open.
   - Apply the same separation to Notes: unfinished-item count and unread handoff state are data, not modal visibility.
10. [webjsdev/webjs — `sonner.ts`](https://github.com/webjsdev/webjs/blob/e8618adde989e26175256d541a0d17d358f4b636/packages/ui/packages/registry/components/sonner.ts)
    - Mount one persistent `aria-live="polite"` region before announcements arrive.
    - Reserve assertive alerts for actual errors; routine task/handoff updates should stay polite and non-repeating.

## Cross-phase product rules

- **One app, two valid modes:** the new default may be one native window with internal panes, but **Open in new window** and the existing 2/4/6 native-window controls remain supported escape hatches until telemetry/manual use proves otherwise.
- **One agent spine:** do not duplicate `AgentSession` or provider logic in React or Rust. Reuse daemon sessions from `packages/ggcoder/src/app-sidecar.ts`.
- **Explicit identity:** every pane gets a stable `paneId`; every agent pane references a daemon session; every persisted project uses a canonical cwd identity.
- **No task collision:** Notes checklist items are human workspace notes. Existing agent-backed project tasks remain in `TasksModal` and keep their current run/delete semantics.
- **Corruption tolerance:** malformed or future-version Notes/layout records fall back to a safe single-pane experience without blocking startup.
- **No noisy attention loop:** a Notes indicator may pulse once when an unread handoff is restored, then becomes a static amber dot/count until viewed. Never pulse indefinitely.
- **Accessibility:** pane focus, resize handles, close/split actions, Notes controls, and terminal controls must be keyboard reachable with visible focus.
- **Small-screen safety:** enforce minimum pane sizes and collapse/defer secondary content rather than rendering unusable slivers.
- **Storage ownership:** keep the existing native-window snapshot backward compatible; use separately versioned records for Notes and internal pane layouts unless a later migration explicitly unifies them.

---

## Phase 1 — Notes persistence boundary and compatibility layer

### Goal

Move project Notes persistence out of `App.tsx` into a typed, tested repository while preserving the current raw textarea behavior and `NotesModal` prop contract exactly.

Introduce a versioned Notes document capable of supporting:

- `currentFocus: string`
- ordered human tasks with stable IDs, `todo | done`, and timestamps
- `handoff: string` plus read/unread metadata
- `reference: string`
- archived/soft-deleted items
- the existing free-form text as a lossless legacy body

### Non-goals

- No command-center redesign yet.
- No pane or workspace UI.
- No agent access to Notes.
- No merging with `ProjectTask`, `TasksModal`, or the sidecar task endpoints.
- No removal or reinterpretation of existing `gg-notes:<cwd>` values.

### Compatibility guardrails

- `NotesModal` continues receiving `value`, `onChange`, and `onClose`; its textarea, title, autofocus, caret-at-end behavior, and visual dimensions remain unchanged.
- Existing raw strings under `gg-notes:<cwd>` must load byte-for-byte into the textarea.
- During this phase, the legacy raw string remains recoverable. Prefer an additive versioned key such as `gg-notes-v2:<canonical-cwd>` and either dual-write the free-form field or retain a reversible one-time import marker.
- A v2 parse failure falls back to the legacy value; it must not overwrite either record during fallback.
- Normalize cwd only through one tested helper. Windows path case/separator behavior and same-project multi-window access must be tested explicitly.
- Storage-unavailable/quota failures preserve in-memory edits for the current session, matching today's behavior.

### Likely files

Existing verified files:

- `gg-app/src/App.tsx`
- `gg-app/src/NotesModal.tsx`
- `gg-app/src/App.css`
- `gg-app/package.json`

Proposed files under the verified `gg-app/src/` directory:

- `gg-app/src/notes-types.ts`
- `gg-app/src/notes-storage.ts`
- `gg-app/src/notes-storage.test.ts`
- `gg-app/src/useProjectNotes.ts`
- `gg-app/src/useProjectNotes.test.tsx`

### Acceptance criteria

- Opening Notes for an existing project displays the exact existing text.
- Editing and reopening Notes in the same and a second native window displays the saved text.
- A fresh project gets a valid empty v2 document without visible UI change.
- Invalid JSON, unknown schema versions, missing fields, and unavailable local storage never crash or block app startup.
- Structured fields round-trip without dropping timestamps, item order, archive state, handoff read state, or free-form text.
- The repository exposes explicit import/export/parse results rather than silently swallowing all migration failures.

### Targeted tests and visual verification

Automated:

- Unit-test empty, valid, malformed, unknown-version, legacy-only, and dual-record reads.
- Unit-test legacy import, dual-write/recovery, stable task ordering, completion toggles, archive restore, and canonical project keys.
- Hook-test switching `cwd` so one project's pending write cannot land in another project's record.
- Run `pnpm --filter gg-app test`, `pnpm --filter gg-app check`, and `pnpm --filter gg-app lint`.

Visual/manual:

- Open a project with a long existing note; verify identical text, scroll position behavior, focus, and caret placement.
- Edit the same project from two native windows and verify the documented conflict behavior.
- Simulate malformed v2 storage in DevTools and verify the legacy textarea still opens.
- Compare the modal before/after at narrow and wide window sizes; there should be no deliberate visual delta.

### Migration and rollback concerns

- Rollout is additive: keep `gg-notes:<cwd>` until at least one release after the command-center UI is stable.
- Never delete legacy data automatically. Mark successful import in v2 metadata instead.
- Rollback means switching the hook back to the legacy field/key; dual-written free-form text keeps old builds usable.
- Define last-write-wins behavior for simultaneous windows now; cross-window merge/synchronization can be added later without changing the schema.

### Dependencies on earlier phases

- None.

---

## Phase 2 — Notes command-center vertical slice

### Goal

Replace the single-purpose Notes body with a project command center that makes the next action obvious while retaining full access to the original free-form note.

Recommended information hierarchy:

1. **Now** — one `currentFocus` field.
2. **Next** — ordered, reversible human checklist.
3. **Handoff** — concise resume context with unread state.
4. **Reference** — durable free-form material, initialized from the legacy textarea body.
5. **Done / Archive** — collapsed history with restore actions.

Add a quiet title-bar status: unfinished count when nonzero, and an amber handoff dot when unread. On project resume, pulse the unread-handoff indicator once, then leave it static.

### Non-goals

- No agent-generated or agent-executed Notes tasks.
- No Kanban board, calendar, reminders, cloud sync, collaboration, or full-text search.
- No permanent animated badge.
- No changes to existing `TasksModal` behavior or its pending-task count.
- No internal workspace panes yet; this remains usable in the existing modal/window UI.

### Compatibility guardrails

- Preserve the `NotesModal` call boundary during the first vertical slice where practical; if expanded, keep a legacy adapter that still maps `value/onChange/onClose` to the **Reference** field.
- Existing raw text appears under **Reference** with no formatting conversion or loss.
- Use distinct labels such as **Notes next items** versus **Agent tasks** so users cannot confuse the two systems.
- Completion is reversible; deletion defaults to archive/soft-delete.
- Derive unfinished and unread counts from persisted state, independently from modal open/closed state.
- Opening the command center marks handoff read only after its content is actually presented, not merely when the app boots.
- Announcements use one persistent polite live region; errors use the existing app error/toast conventions.

### Likely files

Existing verified files:

- `gg-app/src/App.tsx`
- `gg-app/src/NotesModal.tsx`
- `gg-app/src/App.css`
- `gg-app/src/Modal.tsx`
- `gg-app/src/Toaster.tsx`
- `gg-app/src/toast.ts`
- `gg-app/src/theme.ts`

Phase 1 files:

- `gg-app/src/notes-types.ts`
- `gg-app/src/notes-storage.ts`
- `gg-app/src/useProjectNotes.ts`

Proposed files:

- `gg-app/src/NotesCommandCenter.tsx`
- `gg-app/src/NotesTaskList.tsx`
- `gg-app/src/NotesHandoff.tsx`
- `gg-app/src/NotesStatusBadge.tsx`
- `gg-app/src/NotesCommandCenter.test.tsx`

### Acceptance criteria

- A user can set **Now**, add/reorder/complete/reopen/archive/restore **Next** items, edit **Handoff**, and edit **Reference** without leaving the current project.
- Existing text is visible in **Reference** on first open.
- Closing/reopening the app restores every field, task order, completion state, archive state, and handoff read state.
- The Notes title-bar affordance shows the correct unfinished count and unread handoff state without colliding visually with the existing **Tasks (n)** button.
- Keyboard-only users can traverse sections, add and toggle tasks, archive/restore, close the modal, and return focus to the Notes trigger.
- The one-time resume pulse stops automatically and does not replay merely because the modal is closed/reopened.

### Targeted tests and visual verification

Automated:

- Component-test add, reorder, toggle, archive, restore, and keyboard interactions.
- Test derived unfinished count separately from panel visibility.
- Test unread handoff transitions: restored unread, presented, marked read, edited into a new unread handoff if that is the chosen product rule.
- Test the persistent polite live region and ensure routine updates do not use `role="alert"`.
- Re-run Phase 1 migration tests plus `pnpm --filter gg-app test`, `check`, `lint`, and `format:check`.

Visual/manual:

- Verify clear scanning order at 900px modal width and at the narrowest supported app width.
- Check empty, one-item, many-item, long-handoff, long-reference, and large archived-history states.
- Verify title-bar Notes and Tasks counts remain distinguishable.
- Verify the pulse occurs once, respects reduced-motion preferences, and settles to a static indicator.
- Check dark-theme contrast, hover/focus states, textarea resizing/scrolling, and no transcript obstruction.

### Migration and rollback concerns

- Keep the Phase 1 legacy adapter and dual-write path active.
- If the command-center UI is rolled back, the legacy Notes modal must still show **Reference** and retain all original text; structured-only fields remain in v2 for a future retry.
- Do not flatten structured fields into generated prose in the legacy key because that would create irreversible duplication on re-upgrade.
- Archive is recoverable; permanent purge, if ever added, requires separate confirmation and is outside this phase.

### Dependencies on earlier phases

- Requires Phase 1's schema, repository, compatibility adapter, and migration tests.

---

## Phase 3 — Single-window workspace layout foundation

### Goal

Introduce the internal workspace domain model and pane-aware agent routing without yet shipping arbitrary recursive splits.

Start with one native window containing one `AgentPane`, but make identity explicit:

- versioned workspace document
- stable `workspaceId`
- stable `paneId`
- `PaneDescriptor` separated from `LayoutNode`
- `AgentPaneDescriptor` containing cwd and resumable session metadata
- focused pane ID
- a single-leaf layout as the default

Extend the existing shared daemon bridge so one native webview can own multiple daemon sessions. Existing per-window IPC remains a compatibility path; new pane-aware commands take an explicit `paneId` or opaque pane session handle and validate ownership in Rust.

### Non-goals

- No visible split controls or drag resizing yet.
- No terminals yet.
- No replacement of native multi-window controls.
- No direct browser `fetch` from the Tauri webview to the sidecar.
- No fork of `AgentSession`, event handling, provider state, or transcript logic.
- No broad `App.tsx` rewrite unrelated to extracting a reusable agent pane boundary.

### Compatibility guardrails

- Preserve the existing one-window/one-session path while introducing pane-aware routes additively.
- All webview-to-sidecar traffic continues through typed wrappers in `gg-app/src/agent.ts` and registered Tauri commands in `gg-app/src-tauri/src/lib.rs`.
- Pane session IDs are opaque to React where possible; Rust validates that a requested pane belongs to the calling webview.
- SSE events carry both pane identity and session identity, and are emitted only to the owning webview.
- `waitForReady()` semantics become pane-aware without weakening startup/respawn gating.
- Current project picker, session resume, error formatting, cancellation, attachments, model selection, Ken events, tasks, and transcript hydration must remain functional in the single default pane.
- Keep `~/.gg/gg-app-workspace.json` readable by old builds; do not silently redefine its current native-window schema in place.

### Likely files

Existing verified files:

- `gg-app/src/App.tsx`
- `gg-app/src/agent.ts`
- `gg-app/src/useAgentEvents.ts`
- `gg-app/src/useAgentEvents.test.ts`
- `gg-app/src/useKenMentor.ts`
- `gg-app/src/useKenMentor.test.ts`
- `gg-app/src/ProjectPicker.tsx`
- `gg-app/src/WindowLayoutButton.tsx`
- `gg-app/src/App.css`
- `gg-app/src-tauri/src/lib.rs`
- `packages/ggcoder/src/app-sidecar.ts`

Proposed files:

- `gg-app/src/workspace-types.ts`
- `gg-app/src/workspace-reducer.ts`
- `gg-app/src/workspace-reducer.test.ts`
- `gg-app/src/WorkspaceShell.tsx`
- `gg-app/src/AgentPane.tsx`
- `gg-app/src/PaneContext.tsx`

### Acceptance criteria

- The app boots into one visually unchanged agent pane represented by a valid single-leaf workspace tree.
- The project picker can bind that pane to a project/session and all existing agent operations target the pane's daemon session.
- A test-only or internal harness can create two daemon sessions owned by one webview and prove prompts/events/cancellation cannot cross panes.
- Closing or replacing a pane disposes only that pane's session and background resources.
- Daemon crash/respawn recreates all pane sessions from their cwd/session metadata or produces a contained per-pane recovery state.
- Existing native multi-window creation, focus cycling, arrangement, and restore continue to work.
- **Open in new window** remains available and creates a regular isolated native workspace.

### Targeted tests and visual verification

Automated:

- Unit-test workspace model invariants: unique pane IDs, exactly one focused existing pane, no dangling leaf references, and valid single-leaf fallback.
- Rust-test webview ownership checks, pane session create/dispose, unknown pane rejection, and daemon respawn mapping.
- Sidecar integration-test two sessions with interleaved prompts/events and independent disposal.
- Update event-hook tests to assert pane-tag filtering.
- Run `pnpm --filter gg-app test`, `check`, `lint`, `format:check`, and `build`; run targeted Rust tests for `gg-app/src-tauri`.

Visual/manual:

- Compare the default one-pane app before/after: title bar, transcript, input, Notes, Tasks, tool panel, and project picker should be visually equivalent.
- Run two native windows and verify events, model state, Notes, and project changes remain isolated as before.
- Force daemon restart and verify each visible pane shows either restored content or a scoped recovery message, never another pane's state.

### Migration and rollback concerns

- Introduce a separate versioned internal-layout key/file or add optional, ignored fields to a versioned successor; old native-window snapshots must remain consumable.
- The absence of an internal layout always means one agent pane using the existing native-window entry.
- Keep legacy IPC wrappers until all pane-aware call sites are verified. Rollback switches `WorkspaceShell` to its one-pane adapter and legacy per-window commands.
- Session IDs are runtime values and must not be treated as durable restore identifiers; persist cwd and session path/metadata instead.

### Dependencies on earlier phases

- Requires Phase 1 because pane/project identity must use the same canonical project key as Notes.
- Phase 2 should be complete so the command center can later attach to the focused pane without redesigning Notes state again.

---

## Phase 4 — Recursive panes, focus, and layout persistence

### Goal

Ship the actual single-window workspace:

- split focused pane horizontally or vertically
- recursively render `SplitNode | LeafNode`
- resize with visible handles and minimum sizes
- focus by click and keyboard
- close panes safely
- choose a project/session per agent pane
- restore pane tree, ratios, descriptors, and focused pane after reload/restart
- move a pane to a new native window and open a project directly in a new native window

Use app-owned resizable wrappers so a dependency can be upgraded/replaced without leaking its API throughout GG App.

### Non-goals

- No freeform overlapping/floating panes.
- No arbitrary drag docking in the first release; split/close/move commands are sufficient. Header drag-to-rearrange can follow after keyboard behavior and persistence are stable.
- No more than a conservative pane cap initially; default to four visible agent panes and require an explicit action beyond that.
- No terminal panes until Phase 5.
- No removal of native window arrangement or saved geometry.

### Compatibility guardrails

- Follow the Anvil separation: layout tree stores geometry and pane references; pane descriptors store project/session content.
- Stable pane IDs survive resize, reorder, and restart. Never key React panes by array position.
- Validate every restored tree: supported version, legal orientation/ratio, unique IDs, existing descriptors, bounded depth/count, and one valid focus target.
- Invalid layout falls back to one recoverable agent pane; preserve the rejected record for diagnostics rather than overwriting it immediately.
- Resizing must not remount `AgentPane`, reconnect SSE, reset input drafts, or recreate daemon sessions.
- Keyboard focus is scoped to the active pane; global shortcuts must not submit/cancel in multiple panes.
- Existing title-bar Notes/Tasks actions target the focused agent pane's cwd, while pane headers show enough project/session identity to avoid mistakes.
- Project Notes remain shared by cwd when two panes show the same project; agent transcripts/sessions remain separate.
- Preserve **Open in new window**, 2/4/6 windows, auto-arrange, and restart restore as supported workflows.

### Likely files

Existing verified files:

- `gg-app/src/App.tsx`
- `gg-app/src/App.css`
- `gg-app/src/agent.ts`
- `gg-app/src/WindowLayoutButton.tsx`
- `gg-app/src/ProjectPicker.tsx`
- `gg-app/src-tauri/src/lib.rs`
- `gg-app/package.json`

Phase 3 files:

- `gg-app/src/workspace-types.ts`
- `gg-app/src/workspace-reducer.ts`
- `gg-app/src/WorkspaceShell.tsx`
- `gg-app/src/AgentPane.tsx`
- `gg-app/src/PaneContext.tsx`

Proposed files:

- `gg-app/src/WorkspaceLayout.tsx`
- `gg-app/src/WorkspacePane.tsx`
- `gg-app/src/PaneHeader.tsx`
- `gg-app/src/ResizableGroup.tsx`
- `gg-app/src/workspace-storage.ts`
- `gg-app/src/workspace-storage.test.ts`
- `gg-app/src/WorkspaceLayout.test.tsx`

### Acceptance criteria

- A user can split the focused pane in both directions, assign projects/sessions, resize, change focus, close, and reopen the app with the same layout and focused pane.
- Splitting duplicates no active agent session implicitly; a new leaf starts at the project/session picker unless the user explicitly chooses duplication.
- Closing a running pane requires a scoped confirmation and cancels/disposes only that pane after confirmation.
- Resizing does not interrupt streaming, reset transcript scroll, lose drafts, or reconnect event streams.
- Restore works for nested layouts, duplicate cwd panes, native multi-window workspaces, and changed/missing project paths.
- Malformed/stale layouts recover to one pane and surface a concise recoverable warning.
- Moving/opening a pane in a new native window preserves project/session intent without leaving duplicate live ownership behind.

### Targeted tests and visual verification

Automated:

- Reducer property/invariant tests for split, close, focus, ratio update, move, and normalization.
- Storage tests modeled on Cognia: first load, valid restore, malformed JSON, unknown version, pane-count change, missing descriptor, invalid ratio, excessive depth, and write failure.
- Component-test keyboard split/focus/close and accessible resize-handle semantics.
- Integration-test that resize and focus changes do not recreate session/event subscriptions.
- Rust-test moving pane ownership between webviews and restoring multiple internal layouts inside the existing native-window snapshot model.
- Run GG App test/check/lint/format/build and targeted Rust tests.

Visual/manual:

- Capture and inspect 1-pane, 2-column, 2-row, 3-pane nested, and 4-pane layouts at common desktop sizes.
- Verify active-pane border/header is obvious but not visually loud.
- Drag and keyboard-resize to minimum sizes; ensure transcript, composer, tool panel, Notes command center, and menus remain usable.
- Stream simultaneously in multiple panes and verify smooth resizing and correct event placement.
- Restart with each layout, with one project folder removed, and with a deliberately corrupted layout record.
- Verify reduced motion, high zoom, keyboard-only use, and Windows/macOS title-bar drag regions.

### Migration and rollback concerns

- Version layout records independently from native-window snapshots and Notes.
- Persist the last-known-good layout before attempting schema upgrades; write upgraded data only after validation succeeds.
- Rollback ignores internal layout data and opens the first valid agent descriptor as the legacy single pane.
- If a resizable dependency is adopted, pin its verified major version and isolate it behind `ResizableGroup.tsx`; do not persist dependency-private structures directly.

### Dependencies on earlier phases

- Requires Phase 3's pane-aware session routing and single-pane compatibility shell.
- Uses Phase 2's focused-project Notes command center and Phase 1's canonical project identity.

---

## Phase 5 — Terminal panes and workspace polish

### Goal

Add user-controlled terminal panes as another `PaneDescriptor` type, then polish the workspace into a dependable daily driver.

Terminal architecture:

- frontend terminal emulator isolated behind `TerminalPane.tsx`
- Rust-owned PTY/process lifecycle with explicit create/input/resize/close commands and pane ownership checks
- project cwd inherited when opened from an agent pane
- terminal descriptor persisted, but dead OS processes are recreated only through an explicit, safe restore policy
- terminal panes use the same split tree, headers, focus model, resizing, move-to-window behavior, and persistence rules as agent panes

Polish scope:

- workspace command palette/header actions
- one-time handoff notification behavior
- persistent polite announcement region
- clear active/running/error/unread indicators
- session/resource cleanup
- performance budgets and recovery UX
- documentation of shortcuts and rollback/recovery

### Non-goals

- No reuse of the agent's `bash` tool `PersistentShell` as a user terminal.
- No terminal multiplexing protocol, SSH manager, cloud terminal sync, or guarantee that live processes survive an app/OS restart.
- No hidden shell execution on workspace restore.
- No infinite pulse, toast flood, or sound for routine state changes.
- No removal of external terminal or native multi-window workflows.

### Compatibility guardrails

- Evaluate and verify current APIs/licenses before selecting dependencies; keep the emulator behind an app-owned adapter and PTY behind typed Tauri IPC.
- Default shell selection follows the platform/user environment and never interpolates untrusted project text into a command line.
- Terminal input/output is routed by terminal pane ID and validated against the calling webview, mirroring agent pane ownership.
- Closing a terminal pane terminates its process tree with confirmation when a foreground process is active.
- Persist cwd, shell preference, title, and layout—not secrets, scrollback containing credentials, runtime PID, or raw environment.
- On restart, render a stopped terminal with **Restart terminal**; do not silently execute prior commands.
- Agent pane shortcuts do not fire while terminal input owns focus. Workspace shortcuts require explicit platform-safe chords.
- Existing `packages/ggcoder/src/tools/bash.ts`, `task_output`, `task_send`, and `task_stop` semantics remain untouched.
- All status announcements are deduplicated; use polite live updates except for actionable errors.

### Likely files

Existing verified files:

- `gg-app/src/App.tsx`
- `gg-app/src/App.css`
- `gg-app/src/agent.ts`
- `gg-app/src/Toaster.tsx`
- `gg-app/src/toast.ts`
- `gg-app/src/theme.ts`
- `gg-app/src-tauri/src/lib.rs`
- `gg-app/src-tauri/Cargo.toml`
- `gg-app/src-tauri/Cargo.lock`
- `gg-app/package.json`
- `packages/ggcoder/src/tools/bash.ts` (compatibility reference only; no coupling)
- `packages/ggcoder/src/core/persistent-shell.ts` (compatibility reference only; no coupling)

Phase 4 files:

- `gg-app/src/workspace-types.ts`
- `gg-app/src/WorkspaceLayout.tsx`
- `gg-app/src/WorkspacePane.tsx`
- `gg-app/src/PaneHeader.tsx`
- `gg-app/src/workspace-storage.ts`

Proposed files:

- `gg-app/src/TerminalPane.tsx`
- `gg-app/src/terminal.ts`
- `gg-app/src/terminal.test.ts`
- `gg-app/src/WorkspaceCommands.tsx`
- `gg-app/src/WorkspaceStatus.tsx`
- `gg-app/src/LiveAnnouncements.tsx`

### Acceptance criteria

- A user can open a terminal beside the focused agent pane, inherit its cwd, type interactively, resize it, split around it, move focus, and close it safely.
- Multiple terminals and agent panes run concurrently without input/output or event crossover.
- PTY dimensions track rendered terminal dimensions after split resize and zoom changes.
- Restart restores terminal placement and metadata as stopped panes; no command executes until the user chooses **Restart terminal**.
- Closing a native window/app cleans up all owned agent sessions, terminals, PTYs, event bridges, and descendant processes.
- Workspace shortcuts are discoverable and do not conflict with composer, terminal, OS, or existing native-window shortcuts.
- Notes unfinished/unread indicators are accurate, calm, keyboard accessible, reduced-motion aware, and announced once.
- One agent pane plus one idle terminal has no perceptible typing/streaming regression versus the pre-workspace app; define concrete CPU/memory/startup budgets before implementation sign-off.

### Targeted tests and visual verification

Automated:

- Rust PTY tests for create, input, output, resize, exit, ownership rejection, process-tree cleanup, and invalid shell/cwd errors.
- Frontend tests for terminal lifecycle states, focus routing, shortcut suppression, stopped-terminal restore, and output batching.
- Integration-test concurrent terminals plus concurrent agent streams with strict pane routing.
- Test shutdown, native-window close, pane close, daemon crash, terminal process exit, and app restart cleanup paths.
- Accessibility-test live-region deduplication, reduced motion, labels, tab order, and focus restoration.
- Run GG App test/check/lint/format/build, targeted Rust tests, and a packaged-app smoke test on Windows and macOS.

Visual/manual:

- Verify terminal rendering, cursor, selection, copy/paste, colors, Unicode, long lines, scrollback, and resize at 100% and high zoom.
- Exercise 1 agent + 1 terminal, 2 agents + 2 terminals, and nested mixed layouts.
- Verify active focus is unmistakable and terminal focus suppresses agent composer shortcuts.
- Restore a workspace containing stopped terminals and verify no shell command runs automatically.
- Check title-bar indicators, one-time handoff pulse, polite screen-reader announcements, error toasts, and reduced motion.
- Run a 30-minute soak with simultaneous agent streaming and terminal output; inspect memory, CPU, leaked PTYs, and stale daemon sessions.

### Migration and rollback concerns

- Terminal descriptors require their own schema version/discriminator; older builds ignore unsupported pane types and recover the first valid agent pane.
- Never persist PIDs as resumable identity. A restored terminal is a new process started only by user action.
- Keep terminal dependencies isolated so rollback can render terminal leaves as unsupported/stopped placeholders without corrupting the rest of the layout.
- Preserve **Open in external terminal** or equivalent fallback if embedded PTY startup fails.
- Maintain the native multi-window snapshot and single-pane fallback through at least one stable release after terminal rollout.

### Dependencies on earlier phases

- Requires Phase 4's stable recursive layout, focus routing, persistence, and pane lifecycle.
- Requires Phase 3's ownership model for secure per-webview resource routing.
- Reuses Phase 2's notification semantics and Phase 1's durable project identity.

---

## Release gates

Each phase should ship only when its compatibility fallback is independently usable:

- **Phase 1 gate:** legacy Notes text survives upgrade and downgrade.
- **Phase 2 gate:** command-center fields persist, while Reference remains usable by the old modal.
- **Phase 3 gate:** default single-pane behavior is visually and functionally equivalent, with proven two-session isolation inside one webview.
- **Phase 4 gate:** invalid layout recovery and native multi-window escape hatches work before recursive panes become the default.
- **Phase 5 gate:** terminal restore never executes commands automatically, and all PTY/session resources are cleaned up on every close path.

The recommended default progression is feature-flagged single-pane foundation → opt-in internal panes → default internal panes with native-window escape hatch → opt-in terminals → default terminal availability after cross-platform soak testing.
