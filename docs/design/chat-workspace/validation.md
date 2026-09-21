# Validation

## Native appearance follow-up, 2026-09-21

The later approved integration has [its own source/native verification ledger](native-appearance.md#verification-and-retained-failures). It includes actual normal-entry Tauri/Rust IPC, isolated real-daemon review, same-origin native window synchronization, controlled fixture checks, bounded debugging lifecycle regressions, and retained broad-suite timeouts. This does not turn the earlier browser-only results into native proof or erase their failed fidelity/accessibility gates. The full native acceptance matrix still has explicit gaps.

## Historical preview validation

**Current scope: browser-preview verification is complete with documented limits, not production or accessibility-conformance approval.** Final type check/build, 186 targeted tests, 33 layout/capture cases and 18 state/recovery cases passed. The Light pixel gate still fails; the user explicitly approved source-inspired, non-fidelity-verified comparison. Canonical accessibility/affordance reports remain nonzero and are triaged below.

Latest follow-ups: [Light surface/code refinement](surface-refinement.md) and [rank/scorecard/Autopilot refinement](rank-controls.md) record the subsequently authorized changes and their newer checks. Counts and screenshots below describe the original preview delivery; do not treat them as a fresh run of the whole matrix after every refinement.

## Vite reconnection — 2026-09-20 UTC follow-up

The preview bootstrap now exposes `SharedWorker` as undefined, choosing installed Vite 8.2.2's existing main-thread WebSocket ping without enabling blob workers, changing CSP, allowing fetch/EventSource, or changing normal/production entries.

- Before the fix, the owned-browser disconnect regression reproduced a `worker-src` violation for `blob`, no ping success and no reload within 15 seconds (execution `b7c8ffba-139e-4adc-9cfc-8ef4971b30e4`).
- `node gg-app/scripts/chat-design-preview/reconnection-browser.mjs` passed after the fix (execution `4af78fb0-4934-4386-a509-5bf5c41fd9ac`). It reuses the identity-checked server on port 1420, closes only its fresh browser page's HMR socket, observes the real `vite-ping` socket open, and verifies a new document reaches populated readiness. The literal CSP is unchanged. Fetch/EventSource remain blocked; forbidden loopback-port and external WebSocket destinations produce `connect-src` violations. A separate ordinary document retains native capabilities and no preview bootstrap; its app scripts are blocked to avoid native boundaries, so this is not an ordinary-app runtime smoke.
- An interrupted first post-fix run has unknown outcome. A bounded rerun located a test-harness error: Playwright's `routeWebSocket` replaces the native constructor, intercepting forbidden sockets before CSP and leaving the test waiting for an error that never arrives (execution `263ce14a-814a-4b50-adda-f48321f0551a`). The regression now uses a CDP network-level safety guard, requires actual CSP violations, and bounds socket-result waits. No security assertion was weakened.
- Preview Vitest suite: **53 tests in six files passed** (`3f6829f1-4be2-46ba-b082-b92a2de774e9`), including capability masking and unchanged CSP/network restrictions. Existing Vite config-loader warnings remain. `pnpm --filter gg-app check` passed (`95b23299-5123-4a98-84f9-bc57e93087e1`).

The server was not restarted or replaced. No dependencies, production build, native app checks, installers, commits or releases were involved. Historical checks below remain scoped to their original executions.

## Progress fixture parity — 2026-09-19 local follow-up

[Rank-controls current verification](rank-controls.md#canonical-progression-correction--2026-09-19-local-follow-up) records the backend-derived chat snapshot correction: 18,240 XP is now Netrunner level 25 / Vibe / gradient, 993/1,117 XP and 88%, with the full 145-entry ladder. Normal, both sides of a tier boundary, real gold-effect and maximum-level scenarios are canonical producer outputs; effect-only substitutions are explicitly style probes, not contract-valid snapshots. Older screenshots containing Shipwright/Gold and historical pass counts remain untouched and do not verify progression parity. Accepted Light/Light-code styling and the source-inspired reference disposition are unchanged.

## Capture evidence contract — 2026-09-19 follow-up

New generic PNG/JSON pairs use `schemaVersion: 2`. The returned object and saved JSON have `phase: "capture"`: their top-level viewport (CSS dimensions, DPR and app zoom), pane/prose/transcript/header/composer geometry, draft, active-element focus, split ratios, scroll offsets and current preview settings are measured **after** interactions and the caller's verification callback, immediately before screenshot capture. Fonts and two animation frames settle first; zoom and tested actions are not reset.

`initial` has `phase: "initial"` and preserves the readiness-time measurements before hiding comparison controls or running actions. Use `initial.panes` for pre-interaction dimensions such as the historical six-pane comparison below; use top-level `panes` for the image. `settings` comes from the live preview controller's applied selection, not the initial URL (Original still ignores reading adjustments). Pane `focused` means workspace selection; `focus` separately describes the actual active element. Geometry includes scroll offsets. Filenames and scenario labels retain requested launch dimensions/settings; final top-level measurements are authoritative if an action changes them.

`interactions` and `additional` retain their existing scenario-result meanings and may describe intermediate states. Matrix records retain the full returned evidence; state, triage, rank and surface summaries still extract `additional`, not generic capture measurements. Their separately captured images are not implicitly covered by the generic pair's contract.

Final capture rechecks structural readiness, expected pane count, rendered fixture content, positive viewport/DPR/zoom and pane dimensions, fixture errors, invalid Roadmap response text and uncaught page errors. A missing/invalid final workspace or new fixture error rejects the capture instead of saving initial success metadata. The PNG is held in memory until post-screenshot error checks pass.

Older unversioned JSON remains historical, unmodified **initial-phase** evidence; its generic measurements must not be assumed to match a post-action PNG. In particular, earlier 200% screenshots can accompany a top-level zoom of 1. Scenario-specific assertions remain scoped to their recorded checks.

### Verification of the phase correction

- Reproduced the defect with an owned-browser regression: returned zoom `1` versus live screenshot-time zoom `2` (execution `035ffaa3-16d8-4610-acce-21c62caf7b6a`). The original failed evidence is retained.
- `node gg-app/scripts/chat-design-preview/capture-browser.mjs`: seven cases passed, including 200% zoom, six-pane split/viewport/focus/draft/settings changes with interactions preserved, and rejection of missing panes, missing composers, new fixture errors, invalid Roadmap text and uncaught page errors. It compares live screenshot-time fields against returned and serialized data and checks that rejected cases publish no files. Evidence: `capture-regression-1789850625263.json`; execution `09006427-6929-4e27-9166-81a128c84e88`. An intermediate regression run timed out attempting to select a deliberately hidden comparison control; the test now explicitly targets its existing change handler with forced selection.
- Preview Vitest suite: **44 tests passed in five files**, execution `adfb4267-3a03-4c15-9f95-edaec0db7905`; existing Vite config-loader warnings remain.
- Affected owned-browser captures reran successfully: **33 matrix, 18 states, 3 triage, 5 rank and 11 surface/baseline/activity captures**. Evidence: `matrix-1789850731650.json`, `states-1789850777498.json`, `triage-1789850787249.json`, `rank-controls-1789850790890/results.json`, and `surfaces-1789850847269.json` (eight comparison records plus three separate baseline/activity captures). Execution `afbe9e6b-9e54-428c-b265-980673a417c7`.
- Pane lifecycle capture and all seven existing owned-browser readiness scenarios also passed, execution `94447da3-4c1e-4f28-8b6a-56381750482c`.
- Representative 200% rank and resized six-pane draft screenshots were visually inspected, not the entire matrix. Artifacts stay under ignored `.gg/eyes/out/chat-workspace-preview/`. No native settings, installs, production UI/CSS, historical evidence, or release artifacts were changed; this is browser-fixture evidence only.

## Executed baseline checks, 2026-09-18

- Checkout HEAD: `03784732521ae3f1bf7c7ce4526549b481c88a15`; working tree contains pre-existing Programmatic and instruction changes. HEAD does not identify the full tested source.
- ImageMagick: `magick -version` succeeded, version `7.1.2-25 Q16-HDRI x64`, build `04a04ea:20260604`. No fallback to Windows `convert.exe`.
- Node `v22.20.0`, pnpm `10.34.5`.
- Canonical uimaxxxing root: `C:/ggcoder-projects/uimaxxxing`, revision `78a33a5845c79f09159a2443f021d0ca998b7556`.
- Installed Playwright package: `1.60.0`. A fresh owned headless Chromium launched, reported `148.0.7778.96`, and was closed. No inherited browser endpoint variables were reported by the inspected environment filter.
- Canonical probe files are present and the ImageMagick resolver was inspected. Probe execution against the preview has not occurred; file presence is not a probe pass.
- Port 1420 serves Supah Coder's Vite HTML. Windows process inspection identifies PID 4500 as this checkout's Vite CLI with `--host 127.0.0.1`. The process predates this session; no restart was attempted. HTTP success does not establish populated-fixture readiness.
- `docs/design/chat-workspace/` is not ignored; `.gg/eyes/out/chat-workspace-preview/` and `.gg/reference-ui/yaatuber-chat-light/` are ignored.
- Current source still declares assistant prose at 15px, paragraph margins at 0.4em, inline code at 0.88em, and streamed word reveal at 220ms with reduced-motion override. These are source observations, not new computed-layout measurements.

Host execution IDs: tool/version/ignore inspection `e900e645-7a46-44f2-9d46-855a65235b94`; initial endpoint/package inspection `07dc1133-3182-4765-b051-2201202e218f`; process identity/browser launch/CSS diff `6546b1e2-3075-44e7-b34b-92fd3af1a56e`; HEAD inspection `d14c2f8c-bbd2-441e-a119-dd0a52cf1a69`.

## Required verification after implementation

Use installed canonical wrappers with `UIMAXXXING_EYES_NO_INSTALL=1`. Never install to repair a missing check. Require a populated visible transcript, expected pane count and no fixture errors before capture; inspect each image rather than accepting exit zero.

- Layouts: 1/2/3/5/6 panes; usable 3×2 and 2×3; uneven splits; expanded pane; intermediate drag widths. Respect current minima.
- CSS viewports: 1280×800, 390×844, 2560×1400, 2048×1120. Record DPR and app zoom separately. The narrow case is a window guard, not a mobile-product requirement.
- Capture identical-geometry baseline/candidate pairs, text/header crops, palette/hierarchy outputs, strict-size drift and failures.
- Record prose width; computed font, line height, tracking and paragraph margins; transcript usable height; composer/header footprint; overflow and wrap thresholds; focused pane identity.
- Density-card metrics measure the explicitly selected regions, not transcript usable height. Keep both measures separate.
- Preserve draft, focus and reading anchor during resize. Emit simulated streaming events and confirm a reader scrolled upward is not forced to the bottom.
- Exercise keyboard resize/focus, pointer focus, accessible names, reduced motion and zoom/reflow. Automated accessibility probes do not establish complete conformance.
- Compare bounded six-pane rendering/resize/streaming with the same baseline. No performance certification from a screenshot or one timing sample.

Run these as separate foreground checks after CSS changes:

```bash
pnpm --filter gg-app check
pnpm --filter gg-app build
```

Also run the new preview tests and affected Markdown/workspace tests. Inspect emitted production assets for route/fixture/controller exclusion. Invoke canonical visual, typography, density, accessibility/state/affordance, palette/crop/squint/drift and reference capture/gate wrappers as applicable using their current help/source. Record actual scope where a probe cannot accept the full viewport matrix. Actual executions and limitations are recorded below.

## Comfort comparison (manual acceptance)

Use the same long reply, usual room lighting, display scaling and app zoom. Compare briefly first; continue longer only if comfortable. Change one reading setting at a time, then compare palette using identical reading settings. Include the usual six-pane layout and an expanded pane. Note readability, scrolling effort and fatigue without treating any result as medical evidence. No candidate is selected or promoted automatically.

## Earlier execution checkpoint (18 September local time)

This checkpoint was incomplete when recorded. It is preserved to explain failures and corrective work; the current results are in the final section below.

- `pnpm --filter gg-app check`: passed after final CSS changes, execution `b95e4391-025e-46c7-9b86-bd1a4ca9f560`.
- `pnpm --filter gg-app build`: passed after final CSS changes, execution `c39d46b3-b02b-4524-8ad0-09ec71584639`. Existing chunk-size, dynamic-import and future-native-config warnings remain.
- Preview, Markdown, workspace-layout and the separately authorized two-line test fix: 177 tests passed across seven files (`3d803a2f-f1ef-4ac8-b04e-1a4ec5871d23`). The eight workspace evidence-supervisor tests passed under Vitest (`8bd89586-9662-45d8-a4a7-5d3a0701788d`). An earlier mistaken `node --test` invocation failed because that file uses Vitest; it was not a product failure.
- Latest production inspection scanned 11 emitted JS/CSS/HTML/JSON files for route, bootstrap, content and CSS markers; none were present. Ordinary `/` HTML contains no fixture bootstrap (`36911b74-8d10-450c-a237-55f11b2015f5`).
- Latest matrix: **33/33 scheduled capture/readiness cases passed**, stored in `.gg/eyes/out/chat-workspace-preview/matrix-1789776845931.json`, execution `9937eb59-1482-4332-8155-7ae52ce045bf`. This covers seven layouts at 2560×1400, six panes at 2048×1120 and 1280×800, and one pane at 1280×800 and 390×844, for all three variants. It does not mean every planned interaction or message state was tested. A subsequent Light-only draft/done-status contrast correction was rerun through the six-pane interaction path (`4290f954-066a-4e00-9bda-eb3b24737df4`) and visually inspected. Canonical Light captures at 1280×800 and 390×844 plus explicit-region density were rerun afterward (`679334c3-a7db-437a-be70-8082d147578d`, `a5626dee-78bd-4882-92c3-43785034bb0b`). That final density follow-up used the default 15px reading settings, not the 16px capture profile.
- The six-pane cases at 2560×1400 also exercise viewport resize, keyboard split resize, intermediate pointer drag, draft retention, focused composer retention through viewport resize, app zoom 100→105→100%, reduced motion, normal/crisp streaming and reading-anchor retention. All three variants retained scrollTop 100→100 while streaming. Pointer-focus styling and the full 200% reflow range remain unverified.
- A stricter streaming regression test exposed the preview's stale `.word-enter` selector. Current app source emits `.md-word`; the test failed on Reading's real `md-word-in` animation before the CSS fix. The final browser assertions observe `md-word-in` for Original and `none` for Reading/Light. Reduced motion omits word wrappers through the existing `useSmoothText` path. Earlier weaker checks and failed matrix `matrix-1789776189058.json` remain historical, not current failures.

### Measured six-pane dimensions

At CSS viewport 2560×1400, DPR 1, app zoom 1, sampled primary-pane prose width was 796.98px; transcript height 415.86px; composer height 51.5px for all three variants before interactions. Original: 15px / 23.25px line height / −0.154px tracking. Reading and Light profile: 16px / 24.8px / normal tracking; roomy paragraph margin 11.2px. This confirms the candidate did not shrink prose to fit more panes. Source: timestamped six-pane JSON measurements.

Single-run browser-automation timings include scheduling, IPC and assertions, not just UI work. One observed original/reading/light resize round trip was 133/142/228ms; the corresponding synthetic streaming sequence was 1036/997/1084ms. These samples are not a performance certification, a reliable comparative benchmark or evidence of a leak-free application.

### Canonical probes actually invoked

`probes.mjs` invokes installed visual, text, density, accessibility, affordance, palette, region extraction, squint, drift and source-state wrappers. Raw output is under ignored `.gg/eyes/out/chat-workspace-preview/probes/`. All six canonical screenshots were inspected, including a current contact sheet; originals are retained separately from derivatives.

- Visual captures at 1280×800 and 390×844, explicit transcript/composer density selectors, palette, explicit-coordinate crop, squint and strict-size baseline/candidate drift ran successfully.
- Text probing is timing-limited: the wrapper waits a fixed 250ms after navigation and cannot wait for this fixture's Markdown readiness. One Original run measured 15px prose but missed paragraph nodes while the lazy renderer loaded, returning nonzero. The bounded runner waits for actual paragraphs and records their metrics. Do not call the canonical text run fully passed or hide the timing limitation.
- `states.mjs` is a source scan, not runtime proof of empty/error/retry states.
- Accessibility/affordance probes returned nonzero in all three variants. Original/Reading each reported one unlabeled icon-only button and 12 contrast candidates; Light initially introduced poor user-bubble/status-icon contrast, which was corrected and rerun. Latest Light reports one unlabeled button and eight contrast candidates (header/footer separator glyphs and gradient rank text). These need manual triage; a gradient-text ratio of 1 and decorative separators are not automatically confirmed WCAG failures. Existing small targets and the textarea focus-ring heuristic remain flagged. The probe's 32px desktop target floor is not itself WCAG's 24px minimum-with-exceptions rule. No findings were suppressed and no app components were edited to silence them.
- The preview runner verifies populated transcripts and no uncaught fixture errors. Canonical probes use fresh pages and have differing readiness behavior; their scope must not be represented as the whole matrix.

### Reference gate: unresolved

Current local archive/member provenance and static reference capture exist. The first gate run rejected missing canonical provenance/license fields; those fields now accurately describe user-authorized local inspection and unestablished redistribution rights. The second run passed source/decision validation but failed pixel comparison and warned about palette, geometry and surface materials. The reference is an empty 1160×680 background crop; the implementation crop contains the populated 1280×768 workspace. The comparison therefore confounds selected background traits with unchanged GG content/controls and intentional geometry differences.

The gate output remains in `.gg/reference-ui/yaatuber-chat-light/gate.json`, with `status: fail`. No accepted visual delta or warning was fabricated. This must be resolved as a scoped comparison or an explicit degraded-evidence decision before claiming fidelity. Do not redesign GG into an empty onboarding card just to satisfy the pixels.

### Open items at the earlier checkpoint (superseded below)

- Empty, tool-activity, error/retry, command/queued/promoted and other special message fixture coverage is incomplete.
- Expanded-pane interaction, pointer-focus ring behavior, 200% reflow and a systematic overflow/wrap threshold verdict remain open. Existing one-pane captures show expanded geometry, not proof of an expand action.
- Only representative images and the six canonical captures have been visually inspected; the entire matrix is not a manual accessibility or comfort assessment.
- Step 7's final decision handoff and local style-pack/design-memory pointers are not completed while step 6 remains open.
- Browser fixtures do not verify native IPC, real sessions, daemon streaming, WebView2/native chrome, screen-reader conformance or installers. Comfort selection remains with the user.

### Preserved execution problems

No dependencies were installed. Canonical capture initially hit Windows ESM path resolution and succeeded using the supported `EYES_PLAYWRIGHT_PATH=file:///.../index.mjs` override. The first capture-runner output path resolved one directory too high; two synthetic artifacts remain at `E:/Projects/.gg/eyes/out/chat-workspace-preview/`. The runner now writes to this checkout's ignored evidence directory. A locked earlier PNG prevented overwrite, so capture filenames are now timestamped; no user data was deleted to bypass the lock.

## Final bounded verification (2026-09-19 UTC; 18 September local)

### Current results and provenance

| Check | Result / artifact | Host execution |
| --- | --- | --- |
| Type check | Passed after final candidate CSS | `316d87d3-81e1-48fb-a4bd-b60c1ef3b77f` |
| Production build | Passed; existing warnings retained | `03d66b0b-5f93-4661-b09b-88901b1b560c` |
| Targeted tests | 186 passed in eight files, including 15 preview tests | `0e8ab713-33f8-4b8a-85b8-e35083224470` |
| Layout/viewport matrix | 33/33; `matrix-1789784665545.json` | `6a3a22b9-9355-42cf-a4bf-2afcd09aea99` |
| Empty/activity/error/retry/special/completed states | 18/18; `states-1789784710790.json` | Same execution as matrix |
| Additional narrow reflow and accessibility triage | `triage-1789785074088.json` | `e6d57d3b-0d0e-414a-adce-0818806ee4dd` |
| Paragraph anchor during resize; all previous six-pane interactions | Passed for all three variants after final styling | `8dfe6818-023f-4e44-9541-fb2ee74ab5e5` |
| Canonical probes | `probes-1789785197399/summary.json`; nonzero overall, detailed below | `74428fa4-2bdd-456f-8db6-06e7311c5f59` |
| Production exclusion and syntax checks | 11 emitted text assets free of preview markers; ordinary entry unchanged; all new mjs syntax checks passed | `3665639b-a5bf-4e8c-a360-03de6bbce77c` |

Artifact paths above are relative to ignored `.gg/eyes/out/chat-workspace-preview/`. Check/build are separate foreground commands, not an installer rebuild. No new dependency, commit, release note, native change or Roadmap mutation was made.

### Additional state and interaction evidence

- `state=empty|activity|error|retry|variants|completed` uses the actual rendering path. Empty has no assistant content; activity uses native fixture events; error is a structured synthetic provider failure. Retry clicks the real Roadmap retry button after releasing a mocked read failure, then verifies the banner disappears. No Project Notes or real Roadmap is changed.
- Special messages include a command, Ken question, Ken-forwarded label, compaction notice, queued submission and promotion. The queue test initially omitted the pending-list event; the promotion assertion correctly failed. Reproducing the actual event sequence made all three variants pass without changing app logic.
- State screenshots exposed Light-only error-label, forwarded-label and active-tool contrast defects. Corrected in preview CSS; terminal-style empty state and active tools retain dark surfaces. No app DOM/component seam was changed. Three existing 3.37:1 muted-text findings in Reading now reuse the existing brighter muted token; the palette remains the same.
- Six-pane resizing keeps the typed draft, focused composer and sampled first-paragraph offset (within 2px). Streaming keeps scrollTop 100→100. Keyboard split ratio changes and pointer drag are exercised through the existing separators.
- At 200% app zoom, one-pane 1280×800 and 390×844 scenarios retain document width without horizontal overflow. At the narrow size, the composer is initially below the viewport; real Tab/Shift+Tab navigation brings it into view. The candidate assertion checks its resulting top/bottom bounds. This is limited keyboard reachability evidence, not proof every control is always visible or all reflow criteria pass.
- Clicking transcript prose preserves the app's existing composer-focus behavior in all variants. The textarea remains `:focus-visible` with a visible caret and no outline. No new pointer-only ring is introduced; this does not establish native assistive-technology behavior.

### Canonical checks and accessibility triage

Latest visual, computed text, explicit-region density, palette, crop, squint, strict-size drift and source-state probes ran. The trigger-table follow-up also invoked canonical design-system inventory, liveness and explicit transcript/composer density at 1600×900 and 1920×1080 for all variants (default 15px settings), stored in `supplemental-probes-1789785746727.json`, execution `82783bbb-1319-470c-910c-2a286241bb25`. Inventory/density returned zero. Liveness returned nonzero in all variants because the unchanged app stops all six ambient animations under reduced motion; the wrapper treats full stopping as an anti-pattern. This is retained rather than changing accessibility behavior to satisfy its aesthetic heuristic. Measured click-to-paint samples were 13.3/3.7/30.5ms (Original/Reading/Light), all below its 100ms budget; these single samples are not comparative performance certification. All six latest canonical captures were visually inspected in the contact sheet. Earlier lazy-Markdown timing failures remain in the historical section; latest text probes passed, but their fixed readiness delay is still a tool limitation. The canonical `states` tool is a source scan; the new preview `states.mjs` is the separate runtime exercise.

Accessibility/affordance wrappers still return nonzero; no threshold, assertion or scanner finding was suppressed:

- Browser accessible-role queries found **zero visible unnamed buttons** across all 18 runtime state cases. The wrapper's `button.btn` gap does not reproduce as a missing browser accessible name.
- `Rearrange` is disabled in the one-pane fixture. Its low contrast is an inactive-control finding, not a confirmed text-contrast violation.
- Separator glyphs convey no essential state. Their low contrast is not a meaningful-text contrast failure; they still lack `aria-hidden` in the existing app, which is a later semantics-review consideration.
- Rank text uses `background-clip: text` and a gold gradient. The wrapper measures the transparent foreground and reports 1:1, rather than the painted gradient. The raw finding is retained; no full gradient-animation contrast certification is claimed.
- Three meaningful baseline muted-text readings were 3.37:1. These remain in Original as comparison evidence; Reading now uses the existing brighter token for those selectors. Latest remaining Reading contrast candidates are disabled/decorative/gradient cases. Light likewise has only separator/gradient cases in this probe's scope.
- Small-target and textarea-outline heuristics remain review items. The tool's 32px target floor is stricter than WCAG's 24px-with-exceptions rule, and absence of an outline is not by itself absence of a focus indication. Native screen-reader output and a complete per-criterion audit remain unverified. No accessibility waiver was granted.

### Reference disposition

The user expressly authorized continuing Light with degraded reference evidence: **source-inspired, not fidelity-verified**. The preview controls and canonical local decision now say so. The original failing `gate.json` is preserved unchanged, with no fabricated pass or accepted pixel delta. That authorization does not approve production integration, asset redistribution or an accessibility exception.

### Rendered critique and limits

The same app primitives, humor, ranks, controls and content ordering are retained. Optional ring/diamond markers remain small; no onboarding aperture rings or extra decorative badge system were added. One revision pass corrected concrete contrast/readability defects exposed by real state captures.

Prototype rubric (not a release gate): Reading 21/24, Light 20/24. Brief specificity, hierarchy, composition, consistency, typography, motion, authenticity and distinctiveness: 2 each. State completeness, responsive coverage and accessibility audit: 1 each; material logic: Reading 2, Light 1 (mixed light transcript/dark work surfaces remains a taste decision). The independent production contract is not certified by those scores.

Remaining limits: no explicit maximize-pane control was found in inspected workspace shell/node code; the one-pane fixture tests spacious geometry, not a new expansion action. Exhaustive wrap thresholds, every possible special-message permutation, RTL/forced-colors/screen-reader testing, long-duration comfort, native sessions/IPC/daemon behavior and installer verification are not covered. Only representative renders, not every matrix image, received close visual inspection. These are not claims of passed checks, and no production promotion is authorized.
