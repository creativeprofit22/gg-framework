# `dev_app` tool

The `dev_app` agent tool drives the running GG desktop dev app (Tauri + Vite on `:1420`). It is for the GG dev app only; the `screenshot` tool stays the way to look at any other URL. Load it with `tool_search` ("dev_app") when it is not already listed.

- Code: `packages/ggcoder/src/tools/dev-app.ts` (the one agent tool), `packages/ggcoder/src/dev-app-driver/` (the one shared driver, also used by the dev smoke scripts in `gg-app/scripts/`). The driver's `DevCdpClient` is the only control client.
- Tests: `packages/ggcoder/src/tools/dev-app.test.ts`, `packages/ggcoder/src/dev-app-driver/*.test.ts`. They run against a linkedom fixture page with a fake clock, not a real webview, so they are **simulated** evidence and do not prove native Tauri behaviour. Native evidence comes from the replay smoke below.

## A typical session

1. `open` (attach or launch) → first snapshot.
2. `snapshot` to read pane state and element refs.
3. `act` with an expected result → a verdict in one call (`confirmed`, or an error saying what was seen).
4. `snapshot` with `expect` to wait for the agent's reply without sending input.
5. `close`.

Don't park the agent on a sleep or a log watcher waiting for the app: every `dev_app` call returns within its deadline with a verdict or an error.

## Actions

| Action     | What it does                                                                                                                                                                                                                      |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `open`     | `attach` to the control port the user gave (loopback only, exactly one `:1420` app page), or `launch` the dev app on Windows with an isolated profile and a free port. Replaces any earlier connection. Returns a first snapshot. |
| `snapshot` | Pane state (draft, menu, status, focus) plus the visible interactive elements, each with a short ref such as `e7`. `screenshot: true` adds a PNG saved under `.gg/screenshots/`. With `expect`, waits until it holds (below).     |
| `act`      | `type`, `press` (with modifiers), `click` a ref, or `send_prompt`. Each returns a verdict, the expectation, and what changed. When `expect` is omitted, one is inferred.                                                          |
| `close`    | Closes the connection. Stops the app only if this session launched it; an attached app keeps running.                                                                                                                             |

### Launch or attach

- **Launch** (`open` with `mode: "launch"`, Windows only): runs `tauri dev --no-watch` with `gg-app/src-tauri/tauri.local.conf.json` (Local Fork identity), a fresh isolated profile, a free control port and a minimized window. Startup may compile Rust, so the default deadline is 180 s (max 300 s). Refused in plan mode.
- **Attach** (`open` with `mode: "attach"` and `port`): connects to an app the user already started. The control port exists only in a **debug** build and only when the user opts in: `smoke_browser_args` in `gg-app/src-tauri/src/windows.rs` adds `--remote-debugging-port` only when `GG_PHASE25_DEV_FIXTURE_SKIP_ORPHAN_SWEEP=1` and `GG_PHASE25_DEV_FIXTURE_CDP_PORT=<port>` are set; `GG_APP_DEV_SMOKE_WINDOW` must then be `minimized` or `visible`. Use an isolated `WEBVIEW2_USER_DATA_FOLDER`. The driver's `devAppEnvironment` builds exactly this environment. Release builds never open the port.

### Snapshot, and waiting with `expect`

A snapshot shows one status line per pane (`draft "…", menu open|closed, status Idle|Working|…, focus …`) plus up to 150 interactive elements (8 KB), then "N more not shown". Refs belong to the snapshot that produced them; an older ref is refused as `stale_ref`.

`snapshot` with `expect` waits, read-only, until the expectation holds (default 5 s, `deadline_ms` up to 30 s), then returns `confirmed: wait for …` plus the snapshot, or `[timed_out]` with what was seen. It does not need the page to change first, so a result already on screen confirms at once. Because it never sends input, plan mode allows it. Use it to read an agent reply (`text_appears`) instead of sleeping.

### Act with expected results

`expect` kinds: `text_appears`, `text_gone`, `element_appears`, `element_gone`, `draft_equals`, `focus_on`, `menu_open`, `menu_closed`, `dialog_open`, `dialog_closed`, `status_is`.

