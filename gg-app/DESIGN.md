# GG App Interface Design

## Phase 17: Compact Notes Shell

### Design read

- **Surface:** A dense developer-tool workspace inside the existing Notes modal.
- **Audience:** Keyboard-heavy GG Coder users managing project notes in resizable Tauri windows, including split-screen, zoomed, reduced-motion, and Windows high-contrast use.
- **Single job:** Let the user reach and edit the relevant Notes section without scrolling through unrelated sections.
- **Task and risk:** Notes are edited frequently and saved optimistically. Draft loss, hidden-control focus, and obscured save diagnostics are higher risks than visual novelty.
- **Content:** Short current-focus text, variable task lists and actions, multiline Handoff and Reference text, archived tasks, and passive phase/reminder counts.
- **Platform:** React in a Tauri webview with keyboard and pointer input across resizable desktop windows.
- **Constraints:** Preserve the current Geist typography, dark tokens, modal, section, button, form, focus-ring, persistence-status, and task-lifecycle language. Add no design dependency, icon family, Roadmap controls, structured-reference rows, or product-wide style changes.

### Design thesis

Use one stable workspace frame: title and storage status first, a fixed plain-text tab rail second, and exactly one independently scrolling panel below it.

The selected tab uses stronger text and an underline rather than a pill, icon, glow, or elevated surface. All four panels stay mounted so drafts, edit mode, archive disclosure, and panel scroll positions survive navigation. The modal uses one shared inner content rail across every panel.

Only color and border feedback transition. There is no spatial tab animation, hover lift, glass, gradient, decorative emoji, or ambient motion.

### Local reuse map

| Need | Existing source | Phase 17 use |
| --- | --- | --- |
| Dialog semantics, Escape, focus return | `src/Modal.tsx` | Retain and harden its shared focusable-element filter. |
| Tabs and roving keyboard behavior | `src/MemoryModal.tsx` | Reuse the tablist/tab/tabpanel pattern, automatic activation, and focus movement conventions. |
| Notes editors and task lifecycle | `NotesCurrentFocus`, `NotesTaskList`, `NotesHandoff` | Move unchanged beneath destination panels and preserve callbacks. |
| Persistence diagnostics | `NotesPersistenceStatus` in `src/ProjectNotes.tsx` | Keep fixed above the tab rail with existing live-region wording. |
| Visual language | `src/App.css` and `src/theme.ts` | Reuse surfaces, borders, radii, form controls, button anatomy, and focus treatment. |
| Typography and icons | Existing Geist and Lucide setup | Keep existing type roles; add no navigation icons. |

### Content and count contract

- **Overview:** Now, Next, and Handoff in that order. Show an inline Roadmap summary only when an active phase or active reminder exists.
- **Roadmap:** Show passive active-phase and active-reminder totals, or an honest empty state. Do not expose phase titles or create, edit, reorder, status, selection, or session actions.
- **Reference:** Keep the existing free-form `Reference notes` textarea. Structured references remain undisplayed until Phase 19.
- **Archive:** Keep the existing Done / Archive disclosure, archived rows, empty state, and Restore actions. Settled phases remain undisplayed until Phase 18.
- **Stable navigation:** Overview, Roadmap, Reference, and Archive are always present. Empty count fragments disappear without shifting tab positions.
- **Active phase:** Any phase whose status is neither `done` nor `cancelled`.
- **Active reminder:** A non-null reminder attached to an active phase. Settled-phase reminder data does not count.
- **Titlebar status:** Existing unfinished-task and Handoff badge semantics remain unchanged.

### Interaction and accessibility contract

