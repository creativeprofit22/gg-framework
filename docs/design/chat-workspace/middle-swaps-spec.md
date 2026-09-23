# Chat-pane middle swaps: implementation specification

Updated: 2026-09-20. **Status: approved source implementation present; root tests, workspace typechecks and scoped Windows developer-app verification passed. Native-input and accessibility limits remain documented.** See [verification and evidence](middle-swaps-verification.md). Nothing has been installed or released.

The approved plan settles the interaction contract below and authorizes scoped source implementation, tests, synthetic browser checks, and modular documentation. It does not authorize installation, dependency additions, distribution builds, release, commits, pushes, removal of rearrangement, or Light/message-alignment integration.

## Ownership and scope

[Optional chat-pane swaps into the middle](optional-middle-swaps.md) remains the source of user intent and behavioural requirements. This sibling owns implementation constraints, decision tracking, research limits, and future acceptance checks. Neither document changes the Light-preview/message-alignment workflow.

## Required interaction

Implement the proposal's same-row pairwise exchange, not a row rotation or a move that restructures splits. Preserve the other row and allow normal clicking, reading, and typing in every side pane without a swap. The middle position must not acquire special conversation ownership or capabilities.

The six-pane example is not a product restriction. Target actual untransformed split geometry, never tree traversal order.

## Approved interaction contract

- **Rows:** horizontally contiguous panes with matching top/bottom boundaries within less than one divider thickness (7 CSS pixels), so a grid whose column dividers were dragged a few pixels apart still reads as rows. Horizontal adjacency stays within one CSS pixel. No transitive overlap or crossing a taller spanning pane. Partial-workspace rows and unequal widths are supported; fewer than three panes or ambiguous boundaries are unavailable.
- **Middle:** nearest pane centre to the midpoint of row bounds, ties left. Any non-middle pane may exchange with it. Recompute after resize, split, close, or movement; never wrap to another row.
- **Controls (ergonomics correction, user approved):** labelled, keyboard-reachable “Swap with middle” actions remain on side panes. Every eligible center pane also has always-visible left/right arrow buttons to exchange with its immediate neighbour in that direction, without reaching to the side pane. All controls work independently of Rearrange mode. Side actions retain hover/focus/touch visibility; accessible help explains eligibility.
- **Shortcuts:** Ctrl+Alt+Shift+Left/Right (Windows/Linux), Cmd+Option+Shift+Left/Right (macOS), exchanges the immediate left/right neighbour of the middle in the focused pane's row. Buttons can choose farther panes. Do not claim universal OS conflict freedom.
- **Input boundaries:** ignore handled, composing, AltGraph, repeat, modal/menu, and outside-workspace input. The exact chord may operate while typing. Suppress browser default only for an eligible exchange.
- **Focus:** editing/content focus follows conversation identity. Button focus follows the initiating position: side actions hand off to the displaced conversation's side button; center actions hand off to the incoming conversation's same left/right button in the center. Restore before paint with `preventScroll` and the existing logical pane-focus path. Another activation of the same action exchanges the pair back. Never enter a composer or promote a main chat.
- **Continuity:** shortcuts preserve the focused element and selection unless its swap button disappears, in which case apply the initiating-position rule in **Focus**: side buttons hand off at the originating side; center arrows retain the same direction at the center. Composer/content focus follows conversation identity. Generation-scoped handoffs cancel on independent live-control/modal focus. If the destination disappears, focus the surviving originating conversation's labelled region (`tabIndex=-1`) or workspace fallback. No animation-completion focus work, positive tabindex, Tab interception, remounts, or extra sequential region stop.
- **Repeated input:** distinct taps are atomic transactions on current state, even during animation. Guard held native Enter/Space without suppressing ordinary Space keyup. No debounce, queue, or input lock. Pointer activation belongs to the currently hit control. Revalidate targets at execution.
- **Motion:** final geometry commits immediately; animate only the two existing hosts, translation-only, 160 ms `cubic-bezier(0, 0, 0.58, 1)`. Restart interrupted effects from their current rendered location. Unequal-width reflow occurs once. Cancel stale effects on other geometry changes, hidden windows, or motion-preference changes.
- **Reduced motion:** snap intentionally, retaining visible keyboard focus and concise polite feedback.
- **Preservation:** preserve both drafts, selections, stable reading anchors through reflow, bottom-pin/stream-follow intent, pending interactions, sessions and primary identity. Pane-local restoration never competes with button focus. Preserve the unrelated row, split ratios and registry identities.
- **Recovery:** exchange the same pair again; retain general rearrangement for cross-row/split restructuring.

## Approved architecture

**Implementation direction:** retain the existing layout system and perform a single exchange of pane identities at two leaf positions, preserving the split structure and ratios. Keep conversation state and session ownership attached to each pane identity, never to a visual slot or row index. Do not change the existing primary-pane identity merely because another conversation moves into the middle.

The existing flat, keyed pane hosts are a useful foundation. Avoid remounting panes or rebinding native sessions to achieve a visual exchange. State preservation must cover both participants: identity, draft, caret/selection, scroll, active work, and pending interactions.

