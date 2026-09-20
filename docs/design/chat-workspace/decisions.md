# Decisions

## Accepted scope

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

## Pending gates

1. The user prefers the Light direction and explicitly chose Light code. Independent reading settings and extended comfort comparison remain open before integration planning.
2. Native session/IPC behavior, full accessibility-conformance testing and extended real-use comfort are unverified. Browser mocks and heuristic triage are not substitutes.
3. Any production integration requires separate approval. The preview does not provide a new maximize-pane action or authorize changing workspace components.

## Execution decisions

The user separately authorized restarting the identified existing Vite server and removing two unsupported `exact` options from button-role queries in `ProgrammaticDiscovery.test.tsx`. Assertions and exact string-name matching remain. No other unrelated work was changed.

The user explicitly authorized degraded reference evidence on resumption: keep Light available as **source-inspired, not fidelity-verified**, retain the failed pixel gate, and finish verification/handoff. This is not a passing fidelity result, permission to redistribute reference assets, an accessibility waiver or production authorization.

The initial Light comparison retained dark controls and code to separate surface evaluation from the rest of the UI. After seeing it, the user requested replacing those black bands and comparing code treatments. Headers/footer/tool areas and composer now use pale neutral surfaces; code has independently selectable Light (preferred default) and soft Charcoal palettes. Rank accents and the terminal-style empty state retain their character. See surface-refinement.md for current evidence. Reading/Crisp remains independently selectable; Original ignores every candidate setting. These are exploratory treatments, not production decisions.

Current plan progress: preview implementation, bounded verification and modular handoff completed, with limits and retained failed probes documented in validation.md. Light and Light code are the preferred direction. No production design is adopted.

The user approved implementation of the pearl rank badge, light scorecard popup and contained Autopilot switch, then responded positively to the delivered result ("lovely"). Treat these refinements, alongside Light code, as the accepted preview direction rather than reopening the same taste decisions. This feedback does not authorize production integration or waive outstanding verification limits. These use the existing components, unchanged data/logic, and preview-scoped styles; see rank-controls.md. Popup styling is narrowly guarded by the Light preview marker even though the existing modal uses a body portal. Autopilot interaction is backed by synthetic page-local IPC, not real project settings.

Reading also reuses the existing brighter muted-text token for three measured low-contrast labels; no palette replacement is involved. The first-page 16px comparison profile is a proposal, not a preference silently saved for the user.

No dependency installs, commits, pushes, Roadmap/task mutations, release notes, installer work or native/daemon changes are authorized by this experiment.
