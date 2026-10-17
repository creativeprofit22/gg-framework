# Radio recovery and Settings save behaviour

Status: Radio implemented and committed on 2026-09-23 (Roadmap phase "Unify light-theme controls and recovery feedback"). The Settings section was revised on 2026-10-02 (phase "Settle one Settings save model and unify page and dialog"); see its dated note. The 2026-10-02 change is implemented and verified as described below but not committed. Verified with unit tests, browser walkthroughs on synthetic data, and native checks in the developer app: real IPC, persistence of station, volume and project folder across reopen, and mpv start, stop and station switching at process level. Not verified: audible output, screen readers, the installed or packaged app, and density metrics. This is not release approval.

## Radio: loading, empty, ready, failed

The station list has four outcomes, and each looks different:

| State   | What the user sees                                          | Play     |
| ------- | ----------------------------------------------------------- | -------- |
| Loading | "Loading stations…" in the picker and below it              | Disabled |
| Ready   | Station list and the selected station's description         | Enabled  |
| Empty   | "No radio stations are available right now." plus **Retry** | Disabled |
| Failed  | "Couldn't load radio stations." plus **Retry**              | Disabled |

- The desktop's existing radio state read (`getRadioState`) now throws when it fails. It no longer pretends there are zero stations. The native command is unchanged.
- `RadioButton` owns the state. Every read gets a sequence number and only the newest one is applied. A slow read from app start therefore can't overwrite the fresher read made when the modal opens, and closing mid-load does nothing harmful.
- Refreshing a list that already loaded keeps it on screen rather than flashing back to loading.
- If saving the volume fails, the slider goes back to the volume actually in effect and says so. It doesn't do this if the user has already moved the slider again.
- The titlebar button has a name that screen readers announce ("Internet radio" / "Radio playing"). The station picker is named "Station", and the Volume label is tied to its slider.

## Settings: instant preferences versus the saved folder

2026-10-02 revision: the 2026-09-23 split was revisited and kept on purpose (user decision). Saving a half-typed path automatically would move "Your Projects", and the native save does not check that the folder exists. What changed is how the split is presented: the same on the Settings page and in the tray-opened dialog, and no copy explaining what Cancel doesn't do.

- **Effects** (Sound, home background) and **Appearance and reading** apply and save the moment they change. Their own components own them. Their copy says "Changes apply right away."
- **Project folder** is the only field saved explicitly. **Save folder** sits beside the field, after Browse, on both the page and the dialog; the page header holds no General action. It is disabled until the folder differs from the saved one, and when disabled it looks like an outlined, muted button rather than a faded badge. On first run, the suggested default folder counts as unsaved, so it can be accepted as is. How the folder is persisted is unchanged (native settings file).
- While an edit is unsaved the field says "Not saved yet." After a successful save the panel stays open, Save folder is disabled again, and a polite live status says "Folder saved." The next edit clears it. The dialog used to close on save and the page used to show a toast; both now confirm inline.
- A failed save keeps the panel open and keeps the typed folder. It marks the field invalid (red border), shows an inline error with **Retry**, and the toast still appears. Retry saves the kept value and returns focus to the field. Editing the folder clears the error.
- A failed read shows "Couldn't read the saved folder" instead of a silently blank field.
- The dialog's footer has **Close** only (the page uses Back). Close never claims to undo anything; it discards an unsaved folder edit, which the "Not saved yet." hint warns about. The footer stays pinned to the bottom of the scrolling dialog.
- Page and dialog render the same `SettingsModal` with the same sections in the same order. The Effects and Project folder sentences each come from one constant (`EFFECTS_COPY`, `FOLDER_COPY`), so the page description and the dialog hint can't drift; Permissions shows its sentence on the page only, and Appearance and Azure own their copy in their own components.

## Ownership

- Shared tokens own recurring visuals: `--meter-*` (volume track, fill and thumb) and `--border-strong` (neutral control border). Dark defaults are in `App.css` and Light overrides in `appearance.css`. See the style pack §4 and §5.
- Since 2026-09-24 the titlebar usage meter also uses `--meter-track-bg`, `--meter-track-border` and `--meter-fill`, so it follows Light. Its tighter Dark glow stays a literal, and a Light-only rule in `appearance.css` removes it. Dark computed styles are unchanged. Verified by type check, build, format check, the 9 `TitleUsageMeter` tests and an isolated CSS render at 1280×800 and 390×844. The native titlebar was not checked.
- Feature components own composition and state only. They must not copy theme overrides.

## Verification (2026-09-23)

