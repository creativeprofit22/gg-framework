# Terminal Workspace Implementation Roadmap

## Outcome

Ship a conservative terminal-workspace upgrade that gives every new project-bound workspace one safe stopped terminal, removes the normal terminal-count ceiling, permits deliberate terminal-only rearrangement, and keeps controls usable in narrow pane headers without changing existing or migrated layouts.

## Delivery rules

- This roadmap replaces the completed roadmap; the previous roadmap remains only in Git history and must not be copied to an archive file.
- Phases are strictly sequential: **0 → 1 → 2 → 3 → 4 → 5**.
- Before implementing any phase, enter plan mode, inspect the then-current code and tests, and obtain approval for that phase's implementation plan.
- Finish and verify only the approved phase, commit it, and do not begin the next phase until that commit exists.
- Keep terminal processes Rust-owned and pane-scoped; restored and bootstrapped terminal descriptors remain stopped until an explicit user restart.
- Keep the visible product practically unlimited: no normal four-terminal affordance or message remains, while persisted input and reducer output are rejected above **64 total leaves**.
- Do not run or extend `smoke-tauri-windows.mjs`; packaged terminal-interaction smoke remains deferred unless explicitly re-enabled.

## Product contracts

1. **Fresh workspace:** a workspace created from missing layout state starts with one agent pane; after that pane completes project binding, exactly one sibling terminal descriptor is added in the stopped state.
2. **Bootstrap once:** persisted layout metadata records the default-terminal bootstrap as `pending` or `complete`; successful insertion and the transition to `complete` are one state transaction.
3. **No resurrection:** closing the bootstrapped terminal does not reset the persisted state, so reload, rebind, and restart never recreate an intentionally closed default terminal.
4. **Compatibility:** every valid existing layout and every migrated legacy layout is marked bootstrap-complete without changing its root, pane descriptors, focus, ratios, or terminal count.
5. **Practical-unlimited terminals:** users may keep creating terminal leaves without a small product limit; **64 total leaves across agent and terminal panes** is solely a corruption/resource guard.
6. **Movement boundary:** only terminal leaves move; agent leaves, descriptors, sessions, and PTY ownership never move through this feature.
7. **Placement vocabulary:** valid drop positions are exactly `left`, `right`, `up`, and `down`; there is no center, swap, tab, merge, or root-background drop.
8. **Atomicity:** a move either produces a fully validated candidate layout or returns the original layout object unchanged.
9. **Focus:** a successful move keeps focus on the moved terminal; cancellation and rejection restore focus to the drag handle that initiated the operation.
10. **Drag safety:** rearrangement is disabled by default, dragging is impossible while disabled, and leaving rearrangement mode cancels any active drag without mutating layout.
11. **Responsive ownership:** terminal creation and rearrangement controls live immediately left of `Autopilot` in the agent pane header; narrow panes retain both actions through icon and overflow fallbacks.

## Proven references

These repositories are UX and reducer references only; implementation remains native to the existing GG App recursive layout model.

### Dockview — explicit zones, previews, and complete locking