Verdicts:

- `confirmed`: the expectation held inside the deadline.
- `contradicted`: the page shows it did not happen (error `[contradicted]`, or a more specific code such as `[menu_swallowed_key]`).
- `unreadable`: the page could not be read (error `[page_unreadable]`).
- No verdict before the deadline: `[timed_out]`, with what was last seen.

When `expect` is omitted it is inferred: `type` into the composer → the draft becomes the old draft plus the text; `press Escape` with a menu or dialog open → it closes; `click` or other keys → the page changed; `send_prompt` → the prompt left the composer and the pane shows `Working`. `send_prompt` needs an empty composer.

### Recovering from a swallowed send

The 2026-11-01 stall: `/steroids` + Enter went to the slash menu, so nothing was sent and the app sat idle while a watcher waited for output. Now `send_prompt` notices the open menu and fails within its deadline:

```text
[menu_swallowed_key] send prompt contradicted (…): a menu is open (draft "/steroids"), so Enter goes to the menu; nothing was sent; …
Next: press Escape to close the menu, then press Enter with expect status_is "Working".
```

Then `act press Escape` (confirmed `menu_closed`), `act press Enter` with `expect: { kind: "status_is", value: "Working" }`, and `snapshot` with `expect: { kind: "text_appears", value: "…" }` to read the result.

## Error codes

Every error reads `[code] what happened. Next: what to do.`

