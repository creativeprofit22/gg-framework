# Native appearance and reading preferences

Status, 2026-09-21 UTC: **integrated app source with scoped Windows developer-native evidence**. Dark remains the default; Light is opt-in. This is not an installed-app update, release approval, reference-fidelity claim, or accessibility-conformance assessment. The older preview documents are historical experiments, not the current integration boundary.

## Controls and defaults

Settings → **Appearance and reading** applies changes immediately, independently of the project-folder Save/Cancel action. Cancelling Settings does not undo appearance changes.

| Control | Default | Alternative |
| --- | --- | --- |
| Theme | Dark | Light |
| Prose size | 15 px | 16 px; code and compact UI retain their size |
| Letter spacing | Current | Normal |
| Paragraph spacing | Current | Roomier |
| Wide-pane reading width | Full width | 74ch cap only when the individual pane is at least 900 CSS px wide |
| Identity markers | Current | Small decorative shapes; no invented identity data |
| Streamed words | Current reveal | Crisp reveal, without changing parsing or delivery |

Reset appearance defaults affects only these controls. It does not reset projects, sessions, zoom, providers or Autopilot. The preview's Original/Reading comparison modes and charcoal-code experiment are not saved production options. The coding wake screen intentionally retains its dark terminal treatment; it is distinct from Home.

## Ownership and integration

- `appearance.ts` owns allowlisted fields, defaults, bounded record parsing, storage, same-window subscriptions and storage-event synchronization. Unknown/malformed values fall back to defaults. Loading never repair-writes storage. Changed fields merge into the latest record; unsaved changes remain usable in the current window and surface a persistence warning.
- The dedicated key is `gg-app:appearance:v1`. Preferences belong to the current origin/profile, not a session or project. Browser preview, `localhost` versus `127.0.0.1`, isolated developer profiles and packaged origins need not share storage. There is **no automatic cross-origin migration**.
- `main.tsx` initializes the document root before either normal React entry or What's New renders. Preview comparisons remain transient and do not read/write saved preferences.
- `appearance.css` supplies Light semantic roles, reading options, code, rank, scorecard and Autopilot treatments. `theme.ts` retains exported names but resolves semantic variables. Opaque inline borders/chip fills retain distinct Dark roles. Badge/toast alpha colors use valid `color-mix`, not hexadecimal suffixes appended to variables.
- `ActionMetal` passes the selected theme to the installed effect library's own palette; shaders are still lazy, and reduced-motion/forced-color fallbacks remain intact.
- `AppearanceSettings` uses labeled native selects inside the existing modal's scrolling, Escape and focus-return model. New controls have measured boundaries and keyboard-only focus indicators. The shared close glyph's low Dark contrast was corrected.
- `usePaneSwapViewState` supplies the existing transcript/composer/selection capture and restore. The preference owner captures before root reflow and restores before notification. Synchronous changes share one capture until the next microtask so a newly exposed preceding line is not accidentally selected as the next anchor. No transcript remount, per-token state update, additional scroll manager or mutation observer was introduced.
- `appearance-native.ts` serializes/coalesces native theme changes and background requests. The background adapter invokes `plugin:window|set_background_color` with the actual current window's `{ label, value }`, using Rust-supported hex colors; the installed JS SDK's `{ color }` payload silently deserializes as `None` in Tauri 2.11.5. Theme handling, failure reporting and teardown remain unchanged. The existing `core:window:allow-set-theme` and `core:window:allow-set-background-color` grants remain unchanged by this correction. Native paint readback—not setter resolution or `theme()`—now verifies background application as described below.
- After separate user approval during verification, What's New received the same existing guarded debug browser arguments as main/project windows. Without matching arguments, WebView2 rejected the secondary environment with `0x8007139F`. Normal release windows receive no new debugging arguments.

## Background contract correction — 2026-09-21

**Evidence correction:** earlier smoke and real-review passes established theme selection and frontend synchronization, not consumption of a requested native background. Their logs and verdicts remain historical; do not infer background application from those `theme()` assertions. The former setter-only unit mock also could not detect the SDK/Rust key mismatch.

