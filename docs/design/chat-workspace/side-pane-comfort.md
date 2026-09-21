# Side-pane reading comfort

Status: research and proposals only; no side-pane layout implementation approved.

## Scope and user evidence

The user reports that center panes are comfortable with the current reading improvements, but sustained reading at either edge still causes discomfort while sitting or standing. Preserve center-pane defaults. The aim is to reduce sideways viewing for long replies, not to promise treatment for eye strain. Physical display arrangement, viewing distance, eyewear and the user's position remain unknown.

Separately approved and implemented: user messages share the assistant's left text edge in the Light browser preview, retaining their bubble wrapper. Original comparison and installed defaults are unchanged. Personality profile icons remain future work, not part of this change.

## What the sources establish

1. [CCOHS: Positioning the Monitor](https://www.ccohs.ca/oshanswers/ergonomics/office/monitor_positioning.html), confirmed current by CCOHS on 2025-07-21: multiple-display setup should reduce head/body twisting and eye travel; the most-used monitor belongs directly in front of the user. Wide displays can require neck rotation. Distance and text size should be adjusted together, rather than forcing the user closer to resolve small text. This is workstation guidance, not a study validating GG's proposed UI.
2. [VS Code: Custom Layout](https://code.visualstudio.com/docs/configure/custom-layout): centered editor layout, temporary maximize/restore, expand-an-editor-group, and floating editors are established product patterns. These document behavior, not ergonomic efficacy.
3. [WezTerm source, pinned revision](https://github.com/wezterm/wezterm/blob/2afb836403838c3ed7e09e5d570190adb054b607/mux/src/tab.rs#L880-L910), read through the local corpus: zoom stores the active pane and prior size, then restores sizing on toggle. Existing pane identity is retained. This supports reversible focus as an implementation pattern, not copying this code or asserting medical benefit.

The corpus did not contain VS Code; its official docs supplied that evidence. No repositories were indexed or dependencies installed. Source references are indexed in `.gg/sources.md`.

## Interpretation

Better typography reduces reading difficulty within a pane but cannot move an off-axis pane into the user's forward field of view. Making side text larger may help resolve letters, yet also adds wrapping and scrolling. Dimming other panes changes distraction, not viewing angle. Simulated screenshots cannot measure neck posture or long-session comfort.

GG already has pane rearrangement, keyboard focus, resizable splits, and copy-to-new-window behavior in `WorkspaceShell.tsx`. Focus alone does not reposition content. Copying a pane is not equivalent to a temporary reading view: it has separate session/lifecycle constraints, including active-work restrictions. Reuse the existing pane/session rather than proposing a duplicate agent session.

## Proposed directions

### Recommended: a temporary "Read here" view for side panes

An explicit action on a side pane opens its conversation at the user's preferred forward reading location, using the same left-aligned messages and comfortable line length. A clearly labelled Back control and Escape restore the prior workspace view. No automatic movement when a pane finishes, receives text, or gains focus.

- Keep the saved grid and permanently centered panes unchanged underneath; the view may temporarily cover them, which is a tradeoff requiring approval.
- Prefer an initially read-only view: no second composer, ambiguous send target, copied session, or repeated agent work.
- Preserve source pane identity, reading position and draft; maintain streaming updates from the same session.
- Use a bounded reading column, not full-screen lines. Let the user place the reading view: the app-window center is not necessarily the physical center of a multi-monitor desk.
- Keep personality and role identity, but avoid sliding/zooming text effects. Respect reduced motion.
- If the source pane closes or becomes unavailable, explain that state and offer Back; do not silently switch to a different conversation.

This is a proposed named journey: side reply → temporary forward reading → original side pane. It is not approved for implementation or validated with users.

### Smaller alternative: move side reading columns toward the middle

Within only the outer panes, place a bounded text column toward the inner edge; keep the text inside that column left-aligned for both roles. Center panes remain unchanged.

Benefit: all panes remain visible, no temporary view. Cost: consumes outer whitespace and only modestly reduces lateral viewing; narrow panes may have no spare width, and left/right outer-pane detection must follow actual geometry rather than pane IDs. This does not solve prolonged sideways neck posture.

### Not recommended as the primary fix

- Globally enlarge all text: center panes are already comfortable and more text wraps.
- Tilt or curve the UI with CSS: changes pixels, not the physical viewing direction, and can distort glyphs.
- Automatically swap side and center panes: violates spatial memory and disturbs the panes the user wants preserved.
- Merely fade other panes: distraction treatment rather than an off-axis reading solution.

## How to evaluate a future approved prototype

Compare the current side pane with the proposed view using the same realistic long reply, on both sides and with the user's normal sitting and standing setup. Record ease of keeping one's head forward, losing one's place, scrolling, access to other panes, and the cost of returning. Do not ask the user to push through discomfort or claim a quantified health benefit.

Behavior checks: explicit open; Back/Escape; same session and content; source/center scroll and draft preservation; no focus theft during streaming; source closure/reconnection; keyboard navigation; zoom and reduced motion. Use synthetic local fixtures first, then separately authorized native checks. Keep profile icons and broader workspace rearrangement out of scope.

## Left-message preview verification

- CSS change only in `src/dev/chat-design-preview/styles/yaatuber-light.css`: logical margins place the bubble's text on the existing assistant text rail; no font, colour, bubble shape, event, or production entry changes.
- `scripts/chat-design-preview/message-alignment.mjs`: five browser cases passed (1280×800, 390×844, six panes at 2560×1400, special message variants, and Original isolation); synthetic sessions, zero page errors.
- `pnpm --filter gg-app check` and `pnpm --filter gg-app build`: passed; Vite emitted config-loader, dynamic-import and chunk-size warnings.
- Canonical visual probe ran at 1280×800 and 390×844 and rendered the preview, but starts at the transcript bottom. The scoped regression captures scroll to the top and show the changed bubbles; both desktop and narrow captures were inspected against the earlier right-aligned screenshots.
- Density probe ran and exited 2 because the deliberately absent card configuration is unavailable, not passed. No new ARIA, keyboard, motion, typography, or control pattern was introduced. Full accessibility and native comfort remain unverified.
- After screenshots: `.gg/eyes/out/chat-workspace-preview/light-light-completed-one-1280x800-1789881701435.png` and `light-light-completed-one-390x844-1789881703918.png` in the same directory; original comparison capture ends `1789881711603.png`.
- Host executions: alignment `834528af-da68-42c4-8425-5410376f05d4`; check `bb85e236-2b60-4201-b652-b95e5cd75aff`; build `a9769a4a-73a0-46e6-8062-1f2fca0990be`; visual `07a1faa6-d6f3-4fbc-b28b-0cac7062b100` and `71ccbfc8-55d6-43bb-856e-5854d67bdba9`; unavailable density `b8438cd7-f008-4106-9b1b-322c2f4217fe`.