| Code                   | Meaning                                                                                                                                | Next step                                                                               |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `not_attached`         | No connection yet, or it was closed.                                                                                                   | `open` (attach with the user's port, or launch on Windows).                             |
| `endpoint_refused`     | The port is not loopback or does not serve the GG dev app page on `:1420`; `attach` also uses it when no app page answers on the port. | Check the port; use `screenshot` for other URLs.                                        |
| `ambiguous_target`     | More than one GG dev app page is open, so the tool refuses to guess.                                                                   | Close extra dev app windows, then `open` again.                                         |
| `unsupported_platform` | `launch` on a non-Windows host.                                                                                                        | Start the dev app yourself and attach.                                                  |
| `launch_failed`        | The dev app did not start or no app page appeared in time.                                                                             | Check gg-app dependencies and that `pnpm --filter gg-app tauri dev` starts, then retry. |
| `target_gone`          | The window or page closed or reloaded under the connection.                                                                            | `open` again.                                                                           |
| `pane_not_found`       | The `pane` id is not on the page.                                                                                                      | Snapshot without `pane`, or pass an id the page shows.                                  |
| `stale_ref`            | The ref is from an older snapshot or its element was removed.                                                                          | Take a new snapshot and use a ref from it.                                              |
| `element_covered`      | Something (menu, dialog) covers the element.                                                                                           | Close it (Escape closes menus and dialogs), snapshot, retry.                            |
| `element_disabled`     | The element is disabled.                                                                                                               | Enable it first or pick another element.                                                |
| `element_offscreen`    | The element is outside the viewport.                                                                                                   | Scroll it into view or enlarge the window, snapshot, retry.                             |
| `menu_swallowed_key`   | A menu was open, so Enter went to the menu; nothing was sent.                                                                          | Press Escape, then press Enter with `expect` `status_is "Working"`.                     |
| `timed_out`            | The deadline passed without a verdict.                                                                                                 | Snapshot to see the state; retry with a longer `deadline_ms` if the app is slow.        |
| `contradicted`         | The page shows the expected result did not happen.                                                                                     | Snapshot, check what happened, adjust the action or expectation.                        |
| `page_unreadable`      | The page, or a CSS selector you passed, could not be read.                                                                             | Check the selector, snapshot, retry.                                                    |
| `invalid_input`        | Arguments are missing or invalid.                                                                                                      | Fix the arguments and call again.                                                       |
| `aborted`              | The call was cancelled.                                                                                                                | Call again if the work is still needed.                                                 |

## Debug-only limits

- Developer builds only: the control port comes from the debug-only gate in `windows.rs`. Release and installed apps cannot be driven, and the tool never touches an installed app.
- `launch` is Windows-only; elsewhere, attach to an app the user started.
- No raw page-script action: the agent can only snapshot and act through the fixed actions.
- Plan mode refuses `act` and `open` with `launch`; `snapshot` (with or without `expect`), attach and `close` stay allowed.
- Every call has a deadline (act/snapshot/attach 5 s by default, 30 s at most; launch 180 s by default, 300 s at most) and stops when the call is cancelled.
- Output never shows the debugger address, profile paths or environment secrets. The daemon's `x-gg-token`/`x-gg-session` headers stay in Rust and are never readable from the page.

## Native replay smoke

`node gg-app/scripts/dev-app-replay-dev-smoke.mjs --identity com.ggcoder.local-fork` (Windows; refuses if port 1420 is busy). It launches one minimized developer app with an isolated profile, the real Node daemon and a local scripted Azure provider. A scripted (palsu) agent then drives the real `dev_app` tool: attach, snapshot, a deliberately broken `send_prompt "/steroids"` that must fail `[menu_swallowed_key]`, Escape, Enter with `status_is "Working"`, a `snapshot` wait for the reply, close. It writes `result.json` under `.gg/eyes/out/dev-app-replay/<ts>/` and stops everything it started.

Boundary: native WebView2, Rust IPC and the real daemon, but **no real model** and no installed app. The 2026-11-02 before/after numbers (849 s → 4.6 s; 606 s of idle waiting → the broken send caught in 134 ms) are in `.gg/verification/dev-app-replay-2026-11/summary.md`.

## References

Ideas only: **no external code was copied, translated or adapted.** Our snapshot is a short in-page JavaScript script written for this app's markup (Lightpanda is written in Zig). Reviewed 2026-11-02; commits, line ranges and licences were re-checked at the pinned commits with `gh api` (`.gg/verification/dev-app-replay-2026-11/references-check.txt`).

| Repo (licence)                                                    | Pinned source                                                                                                                                                                                  | Idea                                                                                                                         | How `dev_app` uses it                                                                                                     |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| [Lightpanda](https://github.com/lightpanda-io/browser) (AGPL-3.0) | [`src/SemanticTree.zig` L45-56, L112-127 @ `721618ee`](https://github.com/lightpanda-io/browser/blob/721618eebb6fb4b83d7cda0030a438f6c76be6c9/src/SemanticTree.zig#L45-L127)                   | A compact, interactive-only text view of the page, capped in size with `[more]` markers                                      | `snapshot` lists only visible interactive elements, one line each, at most 150 elements and 8 KB, then "N more not shown" |
| [Lightpanda](https://github.com/lightpanda-io/browser) (AGPL-3.0) | [`src/NodeRegistry.zig` L20-45, L117-139 @ `721618ee`](https://github.com/lightpanda-io/browser/blob/721618eebb6fb4b83d7cda0030a438f6c76be6c9/src/NodeRegistry.zig#L20-L139)                   | Short stable ids with a two-way id ↔ node lookup                                                                             | Refs such as `e7` live in an in-page registry with a generation number; an old or removed ref is refused as `stale_ref`   |
| [scout](https://github.com/outcrawlai/scout) (Apache-2.0)         | [`packages/runtime/src/verify.ts` L960-1005 @ `7e09ebae`](https://github.com/outcrawlai/scout/blob/7e09ebae64f554a057648184f8d6999f8b3ed683/packages/runtime/src/verify.ts#L960-L1005)         | An expected result per action with confirmed / contradicted / unchecked verdicts; says when a dialog took the remaining keys | `act` verdicts with `expect`, and `menu_swallowed_key` when an open menu took Enter                                       |
| [unbrowse](https://github.com/unbrowse-ai/unbrowse) (MIT)         | [`packages/cli/src/mcp-tools.ts` L68-72 (cited L70) @ `e8f5f04b`](https://github.com/unbrowse-ai/unbrowse/blob/e8f5f04b761a1ab64f7c1c93fea3552c0de5c813/packages/cli/src/mcp-tools.ts#L68-L72) | A browser tool split into open, snapshot, act and close, tied to one session                                                 | The four `dev_app` actions on one connection per agent session                                                            |