- Repository: [mathuo/dockview](https://github.com/mathuo/dockview)
- Exact sources:
  - [`DroptargetOptions.acceptedTargetZones`](https://github.com/mathuo/dockview/blob/0eef758ef3bcad23cf064e56b8f3aa4b44dea5b2/packages/dockview-core/src/dnd/droptarget.ts#L99-L124)
  - [drop-overlay sizing and compact-boundary behavior](https://github.com/mathuo/dockview/blob/0eef758ef3bcad23cf064e56b8f3aa4b44dea5b2/packages/dockview-core/src/dnd/dropOverlay.ts#L13-L15)
  - [`locked: 'no-drop-target'` contract](https://github.com/mathuo/dockview/blob/0eef758ef3bcad23cf064e56b8f3aa4b44dea5b2/packages/dockview-core/src/api/dockviewGroupPanelApi.ts#L45-L63)
- Borrow: declare accepted zones rather than inferring arbitrary drops, preview the exact resulting half-pane, switch to a compact indicator when a pane is too small, and make disabled mode remove all drop targets rather than merely dimming them.

### VS Code — guarded movement, focus restoration, and atomic transitions

- Repository: [microsoft/vscode](https://github.com/microsoft/vscode)
- Exact sources:
  - [`moveGroup` self-move rejection and focus restoration](https://github.com/microsoft/vscode/blob/d8749b42129d48ba056a6e9cdbdde2007320ef66/src/vs/workbench/browser/parts/editor/editorPart.ts#L885-L923)
  - [atomic group-state application with paused events](https://github.com/microsoft/vscode/blob/d8749b42129d48ba056a6e9cdbdde2007320ef66/src/vs/workbench/browser/parts/editor/editorPart.ts#L1543-L1568)
  - [pane drag `canDrop`, self-target rejection, and cleanup](https://github.com/microsoft/vscode/blob/d8749b42129d48ba056a6e9cdbdde2007320ef66/src/vs/base/browser/ui/splitview/paneview.ts#L409-L500)
- Borrow: reject self-targets before mutation, preserve focus across tree/DOM reparenting, expose a single guarded commit point, and clean drag state on every completion path.

### OpenSumi — four directional placement semantics

- Repository: [opensumi/core](https://github.com/opensumi/core)
- Exact sources:
  - [`DragOverPosition` and `EditorGroupSplitAction`](https://github.com/opensumi/core/blob/094b998ee11d130821ea25af4390e656e35ea425/packages/editor/src/common/editor.ts#L944-L957)
  - [direction-to-split-action mapping](https://github.com/opensumi/core/blob/094b998ee11d130821ea25af4390e656e35ea425/packages/editor/src/common/utils.ts#L1-L10)
- Borrow: use named directional intent and map each direction deterministically to split orientation and child order; GG App deliberately omits OpenSumi's center position.

### OpenTu — enabled gating, self-target rejection, and drag-state reset

- Repository: [ljquan/opentu](https://github.com/ljquan/opentu)
- Exact source: [`useDragSort` enabled guard, self-target guard, preview state, and drag-end reset](https://github.com/ljquan/opentu/blob/f57c21235d3b2e970131ed0a583a0f0f8aa2b054/packages/drawnix/src/hooks/use-drag-sort.ts#L49-L123)
- Borrow: gate every handler on an explicit enabled flag, refuse source-equals-target before showing a preview, keep transient preview state separate from persisted data, and clear transient state on drag end.

## Reducer sketch

The implementation should express this as typed pure helpers, not copy library code.

```text
moveTerminal(layout, sourceId, targetId, placement):
  if placement not in {left, right, up, down}: return layout
  if sourceId == targetId: return layout
  if source is not a visible terminal leaf: return layout
  if target is not a visible leaf: return layout

  detached = removeLeafAndCollapseParent(layout.root, sourceId)
  if detached failed or target no longer exists in detached.root: return layout

  direction = left/right ? horizontal : vertical
  sourceFirst = placement is left or up
  inserted = replace target leaf with split(
    direction,
    ratio = 50,
    first = sourceFirst ? sourceLeaf : targetLeaf,
    second = sourceFirst ? targetLeaf : sourceLeaf
  )

  candidate = normalize({
    ...layout,
    root: inserted,
    focusedPaneId: sourceId,
    panes: layout.panes
  })

  if validate(candidate, maxLeaves = 64) fails: return layout
  return candidate
```

```text
commitMove(previous, request):
  candidate = moveTerminal(previous, request)
  if candidate is previous:
    clearDragPreview()
    announce("Terminal move cancelled")
    restoreFocus(request.handle)
    return previous

  clearDragPreview()
  announce("Terminal moved " + request.placement)
  scheduleFocus(candidate.focusedPaneId)
  return candidate
```

`removeLeafAndCollapseParent` removes only the source leaf, replaces its parent with the surviving sibling, and leaves all unaffected branches and descriptors untouched; candidate validation checks unique valid IDs, descriptor/leaf consistency, finite and clamped split sizes, visible focus, stopped terminal descriptors, required primary-pane preservation where applicable, depth safety, and the 64-leaf guard.

---

## Phase 0 — Contracts and compatibility boundary

### Goal

Freeze schema, compatibility, validation, and UX contracts before changing runtime behavior.

### Exact scope

- Define the next layout schema representation for persisted default-terminal bootstrap state.
- Specify missing-layout creation as bootstrap-pending and all valid/migrated pre-feature layouts as bootstrap-complete.
- Separate the **64-total-leaf corruption guard** from the existing agent-pane product policy and from terminal creation affordances.
- Define terminal-only movement and the four legal placements as exported types.
- Define one reusable candidate-layout validator for load and move-commit boundaries, without implementing drag UI.
- Decide and document whether stale extra descriptor records are pruned or rejected; use the existing loader's safer behavior consistently.

### Invariants

- Parsing old versions produces the same visible tree, descriptors, focus, ratios, and terminal count as before.
- Existing and migrated layouts never receive a default terminal.
- Missing layouts alone may carry bootstrap-pending state.
- More than 64 visible leaves is corrupt input and resolves through the existing safe recovery path.
- A terminal descriptor remains valid only when `kind === "terminal"` and `stopped === true`.
- No move API accepts an agent source or a placement outside left/right/up/down.

### Files expected to change

- `gg-app/src/workspace-layout.ts`
- `gg-app/src/workspace-layout.test.ts`
- `roadmap.md` only to record phase completion evidence after implementation

### Focused tests

- Load every supported stored layout version and assert structural equality with pre-feature expectations.
- Assert migrated layouts are bootstrap-complete but visually unchanged.
- Assert missing layout is bootstrap-pending with one primary agent leaf.
- Accept exactly 64 unique leaves and reject 65, duplicates, invalid IDs, invalid descriptors, non-finite sizes, and excessive depth.
- Assert movement types cannot represent center or agent movement at runtime validation boundaries.

### Visual/manual proof

- Open one workspace with an existing multi-pane saved layout and confirm no pane is added, removed, or focused differently.
- Open one migrated fixture and confirm the same visible pane geometry before and after the schema change.
- Capture before/after screenshots for both compatibility cases.

### Stop condition

Stop when schema tests prove unchanged existing/migrated layouts, the 64-leaf boundary, and the bootstrap-state contract; do not add a terminal or expose drag controls in this phase.

### Phase gate

Enter plan mode and obtain approval before implementation; after focused checks and manual compatibility proof pass, commit Phase 0 and do not start Phase 1 before that commit exists.

### Phase 0 completion evidence

- **Focused contract suite:** `pnpm --filter gg-app exec vitest run src/workspace-layout.test.ts` — 49/49 passed.
- **GG App gates:** `pnpm --filter gg-app check`, `pnpm --filter gg-app lint`, and `pnpm --filter gg-app format:check` passed; `pnpm --filter gg-app test` passed 309/309 tests across 28 files.
- **Compatibility screenshots:** ignored artifacts under `.gg/evidence/terminal-workspace-phase-0/`; `before-v7.png`/`after-v7.png` and `before-v6.png`/`after-v6.png` are all 1040×759.
- **Compatibility outcome:** both records retained the 60/40 root split, 240px stopped-terminal dock, three visible descriptors, one terminal, and their original focus; no pane or terminal was added or removed.
- **Component regression fixture:** `WorkspaceShell.test.tsx` now seeds an explicit recovery record for legacy two-pane scenarios and asserts genuinely missing storage renders only the new pending primary leaf.
- **Phase 0 commit:** this commit; resolve its immutable hash with `git rev-parse HEAD` after checkout.

---

## Phase 1 — Default terminal bootstrap and practical-unlimited creation

### Phase 1A — Default terminal bootstrap

#### Goal

Give each genuinely new project-bound workspace one stopped terminal exactly once.

#### Exact scope

- Create fresh missing-layout workspaces with one primary agent leaf and bootstrap-pending metadata.
- After the primary pane reports a successful, stable project binding, atomically add one stopped terminal sibling and mark bootstrap complete.
- Persist bootstrap completion in the same saved layout update as terminal insertion.
- Keep bootstrap pending if insertion cannot safely complete; retry only on a later valid binding, never after completion.
- Keep completion persisted when the default terminal is closed.
- Keep all restored and bootstrapped terminals stopped and require explicit restart.

#### Invariants

- No terminal is created before project binding is validated.
- A fresh workspace receives at most one automatic terminal.
- Existing, migrated, recovered, and terminal-only layouts receive no automatic terminal.
- Closing the automatic terminal never causes resurrection after reload, rebind, or app restart.
- Failed bootstrap does not persist a false `complete` state.

#### Files expected to change

- `gg-app/src/workspace-layout.ts`
- `gg-app/src/workspace-layout.test.ts`
- `gg-app/src/WorkspaceShell.tsx`
- `gg-app/src/WorkspaceShell.test.tsx`
- `roadmap.md` only to record Phase 1A evidence after implementation

#### Focused tests

- Missing layout → project binding → one stopped terminal plus bootstrap-complete in one resulting state.
- Repeated snapshots, rerenders, and binding events do not add another terminal.
- Close default terminal → save/reload/rebind → terminal remains closed.
- Existing valid and migrated layouts bind without terminal insertion.
- Binding mismatch, stale target, rejected layout, and failed insertion leave safe state.
- No terminal registration/start call occurs during bootstrap or restore.

#### Visual/manual proof

- Create a new workspace, bind a project, and show one agent pane plus one stopped terminal with a visible restart action.
- Close that terminal, restart the dev app, and show that it stays closed.
- Reopen an existing saved multi-pane workspace and show no automatic terminal was added.

#### Stop condition

Stop when bootstrap-once persistence, no-resurrection behavior, compatibility, and stopped lifecycle are proven; do not remove the old small terminal-count ceiling, implement movement, or relocate controls yet.

#### Phase gate

Enter plan mode and obtain approval before implementation; after focused checks and real-app bootstrap proof pass, commit Phase 1A and do not start Phase 1B before that commit exists.

#### Phase 1A completion evidence

- **Reducer bootstrap suite:** `pnpm --filter gg-app exec vitest run src/workspace-layout.test.ts` — 55/55 passed.
- **Shell bootstrap suite:** `pnpm --filter gg-app exec vitest run src/WorkspaceShell.test.tsx` — 65/65 passed; assertions cover auto-insertion, idempotence, close/no-resurrection, existing/migrated no-insertion, stale/non-primary no-insertion, and no PTY registration/start during bootstrap.
- **GG App gates:** `pnpm --filter gg-app check`, `pnpm --filter gg-app lint`, and `pnpm --filter gg-app format:check` passed.
- **Broader regression suite:** `pnpm --filter gg-app test` passed 322/322 tests across 28 files.
- **Implementation outcome:** fresh missing-layout primary binding now atomically creates exactly one stopped `terminal-1` descriptor and persists `defaultTerminalBootstrap: "complete"`; complete, migrated, terminal-only, unsafe pending, and closed-default-terminal layouts remain structurally unchanged.
- **Phase 1A commit:** this commit; resolve its immutable hash with `git rev-parse HEAD` after checkout.

### Phase 1B — Practical-unlimited terminal creation

#### Goal

Remove the normal visible terminal-count ceiling while preserving the 64-total-leaf corruption/resource guard.

#### Exact scope

- Remove terminal creation checks based on the old small leaf limit; retain the 64-total-leaf guard.
- Keep agent-pane limits unchanged unless separately approved.
- Manual creation preserves project/session target identity and never starts a PTY automatically.
- Terminal creation cannot produce a 65th total leaf.

#### Files expected to change

- `gg-app/src/workspace-layout.ts`
- `gg-app/src/workspace-layout.test.ts`
- `gg-app/src/WorkspaceShell.tsx`
- `gg-app/src/WorkspaceShell.test.tsx`
- `roadmap.md` only to record Phase 1B evidence after implementation

#### Focused tests

- Manual terminal creation succeeds beyond four terminals and stops at the 64th total leaf.
- Manual terminal creation preserves project/session target identity and never starts a PTY automatically.
- Existing bootstrap tests from Phase 1A still pass unchanged.

#### Visual/manual proof

- Open at least six terminals and show no four-terminal cap or cap messaging.
- Confirm the 64-total-leaf guard remains the only terminal creation ceiling.

#### Stop condition

Stop when creation beyond four terminals is proven, the 64-total-leaf guard still rejects a 65th leaf, and bootstrap behavior remains unchanged; do not implement movement or relocate controls yet.

#### Phase gate

Enter plan mode and obtain approval before implementation; after focused checks and real-app creation proof pass, commit Phase 1B and do not start Phase 2 before that commit exists.

### Phase 1C — Completion evidence

Record Phase 1A and Phase 1B evidence here only after each subphase is implemented, verified, and committed. Do not mark Phase 1 complete until both subphases have committed evidence.

- **Phase 1A evidence:** complete; see the Phase 1A completion evidence above.
- **Phase 1B evidence:** complete; implementation removed the old 8-leaf terminal creation/split ceiling while preserving the 64-total-leaf guard and the four-agent-pane cap.
  - `pnpm --filter gg-app exec vitest run src/workspace-layout.test.ts` — 57/57 passed.
  - `pnpm --filter gg-app exec vitest run src/WorkspaceShell.test.tsx` — 67/67 passed; existing React `act(...)` warnings were emitted by the pre-existing layout recovery test, but the suite passed.
  - `pnpm --filter gg-app check`, `pnpm --filter gg-app lint`, and `pnpm --filter gg-app format:check` passed.
  - Post-format focused reruns passed: `src/workspace-layout.test.ts` 57/57 and `src/WorkspaceShell.test.tsx` 67/67.

---

## Phase 2 — Pure terminal move reducer

### Phase 2A — Tree helpers and movement validation

#### Goal

Add the typed pure helper foundation for terminal movement without exposing the final reducer or changing runtime UI behavior.

#### Exact scope

- Implement pure lookup helpers for visible leaf discovery and descriptor consistency checks in the layout module.
- Implement pure remove-and-collapse helpers that remove one source leaf and collapse exactly one now-unary parent.
- Implement pure target-replacement helpers that can insert a detached leaf left, right, up, or down of a visible target with a new 50/50 split.
- Implement or extend normalization and candidate validation helpers used by move candidates.
- Define and enforce runtime validation for terminal-only sources and the four legal placements.
- Preserve all pane descriptors and every unaffected branch in helper outputs.
- Do not export or wire the public `moveTerminalWorkspacePane` reducer in this subphase.
- Do not add DOM drag handlers or visual overlays in this subphase.

#### Invariants

- The source validation accepts only a visible terminal leaf.
- The target validation accepts a visible terminal or agent leaf but rejects the source itself.
- Agent leaves can be targets but never sources.
- Legal placements are exactly `left`, `right`, `up`, and `down`.
- Left/right map to horizontal splits; up/down map to vertical splits.
- Left/up place the source first; right/down place the source second.
- Removing the source collapses exactly one now-unary parent and leaves unaffected branches untouched.
- Leaf IDs remain unique, descriptors remain unchanged, focus remains visible, and total leaves remain constant for valid helper candidates.
- Any helper validation failure returns an explicit failed result without partial mutation or persistence.

#### Files expected to change

- `gg-app/src/workspace-layout.ts`
- `gg-app/src/workspace-layout.test.ts`
- `roadmap.md` only to record Phase 2A evidence after implementation

#### Focused tests

- Lookup visible terminal and agent leaves in shallow and nested trees.
- Remove terminals from shallow, nested, first-child, second-child, ratio, and fixed-second source parents.
- Insert detached terminal leaves in each of the four directions around agent and terminal targets.
- Verify unaffected subtree object structure, descriptors, ratios, and fixed sizes remain intact after helper operations.
- Reject agent sources, missing IDs, self-targets, invalid placements, duplicate/corrupt candidates, over-depth candidates, and over-64 candidates at helper validation boundaries.
- Assert helper failure paths do not mutate the original layout object.

#### Visual/manual proof

- Use a reducer-helper harness or test-rendered tree to print before/after structures for helper removal and insertion cases.
- Confirm the renderer can display representative helper-produced nested trees without clipped or missing panes.
- No interactive drag demonstration is required in this subphase.

#### Stop condition

Stop when helper tests prove lookup, remove-and-collapse, four-way insertion semantics, descriptor preservation, validation rejection, and no-mutation failure behavior; do not wire UI events or export the public move reducer yet.

#### Phase gate

Enter plan mode and obtain approval before implementation; after helper checks and structural rendering proof pass, commit Phase 2A and do not start Phase 2B before that commit exists.

### Phase 2B — Public terminal move reducer

#### Goal

Export one deterministic, fully tested recursive tree transformation for moving one terminal left, right, up, or down of another visible pane.

#### Exact scope

- Export one `moveTerminalWorkspacePane` reducer accepting source terminal ID, target leaf ID, and four-way placement.
- Compose the Phase 2A lookup, remove-and-collapse, target replacement, normalization, and validation helpers into one guarded reducer commit point.
- Preserve all pane descriptors and every unaffected branch.
- Use a new 50/50 ratio split at the insertion point; preserve ratios and fixed sizes outside the removed source parent and inserted target position.
- Keep the moved terminal focused on success.
- Return the exact original layout object for all invalid or no-op requests.
- Do not add DOM drag handlers or visual overlays in this subphase.

#### Invariants

- The source must be a visible terminal leaf.
- The target may be a visible terminal or agent leaf but may not equal the source.
- Agent leaves can be targets but never sources.
- Left/right create horizontal splits; up/down create vertical splits.
- Left/up place the source first; right/down place the source second.
- Removing the source collapses exactly one now-unary parent before insertion.
- Leaf IDs remain unique, descriptors remain unchanged, focus remains visible, and total leaves remain constant.
- Any validation failure returns the original object without partial mutation or persistence.

#### Files expected to change

- `gg-app/src/workspace-layout.ts`
- `gg-app/src/workspace-layout.test.ts`
- `roadmap.md` only to record Phase 2B evidence after implementation

#### Focused tests

- Move a terminal in each of the four directions around agent and terminal targets.
- Move from shallow, nested, first-child, second-child, ratio, and fixed-second source parents.
- Verify unaffected subtree object structure, descriptors, and split values remain intact.
- Reject agent sources, missing IDs, self-targets, invalid placements, duplicate/corrupt candidates, over-depth candidates, and over-64 candidates.
- Assert invalid moves return the same object identity and successful moves focus the source terminal.
- Round-trip every successful candidate through save/load validation.
- Property-style table tests assert leaf multiset and descriptor map equality before and after valid moves.

#### Visual/manual proof

- Use a reducer harness or test-rendered tree to print before/after structures for all four directions.
- Confirm the renderer can display each resulting nested tree without clipped or missing panes.
- No interactive drag demonstration is required in this subphase.

#### Stop condition

Stop when the pure reducer proves four-way placement, terminal-only sources, descriptor preservation, focus preservation, round-trip persistence, and exact rollback semantics; do not wire UI events yet.

#### Phase gate

Enter plan mode and obtain approval before implementation; after reducer checks and structural rendering proof pass, commit Phase 2B and do not start Phase 2C before that commit exists.

### Phase 2C — Completion evidence

Record Phase 2A and Phase 2B evidence here only after each subphase is implemented, verified, and committed. Do not mark Phase 2 complete until both subphases have committed evidence.

- **Phase 2A evidence:** complete; commit `dd334ee2` (`Add terminal move layout helper foundations`) implemented the pure helper foundation for terminal movement without exposing the public reducer or UI wiring.
  - `pnpm --filter gg-app exec vitest run src/workspace-layout.test.ts` — 73/73 passed.
- **Phase 2B evidence:** complete; exported `moveTerminalWorkspacePane` as the public pure reducer wrapping the Phase 2A candidate helper, with exact original-layout identity rollback for invalid/no-op requests and terminal focus on successful moves.
  - `pnpm --filter gg-app exec vitest run src/workspace-layout.test.ts` — 101/101 passed.
  - `pnpm --filter gg-app check` — passed.
  - `pnpm --filter gg-app lint` — passed.
  - `pnpm --filter gg-app format:check` — passed.
  - Reducer tests cover four-way movement around agent and terminal targets, source-parent collapse variants, invalid rollback identity, corrupt/over-depth/over-64 rollback, save/parse round-trips, leaf multiset equality, descriptor equality, unchanged leaf count, and unchanged bootstrap state.

### Phase gate

After Phase 2A and Phase 2B are both complete and committed, commit the Phase 2C evidence update and do not start Phase 3 before that commit exists.

---

## Phase 3 — Toggleable terminal drag UI

### Goal

Expose deliberate, previewable terminal rearrangement while making accidental dragging impossible outside rearrangement mode.

### Exact scope

- Add workspace-scoped transient rearrangement state, defaulting to disabled on mount.
- Render a drag handle only for terminal panes and make it draggable only while mode is enabled.
- Render four explicit target zones over visible pane leaves: left, right, up, and down.
- Use full half-pane previews where space permits and compact directional indicators in small panes.
- Dispatch only one reducer request on drop; never mutate layout during hover.
- Cancel active drag on Escape, pointer cancel, drag end without valid drop, outside drop, window blur, source disappearance, target disappearance, and mode disable.
- Keep file-drop/native-drop handling isolated from internal terminal movement through a dedicated drag MIME/type marker.
- Add an accessible non-pointer “Move terminal” flow exposing the same target and direction choices.
- Announce mode changes, valid moves, and cancellations through an app-appropriate polite live region.

### Invariants

- Disabled mode registers no valid internal drop targets and starts no terminal movement.
- Only terminal handles initiate internal movement.
- Hover state is transient and never reaches layout persistence.
- No center/background/root drop exists.
- Invalid drops leave layout object identity unchanged.
- A successful drop focuses the moved terminal; cancellation restores the initiating handle's focus when it still exists.
- Terminal input remains interactive, and terminal text selection does not start a drag.
- Native file drops continue reaching the focused agent input without being mistaken for pane moves.

### Files expected to change

- `gg-app/src/WorkspaceShell.tsx`
- `gg-app/src/WorkspaceNode.tsx`
- `gg-app/src/TerminalPane.tsx`
- `gg-app/src/App.css`
- `gg-app/src/WorkspaceShell.test.tsx`
- `gg-app/src/TerminalPane.test.tsx`
- A focused new drag-overlay component/test file if separation is clearer than expanding `WorkspaceNode.tsx`
- `roadmap.md` only to record phase completion evidence after implementation

### Focused tests

- Disabled mode blocks drag start and renders no active zones.
- Enabled mode accepts only terminal drag payloads and four legal zones.
- Hover previews do not call the reducer; valid drop calls it once.
- Escape, blur, pointer cancel, outside drop, mode-off, invalid target, and source removal clear all transient state.
- Agent panes cannot become drag sources.
- Keyboard movement reaches every target/direction combination and restores focus correctly on cancel.
- ARIA names, pressed state, instructions, live announcements, and focus order are stable.
- File-drop tests remain green alongside internal drag tests.

### Visual/manual proof

- Record enabled and disabled states, including the absence of drag affordances when disabled.
- Drag one terminal left, right, up, and down around both agent and terminal targets.
- Demonstrate compact indicators in a narrow/small pane.
- Demonstrate Escape cancellation and keyboard-only movement with visible focus.
- Type and select text inside a terminal before and after rearrangement to prove interaction remains intact.

### Stop condition

Stop when pointer and keyboard movement share the pure reducer, every cancellation path is inert, disabled mode is genuinely non-draggable, focus/announcements are correct, and file drops remain isolated; do not relocate header controls yet.

### Phase gate

Enter plan mode and obtain approval before implementation; after focused interaction checks and recorded real-app drag proof pass, commit Phase 3 and do not start Phase 4 before that commit exists.

---

## Phase 4 — Responsive pane-header controls

### Goal

Place terminal creation and rearrangement controls immediately left of Autopilot and keep them discoverable at narrow pane widths.

### Exact scope

- Remove the standalone terminal-open control from the workspace toolbar.
- Pass pane-specific terminal actions from `WorkspaceShell` through `WorkspaceNode` to the relevant agent pane header.
- Render `New terminal` and the rearrangement toggle immediately before `Autopilot` in DOM and visual order.
- Ensure terminal creation uses the owning agent pane's target rather than whichever pane happens to gain focus during the click.
- Use pane/container width, not only window width, for responsive behavior.
- Wide: labeled controls; medium: icon buttons with tooltips and accessible names; narrow: one overflow/menu trigger containing both actions.
- Keep toggle state and disabled reasons identical across labeled, icon, and overflow renderings.
- Avoid wrapping controls over the title, usage meter, window drag region, or Autopilot.

### Invariants

- Control order is always terminal creation, rearrangement, Autopilot.
- Every responsive representation invokes the same callbacks and exposes the same accessible names/state.
- No duplicate actionable control remains in the workspace toolbar.
- The add action is disabled until its agent pane has a validated project binding and at the 64-leaf guard.
- The rearrangement toggle remains available when terminals exist; if none exist, it is disabled with a clear reason.
- Narrow layouts preserve Autopilot and both terminal actions without horizontal page overflow.
- Tauri drag regions do not swallow control clicks.

### Files expected to change

- `gg-app/src/AgentPane.tsx`
- `gg-app/src/AgentPane.test.tsx`
- `gg-app/src/WorkspaceShell.tsx`
- `gg-app/src/WorkspaceShell.test.tsx`
- `gg-app/src/WorkspaceNode.tsx`
- `gg-app/src/App.css`
- A focused `TerminalWorkspaceControls.tsx` and test file if extraction keeps `AgentPane` small
- `roadmap.md` only to record phase completion evidence after implementation

### Focused tests

- Assert exact DOM order immediately before Autopilot.
- Assert wide, icon, and overflow variants call identical add/toggle callbacks.
- Assert pane-specific creation uses the clicked header's bound target.
- Assert loading, unbound, zero-terminal, rearranging, and 64-leaf disabled states.
- Assert only one reachable copy of each action exists at each responsive breakpoint.
- Assert keyboard menu operation, focus return, tooltip/accessible names, and pressed state.
- Assert workspace toolbar no longer contains terminal creation.

### Visual/manual proof

- Capture the same workspace at wide, medium, and narrow pane widths.
- Show the controls directly left of Autopilot in every representation.
- Split the window into narrow nested panes and prove controls do not overlap, wrap destructively, or become unreachable.
- Add a terminal from a non-primary agent pane and verify target ownership is correct.

### Stop condition

Stop when all three responsive modes preserve order, semantics, pane ownership, keyboard access, and layout stability, with no duplicate workspace-toolbar action.

### Phase gate

Enter plan mode and obtain approval before implementation; after focused responsive checks and width-by-width screenshots pass, commit Phase 4 and do not start Phase 5 before that commit exists.

---

## Phase 5 — Real-app verification and release confidence

### Goal

Prove the complete workflow in the actual Tauri development app under realistic persistence, focus, terminal lifecycle, and responsive conditions.

### Exact scope

- Run targeted unit/component tests for every changed workspace and terminal module.
- Run GG App check, test, lint, format check, and build commands required by the final diff.
- Rebuild `@kenkaiiii/ggcoder` only if sidecar code changed; no sidecar change is expected for this feature.
- Exercise new workspace bootstrap, existing/migrated compatibility, repeated terminal creation, close/reload behavior, pointer movement, keyboard movement, cancellation, focus, persistence, and responsive controls in the real dev app.
- Verify stopped terminals remain stopped after restore and only explicit restart creates PTYs.
- Inspect app/sidecar logs for routing, ownership, persistence, and cleanup errors generated during the session.
- Record concise evidence and fix only defects within Phases 0–4 scope.
- Do not run the deferred packaged terminal-interaction smoke.

### Invariants

- Existing and migrated layouts remain unchanged throughout real-app verification.
- A fresh project-bound workspace gets one stopped terminal once, and an intentionally closed default never returns.
- More than four terminals remain usable and isolated with no visible small cap.
- Every persisted layout reloads to the same tree and focused terminal after successful moves.
- Invalid/cancelled moves never change persisted storage.
- Agent events, terminal output, input, resize, close, and restart stay pane/window scoped.
- Narrow controls remain reachable and do not compromise Autopilot.
- No verification claim is made for a command or scenario that was not run successfully.

### Files expected to change

- No product file is expected to change during verification.
- Targeted Phase 0–4 files may change only to fix a defect exposed by verification, followed by rerunning their focused checks.
- `roadmap.md` may record final commands, screenshots, and outcomes before the phase commit.
- Temporary screenshots and logs remain ignored artifacts and are not committed unless the repository already has an approved evidence location.

### Focused tests

- `workspace-layout` parser, migration, 64-leaf, bootstrap, reducer, and round-trip suites.
- `WorkspaceShell` bootstrap, persistence, focus, drag cancellation, file-drop isolation, and control wiring suites.
- `WorkspaceNode`, `TerminalPane`, and `AgentPane` interaction/accessibility/responsive suites.
- GG App project-wide checks appropriate to the changed files.
- Regression tests for existing pane split, resize, close confirmation, open-in-new-window, terminal restart, and stale-layout recovery behavior.

### Visual/manual proof

- Fresh bind: one agent plus one stopped terminal.
- Close/restart: default terminal stays closed.
- Existing/migrated restore: no structural change.
- Scale: at least eight simultaneously visible/restorable terminals with isolated identity and output.
- Movement: each terminal-only direction, nested source/target, persistence after restart, and moved-terminal focus.
- Cancellation: Escape, outside drop, blur, mode-off, and invalid/self target.
- Accessibility: keyboard-only move and live announcement.
- Responsiveness: wide labels, medium icons, narrow overflow immediately left of Autopilot.
- Lifecycle: restart selected terminals, close running terminals through confirmation, then exit the dev app and confirm owned processes clean up.

### Stop condition

Stop only when all targeted and project checks pass, real-app evidence covers every product contract, logs show no ownership/routing/persistence regressions, and any discovered defect has a focused regression test; packaged smoke remains explicitly unclaimed.

### Phase gate

Enter plan mode and obtain approval before beginning verification/fix work; after all proof is recorded and checks pass, commit Phase 5 as the final phase and do not push without a separate explicit request.

## Definition of done

- New workspaces bootstrap exactly one stopped terminal after validated project binding.
- Persisted bootstrap-once state prevents resurrection after intentional close.
- Existing and migrated layouts are structurally and visually unchanged.
- Terminal creation has no small visible cap; 64 total leaves remains the corruption guard.
- Only terminals move, only in four directions, and invalid moves roll back atomically.
- Rearrangement is explicitly toggleable, cancellable, pointer-accessible, and keyboard-accessible.
- Creation and rearrangement controls sit immediately left of Autopilot and survive narrow panes.
- Focus, persistence, PTY ownership, native file drop, and terminal lifecycle isolation remain intact.
- Every phase was planned first, verified, and committed before the next phase began.
