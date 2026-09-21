# Light surfaces and code comparison

Current follow-up: [native appearance](native-appearance.md) ports the accepted Light direction into normal semantic roles and saved settings. Light code is the production Light treatment; charcoal remains preview-only. The paragraphs below preserve the earlier browser experiment and its evidence, not the current integration status.

The user liked the Light direction, then authorized refining its remaining black bands and comparing code treatments. This is still browser-only. Source-inspired status, the retained failed reference gate, and the separate native-integration boundary are unchanged.

## Implemented

- Pane headers, footers and active-tool areas use a quiet grey-lavender surface. The composer is a slightly lighter inset with a restrained border/shadow.
- Text and semantic accents are adapted together, including usage thresholds and tool success/failure colours. Existing rank effects keep their dark badge, and the terminal-style empty state remains dark; these are not large permanent work-area bands.
- `code=light` is the proposed default: lightly tinted code with deeper plum, blue and teal syntax. `code=charcoal` offers softened charcoal with a coordinated brighter syntax palette. The **Code surface (Light only)** control changes this independently of reading settings.
- Font, copy handler, selection, whitespace and wrapping implementation are unchanged. A wider copy-button gutter prevents the Copy/Copied button obscuring code on narrow panes.
- Original and Reading do not receive these surface/code changes. No application component, installed theme, preference store or native boundary was changed.

Module ownership: `styles/yaatuber-light.css` owns surrounding surfaces; `styles/code-surfaces.css` owns code palettes. Both are preview-scoped. Inline dark-theme colours on existing controls require targeted scoped overrides; these are an exploration seam, not a proposal to build production theming from style-attribute selectors.

## Compare

- [Light code](http://127.0.0.1:1420/__chat-design-preview?variant=light&layout=six&size=16&tracking=normal&paragraphs=roomy&cap=on&markers=on&streaming=crisp&code=light)
- [Soft charcoal code](http://127.0.0.1:1420/__chat-design-preview?variant=light&layout=six&size=16&tracking=normal&paragraphs=roomy&cap=on&markers=on&streaming=crisp&code=charcoal)
- [Light code, six-pane screenshot](../../../.gg/eyes/out/chat-workspace-preview/light-light-completed-six-2560x1400-1789789497598.png)
- [Charcoal code, identical geometry](../../../.gg/eyes/out/chat-workspace-preview/light-charcoal-completed-six-2560x1400-1789789515638.png)

The user subsequently chose **Light code**. Charcoal remains available as a comparison, not the preferred treatment. The newer badge/popup/switch work is documented in rank-controls.md; screenshots here precede that refinement.

## Bounded verification

`node gg-app/scripts/chat-design-preview/surface-refinement.mjs` exercises both palettes at 1280×800 and 390×844 with one pane, and 2560×1400 and 2048×1120 with six panes. It checks actual rendered syntax, palette variables, surrounding text contrast, placeholder contrast, switch contrast/focus, code-copy text and button clearance. It also verifies Original/Reading code backgrounds are unchanged and checks live-tool text plus completed/failed semantic colours.

The real React copy handler is used with only `navigator.clipboard.writeText` mocked inside the fresh browser page; the user's OS clipboard is not overwritten. This does not verify native clipboard permissions.

- Final type check passed (`06fa1c3a-aa3f-45e0-b860-60c27263263a`) and final production build passed (`7183551f-3562-4aba-8236-267c4e2ac3c2`), as separate foreground commands. The 145 affected preview/Markdown/workspace tests passed (`748580e6-8701-4a7e-b758-40a3af9b2188`). Production exclusion rechecked 11 emitted text assets with no preview/controller/code-palette markers (`01095454-ee2c-4dc7-a358-6aa28f4cac9c`).
- Eight code/layout cases, two baseline-isolation cases and live-tool checks passed: `surfaces-1789789532334.json`, execution `0ef1eabe-b4b6-4ba5-8b99-3370ccf4eb4c`.
- Minimum measured syntax-palette contrast against its opaque code background: **5.38:1 Light**, **6.80:1 Charcoal**. All rendered syntax samples also passed the 4.5:1 assertion. These numbers do not certify the entire app.
- Both code settings passed the existing six-pane resize/draft/focus/reading-anchor/streaming exercise (`a090db83-da76-415e-842f-e49063db1a7d`).
- All 18 existing fixture state/recovery cases passed during this refinement (`37f8ff84-7f87-4c3c-8417-038a17fbda00`).
- Existing build warnings are retained. No packages were installed, and no native app was rebuilt.

Artifact paths above are relative to ignored `.gg/eyes/out/chat-workspace-preview/`.

## Findings and limits retained

Earlier renders exposed insufficient placeholder/rank/live-tool contrast and an overlapping copy button; the scoped changes corrected them. The switch focus test initially focused a control in an inactive pane while the workspace was moving focus to that pane's composer. The test now activates the pane, then uses actual Tab/Shift+Tab traversal before checking its outline; it does not claim to fix cross-pane focus routing.

Canonical visual/density/palette/design-system/accessibility tools were invoked. Accessibility and affordance outputs remain nonzero for existing heuristic findings; no scanner was suppressed. In the completed state, remaining contrast candidates were decorative header separators and transparent-foreground gradient rank text. Some canonical probes still capture before lazy Markdown/fixture activity is ready: the `surface-check-1789789595894/activity.png` screenshot is an **invalid activity capture**, despite exit zero. The `surface-final-1789789198450/1280x800.png` capture likewise caught the fallback renderer, while that batch's narrow capture and the six captures in `probes-1789788898782/` rendered populated Markdown (visually inspected in `surface-tool-captures.png`). Reduced sets of scanned nodes are not proof that tool activity passed. The owned harness waits for actual rendered content and separately asserts live-tool contrast and success/error colours. Prior failed/intermediate artifacts are retained.

No full accessibility, native IPC, all-rank/all-provider/all-tool-state or medical comfort claim is made. The user can compare these treatments before authorizing any production integration.
