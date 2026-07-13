# GG Coder Workspace + Notes Roadmap

## Outcome

Ship a durable VS Code-style workspace in one `gg-app` window without sacrificing project-scoped Notes, pane/session isolation, native multi-window workflows, or restart recovery.

## Shipped

- **Notes contract:** legacy text remains readable; versioned storage is additive and recoverable; Notes stay project-scoped and separate from agent-backed `TasksModal` tasks.
- **Workspace foundation:** pane-aware Rust/sidecar routing validates webview ownership, scopes SSE and cancellation, recovers daemon sessions, and keeps the typed Tauri bridge and native-window compatibility path intact (`f9fcb88`, `29eed34`, `c2adb9f`).
- **Recursive workspace:** versioned split-tree layouts support stable pane IDs, focused-pane routing, accessible pointer/keyboard resizing, nested horizontal/vertical splits, a four-pane cap, safe pane lifecycle, and recoverable malformed-layout fallback (`b36ec25`, `e7a29b1`, `4cde985`, `4befda5`, `34a698d`, `50a316c`).
- **Native windows:** **Open Pane/Project in New Native Window** creates an isolated copy of the focused target while preserving its source pane; startup reservations, fallback, rollback, duplicate targets, close, restore, and respawn are handled safely (`8055bc8`). Existing **Open in new window**, 2/4/6 windows, auto-arrange, saved geometry, and restart restore remain supported.
- **Terminal panes:** independently identified split-tree terminal leaves provide isolated Rust-owned PTYs, ownership-checked lifecycle and I/O, ordered output/input, resize reconciliation, stopped restore with explicit **Restart terminal**, multiple terminals, focus/close/persistence, Windows Job Object process-tree cleanup, and external-terminal recovery (`798b558`, `b5d25f5`, `b7418e1d`, `45cbb3a`, `81e8260`, `f35b019`, `4d24af0`, `0fe8b78c`, `8ffd851`).
- **Release coverage:** desktop releases run the locked Rust test gate before Tauri bundling, and the Windows packaged native-UI launch/identity/screenshot smoke is implemented (`6ec172dc`, `23899d0`).
- **Product constraints:** Notes remain project-scoped and separate from agent tasks; layouts and snapshots stay versioned/backward-compatible; malformed records fall back safely; terminals never execute on restore; terminal input suppresses agent shortcuts; app, window, pane, and project changes clean up only their owned resources.
- **Live-pane transfer:** deferred indefinitely because the isolated-copy workflow covers the user need; moving a live runtime across webviews adds disproportionate event-routing, rollback, persistence, terminal, and resource-ownership risk.

## Next

- [ ] **Windows packaged multi-terminal lifecycle smoke:** exercise multiple embedded terminals in the packaged Windows app, including concurrent creation, input/output isolation, resize, natural exit, pane close, native-window close, and app exit. **Pass** only when every owned terminal and descendant process exits, no PTY/output crosses panes, no stale daemon/session or terminal ownership remains, and the packaged app stays responsive through each lifecycle path.

## Deferred

- [ ] **Persisted fixed-pixel terminal sizing:** constrained-height verification showed nested terminal tracks can hide the agent composer and model controls. Ratio sizing remains the safe behavior until recursive descendant minimum-size constraints make fixed pixels safe.
- [ ] **App-wide announcements:** release polish, not an active workspace blocker; add one persistent, deduplicated polite announcement region.
- [ ] **Docs:** release polish, not an active workspace blocker; document workspace commands, shortcuts, and rollback/recovery.
- [ ] **Performance and soak work:** release polish, not an active workspace blocker; define concrete budgets and record a 30-minute mixed agent/terminal soak.

## Dropped

- **Open then close source:** the isolated copy is the supported native-window workflow. Automatically disposing the source adds lifecycle, readiness, persistence, terminal, and rollback risk without enough user value.
- **Handoff pulse:** retain the static unread indicator without restored-state animation.