- The new regression intercepts the real SDK/core invoke boundary and checks exact command, current-window label and `value` for both colors across all three window kinds. It reproduced the old `{ color }` payload before the adapter. Rapid-toggle, rejection/recovery and teardown tests remain.
- Frontend/native and launcher selection: **62 passed / 3 files**, execution `e90ecb5d-21c9-4d82-a77b-542e460f5faa`; final smoke-harness rerun **8 passed**, `13242bae-4a61-4eaf-97fe-eb1ba3b9ac4c`. Standalone typecheck passed, `8be114be-8309-4ec2-8650-c23b7a3e30ba`.
- Final native smoke: **passed**, `be1a3b79-85e8-4f5d-a908-f09bc7346724`; `.gg/eyes/out/appearance-native/fixture-1790006252311/result.json`. Actual native readback was `#fcfbfd` and `#0f1115` for main, project-1 and What's New. The installed SDK negative control produced `Native background erasure was not handled`, then the production owner recovered both colors. Source/verifier hashes and exact per-window samples are recorded; cleanup observed 14 fixture processes and no survivors.
- Probe-development failures remain retained; earlier diagnostic fixture results are not final acceptance evidence. In particular `fixture-1790005130820` measured main/project paint but external PrintWindow returned black for transparent What's New; `fixture-1790005266147` was a diagnostic callback-only run, not an appearance acceptance pass; `fixture-1790005319218` retained the transparent-window capture failure. Raw cross-process GDI probes left sentinel pixels unchanged. The in-process probe first rejected the minimized window's empty client area (`fixture-1790005788375`); the final fixture uses visible windows. The negative-control recovery initially read before asynchronous background work completed (`fixture-1790006128057`); the final bounded polling retains the same exact color assertions.

This is Windows developer-fixture verification, not desktop screenshot appearance, cold-start compositor behavior, macOS, production-profile or installed-build approval. No dependency/registry edits, permission widening, installer, install, commit or push.

## Developer workflow

From the adopted repository root:

```sh
pnpm --filter gg-app dev:appearance
pnpm --filter gg-app smoke:appearance
```

`dev:appearance` opens the visible **normal app**, not the comparison route. It creates a fresh isolated profile/project under ignored `.gg/eyes/out/appearance-native/`, seeds no credentials, and explicitly selects `packages/ggcoder/dist/app-sidecar.js` rather than this checkout's default reporting wrapper. It never sends a model request. The current profile/debug endpoint is recorded in `visible-session.json` for local review only.

The launcher validates Local Fork identity and disabled updater artifacts, rejects incompatible port-1420 listeners, verifies checkout identity/current modules before reuse, sanitizes inherited provider/debug configuration, checks dependency-ordered framework output fingerprints, and performs an incremental offline debug build. Finite builds finish before native readiness timing starts. It does not install prerequisites or build installers. Close the developer app to finish; cleanup targets only owned processes. A separately started/reused Vite server is not stopped by this launcher.

`smoke:appearance` uses visible isolated Tauri/WebView2 windows, actual Rust IPC and a credential-free **controlled fixture daemon**. Visibility is required for a nonempty native client rectangle during background readback; other cross-pane fixtures still default to minimized. A Windows-debug-only command, excluded from release registration and gated by the existing exact developer-fixture opt-in, samples the calling window's `WM_ERASEBKGND` paint into an in-process GDI bitmap. It accepts no requested color or target label, reads no CSS, and changes neither theme nor window state. The smoke requires both native RGB colors for `main`, `project-*` and `whatsnew`, plus a negative control showing the installed SDK resolves without applying its color and recovery through the production appearance owner. It tests normal Settings, saved reload, native theme, shader palette, root/portal inheritance, narrow reflow, stable native sessions, keyed hosts, drafts, selections, reading anchors and What's New initialization/live synchronization/closure. Fixture activity/history is not model-quality evidence. Existing fixture warnings about unsupported endpoints are retained, not silently represented as a production-provider test.

For both-theme pane regressions, start a compatible normal-app Vite server first:

```sh
pnpm --filter gg-app dev --host 127.0.0.1
GG_APPEARANCE_SMOKE_THEME=light node gg-app/scripts/pane-swaps-dev-smoke.mjs
GG_APPEARANCE_SMOKE_THEME=dark node gg-app/scripts/pane-swaps-dev-smoke.mjs
GG_APPEARANCE_SMOKE_THEME=light node gg-app/scripts/pane-reading-anchor-dev-smoke.mjs
GG_APPEARANCE_SMOKE_THEME=dark node gg-app/scripts/pane-reading-anchor-dev-smoke.mjs
```

