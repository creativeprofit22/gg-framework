# Radio recovery and Settings save behaviour

Status: implemented and committed on 2026-09-23 (Roadmap phase "Unify light-theme controls and recovery feedback"). Verified with unit tests, browser walkthroughs on synthetic data, and native checks in the developer app: real IPC, persistence of station, volume and project folder across reopen, and mpv start, stop and station switching at process level. Not verified: audible output, screen readers, the installed or packaged app, and density metrics. This is not release approval.

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

- **Effects** (Sound, Memes, GG UI) and **Appearance and reading** apply and save the moment they change. Their own components own them. Settings says Cancel does not undo them.
- **Project folder** is the only field saved explicitly. The button reads **Save folder** and is disabled until the folder differs from the saved one. On first run, the suggested default folder counts as unsaved, so it can be accepted as is. Cancel closes without saving. How the folder is persisted is unchanged (native settings file).
- A failed save keeps the modal open and keeps the typed folder. It shows an inline error tied to the field, and the toast still appears. Editing the folder clears the error.
- A failed read shows "Couldn't read the saved folder" instead of a silently blank field.
- Save folder/Cancel stay pinned to the bottom of the scrolling modal, so they're reachable at any scroll position and window size.

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
