# Pearl rank badge, light scorecard and Autopilot

The user confirmed a preference for **Light code**, then approved the proposed badge/popup/switch refinements. The user subsequently responded positively to the delivered result ("lovely"). These remain isolated to the browser preview; no installed settings, real ranks or project-wide Autopilot state were changed.

## Delivered

- Pearl rank badge with the existing diamond, level number and rank identity. Deeper rank inks replace bright-on-dark colours; existing colour families and motion remain distinguishable. No extra XP meter was added to the header.
- Light scorecard with the existing milestone meanings and backend-derived synthetic progression data: rank/tier, large level, XP meter, four aligned stat rows and membership date. Softer backdrop, readable labels, 32px close control and scrolling/reflow at narrow/zoomed sizes.
- Contained Autopilot thumb: pale off track with a dark thumb; periwinkle on track with a light thumb. Short state transition, no new looping switch animation, visible keyboard focus and disabled/reduced-motion states.
- Pointer and keyboard input are distinguished only for these preview controls. Pointer-close no longer leaves a stale keyboard ring on the badge; keyboard focus and focus return remain visible.

Local component/source inspection settled the implementation questions. No corpus lookup, external code copying or new dependency was necessary.

## Module boundary

`rank-scorecard.css` owns badge/card geometry and surfaces; `rank-colors.css` adapts the 21 existing effect families; `autopilot.css` owns the switch. The scorecard is an existing body portal: selectors match that card/backdrop only when the direct application root explicitly selects the Light preview. Other modal classes and ordinary app entry are not rethemed.

The controller owns two abortable input-modality listeners, updates its marker only when modality changes, and removes listeners/attributes on cleanup. It neither blurs elements nor rewrites React-owned content. Autopilot clicks use the real labelled checkbox and existing handler, with a boolean-only, page-local synthetic IPC response. Invalid fixture values reject without changing state or falling through. Native settings persistence is not tested or invoked.

`measurements.mjs` now shares the existing opaque-colour contrast calculation between browser checks and rejects transparent/unsupported samples rather than producing misleading ratios.

## Canonical progression correction — 2026-09-19 local follow-up

The chat preview now overrides the shared screenshot helper's illustrative rank sample. `progress-fixtures.mjs` imports the authoritative pure backend `buildSnapshot`, rank and XP functions directly; an explicit deterministic in-memory seed supplies XP, source totals, seven synthetic project IDs, dates and counters. No progress store or award engine is imported, and no real progress file is read or written. Direct Node runners use the installed Node 22.20 TypeScript stripping support; Vite/Vitest transform the same source import. The shared screenshot helper and real ladder are unchanged.

The current normal example retains **18,240 XP** and now correctly renders **level 25 / Netrunner / Vibe / gradient**, **993 / 1,117 XP**, **88%**, and all **145 ladder entries**, including the producer's maximum-level metadata. The earlier level 14 / Shipwright / Gold / 62% sample was illustrative and backend-invalid; real level 14 is Compiler / Flow / blue. Older screenshots and passing style checks below are retained historical evidence, not canonical progression verification.

Contract-valid scenarios cover the normal example, one XP before and exactly at the level-26 tier transition (Netrunner/Vibe → Cipher/Deep), a real level-36 Shellmaster/Root gold-effect example at `xpForLevel(36) + 740`, and maximum level 1000 / Origin. Every payload comes from the same producer. The browser checks verify badge identity/effect/tooltip, scorecard rank/tier/level, XP span, lifetime XP, percent and terminal wording against those snapshots. Transition feedback finishes before normal screenshots are captured.

The separate **21-effect style-isolation loop deliberately substitutes only `effectId`**. Those combinations are not progression scenarios and are labelled `contractValid: false` in the evidence. It tests painted contrast and motion, then restores and verifies the canonical normal snapshot; it no longer assumes gold on reset. This correction changes data and verification only: accepted Light/Light-code styling and the source-inspired, non-fidelity-verified reference disposition remain unchanged.

### Current verification

- Preview suite plus `ScorecardModal.test.tsx`: **58 tests passed**, including seven new fixture tests (execution `67d6220d-7f5b-45c0-bbeb-5f2e80bc42a3`). Assertions compare serialized metadata with `buildSnapshot(seed)`, pin the current normal values, check source-XP totals, and verify the full ladder's shape, order and rank/XP mappings. Existing Vite config-loader warnings remain.
- Backend rank suite: **16 tests passed** (`3f7e100e-f7e7-4e3b-9a02-d93414210cf0`). App TypeScript check passed (`5800ff75-7dbb-4a83-b13f-09b9aa770884`).
- Rank browser checks: **five viewport/layout cases passed**, each checking all five canonical snapshots, plus the separate 21-effect desktop isolation loop. Final evidence: `rank-controls-1789870216119/results.json`, execution `638bf769-4ab0-4e3f-89ba-8a125b61690f`. The earlier successful run `rank-controls-1789869815209/` remains retained; its normal captures still contained transient tier-transition feedback, which the final runner now waits out.
- Existing progress-transition browser checks passed at 1280×800 and 390×844 (`15a678c1-a204-4bb8-a06f-6dad5ef6427e`), including tier/rank feedback and reduced-motion behavior. These remain synthetic native-boundary checks.
- Current normal captures: [desktop](../../../.gg/eyes/out/chat-workspace-preview/rank-controls-1789870216119/light-one-1280-zoom1.png), [narrow](../../../.gg/eyes/out/chat-workspace-preview/rank-controls-1789870216119/light-one-390-zoom1.png), [narrow 200%](../../../.gg/eyes/out/chat-workspace-preview/rank-controls-1789870216119/light-one-390-zoom2.png). Desktop and narrow final captures were visually inspected: the corrected normal metadata fits the accepted scorecard with no transition feedback remaining. No CSS, native packaging, installs, real XP, theme promotion or historical evidence was changed.

