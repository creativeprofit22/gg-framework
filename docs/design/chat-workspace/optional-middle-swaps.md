# Optional chat-pane swaps into the middle

Recorded: 2026-09-20. **Status: the user subsequently approved the implementation plan; source implementation is present, with verification gaps recorded separately.** Keep this work separate from Light-preview/message-alignment integration. No installation, distribution build, release, or removal of general rearrangement was authorized.

This document owns the requested behaviour and scope. The [implementation specification](middle-swaps-spec.md) owns the approved contract and implementation constraints. [Verification](middle-swaps-verification.md) records what ran, what failed, and what remains unverified.

## User context and desired behaviour

The user reports that the existing button-activated drag-and-drop pane rearrangement feature is broken in their experience. They want to replace it with a more convenient way to reposition chats. Subsequent research confirmed an isolated drag-cancellation mechanism, but the installed-app cause remains unverified; see the [evidence and limits](middle-swaps-spec.md#rearrangement-defect-evidence-and-limits).

In a six-pane layout, or a larger layout with at least three panes across the top and at least three across the bottom, provide buttons and keyboard shortcuts to swap a selected left or right pane with the middle pane **in the same row**:

- Every center pane has always-visible left/right swap arrows: either neighbour can be exchanged without reaching away from the center. Side-pane buttons remain available.
- The selected side pane moves into the middle position.
- The displaced middle pane takes that side pane's previous position.
- The other row stays unchanged.
- This is a pairwise swap, not rotation of the whole row.

For example, a row ordered `A B C` becomes `B A C` when swapping the left pane into the middle, or `A C B` when swapping the right pane into the middle. The six-pane example establishes the desired interaction, not a six-pane-only product restriction. The approved specification resolves wider and uneven layouts using physical pane geometry, with unavailable actions for ambiguous rows.

## Preserve every chat as a usable peer

Every pane must remain fully usable in place: the user can click and type in a side pane without swapping it. The middle is only a comfortable physical position, not a privileged “main” chat.

Swapping must preserve each conversation's identity, draft, scroll position, and ongoing work. Moving a conversation must not reset it or interrupt its work.

## Approved UX direction

The [approved interaction contract](middle-swaps-spec.md#approved-interaction-contract) settles control placement, shortcuts, focused-row targeting, focus handoff, rapid input, reduced motion, and other layouts. Swaps commit immediately, with an optional 160 ms translation of the two existing hosts; reduced motion snaps. No conversation becomes a privileged main chat.

## Diagnosis and replacement boundary

Before proposing removal of the existing rearrangement feature, diagnose the reported defect and assess replacement coverage: determine which existing rearrangement capabilities the proposed swaps would cover and which would remain unmet. The user's replacement intent does not authorize removal now.

The approved implementation retains general rearrangement for cross-row movement and split restructuring. Its narrow pointercancel and inert-overlay corrections have component-test and real Chromium drag evidence, but not installed Tauri verification. Neither this implementation nor its browser evidence authorizes release or expansion of the Light-preview/message-alignment work.