These environment-prefix examples use bash. Native 390px captures emulate web content width; the physical window minimum remains 480px. A preview-enabled server is incompatible with normal-app verification and is rejected, never automatically killed.

## Windows CI gate — 2026-09-21

Task `23b2939d` adds `pnpm --filter gg-app smoke:appearance` to the Windows app job, serially after framework/browser/Rust setup and the cross-pane/pane-swap fixtures, before Programmatic execution. The blocking Bash step has a 30-minute outer bound to accommodate finite offline debug compilation plus the separate unchanged 300-second native readiness budget. It reuses the existing WebView2/CDP driver, Local Fork identity, credential-free profiles and verified strict-port normal server; no preview or extra installation path is introduced.

Failure upload explicitly allows only `.gg/eyes/out/appearance-native/fixture-*/result.json` and `fixture-*/*.png`. Hidden-file inclusion is required for `.gg`, but the whole directory, visible-session records, nested profiles and raw logs are not selected. The existing runtime tasks own native background readback (`baa9ad5d`), prebuild/readiness separation (`83055721`) and failure/cleanup evidence persistence (`8e69ec11`); this integration leaves those implementations untouched.

Fresh local verification:
- **19 release-CI tests passed**, including serial ordering, blocking failure propagation and exact artifact paths; **53 launcher/smoke tests passed**, including startup/cleanup failure cases. Execution `a9ce09b7-d74f-487c-96ae-865686b6baf1`.
- The requested native smoke ran once and **passed**, execution `817166b5-2626-4a53-9402-0fe327f20011`. Cargo's finite incremental build completed in 1.90 seconds before readiness. Verdict, source hashes and four controlled PNGs: `.gg/eyes/out/appearance-native/fixture-1790006728675/`. Both actual native colors passed for main, project-1 and What's New; the SDK negative control remained effective. Saved reading settings, reading anchors, session/pane stability, synchronization and closure passed. Cleanup recorded 14 observed fixture processes and no survivors. A compatible existing normal-app Vite server was reused, not stopped.

**Hosted CI and the artifact service have not run.** This is a workflow contract check plus isolated local Windows developer-native verification, not a cold-cache build benchmark, installer test or overall ship approval. Existing warnings and historical failures remain retained. No production profile, runtime repair, release-note change, installer, install, deployment, commit or push occurred for this task.

## Verification and retained failures

Latest scoped receipts (host logs are `C:/Users/SPARTAN PC/.gg/foreground/<execution-id>.log`):

| Check | Result / evidence |
| --- | --- |
| Final affected tests, including preview isolation and debug lifecycle | 85 passed across 11 files; `111ffbb6-6fa2-457b-b31c-b128121ddc12` |
| Final debug-helper/launcher regression rerun | 10 passed after final socket teardown tightening; `40738808-e21d-4f83-a156-8e4a8f262b88`; subsequent native smoke and real review passed |
| Standalone app typecheck | Passed; `cb3661dd-82db-417c-a649-72f5571aa4e6` |
| App build | Passed; `69bacd07-7cdb-4ef0-b9c6-0c72a4969722`; existing config-loader/chunk warnings retained |
| Unchanged frontend initial size gate | 822.4 KB / 826.0 KB; `3d8b8843-f3be-469e-a599-9b787cff2abd` |
| Final permanent native smoke, including What's New closure | Passed; `8f51586d-9151-41e3-9d37-cff895eb5fa5`; `appearance-native/fixture-1789974806570/result.json` |
| Visible real-daemon review | Passed scoped checks in 5.6 seconds after hang fix; `045023cb-ca5e-441d-b45e-39f1723e20a9`; `appearance-native/real-review-after-hang-fix.json` |
| Light pane swaps / six panes | Passed; `pane-swaps-native/1789971606178/` |
| Dark pane swaps | Passed unchanged rerun; `pane-swaps-native/1789971747477/`; retain failed narrow Enter run `1789971654861/` |
| Unequal-width reading-anchor tests in both themes | Passed; `pane-reading-native/1789971793689/` and `1789971824161/` |
| Supplemental canonical visuals and component checks | `appearance-native/final-geist-*.png`, `settings-checks.json`; browser component evidence, not native substitution |

