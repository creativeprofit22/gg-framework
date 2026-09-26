# Native appearance and reading preferences

Status, 2026-09-21 UTC: **integrated app source with scoped Windows developer-native evidence**. 2026-09-25 follow-up fixes (uncommitted) are summarized under [Follow-ups — 2026-09-25](#follow-ups--2026-09-25); the current open list is [Open items](#open-items). Dark remains the default; Light is opt-in. This is not an installed-app update, release approval, reference-fidelity claim, or accessibility-conformance assessment. The older preview documents are historical experiments, not the current integration boundary.

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

### Open items

Current list, updated 2026-09-25. Items closed on 2026-09-25 are listed below it with where the evidence lives.

**Still open (verification not yet done):**

- **Diffs inside agent replies** (Dark/Light, native). There is no standalone file/diff dialog; checking this needs a reply that contains a diff. The fake-login profile cannot produce one, so it needs a saved sample conversation or a real provider.
- **Every message, error and streaming state** in the native app.
- **Cold-start first frame** of the main window. Reload and new-window paths are measured flash-free; the very first frame after a full launch was not captured.
- **Real edge-drag to the minimum window size.** Layout at the 480×360 minimum is verified by setting the size through Windows; a scripted resize can bypass the minimum, so a real mouse drag was not tested.
- **Screen reader and manual platform accessibility**, plus exhaustive forced-color and reduced-motion effects.
- **macOS**, and **installed/distributable builds** (none of the 2026-09-25 changes is in an installed app).
- **Density-card metrics**: unavailable until density cards are configured.
- **Safari-engine (WebKit) effects geometry**: the Playwright WebKit browser is not installed, so only Chromium ran.

**Closed on 2026-09-25 (uncommitted source, Windows developer app):** Notes, scorecard and provider sign-in dialogs checked in both themes; startup theme on reload; dark frame on new windows; Light provider logos; Code-pane stray scrollbar; Home at the minimum window size; full close and reopen with the same profile; usage-meter Light styling (fixture data). Details in [Follow-ups — 2026-09-25](#follow-ups--2026-09-25).

Current reading/pane-swap comfort is satisfactory for the user as of 2026-09-21 ("checked that already" / "fine atm"); no repeat comfort review is pending. This does not establish a measured long-session study or close the separate technical gaps. The initial post-hang-fix warm Light reload-to-Home observation was 580 ms (later reruns record their own timing), not a performance benchmark or proof of flash-free startup. The fixed pre-webview background was a known cold-start risk at that time; see the 2026-09-25 follow-ups. Native capability catalog lookup exposed no desktop screenshot tool; WebView captures do not establish OS-chrome fidelity.

## Follow-ups — 2026-09-25

All uncommitted; nothing is in an installed app. Entries below are in the order they happened, so an earlier "open" can be closed by a later entry.

| Change | User-visible effect | Where |
| --- | --- | --- |
| Early theme script before first paint | Light no longer flashes dark on reload | `gg-app/public/appearance-boot.js`, `gg-app/index.html` |
| Remembered window theme | New windows open with the saved theme's background and title bar | `gg-app/src-tauri/src/window_theme.rs`, `gg-app/src/appearance-native.ts` |
| Reveal windows after first load | No dark frame when a window opens; windows appear ~0.6 s after request | `window_theme.rs`, window builder in `gg-app/src-tauri/src/lib.rs` |
| Re-inked monochrome logos | OpenAI, xAI and Moonshot logos visible on Light provider tiles | `gg-app/src/provider-logos.ts`, `gg-app/src/LoginScreen.tsx`, `gg-app/src/appearance.css` |
| Header glow clipped at the pane edge | No stray sideways scrollbar in Code panes | `.chat-head` in `gg-app/src/App.css` |
| Home scrolls when too tall | Top and bottom rows reachable at the minimum window size | `.home` in `gg-app/src/App.css` |
| Short review panes scroll the header vertically only | No sideways scrollbar inside the header when a review is open in a short pane | `@container review-pane` `.chat-head` in `gg-app/src/App.css` |

New or changed tests: `appearance-boot.test.ts`, `provider-logos.test.ts`, `appearance-native.test.ts`, `main.whatsnew.test.tsx`, `LoginScreen.test.tsx`, and Rust `window_theme` tests.

**2026-09-25 startup-theme follow-up (Windows developer app, isolated profile; uncommitted source).** A native WebView screencast of a Light reload recorded a full-frame near-black frame (average brightness 18/255) at 856 ms before Light returned (earlier baseline frames retained under `.gg/eyes/out/title-native/before-fix/`). Two fixes followed. (1) A blocking head script (`public/appearance-boot.js`) applies the saved theme before first paint, with a matching Light pre-paint background in `index.html`. (2) The frontend mirrors the selected theme into a per-identity native hint, and new windows are built with that theme's background and OS chrome theme (`src-tauri/src/window_theme.rs`); a missing or unknown hint falls back to Dark. After the fixes, the same reload screencast (261 frames) never dropped below brightness 244/255. Opening a brand-new Light window gave a light OS title bar. However, one screen sample (~350 ms sampling interval) still showed neutral 18,18,18 content before Light. This is neither app background, so it is presumably painted by Windows/WebView2 before the webview's own background applies. Cold-start first-window pixels therefore remain **open**. The title usage meter was rendered from fixture markup under real app CSS in the native WebView: Dark keeps its gradient fill and glow; Light uses a solid indigo fill on a lavender track without glow. No live provider data or credentials were used. Checks: focused Vitest suites (58 tests), `pnpm --filter gg-app check`, `pnpm --filter gg-app build`, `cargo test --lib window_theme` (2), and `cargo clippy --lib` (no new findings). The effects-geometry script passed Chromium but could not run WebKit because that Playwright browser is not installed.

**2026-09-25 minimized native dialog pass (Windows developer app, isolated credential-free profile, window confirmed minimized; uncommitted source).** WebView captures render normally while the window is minimized. The scorecard and the Anthropic sign-in dialog were checked in Dark and Light. Both dialogs used theme surfaces and ink, received focus on open, closed on Escape, and had no overflowing children; nothing was submitted. The provider list's bottom rows read correctly in Light. **Confirmed Light defect:** the OpenAI, xAI (Grok) and Moonshot marks are off-white assets normalized for Dark, so they nearly vanish on Light provider tiles. **Not reached:** Notes and file/diff need a Code pane, which stays disabled until a provider is connected; no credentials or provider fixture were added. Evidence: `.gg/eyes/out/title-native/dialogs/`.

**2026-09-25 follow-up (same minimized setup; uncommitted source).** The Light logo defect is fixed. OpenAI, xAI and Moonshot tiles now carry a monochrome marker that Light re-inks (`invert(0.88)`) and Dark leaves untouched; a test ties the marker to the off-white SVG assets. Native captures confirm dark marks on Light tiles and unchanged Dark marks. With user approval, a second throwaway profile held a placeholder DeepSeek key pointed at a dead loopback port; no message was sent. Notes opened from a fixture project's Code pane in Dark and Light. It used theme surfaces and ink, focused its Overview tab (focus-visible), closed on Escape, and had no clipped children. **New finding:** in a Code pane, the decorative glow canvas on the right-most header action extended 26 px past a 1024 px pane. The pane is an `overflow-y: auto` scroll container, so it showed a horizontal scrollbar in both themes. **Fixed** by `overflow-x: clip` on the workspace header, which only trims glow beyond the pane's side edge and does not make the header a scroll container. Native re-check (minimized, fixture profile): the pane's scroll width now equals its client width in Dark and Light, and glows still render with their vertical bleed. At a 480 px pane, no header control extends past the header, so none is clipped. **Still not reached:** there is no standalone file/diff dialog. Diffs only appear in agent replies, which would require sending a message.

**2026-09-25 checklist and visible-window pass (uncommitted source).**

- **Browser checklist (fixture-backed, simulated IPC; headless; not native):** Home, Providers and Code screens were checked at 1280×800 and 390×844 in Dark and Light (12 captures). In every capture the saved theme was applied before the app bundle ran, with no document overflow, horizontal scroll containers or cut header controls. Monochrome logos were re-inked in Light only. The shared screenshot fixture lacks the native Qwen status reply, so the check supplied one locally. Its Code flow stops at the session list with a fixture pane-generation banner, so the header was measured natively instead (above). The standard `visual` and `design-system` probes open the app without the native bridge and see only the dark pre-paint shell (14 elements), so they add no evidence here. Density cards stay unconfigured, so card metrics are unavailable.
- **New window (visible, Light saved, fixture profile):** watching only the new window's rectangle, 5 of 5 opens showed a solid near-black fill (RGB 18,18,18, 100% of samples) for roughly 40–300 ms before Light painted. It matches neither app background, so it is painted before the saved window background takes effect (presumably by Windows/WebView2). **Confirmed open**, not fixed.
- **Minimum size (480×360 inner, set through the OS):** no horizontal overflow or off-screen controls in either theme. In a Code pane the composer and send button stay visible. **New finding (not fixed):** on Home, the version/update row sits under the pane strip, and the MCP/Remote row runs past the bottom edge with no scroll container, so both rows are partly unreachable. A scripted OS resize can bypass the minimum (it reached 184×111), so a real edge drag was not tested.
- **Close/reopen:** closing the first window while others stayed open kept the app running. Closing the last window exited cleanly: the app process and background service stopped. Relaunching the same profile opened one window with Light and the other saved reading preferences intact. The cold-start first frame was not captured, because the relaunched window opened outside the watched rectangle.

**2026-09-25 fixes for the two open findings above (uncommitted source; Windows developer app, visible, Light saved, fixture profile).**

- **Home at minimum size — fixed.** Home now uses `justify-content: safe center` with vertical scrolling. At a 480×360 inner size, in Dark and Light, the top row clears the pane strip and the bottom row scrolls fully into view and receives clicks. At 1024×720, Home is unchanged: centred, nothing to scroll, no horizontal overflow.
- **New-window dark frame — fixed for the cases measured.** Windows that open visibly now stay hidden until their first page load finishes, then appear once. A two-second fallback shows them anyway if loading stalls, and the reveal never re-shows a window after a later reload. Startup restore uses the same path, so restored windows appear already at their saved position. Pane-copy windows stay hidden until their own setup finishes, as before; smoke windows that start minimized keep their old path. Measured by watching the new window's own rectangle with the main window kept on top: 6 of 6 opens went straight to Light with no dark frame. Before the fix, 5 of 5 showed a solid 18,18,18 fill. Earlier 'dark' samples in this pass were the test's own main window, which has the dark launch splash and briefly sits over the test area while it has focus. A new window now becomes visible about 0.6 s after it is requested. Native tests (255), full app tests (2,941), type check and web build pass. The very first frame of a cold start was not captured, because the reopened window landed behind other windows.

**2026-09-25 short review-pane header (uncommitted source; Windows developer app, visible, isolated fixture profile from `roadmap-reliability-dev-smoke.mjs --review-plan`, plan and Roadmap reviews showing).** The earlier header clip did not cover panes 700 px tall or less with a review open: there, a container-query rule turned the header into a scroll container on both axes, overriding the clip. Measured in the native WebView (CSS viewport emulation 1000×640, 600×640 and 1000×420, panes 572/572/352 px tall), in Dark and Light. In the fixture, the header's glow button (**+ New**) sat mid-row, so the header did not overflow (scroll width equal to client width). Because the glow button can be the right-most action (for example, the commit button in a git project), the probe then moved that button to the end of the action row in the DOM. **Confirmed:** the glow reached 12 px past the header, the header scroll width exceeded its client width by 27 px (1012/985, 612/585 and 997/970), and a horizontal scrollbar was visible, in both themes at all three sizes. **Fixed** by changing that rule to hide horizontal overflow and keep vertical scrolling. After a hot reload of the same window: no horizontal scrollbar at any size in either theme; focusing the right-most button and a sideways wheel both left the header's horizontal scroll at 0; vertical scrolling still works (scroll heights 96/68, 159/68 and 90/41, reaching 28, 91 and 49 px); the pane's scroll width equals its client width. The header's own scroll width still reports the clipped glow; that area is hidden and cannot be scrolled to. `pnpm --filter gg-app check` and `pnpm --filter gg-app build` passed. Not verified: the real git-project layout with the commit button (simulated by the DOM move) or an installed build. Evidence: `.gg/eyes/out/chat-head-review/` (`before*.json/png`, `after-rightmost.json/png`, probe scripts).

Historical reference-pixel and accessibility failures are not erased. No packages, production-profile changes, model calls, installed-app replacement, release notes, Roadmap mutations, commits or pushes were part of this work.
