# Decisions

## Native integration decision, 2026-09-21

The user separately approved the native appearance plan: keep Dark as default, offer opt-in Light and six independent saved reading controls, and use the visible native developer app for review. Source integration and bounded native verification are now implemented; see [native appearance](native-appearance.md) for defaults, evidence and acceptance gaps. During verification the user additionally approved closing/reopening only the owned developer app and applying its existing guarded debug setup to What's New. No additional window privileges were granted. A later request explicitly authorized diagnosing the verification hang before resuming; detached debug requests now fail promptly and secondary-window closure is exercised in the permanent smoke.

The prior decisions below remain historical. They do not supersede this later integration approval, grant release permission, or establish accessibility/reference-fidelity acceptance.

## Historical preview scope

The user approved implementation of the modular real-UI preview plan on 2026-09-18. Approval covers isolated browser fixtures, scoped experimental styles, tests, evidence and documentation. It does not approve a final design, production integration or installed-app changes.

User requirements:

- Start from the current UI and preserve personality, humor, names, ranks, effects, familiar controls and technical character.
- Support the actual one-to-six-pane workflow, especially six panes, uneven splits and per-pane dimensions.
- Explore small user/agent identity markers.
- Adapt relevant installed Yaatuber light-background styling, not an image-model imitation.
- Do not replace the framework or introduce a new UI/docking/icon dependency.

Assistant proposals to evaluate, not established requirements:

- Stable prose size across pane counts, independently selectable 15px/16px reading size, spacing and tracking.
- A reading-width cap only where a pane is sufficiently wide.
- Crisp streaming alongside the current word reveal, preserving other effects.
- Palette comparison separate from reading adjustments.

## Rejected

**Prismatic Graphite, the first generated concept, is explicitly rejected and must not be proposed again.** Neither remaining generated concept is an approved design specification. No further whole-app image generation is planned.

Do not remove personality, dim inactive-pane prose indiscriminately, flatten all motion, force six panes at every width, copy onboarding proportions or claim a typography/palette change cures eye strain.

## Historical preview gates

1. The user prefers the Light direction and explicitly chose Light code. Independent reading settings and extended comfort comparison remain open before integration planning.
2. Native session/IPC behavior, full accessibility-conformance testing and extended real-use comfort are unverified. Browser mocks and heuristic triage are not substitutes.
3. Any production integration requires separate approval. The preview does not provide a new maximize-pane action or authorize changing workspace components.

## Execution decisions

The user separately authorized restarting the identified existing Vite server and removing two unsupported `exact` options from button-role queries in `ProgrammaticDiscovery.test.tsx`. Assertions and exact string-name matching remain. No other unrelated work was changed.

The user explicitly authorized degraded reference evidence on resumption: keep Light available as **source-inspired, not fidelity-verified**, retain the failed pixel gate, and finish verification/handoff. This is not a passing fidelity result, permission to redistribute reference assets, an accessibility waiver or production authorization.

The initial Light comparison retained dark controls and code to separate surface evaluation from the rest of the UI. After seeing it, the user requested replacing those black bands and comparing code treatments. Headers/footer/tool areas and composer now use pale neutral surfaces; code has independently selectable Light (preferred default) and soft Charcoal palettes. Rank accents and the terminal-style empty state retain their character. See surface-refinement.md for current evidence. Reading/Crisp remains independently selectable; Original ignores every candidate setting. These are exploratory treatments, not production decisions.

At the preview handoff, implementation and bounded verification were completed without production adoption. The subsequent separately approved source integration is documented above; the preview's failed probes and limits remain in validation.md.

The user approved implementation of the pearl rank badge, light scorecard popup and contained Autopilot switch, then responded positively to the delivered result ("lovely"). Treat these refinements, alongside Light code, as the accepted preview direction rather than reopening the same taste decisions. This feedback does not authorize production integration or waive outstanding verification limits. These use the existing components, unchanged data/logic, and preview-scoped styles; see rank-controls.md. Popup styling is narrowly guarded by the Light preview marker even though the existing modal uses a body portal. Autopilot interaction is backed by synthetic page-local IPC, not real project settings.

Reading also reuses the existing brighter muted-text token for three measured low-contrast labels; no palette replacement is involved. The first-page 16px comparison profile is a proposal, not a preference silently saved for the user.

No dependency installs, commits, pushes, Roadmap/task mutations, release notes, installer work or native/daemon changes are authorized by this experiment.