For unequal pane sizes, retaining a DOM node alone does not prove that reading position survives text reflow. Define and verify preservation of the visible reading location and bottom-pinned behaviour, rather than relying only on an unchanged numeric scroll offset.

Research references already inspected in this conversation:

- **Stack-Cairn/LiveAgent**, revision `4eb6a4a89a5a49ffa0ebcde69f6b0fad373a6ad2`, `crates/agent-ui/src/lib/workbench/reducer.ts:289–300,600–623`: pairwise leaf exchange distinct from movement. Does not define this proposal's row or middle rules.
- **crynta/terax-ai**, revision `b02a7dcbfe58d22b2352d9618b8ed3199e317a00`, `src/modules/terminal/lib/panes.ts:193–289`: spatial targeting and distinction between slot and pane identity. Directional-neighbour selection and wrapping are not the requested side-to-middle behaviour.
- **caplin/FlexLayout**, revision `92c9d67c2cba18b1fe6731af25f287e7abe30b2f`, `src/model/TabNode.ts:391–404`: mounted-element and scroll-state transfer. This is a preservation reference, not a recommendation to replace the local layout system.

These are source comparisons, not proof of local correctness or approval to add dependencies.

## Rearrangement defect: evidence and limits

During read-only research on 2026-09-20, the local source showed that starting an HTML pane drag records active drag state, while a window-level `pointercancel` listener cancels that state. The drop handler rejects requests without active drag state. Source locations at inspection: `gg-app/src/WorkspaceNode.tsx:353–368`; `gg-app/src/WorkspaceShell.tsx:301–319,403–418,446–477,527–545`.

An isolated in-memory Chromium experiment observed `dragstart → pointercancel → drop`. With cancellation on `pointercancel`, the simulated move did not commit; changing only that cancellation behaviour allowed it to commit. This confirms the isolated event-order mechanism, not reproduction of the user's installed-app failure. The HTML drag processing model also specifies `pointercancel` after an uncancelled `dragstart`: <https://html.spec.whatwg.org/multipage/dnd.html#drag-and-drop-processing-model>.

Conversation execution records: failing isolated probe `6ee03e0d-c12c-4553-8fd9-96819fee6774`; differential probe `584824a1-0908-4e55-aab2-ca5aa06a6564`. These records are not portable checked-in test artifacts. A later real-component browser attempt was interrupted with an unknown result. Do not count it as passed, failed, or native verification.

**Implementation update:** the real WorkspaceShell regression test reproduced cancellation after `dragstart → pointercancel` and passed after removing only the HTML pane-drag cancellation listener. Divider pointer-resize cancellation is unchanged. Escape, dragend, blur, outside-drop and valid edge-drop checks pass. The initial real-component Chromium mouse-drag attempt ended `dragstart → dragend` before interception. A second defect was then isolated: the source pane's inert drop zones still intercepted the initiating pointer. Making only those zones ignore pointer events fixes the real Chromium drag sequence and pane relocation. The regression runner retains bounded diagnostics. **Installed Tauri reproduction and verification remain pending.** Revalidate installed-build provenance before claiming a confirmed installed-app cause.

## Replacement coverage

Same-row swaps cover exchanging two existing positions without changing row geometry. They do not cover cross-row relocation or insertion beside a target that changes the split structure, which the current movement operation supports (`gg-app/src/workspace-layout.ts:640–664` at inspection).

The approved implementation retains general rearrangement while adding swaps. Diagnose the native defect and assess remaining relocation needs before proposing removal. This implementation does not authorize deleting the existing feature.

## Acceptance checklist

These are required scenarios, not a blanket pass. Consult the [verification matrix](middle-swaps-verification.md) for executed checks and remaining gaps:

- Left/middle and right/middle exchanges in either row are pairwise; the other row and all split ratios remain unchanged.
- Side panes remain clickable and editable before and after repeated swaps; moving into the middle does not promote conversation ownership.
- Both participants retain conversation identity, draft, caret/selection, reading position, bottom-pin intent, and ongoing work without remount/session restart.
- Verify preservation with real chat bodies, active streaming, pending interactions, and unequal widths, not only synthetic pane fixtures.
- Exercise every approved layout rule, ambiguous/unavailable targets, pane closure, resize, and repeated input against current state.
- Verify buttons, shortcut conflicts, row targeting, focus, modal/composition exclusions, reduced motion, and non-motion feedback against the settled decisions.
- Verify saved layout restores the exchanged positions without changing conversation ownership.
- Distinguish pure layout tests, synthetic browser tests, and native app verification. Preserve file/folder attachment drops and existing general rearrangement capabilities unless separately approved otherwise.

Record actual verification results only after execution, with their environment and boundaries. Initial baseline: 99 tests passed across workspace-layout, WorkspaceShell and PaneDropOverlay; ImageMagick 7.1.2-25 is installed. These results predate implementation and do not verify swaps.