All relative evidence paths above live under ignored `.gg/eyes/out/`. They do not automatically accompany a clone. `appearance-native/baseline.md` and `source-manifest.json` distinguish the dirty source from HEAD. Earlier screenshots, failures and logs remain preserved.

The broad app test command was run, but it is **not an all-green gate**: its latest broad group reported 2,525 passing tests and two timeouts in existing AgentPane tests. Both passed when rerun unchanged (`ecaf62b4-e954-4789-92c9-84cc03df59cc`). An earlier broad run retained one timeout. Separately run serial updater/installer/launcher, workspace and What's New test groups passed earlier in this implementation; those are not a fresh whole-repository run. No timeout increases, skipped-test changes or weakened assertions were used. Later narrow corrections have affected-test/native evidence, not a new whole-suite pass.

The targeted native readability reproduction initially moved anchored text roughly 67 and 704 CSS px. Reusing the existing view-state owner corrected this; the permanent smoke retains a one-CSS-pixel tolerance. A second synchronous-change case exposed re-capture of a newly visible preceding line, corrected by the bounded same-turn capture. The Light shader initially kept its dark numeric palette; actual WebView screenshots identified this and the existing library's Light theme corrected it.

### Verification hang: diagnosed and fixed

The interrupted visible review had finished its four What's New captures at 06:26:57 UTC, then awaited JavaScript inside the window it was closing. WebView2 emitted `Inspector.detached`, not the socket-close event that the old helper awaited. Its pending request had no deadline, so neither the test nor its report-writing cleanup completed.

`DevCdpClient` now rejects pending requests on detach/crash/error/local close, clears deadlines on completion, bounds silent requests to 15 seconds, and bounds connection/discovery waits. No script content or credentials are included in timeout messages. The native regression reproduced the detach (`a9986ec8-fa0e-45ba-8602-309a3e70aaa0`); four lifecycle regression tests passed after three failed before the fix. The permanent smoke closes secondary windows through the surviving primary renderer and confirms target removal. The previously hanging real review then completed in 5.6 seconds. This fixes the actual indefinite wait; it does not excuse the earlier repeated broad checks and excessive verification time.

## State coverage and limits

Verified scope includes Dark/Light Settings and Home; saved root inheritance and live changes in late-created project/What's New windows; desktop/narrow Settings and What's New content; shader state; six-pane and unequal layouts; held controlled activity; transcript rows including Ken/Autopilot/error paragraphs in the reading fixture; drafts/selections/reading positions; and shared modal focus/Escape/return.

Supplemental settings checks measured text contrast about 16.45:1 Dark / 14.64:1 Light, field-boundary contrast 6.61:1 / 6.66:1, and keyboard-focus contrast 9.51:1 / 6.94:1. They exercised 200% zoom, forced colors, reduced-motion mode and pointer versus keyboard focus. The canonical accessibility heuristic still flags the modal's rotated/wrapped tab sequence; that report is retained alongside the actual focus-trap tests. Density-card metrics remain unavailable because no card is configured.

**Remaining acceptance gaps:** full native dialog/state coverage (Notes, scorecard, provider/auth, file/diff and every message/error/streaming permutation); cold-start/OS-titlebar pixels and physical minimum-window resizing; full process reopen with the same profile rather than the verified WebView reload; screen-reader/manual platform accessibility; exhaustive forced-color/reduced-motion effects; macOS; extended comfort; and installed/distributable verification. The initial post-hang-fix warm Light reload-to-Home observation was 580 ms (later reruns record their own timing), not a performance benchmark or proof of flash-free startup. The fixed pre-webview background remains a known cold-start risk. Native capability catalog lookup exposed no desktop screenshot tool; WebView captures do not establish OS-chrome fidelity.

Consequently the source implementation and scoped developer workflow are delivered, but the entire acceptance matrix is **not certified complete**. Historical reference-pixel and accessibility failures are not erased. No packages, production-profile changes, model calls, installed-app replacement, release notes, Roadmap mutations, commits or pushes were part of this work.