- Unit tests: `RadioButton.test.tsx` covers loading→ready, failed→Retry, empty→Retry, a stale read resolving late, rollback after a failed volume save, and names/labels. `SettingsModal.test.tsx` covers the label, the unchanged/empty disable, saving the first-run default, save success, save failure keeping the value plus the inline error, Cancel not saving, the read-failure note and the instant-apply hints. `HomeScreen.test.tsx` checks that Settings and Telegram have distinct names.
- `gg-app` check, lint (no errors), format check and build all passed.
- Browser walkthroughs used the synthetic native fixture at 1280×800 and 390×844, in Light. For Radio: happy path, close while loading, and read failure → Retry. For Settings: save, Cancel mid-scroll then reopen, and save failure → retry. All 12 passed. These ran as Playwright scripts because the canonical journey probe can't inject the native-call fixture.
- Dark regression: computed styles matched the baseline, except for the intended changes. The neutral border moved from 0.12 to 0.13 alpha white, and Notes reference/reminder buttons now use the shared neutral treatment.
- Canonical probes: `a11y.mjs` and `affordance.mjs` can't inject the fixture, so they saw an unfixtured page with 0 interactive elements. That is not a pass. `states.mjs` (source scan) reported no missing required states. `measure-density.mjs` has no card configuration.
- Native re-run (developer app via `dev:appearance`, probes attached over CDP; evidence in `.gg/eyes/out/light-controls-20260923/native/`): Home and Settings at 1280×800 and 390×844 in Dark and Light have no missing names and no colour-only states. The re-run found the Settings Effects and folder hints at 2.84:1 contrast, and they now use the muted text colour.
- Native Radio (developer app with an access-token-only copy of the Anthropic login, no refresh token): Radio scanned at both sizes in Light and Dark. Dark found the station description and volume readout at 2.84:1, and they now use the muted colour. Real stations load (19), choosing a station and keyboard volume changes survive reopening, and saving the project folder persists and restores. Play first showed the app's "needs a streaming player" message because no player was installed.
- Player (mpv 0.41.0, the official build `mpv-player.mpv-CI.MSVC`, installed per user with winget): Play starts mpv, the volume changes live without restarting it, and switching stations leaves exactly one player. On Windows, Pause used to leave audio running because the `mpv.com` launcher starts the real `mpv.exe` as a child, and only the launcher was stopped. Stopping now uses the shared process-tree cleanup, and native Pause leaves 0 players. The install hint now names this real package; the old `mpv.mpv` ID does not exist in winget.
- Not verified: audible output (process-level only), real audio, screen readers. Density-card metrics are unavailable because no card configuration exists.

## Verification (2026-10-02, Settings revision)

- Unit tests: `SettingsModal.test.tsx` now covers shared copy with no "does not undo" text and no Cancel, Save folder in the folder row, the unchanged/blank disable, first-run default saving while staying open, save success (stays open, "Folder saved." in a polite status, disabled again, next edit clears it), failure (value kept, `aria-invalid`, exact alert text, error toast, no close/onSaved, Retry shown), Retry succeeding with focus returned to the field, the "Not saved yet." hint plus Close not saving, the read-failure note, and the embedded page render (same sections in the same order, no Close, header action slot empty). `SettingsScreen.test.tsx` checks that General leaves the header's action slot empty. Together with `AppearanceSettings.test.tsx` and `modal-embed.test.tsx`: 25 tests pass.
- `gg-app` check, lint (0 errors; 10 existing warnings in other files), format check and build passed.
- Browser walkthroughs on the synthetic native fixture (Playwright scripts, because the canonical journey probe can't inject it), page and dialog at 1280×800 and 390×844: happy save, Close/Back then reopen showing the saved value, and a rejected save, which keeps the value, shows the exact alert, and then succeeds on Retry. All expectations passed with no page errors. Keyboard: Tab goes field → Browse → Save folder (skipped while disabled), the focus ring is 2px solid, and Enter saves. The smallest button is 35px tall.
- Disabled Save folder computed style in both themes: neutral glass fill, 1px `--border-strong` outline, muted ink, opacity 0.7 (was the accent pill at opacity 0.4).
- Native (developer app via `dev:appearance`, isolated profile, real Rust IPC, driven over CDP): saving a folder showed "Folder saved.", `app_settings_get` returned it, the identity's `gg-app.json` held it, and after a full webview reload the field showed it again.
- Light-theme fix, done in the same pass at the user's request ("fix it first"): the shared glass tints in `glass.css` are smoked dark for Dark and had no Light values, so in Light every glass surface (Settings cards, popups, toasts, menus, fields, the tab bar) drew dark glass under dark ink. `appearance.css` now gives Light pale frosted values for `--glass`, `--glass-hover`, `--glass-field`, `--glass-float`, `--glass-modal`, a faint ink wash for `--glass-clear`/`--glass-clear-hover`, and a softer `--glass-shadow`. Two follow-on Light overrides: unticked popup checkbox/radio edges use `--text-muted` instead of white, and `.home-link` (Remote and Steroids links) uses `--primary` instead of white. Dark is unchanged.
- Light contrast, computed per text element (ink over composited backgrounds, disabled text exempt), old tints vs new at 1280×800: General page 18 → 0 elements below minimum, General dialog 21 → 0, General page/dialog at 390×844 7/17 → 0, AI Providers 17 → 0, provider sign-in popup 25 → 0, failed-save toast 22 → 0, MCP 3 → 0, Steroids 2 → 0, Remote 4 → 0. The minimum text ratio on General is now 6.11:1; the folder hint is 9.37:1 on the page and 6.67:1 in the dialog (2.91:1 before). The disabled Save folder is 2.0–2.9:1 in Light and 2.5–3.3:1 in Dark (disabled, so exempt). Home and the session screen show no change in either direction. What remains there is outside this fix: the Codex/Claude Code badges on Projects (1.98/3.03:1) and the `│` separators in the session header/footer (1.34–1.39:1) measure the same with old and new tints.
- Not verified: screen readers, the installed or packaged app, density metrics (no card configuration).