## Historical styling evidence

All artifact paths below are relative to ignored `.gg/eyes/out/chat-workspace-preview/`.

- **30 tests passed**, including existing Modal/Scorecard/Autopilot checks and new fixture/modality checks (`c8d9d394-ee9d-4478-b289-cf538f63f5a5`).
- **Type check and build passed** separately: `4430c73f-db6a-4541-a402-f9f301bd7e9c`, `2de8e608-8fc9-4e21-9bbc-dc05788aaa01`. Existing build warnings are retained.
- Production exclusion scan found no preview rank/modality/fixture markers in 11 emitted text assets (`445ab220-21fd-4e6a-af76-a7deb7041d57`). The existing app components were not edited; the pre-existing App.css changes were preserved.
- `rank-controls-1789795031672/results.json`: five real-UI browser cases cover 1280×800, 390×844, narrow 200% app zoom, six panes at 2560×1400, and unchanged Original styling (`6813fd3a-2a9b-4640-a257-b2b59b996b94`).
- Checks include keyboard and pointer toggles, project-fixture pane synchronisation, no run started by merely enabling it, pointer ring cleanup, disabled clicks, reduced motion, modal Tab/Escape/pointer-close focus, viewport bounds, no horizontal card overflow, and scrolling to the footer at 200%.
- All 21 existing effect families were rendered through synthetic progress events. Painted RGB samples/stops and declared inks passed 4.5:1 against the darker pearl base; minimum declared-ink comparison was **4.93:1**. Five animated families retained animation and stopped under reduced motion. This is not certification of every celebration/filter/anti-aliased pixel.
- The previous eight code/layout comparisons, two baseline-isolation checks and live-tool contrast checks also passed after sharing the measurement helper (`surfaces-1789793674978.json`, execution `c8d9d394-ee9d-4478-b289-cf538f63f5a5`).

### Follow-up after editor diagnostics timeout

The editor reported a diagnostics timeout for `rank-controls.mjs`, not a completed error check. Direct verification was rerun without changing code: `node --check` and all five browser cases/21 rank-effect checks passed (`f7d9bb94-c887-45ed-9d89-2f3c47588965`; `rank-controls-1789795557207/results.json`). The project TypeScript check also passed (`69a2ea85-bf71-4508-8c16-79af7884b386`). The earlier build result remains applicable because no code changed. The timeout itself is not recorded as a successful editor diagnostic run.

### Historical screenshots (illustrative rank data)

- [Desktop scorecard](../../../.gg/eyes/out/chat-workspace-preview/rank-controls-1789795031672/light-one-1280-zoom1.png)
- [Narrow scorecard](../../../.gg/eyes/out/chat-workspace-preview/rank-controls-1789795031672/light-one-390-zoom1.png)
- [Narrow at 200%, scrollable](../../../.gg/eyes/out/chat-workspace-preview/rank-controls-1789795031672/light-one-390-zoom2.png)
- [Scorecard over six panes](../../../.gg/eyes/out/chat-workspace-preview/rank-controls-1789795031672/light-six-2560-zoom1.png)
- [Autopilot off](../../../.gg/eyes/out/chat-workspace-preview/rank-controls-1789795031672/one-1280-1-off.png) / [on](../../../.gg/eyes/out/chat-workspace-preview/rank-controls-1789795031672/one-1280-1-on.png)

## Failures retained and scope limits

The first disabled-control test waited for Playwright to consider the control enabled; it now sends a real mouse click at its bounds and verifies no state change. A genuine 200% header overflow was reproduced and fixed with wrapping/min-width constraints. A real sticky focus-ring failure after pointer-close led to scoped modality handling; assertions still require solid keyboard outlines and no pointer-only outline. No assertion or native safety control was removed to obtain a pass.

Canonical probes were rerun (`probes-1789793837129/`, `rank-controls-1789793607357/canonical.json`). Visual/density/palette/crop/inventory outputs are retained. Text timing and accessibility/affordance findings remain nonzero as described in validation.md; the rank gradient's transparent foreground still produces the scanner's 1:1 false lead, so actual painted stops are measured separately. Liveness measured the rank click at 16.5ms in one sample but fails its preference for slowing rather than stopping ambient animation under reduced motion. We did not weaken reduced-motion behavior to satisfy that heuristic. The six canonical workspace captures were visually inspected in their contact sheet. The Light 1280×800 capture caught lazy Markdown fallback text and is not accepted as a ready transcript capture; the other five rendered Markdown. Canonical fresh-page probes do not open the scorecard automatically; the owned browser harness waits for readiness and provides the modal evidence.

The source-inspired reference disposition is unchanged. Native IPC, actual Autopilot review execution, native assistive technology and full accessibility conformance are not verified. No production promotion, release, installer or commit is authorized by this refinement.