- Use one labeled horizontal `tablist` with four `tab` buttons and four matching `tabpanel` elements.
- Every tab has a stable `id`, `aria-controls`, `aria-selected`, and roving `tabIndex`; every panel has matching `aria-labelledby`.
- Activate tabs automatically. Left and Right arrows wrap; Home and End select the first and last tabs.
- Initial modal focus lands on Overview. Tab then enters only Overview content.
- Keep inactive panels mounted with the native `hidden` attribute.
- Modal initial focus and containment exclude negative-tab-index controls and descendants of `hidden`, `aria-hidden="true"`, or `inert` ancestors.
- Preserve Escape close, trigger focus return, semantic labels, live save/task status, visible `:focus-visible`, and minimum 24 CSS-pixel pointer targets.
- Pointer activation must not masquerade as keyboard focus. Selected state remains visibly independent from focus state.
- Keep title, persistence status, and tab rail fixed. Only the active panel scrolls vertically.
- Use text plus structure rather than color alone for selection, counts, warnings, errors, and empty states.

### Responsive behavior

- Size the Notes workspace relative to the viewport with a small outer gutter and bounded shared panel rail.
- At narrow widths, keep a single vertical reading flow and let only the tab rail scroll horizontally.
- Keep the modal and active panel within the viewport; do not introduce page-level horizontal scrolling.
- Wrap task actions and edit controls without changing DOM or focus order.
- Preserve reachable controls and readable unbroken content at 320 CSS pixels and 200% text zoom.
- Keep target sizes and focus outlines intact for pointer, keyboard, no-hover, and Windows desktop input.
- Under `prefers-reduced-motion: reduce`, remove tab color/border transitions while preserving immediate state feedback.
- Under forced colors, retain visible dialog, tab, panel, control, selected, and focus boundaries.

### State matrix

| State | Required result |
| --- | --- |
| Initial open | Overview is selected and focused; exactly one panel is visible. |
| Populated Overview | Existing edits and task actions remain available; non-zero Roadmap summary fragments appear. |
| Empty Overview summary | Zero phase/reminder fragments are absent; all tabs remain stable. |
| Empty Roadmap | Honest no-active-roadmap-work message with no CRUD or session action. |
| Populated Roadmap | Correct singular/plural passive counts only. |
| Reference editing | Existing textarea value and sidecar persistence flow remain intact across tab switches. |
| Archive collapsed/expanded | Disclosure and Restore behavior remain intact across tab switches. |
| Authoritative rerender | Selected tab and mounted local editor/disclosure state survive. |
| Project switch | Old modal closes; prior project tab and content cannot leak into the new project. |
| Save warning/error | Existing live diagnostic stays fixed and visible above navigation. |
| Long content | Only the selected panel scrolls; shell title, status, and tabs remain fixed. |
| Narrow/zoomed | Tab rail scrolls horizontally, actions wrap, and no page-level horizontal overflow appears. |
| Reduced motion | State feedback is immediate with no tab transition. |
| Forced colors | Selected tab, controls, focus, and boundaries remain distinguishable. |

### Release evidence contract

Phase 17 is complete only after all of the following are reviewed and pass:

1. Focused Notes/modal/storage tests, gg-app typecheck, lint, and format check.
2. Full gg-app test suite and production build.
3. Controlled browser captures with synthetic non-sensitive v3 fixtures for empty desktop, typical Overview, long content, and a 320–420 CSS-pixel narrow window.
4. One native Tauri smoke at typical and narrow window sizes.
5. Keyboard-only tab selection plus every existing edit and restore flow; visible, unobscured focus; no hidden-panel focus; Escape; and trigger focus return.
6. Semantic role/name/control inspection and live-status wording review. Automated accessibility scans are defect detection, not full conformance proof.
7. 200% text and 320 CSS-pixel reflow, long unbroken content, and long-label/localization stress.
8. Pointer focus, reduced-motion, and Windows forced-colors/high-contrast checks.
9. One rendered critique-and-revision cycle scoring at least 20/24 on the evidence-led UI rubric, with no zero in accessibility, consistency and flow, responsive behavior, state completeness, or content authenticity.
10. Honest recording of unavailable performance or accessibility tooling rather than substituting semantic tests for missing evidence.
